// Reconciler: the safety net behind live events and search. Every reconcileMinutes it reads, straight
// from Slack, the conversations most likely to hold a message for me, and runs every message in
// them through the same pipeline as a live event:
//
//   - conversations qitt has heard about (lib/conversations.mjs): a thread with
//     conversations.replies, a DM or group DM with conversations.history (top level only);
//   - conversations I posted in during the last myThreadDays, found with search from:<@me>: the
//     thread of each channel reply or post of mine (a post can start one), and each DM. They are
//     kept in the state file, so each run only searches my messages since the previous one.
//
// It reads only messages older than settleSeconds, so live events and search (which reads back 10
// minutes) have had their chance. Anything already sent is a duplicate there and anything the
// filters drop stays dropped, so a message the pipeline keeps now is one they missed: it goes out
// flagged backfill, is logged as `reconcile gap`, and is reported to qitt through health.
//
// The window starts where the previous run's ended, at most maxLookbackSeconds back. It is kept in
// a state file and held back while a read failed or stopped at maxPages, a thread lookup failed, or
// a batch is unflushed,
// so the next run (or a restart) reads that part again. With no state file the first run starts
// from now. Slack calls are paced pauseMs apart: conversations.replies and conversations.history
// are Tier 3 (about 50 a minute), and live thread lookups share that budget.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { keepReasons } from "./filter.mjs";
import { errorText } from "./log.mjs";
import { channelType } from "./saved.mjs";
import { afterDate } from "./search.mjs";

const dayMs = 24 * 3600 * 1000;
const tsMs = (ts) => Number(ts) * 1000;
const slackTs = (ms) => (ms / 1000).toFixed(6);
// What the pipeline returns for a message it sent on.
const sentReasons = new Set([...keepReasons, "my reply"]);
// Errors a retry will not fix (an archived or deleted conversation, one I left): skipped, not
// failed. A missing scope is a failure, so it is reported.
const permanentErrors = new Set(["channel_not_found", "thread_not_found", "not_in_channel", "is_archived"]);
const searchOverlapMs = 600_000;

export const reconcileStatePath = (home, dryRun) => join(home, `.local/state/qitt/bridge-reconcile${dryRun ? ".dry-run" : ""}.json`);

// A conversation key (lib/conversations.mjs) as what to read: slack:<channel>:<thread ts> is a
// thread, slack:<channel> a whole DM (D...) or group DM.
export const parseKey = (key) => {
  const [, channel, threadTs] = key.split(":");
  if (!channel) return undefined;
  return threadTs ? { key, channel, threadTs } : { key, channel };
};

export class Reconciler {
  constructor({
    cfg,
    client,
    handle,
    conversations,
    delivered,
    health,
    stateFile = null,
    log = () => {},
    now = () => Date.now(),
    settleSeconds = 900,
    maxLookbackSeconds = 24 * 3600,
    myThreadDays = 7,
    maxPages = 50,
    pauseMs = 1500,
    wait = sleep,
  }) {
    this.cfg = cfg;
    this.client = client;
    this.handle = handle;
    this.conversations = conversations;
    this.delivered = delivered;
    this.health = health;
    this.stateFile = stateFile;
    this.log = log;
    this.now = now;
    this.settleMs = settleSeconds * 1000;
    this.maxLookbackMs = maxLookbackSeconds * 1000;
    this.myThreadMs = myThreadDays * dayMs;
    this.maxPages = maxPages;
    this.pauseMs = pauseMs;
    this.wait = wait;
    this.disabled = !(cfg.reconcileMinutes > 0);
    this.running = false;
    this.failures = 0; // runs failed in a row
    const state = this.#load();
    this.cursor = state.cursor; // reconciled up to here
    this.mine = new Map(Object.entries(state.mine ?? {})); // conversation key -> ms of my latest message
    this.mineSearched = state.mineSearched; // ms my messages were last searched
    this.gone = new Set(); // keys that failed with a permanent error, skipped until restart
    this.timer = undefined;
  }

