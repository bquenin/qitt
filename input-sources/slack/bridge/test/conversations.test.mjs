import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { Conversations, conversationKey, conversationsFilePath } from "../lib/conversations.mjs";

const day = 24 * 3600 * 1000;
const event = (fields = {}) => ({ id: "slack:C1:1760648700.000100", channel_id: "C1", channel_type: "channel", ts: "1760648700.000100", thread_ts: null, user_id: "U1", ...fields });

describe("conversations", () => {
  const dir = mkdtempSync(join(tmpdir(), "qitt-conversations-test-"));
  after(() => rmSync(dir, { recursive: true, force: true }));

  it("keys a thread by its root and a DM by its channel", () => {
    assert.equal(conversationKey(event()), "slack:C1:1760648700.000100");
    assert.equal(conversationKey(event({ ts: "1760648800.000100", thread_ts: "1760648700.000100" })), "slack:C1:1760648700.000100");
    assert.equal(conversationKey({ channel: "C1", ts: "1760648800.000100", thread_ts: "1760648700.000100" }), "slack:C1:1760648700.000100");
    assert.equal(conversationKey({ channel: "D1", channel_type: "im", ts: "1", thread_ts: "0" }), "slack:D1");
    assert.equal(conversationKey(event({ channel_id: "G1", channel_type: "mpim" })), "slack:G1");
  });

  it("learns other people's conversations, persists them, and forgets after keepDays", () => {
    const file = join(dir, "c.json");
    let now = Date.parse("2025-10-16T21:05:00Z");
    const c = new Conversations({ file, now: () => now });
    c.note(event({ user_id: "U000ME" }), "U000ME");
    c.note({ id: "slack:C1:2", unsaved: true, source_key: "slack:C2:2" }, "U000ME");
    assert.equal(c.knows({ channel: "C1", ts: "1760648700.000100" }), false);
    c.note(event(), "U000ME");
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.deepEqual(Object.keys(JSON.parse(readFileSync(file, "utf8")).conversations), ["slack:C1:1760648700.000100"]);
    const reply = { channel: "C1", ts: "1760648900.000100", thread_ts: "1760648700.000100" };
    assert.equal(new Conversations({ file, now: () => now }).knows(reply), true);
    now += 15 * day;
    assert.equal(c.knows(reply), false);
  });

  it("learns from a raw event, and keeps going when the file cannot be written", () => {
    const lines = [];
    const blocker = join(dir, "blocker");
    writeFileSync(blocker, "");
    const c = new Conversations({ log: (l) => lines.push(l) });
    c.file = join(blocker, "c.json"); // under a regular file, so the write fails
    c.note({ channel: "D1", channel_type: "im", user: "U1", ts: "1" }, "U000ME");
    c.note({ channel: "D2", channel_type: "im", user: "U000ME", ts: "1" }, "U000ME");
    assert.equal(c.knows({ channel: "D1", channel_type: "im", ts: "2" }), true);
    assert.equal(c.knows({ channel: "D2", channel_type: "im", ts: "2" }), false);
    assert.equal(lines.length, 1);
    assert.match(lines[0], /^conversations file not saved: /);
  });

  it("rewrites the file for a known conversation at most once an hour", () => {
    const file = join(dir, "hourly.json");
    let now = Date.parse("2025-10-16T21:05:00Z");
    const c = new Conversations({ file, now: () => now });
    const stored = () => JSON.parse(readFileSync(file, "utf8")).conversations["slack:C1:1760648700.000100"];
    c.note(event(), "U000ME");
    const first = now;
    now += 59 * 60 * 1000;
    c.note(event(), "U000ME");
    assert.equal(stored(), first);
    now += 60 * 1000;
    c.note(event(), "U000ME");
    assert.equal(stored(), now);
  });

  it("names the dry-run state apart", () => {
    assert.match(conversationsFilePath("/h", false), /bridge-conversations\.json$/);
    assert.match(conversationsFilePath("/h", true), /bridge-conversations\.dry-run\.json$/);
  });
});
