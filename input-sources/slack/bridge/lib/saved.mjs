// Saved-for-later poller. Every savedPollSeconds it lists my saved messages and hands each newly
// saved one to the batcher as a normalized event with saved: true, and each item that disappeared
// from the list as a short unsaved: true event.
//
// Listing: search.messages for "is:saved" (search:read user scope), 100 per page up to maxPages
// (20). Search has no save time, so saved_at is null and the first-run cutoff uses the message time.
//
// The keys seen so far (channel:ts) persist in a state file so a restart does not re-send. With
// no state file, the first poll reads the whole list, records every item, and sends only messages
// from the last 7 days; if the list is longer than maxPages it seeds nothing and retries next tick.
// Saved events skip the drop/keep filters: saving is the signal.
//
// Search pages drift: a poll can return one item twice and drop another while the total stays the
// same. So the listing is deduped, a list with fewer distinct items than search's total is treated
// as incomplete (no removals), and an item must be missing from removalPolls whole lists in a row
// before it is reported unsaved. Until then it stays in the state with a miss count, so its return
// is not announced as a new save.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { errorText } from "./log.mjs";
import { normalize } from "./normalize.mjs";

// Errors meaning search will not work for this token for the process lifetime.
const disablingErrors = new Set(["missing_scope", "not_allowed_token_type"]);
const weekMs = 7 * 24 * 3600 * 1000;
const removalPolls = 2;

export const savedKey = (channel, ts) => `${channel}:${ts}`;

// A dry run keeps its own state, so it never marks saves as seen for the real bridge.
export const stateFilePath = (home, dryRun) => join(home, `.local/state/qitt/bridge-saved${dryRun ? ".dry-run" : ""}.json`);

// The Events API channel_type for a channel, from conversations.info or, failing that, its id.
export const channelType = (channel, info) => {
  if (info?.is_im) return "im";
  if (info?.is_mpim) return "mpim";
  if (info?.is_private || info?.is_group) return "group";
  if (info) return "channel";
  if (channel.startsWith("D")) return "im";
  if (channel.startsWith("G")) return "group";
  return "channel";
};

