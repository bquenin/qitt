// Search intake. Slack caps the Events API at 30,000 events per workspace per app per hour, and a
// user-scoped message.channels/message.groups subscription goes over it on a weekday morning:
// Slack then sends app_rate_limited and drops events, DMs included. So the app subscribes only to
// DMs and group DMs, and channel messages come from polling search.messages (search:read) every
// searchPollSeconds:
//
//   is:dm                      DMs and group DMs, catching up whatever the socket missed
//   <@me>, <!subteam^group>    mentions of me and my user groups
//   is:thread with:<@me>       threads I am in, my own replies included (they teach ThreadTracker)
//   in:<#channel>              each watched channel
//
// Search is fuzzy (a mention query also matches names), so every match goes through the same
// pipeline as a live event: drop/keep filters, dedupe against what was already sent, batch.
//
// Each poll reads back to a cursor minus overlapSeconds (search indexes with a lag), at most
// maxLookbackSeconds. The cursor is the previous poll's start, held back while something before it
// is still unread or unflushed, and persists in a state file, so after a restart the bridge
// catches up on what it missed while down. A query reads newest first; when that hits maxPages,
// the rest of its window is read oldest first, and if that runs out too the cursor and the page
// reached stay where reading stopped, so the next poll goes on from there.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Recent } from "./dedupe.mjs";
import { keepReasons } from "./filter.mjs";
import { errorText } from "./log.mjs";
import { channelType } from "./saved.mjs";

const disablingErrors = new Set(["missing_scope", "not_allowed_token_type"]);
const dayMs = 24 * 3600 * 1000;
const tsMs = (m) => Number(m.ts) * 1000;
// Search's after: takes a date and its time zone is not documented; two days early is safe.
export const afterDate = (ms) => new Date(ms - 2 * dayMs).toISOString().slice(0, 10);

export const searchStatePath = (home, dryRun) => join(home, `.local/state/qitt/bridge-search${dryRun ? ".dry-run" : ""}.json`);

export const searchQueries = (cfg) => [
  "is:dm",
  `<@${cfg.me}>`,
  ...cfg.groups.map((g) => `<!subteam^${g}>`),
  `is:thread with:<@${cfg.me}>`,
  ...cfg.watchChannels.map((c) => `in:<#${c}>`),
];

// The live-event shape the pipeline expects, built from a search.messages match. Matches carry no
// thread_ts (a reply's permalink does) and no bot_id (the caller looks the user up).
export const matchEvent = (m) => {
  const threadTs = m.permalink?.match(/[?&]thread_ts=([0-9.]+)/)?.[1];
  return {
    type: "message",
    channel: m.channel.id,
    channel_type: channelType(m.channel.id, m.channel),
    channel_name: m.channel.name ?? null,
    user: m.user,
    text: m.text ?? "",
    ts: m.ts,
    ...(threadTs && { thread_ts: threadTs }),
    permalink: m.permalink ?? null,
    files: m.files ?? [],
  };
};

