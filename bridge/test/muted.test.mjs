import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Muted, muteKey, readMuted, writeMuted } from "../lib/muted.mjs";

const dir = mkdtempSync(join(tmpdir(), "qitt-muted-"));
after(() => rmSync(dir, { recursive: true, force: true }));
let n = 0;
const file = () => join(dir, `muted-${++n}.json`);

describe("muteKey", () => {
  it("accepts thread and channel source keys", () => {
    assert.equal(muteKey("slack:C000TEAM:1760648000.000100"), "slack:C000TEAM:1760648000.000100");
    assert.equal(muteKey(" slack:D000DM "), "slack:D000DM");
  });

  it("turns a reply permalink into its thread key", () => {
    assert.equal(
      muteKey("https://example.slack.com/archives/C000TEAM/p1760648800000100?thread_ts=1760648000.000100&cid=C000TEAM"),
      "slack:C000TEAM:1760648000.000100",
    );
  });

  it("turns a top-level permalink into its own key, and a channel link into the channel", () => {
    assert.equal(muteKey("https://example.slack.com/archives/C000TEAM/p1760648000000100"), "slack:C000TEAM:1760648000.000100");
    assert.equal(muteKey("https://example.slack.com/archives/C000TEAM"), "slack:C000TEAM");
  });

  it("rejects anything else", () => {
    assert.throws(() => muteKey("jira:ABC-1"), /not a Slack source key/);
    assert.throws(() => muteKey("slack:C000TEAM:notats"), /not a Slack source key/);
    assert.throws(() => muteKey(""), /not a Slack source key/);
  });
});

describe("Muted", () => {
  it("matches a reply or the thread's top message by thread key, then by channel", () => {
    const f = file();
    writeMuted(f, new Map([["slack:C000TEAM:1760648000.000100", { at: "x" }], ["slack:D000DM", { at: "x" }]]));
    const muted = new Muted({ file: f });
    assert.equal(muted.match({ channel: "C000TEAM", ts: "1760648800.000100", thread_ts: "1760648000.000100" }), "slack:C000TEAM:1760648000.000100");
    assert.equal(muted.match({ channel: "C000TEAM", ts: "1760648000.000100" }), "slack:C000TEAM:1760648000.000100");
    assert.equal(muted.match({ channel: "C000TEAM", ts: "1760649000.000100", thread_ts: "1760649000.000100" }), undefined);
    assert.equal(muted.match({ channel: "D000DM", ts: "1760649000.000100" }), "slack:D000DM");
  });

  it("is empty without a file and picks up changes without a restart", () => {
    const f = file();
    const muted = new Muted({ file: f });
    const event = { channel: "C000TEAM", ts: "1760648000.000100" };
    assert.equal(muted.match(event), undefined);
    writeMuted(f, new Map([["slack:C000TEAM", { at: "x", note: "a longer note than before" }]]));
    assert.equal(muted.match(event), "slack:C000TEAM");
    writeMuted(f, new Map());
    assert.equal(muted.match(event), undefined);
    rmSync(f);
    assert.equal(muted.match(event), undefined);
  });

  it("keeps the last good list when the file turns unreadable", () => {
    const f = file();
    const lines = [];
    writeMuted(f, new Map([["slack:C000TEAM", { at: "x" }]]));
    const muted = new Muted({ file: f, log: (l) => lines.push(l) });
    const event = { channel: "C000TEAM", ts: "1760648000.000100" };
    assert.equal(muted.match(event), "slack:C000TEAM");
    writeFileSync(f, "{ not json, and a different size");
    assert.equal(muted.match(event), "slack:C000TEAM");
    assert.equal(muted.match(event), "slack:C000TEAM");
    assert.equal(lines.length, 1);
    assert.match(lines[0], /keeping the last list/);
  });

  it("keeps the last good list when the file loses its shape", () => {
    for (const bad of ["{}", '{"muted": null}', '{"muted": []}', "[]", "null"]) {
      const f = file();
      writeMuted(f, new Map([["slack:C000TEAM", { at: "x" }]]));
      const muted = new Muted({ file: f });
      const event = { channel: "C000TEAM", ts: "1760648000.000100" };
      assert.equal(muted.match(event), "slack:C000TEAM");
      writeFileSync(f, `${bad}${" ".repeat(50)}`);
      assert.equal(muted.match(event), "slack:C000TEAM", bad);
      assert.throws(() => readMuted(f), /expected/, bad);
    }
    const f = file();
    writeFileSync(f, '{"muted": {}}');
    assert.equal(readMuted(f).size, 0);
  });

  it("logs a lasting stat error once, not once per message", () => {
    const notDir = file();
    writeFileSync(notDir, "");
    const lines = [];
    const muted = new Muted({ file: join(notDir, "muted.json"), log: (l) => lines.push(l) });
    for (let i = 0; i < 5; i++) assert.equal(muted.match({ channel: "C000TEAM", ts: "1760648000.000100" }), undefined);
    assert.equal(lines.length, 1);
    assert.match(lines[0], /ENOTDIR|not a directory/i);
  });
});

describe("qitt-mute", () => {
  const cli = fileURLToPath(new URL("../../bin/qitt-mute", import.meta.url));
  const run = (f, ...args) => execFileSync(cli, args, { env: { ...process.env, QITT_MUTED_FILE: f }, encoding: "utf8" });

  it("mutes, lists, and unmutes", () => {
    const f = file();
    assert.equal(run(f, "--list"), "nothing muted\n");
    assert.equal(
      run(f, "https://example.slack.com/archives/C000TEAM/p1760648800000100?thread_ts=1760648000.000100", "Going", "on", "without", "me"),
      "muted slack:C000TEAM:1760648000.000100\n",
    );
    const entry = readMuted(f).get("slack:C000TEAM:1760648000.000100");
    assert.equal(entry.note, "Going on without me");
    assert.ok(Date.parse(entry.at) > 0);
    assert.match(run(f, "--list"), /^slack:C000TEAM:1760648000\.000100 {2}\S+ {2}Going on without me\n$/);
    assert.equal(run(f, "--unmute", "slack:C000TEAM:1760648000.000100"), "unmuted slack:C000TEAM:1760648000.000100\n");
    assert.equal(run(f, "--unmute", "slack:C000TEAM:1760648000.000100"), "not muted: slack:C000TEAM:1760648000.000100\n");
    assert.equal(readMuted(f).size, 0);
  });

  it("never loses a change when commands overlap", async () => {
    const f = file();
    const keys = Array.from({ length: 12 }, (_, i) => `slack:C000TEAM:17606480${String(i).padStart(2, "0")}.000100`);
    await Promise.all(keys.map((k) => promisify(execFile)(cli, [k], { env: { ...process.env, QITT_MUTED_FILE: f } })));
    assert.deepEqual([...readMuted(f).keys()].sort(), keys);
  });

  it("refuses to edit a file it cannot read", () => {
    const f = file();
    writeFileSync(f, "{}");
    assert.throws(() => run(f, "slack:C000TEAM"), /expected/);
    assert.equal(readFileSync(f, "utf8"), "{}");
  });

  it("fails on a bad key or no arguments, without touching the file", () => {
    const f = file();
    assert.throws(() => run(f, "jira:ABC-1"), /not a Slack source key/);
    assert.throws(() => run(f), /usage/);
    assert.equal(readMuted(f).size, 0);
  });
});
