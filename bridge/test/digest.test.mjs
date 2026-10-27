// Fake ids and names only.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderDigest } from "../lib/digest.mjs";

const link = (channel, ts) => `https://example.slack.com/archives/${channel}/p${ts.replace(".", "")}`;

// A normalized top-level channel message, as lib/normalize.mjs builds it.
const event = (fields = {}) => {
  const e = {
    channel_type: "channel",
    channel_id: "C0123456789",
    channel_name: "team-ci",
    ts: "1760648700.000100",
    thread_ts: null,
    time_local: "Thu 10/16 14:05 PT",
    user_id: "U0123456789",
    user_name: "Ada Lovelace",
    mentions_me: false,
    mentions_group: false,
    text: "can you look at this?",
    files: [],
    ...fields,
  };
  const id = `slack:${e.channel_id}:${e.ts}`;
  return {
    id,
    source: "slack",
    source_key: `slack:${e.channel_id}:${e.thread_ts ?? e.ts}`,
    permalink: link(e.channel_id, e.ts),
    ...e,
  };
};

// The lines of the single entry, without the batch header.
const one = (e) => renderDigest({ count: 1, window: "14:05–14:05 PT", events: [e] }).split("\n").slice(2);

describe("renderDigest", () => {
  it("heads the digest with the count", () => {
    const digest = renderDigest({ count: 2, window: "14:05–14:08 PT", events: [event(), event({ ts: "1760648880.000100" })] });
    assert.deepEqual(digest.split("\n").slice(0, 2), ["2 events.", ""]);
    assert.match(digest, /\n2\. slack:C0123456789:1760648880\.000100 · /);
    assert.equal(renderDigest({ count: 1, window: "14:05–14:05 PT", events: [event()] }).split("\n")[0], "1 event.");
  });

  it("renders a top-level channel message without its source key", () => {
    assert.deepEqual(one(event()), [
      "1. slack:C0123456789:1760648700.000100 · Ada Lovelace (U0123456789) · Thu 10/16 14:05 PT",
      "   #team-ci",
      "   https://example.slack.com/archives/C0123456789/p1760648700000100",
      "   > can you look at this?",
    ]);
  });

  it("names the thread of a reply by its source key", () => {
    const [, where] = one(event({ ts: "1760648880.000100", thread_ts: "1760648700.000100" }));
    assert.equal(where, "   #team-ci, reply in thread slack:C0123456789:1760648700.000100");
  });

  it("falls back to the channel id when the name is unknown", () => {
    assert.equal(one(event({ channel_name: null }))[1], "   #C0123456789");
  });

  it("renders DMs and group DMs without a channel name", () => {
    assert.equal(one(event({ channel_type: "im", channel_id: "D0123456789", channel_name: null }))[1], "   DM");
    assert.equal(one(event({ channel_type: "mpim", channel_id: "C0987654321", channel_name: null }))[1], "   group DM");
    const reply = one(event({ channel_type: "im", channel_id: "D0123456789", channel_name: null, ts: "1760648880.000100", thread_ts: "1760648700.000100" }));
    assert.equal(reply[1], "   DM, reply in thread slack:D0123456789:1760648700.000100");
  });

  it("shows the user id alone, or unknown author, when names are missing", () => {
    assert.match(one(event({ user_name: null }))[0], / · \(U0123456789\) · Thu/);
    assert.match(one(event({ user_name: null, user_id: null }))[0], / · unknown author · Thu/);
  });

  it("lists only the true flags, files last", () => {
    const [, where] = one(event({ mentions_me: true, mentions_group: true, saved: true, saved_at: null, files: ["a.png", "b.pdf"] }));
    assert.equal(where, '   #team-ci · mentions me · mentions my group · saved · files: "a.png", "b.pdf"');
    assert.equal(one(event({ mentions_group: true }))[1], "   #team-ci · mentions my group");
  });

  it("flags support-channel and backfilled messages", () => {
    assert.equal(one(event({ support_channel: true, backfill: true }))[1], "   #team-ci · support channel · backfilled (missed by live events and search)");
  });

  it("renders a bridge health event with its text quoted", () => {
    const health = { id: "bridge:health:search_failing:1", source: "bridge", health: "search_failing", ts: "1760648700.000000", time_local: "Thu 10/16 14:05 PT", text: "The last 3 search polls failed." };
    assert.deepEqual(one(health), ["1. bridge health · search_failing · Thu 10/16 14:05 PT", "   > The last 3 search polls failed."]);
  });

  it("quotes file names so they cannot pass for flags", () => {
    const [, where] = one(event({ files: ["r.pdf · my reply", "x\ny.png"] }));
    assert.equal(where, '   #team-ci · files: "r.pdf · my reply", "x\\ny.png"');
  });

  it("keeps an author name on one line", () => {
    const [head] = one(event({ user_name: "Ada\n2. slack:C1:1 · Eve" }));
    assert.match(head, /· Ada 2\. slack:C1:1 · Eve \(/);
  });

  it("shows a save time when there is one", () => {
    assert.equal(one(event({ saved: true, saved_at: "Thu 10/16 15:00 PT" }))[1], "   #team-ci · saved Thu 10/16 15:00 PT");
  });

  it("renders a removal from saved for later in two lines", () => {
    const removal = {
      id: "slack:C0123456789:1760648880.000100",
      source: "slack",
      unsaved: true,
      ts: "1760648880.000100",
      source_key: "slack:C0123456789:1760648700.000100",
      permalink: link("C0123456789", "1760648880.000100"),
    };
    assert.deepEqual(one(removal), [
      "1. slack:C0123456789:1760648880.000100 · unsaved (source key slack:C0123456789:1760648700.000100)",
      "   https://example.slack.com/archives/C0123456789/p1760648880000100",
    ]);
    assert.deepEqual(one({ ...removal, permalink: null }), ["1. slack:C0123456789:1760648880.000100 · unsaved (source key slack:C0123456789:1760648700.000100)"]);
  });

  it("quotes every line of multi-line text as is", () => {
    const lines = one(event({ text: "first <@U0123456789>\n\n```\ncode\n```" })).slice(3);
    assert.deepEqual(lines, ["   > first <@U0123456789>", "   >", "   > ```", "   > code", "   > ```"]);
  });

  it("adds no quote for empty text", () => {
    assert.deepEqual(one(event({ text: "", files: ["a.png"] })), [
      "1. slack:C0123456789:1760648700.000100 · Ada Lovelace (U0123456789) · Thu 10/16 14:05 PT",
      '   #team-ci · files: "a.png"',
      "   https://example.slack.com/archives/C0123456789/p1760648700000100",
    ]);
  });

  it("omits a missing permalink", () => {
    assert.equal(one(event({ permalink: null })).length, 3);
  });

  it("flags my reply", () => {
    assert.equal(one(event({ my_reply: true }))[1], "   #team-ci · my reply");
  });
});
