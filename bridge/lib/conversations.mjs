// Conversations qitt has heard about: the Slack threads, and the whole DMs and group DMs, of the
// messages from other people that the bridge batched for it (learned as they are batched, so a
// reply of mine inside the same batch window counts). A message of mine in one of them goes to
// qitt flagged my_reply (lib/pipeline.mjs), so the thread working on it learns I answered; my
// messages anywhere else stay dropped. Kept in a state file so a restart remembers them; a
// conversation not heard from for keepDays is forgotten.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { errorText } from "./log.mjs";

const hourMs = 3600 * 1000;
const dayMs = 24 * hourMs;

// A dry run keeps its own state, so it never teaches the real bridge.
export const conversationsFilePath = (home, dryRun) => join(home, `.local/state/qitt/bridge-conversations${dryRun ? ".dry-run" : ""}.json`);

// slack:<channel> for a DM or group DM (one conversation, threads included), else the thread's
// source key, slack:<channel>:<thread ts>. Takes a raw event or a normalized one.
export const conversationKey = (e) => {
  const channel = e.channel ?? e.channel_id;
  if (e.channel_type === "im" || e.channel_type === "mpim") return `slack:${channel}`;
  const threadTs = e.thread_ts && e.thread_ts !== e.ts ? e.thread_ts : e.ts;
  return `slack:${channel}:${threadTs}`;
};

export class Conversations {
  // file null keeps everything in memory (tests).
  constructor({ file = null, keepDays = 14, now = () => Date.now(), log = () => {} } = {}) {
    this.file = file;
    this.log = log;
    this.keepMs = keepDays * dayMs;
    this.now = now;
    this.seen = new Map(); // key -> ms last heard about
    if (file) {
      try {
        this.seen = new Map(Object.entries(JSON.parse(readFileSync(file, "utf8")).conversations ?? {}));
      } catch (err) {
        if (err.code !== "ENOENT") throw err;
      }
    }
    this.saved = new Map(this.seen); // key -> ms as last written to the file
  }

  knows(event) {
    const ms = this.seen.get(conversationKey(event));
    return ms !== undefined && this.now() - ms <= this.keepMs;
  }

  // Keys of the conversations heard about in the last keepDays.
  recent() {
    const cutoff = this.now() - this.keepMs;
    return [...this.seen].filter(([, ms]) => ms >= cutoff).map(([key]) => key);
  }

  // Learns the conversation of a message on its way to qitt (raw or normalized), unless it is mine
  // or a saved-list removal. The pipeline notes a message before its lookups and the batcher again
  // as it is added, and a busy thread notes it often, so a conversation saved within the last hour
  // is only refreshed in memory: a restart can then forget it up to an hour early. A failed write
  // is logged, never thrown: the message still goes out, and the conversation is known in memory
  // and saved with the next one.
  note(e, me) {
    if (e.unsaved || (e.user_id ?? e.user) === me || !(e.channel_id ?? e.channel)) return;
    const key = conversationKey(e);
    const now = this.now();
    const saved = this.saved.get(key);
    this.seen.set(key, now);
    if (saved !== undefined && now - saved < hourMs) return;
    try {
      this.#save();
    } catch (err) {
      this.log(`conversations file not saved: ${errorText(err)}`);
    }
  }

  #save() {
    const cutoff = this.now() - this.keepMs;
    for (const [key, ms] of this.seen) if (ms < cutoff) this.seen.delete(key);
    if (!this.file) return;
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, `${JSON.stringify({ conversations: Object.fromEntries(this.seen) }, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmp, this.file);
    this.saved = new Map(this.seen);
  }
}
