import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Directory, normalize } from "../lib/normalize.mjs";
import { configureTime, timeLocal, tsDate, windowLocal } from "../lib/time.mjs";
import { cfg, message, slackStub } from "./helpers.mjs";

configureTime({ timezone: "America/Los_Angeles" });

const run = (event, client = slackStub()) => normalize(event, cfg(), new Directory({ client }));

describe("normalize", () => {
  it("normalizes a thread root", async () => {
    const event = message({ text: "<@U000ME> can you look", ts: "1760648700.000100" });
    assert.deepEqual(await run(event), {
      id: "slack:C000TEAM:1760648700.000100",
      source: "slack",
      channel_type: "channel",
      channel_id: "C000TEAM",
      channel_name: "name-of-C000TEAM",
      ts: "1760648700.000100",
      thread_ts: null,
      source_key: "slack:C000TEAM:1760648700.000100",
      time_local: "Thu 10/16 14:05 PT",
      user_id: "U000OTHER",
      user_name: "disp-U000OTHER",
      mentions_me: true,
      mentions_group: false,
      text: "<@U000ME> can you look",
      permalink: "https://example.invalid/C000TEAM/1760648700.000100",
      files: [],
    });
  });

  it("keys a reply by its thread root", async () => {
    const n = await run(message({ ts: "1760648800.000200", thread_ts: "1760648700.000100" }));
    assert.equal(n.id, "slack:C000TEAM:1760648800.000200");
    assert.equal(n.thread_ts, "1760648700.000100");
    assert.equal(n.source_key, "slack:C000TEAM:1760648700.000100");
  });

  it("treats thread_ts equal to ts as a root", async () => {
    const n = await run(message({ thread_ts: "1760648700.000100" }));
    assert.equal(n.thread_ts, null);
    assert.equal(n.source_key, "slack:C000TEAM:1760648700.000100");
  });

  it("flags group mentions in both forms", async () => {
    assert.equal((await run(message({ text: "<!subteam^S000GROUP> ping" }))).mentions_group, true);
    assert.equal((await run(message({ text: "<!subteam^S000GROUP|@team> ping" }))).mentions_group, true);
    assert.equal((await run(message({ text: "<!subteam^S000GROUP|@team> ping" }))).mentions_me, false);
  });

  it("leaves channel_name null for DMs without asking Slack", async () => {
    const client = slackStub();
    const n = await run(message({ channel: "D000DM", channel_type: "im" }), client);
    assert.equal(n.channel_name, null);
    assert.equal(client.calls["conversations.info"], undefined);
    assert.equal((await run(message({ channel: "G000MPIM", channel_type: "mpim" }))).channel_name, null);
  });

  it("falls back to real_name and lists file names", async () => {
    const n = await run(message({ user: "U000NODISPLAY", text: "", subtype: "file_share", files: [{ name: "a.png" }, { title: "b" }] }));
    assert.equal(n.user_name, "Real U000NODISPLAY");
    assert.deepEqual(n.files, ["a.png", "b"]);
  });

  it("caches users, channels, and permalinks", async () => {
    const client = slackStub();
    const directory = new Directory({ client });
    await normalize(message(), cfg(), directory);
    await normalize(message(), cfg(), directory);
    await normalize(message({ ts: "1760648800.000200" }), cfg(), directory);
    assert.equal(client.calls["users.info"].length, 1);
    assert.equal(client.calls["conversations.info"].length, 1);
    assert.equal(client.calls["chat.getPermalink"].length, 2);
  });

  it("yields null for failed lookups", async () => {
    const lines = [];
    const client = slackStub({ fail: ["chat.getPermalink", "users.info", "conversations.info"] });
    const n = await normalize(message(), cfg(), new Directory({ client, log: (l) => lines.push(l) }));
    assert.equal(n.permalink, null);
    assert.equal(n.user_name, null);
    assert.equal(n.channel_name, null);
    assert.equal(lines.length, 3);
  });

  it("caches a missing-scope failure but retries other failures", async () => {
    const client = slackStub();
    client.conversations.info = async () => {
      (client.calls["conversations.info"] ??= []).push(1);
      throw Object.assign(new Error("scope"), { data: { error: "missing_scope" } });
    };
    const directory = new Directory({ client });
    await normalize(message(), cfg(), directory);
    await normalize(message({ ts: "1760648800.000300" }), cfg(), directory);
    assert.equal(client.calls["conversations.info"].length, 1);

    const flaky = slackStub({ fail: ["users.info"] });
    const retrying = new Directory({ client: flaky });
    await normalize(message(), cfg(), retrying);
    await normalize(message({ ts: "1760648800.000400" }), cfg(), retrying);
    assert.equal(flaky.calls["users.info"].length, 2);
  });
});

describe("time labels", () => {
  it("formats America/Los_Angeles time across DST", () => {
    assert.equal(timeLocal(tsDate("1760648700.000100")), "Thu 10/16 14:05 PT");
    assert.equal(timeLocal(tsDate("1765000800")), "Fri 12/5 22:00 PT");
    assert.equal(timeLocal(tsDate("1760598000")), "Thu 10/16 00:00 PT");
  });
  it("formats a window", () => assert.equal(windowLocal(tsDate("1760648700"), tsDate("1760648880")), "14:05–14:08 PT"));
});
