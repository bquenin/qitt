// Muted conversations: Slack threads or whole channels I told qitt to stop following. The bridge
// drops their messages before they reach qitt, except ones that mention me personally. Saved
// items skip the keep filters, so they still get through.
//
// bin/qitt-mute (entry point mute.mjs) edits the file under a lock; the bridge only reads it, again
// whenever its mtime or size changes, so a mute applies without a restart. Format:
//   { "muted": { "slack:<channel>:<thread ts>" | "slack:<channel>": { "at": <ISO time>, "note": <text> } } }
import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { errorText } from "./log.mjs";

const keyPattern = /^slack:[A-Z0-9]+(?::\d+\.\d+)?$/;

// A source key (slack:C123:1792390389.516039 or slack:C123) or a Slack permalink, as a mute key.
// A permalink to a reply mutes its thread. Throws on anything else.
export const muteKey = (input) => {
  const s = String(input ?? "").trim();
  if (keyPattern.test(s)) return s;
  const link = s.match(/\/archives\/([A-Z0-9]+)(?:\/p(\d{10})(\d{6}))?(?:[/?#]|$)/);
  if (link) {
    const [, channel, sec, micro] = link;
    const threadTs = s.match(/[?&]thread_ts=(\d+\.\d+)/)?.[1] ?? (sec && `${sec}.${micro}`);
    return threadTs ? `slack:${channel}:${threadTs}` : `slack:${channel}`;
  }
  throw new Error(`not a Slack source key or permalink: ${s}`);
};

// Requires {"muted": {...}}: anything else is an error, so a bad edit never reads as "nothing muted".
export const readMuted = (file) => {
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") return new Map();
    throw err;
  }
  const doc = JSON.parse(text);
  const isObject = (v) => Boolean(v) && typeof v === "object" && !Array.isArray(v);
  if (!isObject(doc) || !isObject(doc.muted)) throw new Error('expected {"muted": {...}}');
  return new Map(Object.entries(doc.muted));
};

export const writeMuted = (file, muted) => {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify({ muted: Object.fromEntries(muted) }, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, file);
};

export class Muted {
  constructor({ file, log = () => {} }) {
    this.file = file;
    this.log = log;
    this.keys = new Map();
    this.stamp = undefined;
  }

  // An unreadable file keeps the last good list, so a bad edit never floods qitt with conversations
  // it was told to drop. Each distinct error is logged once, not once per message.
  #fail(what, err) {
    const line = `muted file ${what}: ${errorText(err)}`;
    if (line !== this.lastError) this.log(line);
    this.lastError = line;
  }

  #load() {
    let st;
    try {
      st = statSync(this.file);
    } catch (err) {
      if (err.code === "ENOENT") {
        this.keys = new Map();
        this.lastError = undefined;
      } else this.#fail("unreadable, keeping the last list", err);
      this.stamp = undefined;
      return this.keys;
    }
    const stamp = `${st.mtimeMs}:${st.size}`;
    if (stamp !== this.stamp) {
      this.stamp = stamp;
      try {
        this.keys = readMuted(this.file);
        this.lastError = undefined;
      } catch (err) {
        this.#fail("unreadable, keeping the last list", err);
      }
    }
    return this.keys;
  }

  // The mute key that covers a message (its thread first, then its channel), or undefined.
  match(event) {
    const keys = this.#load();
    const thread = `slack:${event.channel}:${event.thread_ts || event.ts}`;
    if (keys.has(thread)) return thread;
    const channel = `slack:${event.channel}`;
    return keys.has(channel) ? channel : undefined;
  }
}