export class SearchPoller {
  constructor({
    cfg,
    client,
    directory,
    handle,
    delivered,
    health, // a Health, optional: told when polls keep failing or search is disabled
    stateFile = null,
    log = () => {},
    now = () => Date.now(),
    overlapSeconds = 600,
    maxLookbackSeconds = 24 * 3600,
    maxPages = 10,
  }) {
    this.cfg = cfg;
    this.client = client;
    this.directory = directory;
    this.handle = handle;
    this.delivered = delivered;
    this.health = health;
    this.failures = 0; // polls failed in a row
    this.stateFile = stateFile;
    this.log = log;
    this.now = now;
    this.overlapMs = overlapSeconds * 1000;
    this.maxLookbackMs = maxLookbackSeconds * 1000;
    this.maxPages = maxPages;
    this.disabled = !(cfg.searchPollSeconds > 0);
    this.running = false;
    this.again = false;
    this.seen = new Recent(20000); // channel:ts already judged by the pipeline
    ({ cursor: this.cursor, backlog: this.backlog = {} } = this.#load());
    this.lastStarted = undefined;
    this.timer = undefined;
  }

  // { cursor, backlog }: backlog maps a query to where its oldest-first reading stopped.
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
    writeFileSync(tmp, `${JSON.stringify({ cursor: this.cursor, backlog: this.backlog }, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmp, this.stateFile);
  }

  // Polls now and then every searchPollSeconds. False when disabled by config.
  start() {
    if (this.disabled) return false;
    this.poll();
    this.timer = setInterval(() => this.poll(), this.cfg.searchPollSeconds * 1000);
    return true;
  }

  stop() {
    clearInterval(this.timer);
    this.timer = undefined;
  }

  // Polls now (the socket saw a gap); a call during a poll runs one more right after it. Skipped
  // when a poll started in the last 30 seconds: app_rate_limited repeats every minute.
  async catchUp(why) {
    if (this.disabled) return "disabled";
    if (!this.running && this.now() - (this.lastStarted ?? 0) < 30_000) return "recent";
    this.log(`search catch-up: ${why}`);
    if (this.running) {
      this.again = true;
      return "queued";
    }
    return this.poll();
  }

  // One poll. Resolves to { matched, kept } counts, or a reason it did nothing (for tests).
  async poll() {
    if (this.disabled) return "disabled";
    if (this.running) return "busy";
    this.running = true;
    try {
      const result = await this.#poll();
      this.failures = 0;
      return result;
    } catch (err) {
      const code = errorText(err);
      if (disablingErrors.has(code)) {
        this.disabled = true;
        this.stop();
        this.log(`search intake disabled: search.messages failed with ${code}; the user token needs search:read`);
        this.health?.report("search_disabled", `Search intake is off until the bridge restarts: search.messages failed with ${code} (the user token needs search:read). Channel messages are not reaching qitt.`);
        return "disabled";
      }
      this.log(`search poll failed: ${code}`);
      if (++this.failures >= 3) {
        this.health?.report("search_failing", `The last ${this.failures} search polls failed (latest: ${code}). Channel messages are late until a poll succeeds; it resumes from where it stopped.`);
      }
      return "error";
    } finally {
      this.running = false;
      if (this.again && !this.disabled) {
        this.again = false;
        this.poll();
      }
    }
  }

  // Pages of one query in one direction from firstPage, keeping matches in [sinceMs, untilMs).
  // complete is false when maxPages ran out first; page is the last page read, lastMs the time of
  // its last match, in or out of range.
  async #pages(query, dir, sinceMs, { untilMs = Infinity, firstPage = 1, maxPages = this.maxPages } = {}) {
    const matches = [];
    let lastMs;
    let page = firstPage;
    for (; page < firstPage + maxPages; page++) {
      const res = await this.client.search.messages({ query, sort: "timestamp", sort_dir: dir, count: 100, page });
      const found = (res.messages?.matches ?? []).filter((m) => m.channel?.id && m.ts);
      matches.push(...found.filter((m) => tsMs(m) >= sinceMs && tsMs(m) < untilMs));
      if (found.length) lastMs = tsMs(found.at(-1));
      const pages = res.messages?.paging?.pages ?? res.messages?.pagination?.page_count ?? 1;
      const pastEnd = dir === "desc" ? found.some((m) => tsMs(m) < sinceMs) : found.some((m) => tsMs(m) >= untilMs);
      if (page >= pages || pastEnd) return { matches, complete: true, page, lastMs };
    }
    return { matches, complete: false, page: page - 1, lastMs };
  }

  // Matches of one query since sinceMs; readMs: everything from sinceMs on was read when it is
  // Infinity, only up to readMs otherwise; backlog: the query's next backlog entry, or undefined.
  async #query(query, sinceMs) {
    const newest = await this.#pages(query, "desc", sinceMs);
    if (newest.complete) return { matches: newest.matches, readMs: Infinity };
    // Newest first ran out of pages: read the rest oldest first, up to the oldest match seen. That
    // order only grows at the end, so a later poll resumes at the page where this one stopped
    // (read again, in case it shifted) instead of starting over before the window.
    const from = this.backlog[query] ?? { after: afterDate(sinceMs), page: 1 };
    const oldest = await this.#pages(`${query} after:${from.after}`, "asc", sinceMs, { untilMs: newest.lastMs, firstPage: from.page });
    const matches = [...newest.matches, ...oldest.matches];
    if (oldest.complete) return { matches, readMs: Infinity };
    const readMs = Math.max(sinceMs, oldest.lastMs ?? sinceMs);
    this.log(`search "${query}": more than ${this.maxPages} pages; read through ${new Date(readMs).toISOString()}, the rest next poll`);
    return { matches, readMs, backlog: { after: from.after, page: oldest.page } };
  }

  async #poll() {
    const started = this.now();
    this.lastStarted = started;
    const sinceMs = Math.max((this.cursor ?? started) - this.overlapMs, started - this.maxLookbackMs);
    const byKey = new Map();
    let readMs = Infinity;
    // Takes effect only once every match is handled: a poll that fails reads the same pages again.
    const backlog = {};
    for (const query of searchQueries(this.cfg)) {
      const result = await this.#query(query, sinceMs);
      readMs = Math.min(readMs, result.readMs);
      if (result.backlog) backlog[query] = result.backlog;
      for (const m of result.matches) byKey.set(`${m.channel.id}:${m.ts}`, m);
    }
    // Oldest first, so my reply is noted before a later reply in the same thread is judged.
    const fresh = [...byKey.entries()].filter(([key]) => !this.seen.has(key)).sort(([, a], [, b]) => Number(a.ts) - Number(b.ts));
    let kept = 0;
    let retry = 0;
    for (const [key, m] of fresh) {
      const event = matchEvent(m);
      if (this.cfg.ignoreBots && event.user !== this.cfg.me) {
        // No user is a bot; an author lookup that failed is judged again next poll.
        const bot = event.user ? await this.directory.isBot(event.user) : true;
        if (bot === null) {
          retry++;
          continue;
        }
        if (bot) event.bot_id = "search";
      }
      const reason = await this.handle({ event });
      if (reason === "thread lookup failed") {
        retry++;
        continue;
      }
      if (keepReasons.has(reason) || reason === "my reply") kept++;
      this.seen.remember(key);
    }
    // Hold the cursor back to what is still unread, or batched but not flushed (a restart now
    // would lose that batch, and the next poll must find those messages again).
    this.backlog = backlog;
    const pendingMs = this.delivered?.oldestPendingMs();
    this.cursor = Math.min(started, readMs === Infinity ? started : readMs + this.overlapMs, pendingMs === undefined ? started : pendingMs + this.overlapMs);
    this.#save();
    if (kept || retry) this.log(`search: ${kept} kept of ${fresh.length} new matches since ${new Date(sinceMs).toISOString()}${retry ? `, ${retry} to retry` : ""}`);
    return { matched: fresh.length, kept, retry };
  }
}
