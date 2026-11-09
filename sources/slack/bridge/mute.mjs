#!/usr/bin/env node
// Edits the bridge's muted-conversations file (lib/muted.mjs). bin/qitt-mute is the entry point.
//
//   mute.mjs <source key | permalink> [note...]   mute a Slack thread, or a whole channel or DM
//   mute.mjs --unmute <source key | permalink>    follow it again
//   mute.mjs --list                               print what is muted
//
// File: $QITT_MUTED_FILE or ~/.local/state/qitt/muted.json (the bridge's mutedFile default).
import { homedir } from "node:os";
import { join } from "node:path";
import { muteKey, readMuted, writeMuted } from "./lib/muted.mjs";

const file = process.env.QITT_MUTED_FILE || join(homedir(), ".local/state/qitt/muted.json");
const usage = "usage: qitt-mute <source key | permalink> [note...] | --unmute <source key | permalink> | --list";

const [first, ...rest] = process.argv.slice(2);
try {
  const muted = readMuted(file);
  if (first === "--list") {
    for (const [key, { at, note }] of muted) console.log([key, at, note].filter(Boolean).join("  "));
    if (!muted.size) console.log("nothing muted");
  } else if (first === "--unmute") {
    if (rest.length !== 1) throw new Error(usage);
    const key = muteKey(rest[0]);
    if (!muted.delete(key)) console.log(`not muted: ${key}`);
    else {
      writeMuted(file, muted);
      console.log(`unmuted ${key}`);
    }
  } else if (first && !first.startsWith("-")) {
    const key = muteKey(first);
    muted.set(key, { at: new Date().toISOString(), ...(rest.length && { note: rest.join(" ") }) });
    writeMuted(file, muted);
    console.log(`muted ${key}`);
  } else throw new Error(usage);
} catch (err) {
  console.error(`qitt-mute: ${err.message}`);
  process.exit(1);
}
