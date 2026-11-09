// Message ids already batched, kept in a state file so a restart or a catch-up search poll does
// not send a message twice. An id is pending (memory only) from the moment the pipeline batches it
// until its batch is flushed, then committed to the file: a restart inside the batch window loses
// the pending ids with the batch, so search catch-up sends those messages again. Committed entries
// older than keepSeconds (by message time) are pruned at every save; keep it longer than the
// search poller's longest look-back.
//
// A message can also carry aliases, other keys that mean the same message. The pipeline uses
// user:<user>:<ts>: adding someone to a DM copies its history into a new group DM with the same
// author and ts but a new channel, and search finds the copies.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

// A dry run keeps its own state, so it never marks messages as sent for the real bridge.
export const deliveredFilePath = (home, dryRun) => join(home, `.local/state/qitt/bridge-delivered${dryRun ? ".dry-run" : ""}.json`);

export class Delivered {
  // file null keeps everything in memory (tests).
  constructor({ file = null, keepSeconds = 3 * 24 * 3600, now = () => Date.now() } = {}) {
    this.file = file;
    this.keepSeconds = keepSeconds;
    this.now = now;
    this.ids = new Map(); // committed: id -> message ts
    this.pending = new Map(); // batched, not flushed yet: id -> { ts, aliases }
    this.pendingAliases = new Set();
    if (file) {
      try {
        this.ids = new Map(Object.entries(JSON.parse(readFileSync(file, "utf8")).delivered ?? {}));
      } catch (err) {
        if (err.code !== "ENOENT") throw err;
      }
    }
  }

  has(key) {
    return this.ids.has(key) || this.pending.has(key) || this.pendingAliases.has(key);
  }

  // True the first time a message is seen (it becomes pending), false once its id or one of its
  // aliases is remembered. A known id learns the aliases it lacks (ids sent before aliases
  // existed), so a later copy is caught too.
  remember(id, ts, aliases = []) {
    if (this.ids.has(id)) {
      const missing = aliases.filter((a) => !this.ids.has(a));
      for (const a of missing) this.ids.set(a, this.ids.get(id));
      if (missing.length) this.#save();
      return false;
    }
    const entry = this.pending.get(id);
    if (entry) {
      for (const a of aliases.filter((a) => !entry.aliases.includes(a))) {
        entry.aliases.push(a);
        this.pendingAliases.add(a);
      }
      return false;
    }
    if (aliases.some((a) => this.has(a))) return false;
    this.pending.set(id, { ts, aliases });
    for (const a of aliases) this.pendingAliases.add(a);
    return true;
  }

  // Commits the pending ids among these (a flushed batch's event ids); others are ignored.
  commit(ids) {
    let changed = false;
    for (const id of ids) {
      const entry = this.pending.get(id);
      if (!entry) continue;
      for (const key of [id, ...entry.aliases]) this.ids.set(key, entry.ts);
      for (const a of entry.aliases) this.pendingAliases.delete(a);
      this.pending.delete(id);
      changed = true;
    }
    if (changed) this.#save();
  }

  // The oldest pending message time in ms, or undefined when none is pending.
  oldestPendingMs() {
    let oldest;
    for (const { ts } of this.pending.values()) oldest = Math.min(oldest ?? Infinity, Number(ts) * 1000);
    return oldest;
  }

  #save() {
    const cutoff = this.now() / 1000 - this.keepSeconds;
    for (const [id, ts] of this.ids) if (Number(ts) < cutoff) this.ids.delete(id);
    if (!this.file) return;
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, `${JSON.stringify({ delivered: Object.fromEntries(this.ids) }, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmp, this.file);
  }
}