  #load() {
    if (!this.stateFile) return {};
    try {
      return JSON.parse(readFileSync(this.stateFile, "utf8"));
    } catch (err) {
      if (err.code === "ENOENT") return {};
      throw err;
    }
  }

  #save() {
    if (!this.stateFile) return;
    mkdirSync(dirname(this.stateFile), { recursive: true });
    const tmp = `${this.stateFile}.tmp`;
    const state = { cursor: this.cursor, mineSearched: this.mineSearched, mine: Object.fromEntries(this.mine) };
    writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmp, this.stateFile);
  }

  // Runs every reconcileMinutes, the first time one interval after start (search catches up first).
  start() {
    if (this.disabled) return false;
    this.timer = setInterval(() => this.run(), this.cfg.reconcileMinutes * 60_000);
    return true;
  }

  stop() {
    clearInterval(this.timer);
    this.timer = undefined;
  }

  // One run. Resolves to { conversations, read, backfilled, failed }, or a reason it did nothing.
  async run() {
    if (this.disabled) return "disabled";
    if (this.running) return "busy";
    this.running = true;
    try {
      const result = await this.#run();
      this.#counted(result.failed);
      return result;
    } catch (err) {
      this.log(`reconcile failed: ${errorText(err)}`);
      this.#counted(true);
      return "error";
    } finally {
      this.running = false;
    }
  }

  // Counts runs failed in a row and reports from the third on.
  #counted(failed) {
    this.failures = failed ? this.failures + 1 : 0;
    if (this.failures >= 3) {
      this.health?.report("reconcile_failing", `The last ${this.failures} reconcile runs could not read everything (see the bridge log); what they missed is read again next run.`);
    }
  }

  // Slack call, paced.
  async #call(fn) {
    if (this.pauseMs) await this.wait(this.pauseMs);
    return fn();
  }

  // Updates this.mine with my messages since the last search (a little overlap for search's
  // indexing lag), or the last myThreadDays the first time, and forgets the older ones. False when
  // maxPages ran out first: the search time stays, so the next run searches that span again.
  async #searchMine(started) {
    const cutoff = started - this.myThreadMs;
    const sinceMs = Math.max(cutoff, (this.mineSearched ?? -Infinity) - searchOverlapMs);
    const query = `from:<@${this.cfg.me}> after:${afterDate(sinceMs)}`;
    for (let page = 1; page <= this.maxPages; page++) {
      const res = await this.#call(() => this.client.search.messages({ query, sort: "timestamp", sort_dir: "desc", count: 100, page }));
      const matches = (res.messages?.matches ?? []).filter((m) => m.channel?.id && m.ts);
      for (const m of matches) {
        if (tsMs(m.ts) < sinceMs) continue;
        const type = channelType(m.channel.id, m.channel);
        const key = type === "im" || type === "mpim" ? `slack:${m.channel.id}` : `slack:${m.channel.id}:${m.permalink?.match(/[?&]thread_ts=([0-9.]+)/)?.[1] ?? m.ts}`;
        this.mine.set(key, Math.max(this.mine.get(key) ?? 0, tsMs(m.ts)));
      }
      const pages = res.messages?.paging?.pages ?? res.messages?.pagination?.page_count ?? 1;
      if (page >= pages || matches.some((m) => tsMs(m.ts) < sinceMs)) {
        for (const [key, ms] of this.mine) if (ms < cutoff) this.mine.delete(key);
        this.mineSearched = started;
        return true;
      }
    }
    this.log(`reconcile: more than ${this.maxPages} pages of my messages; kept the newest, searching again next run`);
    return false;
  }

  // Messages of one conversation in [oldest, latest], as live-event shapes; complete is false when
  // maxPages ran out first.
  async #read({ channel, threadTs }, oldest, latest) {
    const events = [];
    let cursor;
    for (let page = 0; page < this.maxPages; page++) {
      const args = { channel, oldest, latest, inclusive: true, limit: 200, ...(threadTs && { ts: threadTs }), ...(cursor && { cursor }) };
      const res = await this.#call(() => (threadTs ? this.client.conversations.replies(args) : this.client.conversations.history(args)));
      for (const m of res.messages ?? []) {
        // conversations.replies always returns the thread's parent first.
        if (!m.ts || Number(m.ts) < Number(oldest) || Number(m.ts) > Number(latest)) continue;
        events.push({
          type: "message",
          channel,
          channel_type: threadTs ? channelType(channel) : channel.startsWith("D") ? "im" : "mpim",
          user: m.user,
          text: m.text ?? "",
          ts: m.ts,
          ...(m.thread_ts && { thread_ts: m.thread_ts }),
          ...(m.subtype && { subtype: m.subtype }),
          ...(m.bot_id && { bot_id: m.bot_id }),
          files: m.files ?? [],
          backfill: true,
        });
      }
      cursor = res.response_metadata?.next_cursor;
      if (!cursor) return { events, complete: true };
    }
    this.log(`reconcile: ${channel}${threadTs ? `:${threadTs}` : ""} has more than ${this.maxPages} pages in the window; reading it again next run`);
    return { events, complete: false };
  }

  async #run() {
    const started = this.now();
    const untilMs = started - this.settleMs;
    if (this.cursor === undefined) {
      this.cursor = untilMs;
      this.#save();
      this.log(`reconcile: first run, reading from ${new Date(untilMs).toISOString()} on`);
      return { conversations: 0, read: 0, backfilled: 0, failed: false };
    }
    const sinceMs = Math.max(this.cursor, started - this.maxLookbackMs);
    if (sinceMs >= untilMs) return { conversations: 0, read: 0, backfilled: 0, failed: false };
    let failed = false;
    try {
      if (!(await this.#searchMine(started))) failed = true;
    } catch (err) {
      failed = true;
      this.log(`reconcile: search for my messages failed: ${errorText(err)}`);
    }
    const keys = new Set([...(this.conversations?.recent() ?? []), ...this.mine.keys()]);
    const events = [];
    for (const target of [...keys].filter((k) => !this.gone.has(k)).map(parseKey).filter(Boolean)) {
      try {
        const read = await this.#read(target, slackTs(sinceMs), slackTs(untilMs));
        events.push(...read.events);
        if (!read.complete) failed = true;
      } catch (err) {
        const code = errorText(err);
        if (permanentErrors.has(code)) this.gone.add(target.key);
        else failed = true;
        this.log(`reconcile: reading ${target.key} failed: ${code}${permanentErrors.has(code) ? "; skipped until restart" : ""}`);
      }
    }
    // Oldest first, so my reply is noted before a later reply in the same thread is judged.
    events.sort((a, b) => Number(a.ts) - Number(b.ts));
    const seen = new Set();
    const gaps = [];
    for (const event of events) {
      const id = `slack:${event.channel}:${event.ts}`;
      if (seen.has(id)) continue;
      seen.add(id);
      const reason = await this.handle({ event });
      if (reason === "thread lookup failed") failed = true;
      if (!sentReasons.has(reason)) continue;
      this.log(`reconcile gap ${id} (${reason})`);
      // A message of mine can be held as my reply only because qitt heard about its conversation
      // after I posted, so only other people's messages count as missed.
      if (event.user !== this.cfg.me) gaps.push(id);
    }
    // A failed read is read again next run; so is anything batched but not flushed yet, since a
    // restart would lose that batch.
    const pendingMs = this.delivered?.oldestPendingMs();
    if (!failed) this.cursor = Math.min(untilMs, pendingMs ?? untilMs);
    this.#save();
    if (gaps.length || failed) {
      this.log(`reconcile: ${keys.size} conversations, ${seen.size} messages since ${new Date(sinceMs).toISOString()}, ${gaps.length} backfilled${failed ? ", some reads failed" : ""}`);
    }
    if (gaps.length) {
      this.health?.report(
        "missed_messages",
        `The reconciler found ${gaps.length} message${gaps.length === 1 ? "" : "s"} that live events and search missed: ${gaps.join(", ")}. They are in this batch or the next, flagged backfilled.`,
      );
    }
    return { conversations: keys.size, read: seen.size, backfilled: gaps.length, failed };
  }
}