// Map of key -> { source_key, permalink }, or null when there is no state file yet.
export const loadState = (file) => {
  let raw;
  try {
    raw = readFileSync(file, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") return null;
    throw err;
  }
  return new Map(Object.entries(JSON.parse(raw).seen ?? {}));
};

export const saveState = (file, seen) => {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, `${JSON.stringify({ seen: Object.fromEntries(seen) }, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, file);
};

export class SavedPoller {
  constructor({ cfg, client, directory, batcher, stateFile, log = () => {}, now = () => Date.now(), maxPages = 20 }) {
    this.cfg = cfg;
    this.client = client;
    this.directory = directory;
    this.batcher = batcher;
    this.stateFile = stateFile;
    this.log = log;
    this.now = now;
    this.maxPages = maxPages;
    this.disabled = !(cfg.savedPollSeconds > 0);
    this.running = false;
    this.own = new WeakSet(); // events this poller created, as opposed to live ones it marked saved
    this.seen = undefined; // loaded at the first poll
    this.timer = undefined;
  }

  // Polls now and then every savedPollSeconds. False when disabled by config.
  start() {
    if (this.disabled) return false;
    this.poll();
    this.timer = setInterval(() => this.poll(), this.cfg.savedPollSeconds * 1000);
    return true;
  }

  stop() {
    clearInterval(this.timer);
    this.timer = undefined;
  }

  // My saved messages, as { channel, message } items, each once; whether the last page was
  // reached; and search's total (undefined when it gives none).
  async #list() {
    const items = [];
    const keys = new Set();
    let total;
    for (let page = 1; page <= this.maxPages; page++) {
      const res = await this.client.search.messages({ query: "is:saved", sort: "timestamp", sort_dir: "desc", count: 100, page });
      total = res.messages?.paging?.total ?? res.messages?.pagination?.total_count ?? total;
      for (const m of res.messages?.matches ?? []) {
        if (!m.channel?.id || !m.ts) continue;
        const key = savedKey(m.channel.id, m.ts);
        if (keys.has(key)) continue;
        keys.add(key);
        // Search matches carry no thread_ts; a reply's permalink does.
        const threadTs = m.permalink?.match(/[?&]thread_ts=([0-9.]+)/)?.[1];
        items.push({
          channel: m.channel.id,
          info: m.channel, // search's channel object has the same is_im/is_mpim/is_private flags
          message: { ts: m.ts, user: m.user, text: m.text, permalink: m.permalink, ...(threadTs && { thread_ts: threadTs }), files: m.files },
        });
      }
      const pages = res.messages?.paging?.pages ?? res.messages?.pagination?.page_count ?? 1;
      if (page >= pages) return { items, complete: true, total };
    }
    return { items, complete: false, total };
  }

  async #event(item) {
    const m = item.message;
    const info = (await this.directory.channel(item.channel)) ?? item.info;
    const event = await normalize(
      { type: "message", channel: item.channel, channel_type: channelType(item.channel, info), channel_name: info?.name, user: m.user, text: m.text, ts: m.ts, thread_ts: m.thread_ts, files: m.files },
      this.cfg,
      this.directory,
    );
    return {
      ...event,
      permalink: event.permalink ?? m.permalink ?? null,
      saved: true,
      saved_at: null, // search does not say when a message was saved
    };
  }

  // A live copy still waiting in the batch is marked saved. A removal still waiting (unsaved,
  // then saved again within one window) is replaced by the full saved event. Otherwise the saved
  // event is added, even if the live copy already went out.
  #queueSave(event) {
    this.own.add(event);
    const pending = this.batcher.find(event.id);
    if (pending?.unsaved) this.batcher.replace(event.id, event);
    else if (pending) Object.assign(pending, { saved: true, saved_at: event.saved_at });
    else this.batcher.add(event);
  }

  // A saved event of ours still waiting (saved, then unsaved within one window) is replaced by
  // the removal, so qitt sees the final state. A live copy still waiting that was marked saved
  // loses the mark and goes out as the plain live message, with no removal.
  #queueUnsave(removal) {
    this.own.add(removal);
    const pending = this.batcher.find(removal.id);
    if (pending && !this.own.has(pending)) {
      delete pending.saved;
      delete pending.saved_at;
    } else if (pending) this.batcher.replace(removal.id, removal);
    else this.batcher.add(removal);
  }

  // One poll. Resolves to { sent, unsaved } counts, or a reason it did nothing (for tests).
  async poll() {
    if (this.disabled) return "disabled";
    if (this.running) return "busy";
    this.running = true;
    try {
      return await this.#poll();
    } catch (err) {
      const code = errorText(err);
      if (disablingErrors.has(code)) {
        this.disabled = true;
        this.stop();
        this.log(`saved-for-later polling disabled: search.messages failed with ${code}; the user token needs search:read`);
        return "disabled";
      }
      this.log(`saved-for-later poll failed: ${code}`);
      return "error";
    } finally {
      this.running = false;
    }
  }

  async #poll() {
    const { items, complete, total } = await this.#list();
    // Every page read, and no item lost to page drift.
    const drifted = complete && total !== undefined && items.length < total;
    const whole = complete && !drifted;
    if (this.seen === undefined) this.seen = loadState(this.stateFile);
    const firstRun = this.seen === null;
    // Seeding needs every existing save, or the unread ones would be announced as new later.
    if (firstRun && !whole) {
      this.log(`saved-for-later: ${drifted ? `pages drifted (${items.length} of ${total} items)` : `more than ${this.maxPages} pages of saved items`}; not seeding, retrying next poll`);
      return "incomplete";
    }
    const previous = this.seen ?? new Map();
    const next = whole ? new Map() : new Map(previous);
    const cutoff = this.now() - weekMs;
    let sent = 0;
    let unsaved = 0;

    for (const item of items) {
      const key = savedKey(item.channel, item.message.ts);
      const known = previous.get(key);
      let permalink = known?.permalink ?? item.message.permalink ?? null;
      const isNew = !known && (!firstRun || Number(item.message.ts) * 1000 >= cutoff);
      if (isNew) {
        const event = await this.#event(item);
        permalink = event.permalink;
        this.#queueSave(event);
        sent++;
      }
      const threadTs = item.message.thread_ts && item.message.thread_ts !== item.message.ts ? item.message.thread_ts : item.message.ts;
      next.set(key, { source_key: `slack:${item.channel}:${threadTs}`, permalink });
    }

    // Removals are only certain when the whole list was read, and only after removalPolls misses
    // in a row; a missing item keeps its state with the count until then.
    if (whole && !firstRun) {
      for (const [key, entry] of previous) {
        if (next.has(key)) continue;
        const missed = (entry.missed ?? 0) + 1;
        if (missed < removalPolls) {
          next.set(key, { ...entry, missed });
          continue;
        }
        const ts = key.slice(key.indexOf(":") + 1);
        this.#queueUnsave({ id: `slack:${key}`, source: "slack", unsaved: true, ts, source_key: entry.source_key, permalink: entry.permalink });
        unsaved++;
      }
    }

    this.seen = next;
    saveState(this.stateFile, next);
    if (sent || unsaved || firstRun || !whole) {
      const why = !complete ? `list longer than ${this.maxPages} pages` : drifted ? `pages drifted, ${items.length} of ${total} items` : "";
      this.log(`saved-for-later: ${items.length} saved, ${sent} new, ${unsaved} removed${firstRun ? " (first run)" : ""}${why ? ` (${why}; removals skipped)` : ""}`);
    }
    return { sent, unsaved };
  }
}
