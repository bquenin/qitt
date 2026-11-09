import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { Conversations } from "../lib/conversations.mjs";
import { Muted, writeMuted } from "../lib/muted.mjs";
import { ThreadTracker } from "../lib/filter.mjs";
import { Directory } from "../lib/normalize.mjs";
import { createPipeline } from "../lib/pipeline.mjs";
import { cfg, message, slackStub } from "./helpers.mjs";

const setup = (client = slackStub(), overrides = {}, muted = undefined) => {
  const added = [];
  const lines = [];
  const config = cfg(overrides);
  const handle = createPipeline({
    cfg: config,
    threads: new ThreadTracker({ me: config.me, client }),
    directory: new Directory({ client }),
    batcher: { add: (e) => added.push(e) },
    muted,
    log: (line) => lines.push(line),
  });
  let n = 0;
  const envelope = (event, eventId = `Ev${++n}`) => ({ type: "event_callback", event_id: eventId, event });
  return { added, handle, envelope, client, lines };
};

describe("pipeline", () => {
  it("batches a kept event once, deduped by event_id", async () => {
    const { added, handle, envelope } = setup();
    const env = envelope(message({ channel: "D000DM", channel_type: "im" }), "Ev000A");
    assert.equal(await handle(env), "im");
    assert.equal(await handle(env), "duplicate event");
    assert.equal(added.length, 1);
    assert.equal(added[0].id, "slack:D000DM:1760648700.000100");
  });

  it("dedupes the same message delivered under two event ids", async () => {
    const { added, handle, envelope } = setup();
    const event = message({ text: "<@U000ME> hi" });
    assert.equal(await handle(envelope(event)), "mentions me");
    assert.equal(await handle(envelope(event)), "duplicate message");
    assert.equal(added.length, 1);
  });

  it("learns my threads from my own (dropped) messages", async () => {
    const { added, handle, envelope, client } = setup();
    assert.equal(await handle(envelope(message({ user: "U000ME", ts: "1760648000.000100" }))), "from me");
    assert.equal(await handle(envelope(message({ ts: "1760648800.000100", thread_ts: "1760648000.000100" }))), "my thread");
    assert.equal(added.length, 1);
    assert.equal(added[0].source_key, "slack:C000TEAM:1760648000.000100");
    assert.equal(client.calls["conversations.replies"], undefined);
  });

  it("reports a reply whose thread lookup failed, without batching it", async () => {
    const { added, handle, envelope } = setup(slackStub({ fail: ["conversations.replies"] }));
    assert.equal(await handle(envelope(message({ ts: "1760648800.000100", thread_ts: "1760648000.000100" }))), "thread lookup failed");
    assert.equal(added.length, 0);
  });

  it("skips non-message events, drops, and unrelated messages", async () => {
    const { added, handle, envelope } = setup();
    assert.equal(await handle(envelope({ type: "reaction_added" })), "not a message");
    assert.equal(await handle(envelope(message({ subtype: "message_changed" }))), "subtype message_changed");
    assert.equal(await handle(envelope(message())), "not relevant");
    assert.equal(added.length, 0);
  });

  describe("support channels", () => {
    const support = (fields) => message({ channel: "C000SUPPORT", ...fields });
    const supportSetup = (client) => setup(client, { supportChannels: ["C000SUPPORT"] });

    it("drops and logs a group mention", async () => {
      const { added, handle, envelope, lines } = supportSetup();
      assert.equal(await handle(envelope(support({ text: "<!subteam^S000GROUP|@team> help" }))), "support channel");
      assert.equal(added.length, 0);
      assert.deepEqual(lines, ["dropped slack:C000SUPPORT:1760648700.000100: support channel (mentions group)"]);
    });

    it("keeps a reply in a thread I posted in, flagged support_channel", async () => {
      const { added, handle, envelope, lines, client } = supportSetup();
      assert.equal(await handle(envelope(support({ user: "U000ME", ts: "1760648000.000100" }))), "from me");
      assert.equal(await handle(envelope(support({ ts: "1760648800.000100", thread_ts: "1760648000.000100" }))), "my thread");
      assert.equal(added.length, 1);
      assert.equal(added[0].support_channel, true);
      assert.equal(added[0].source_key, "slack:C000SUPPORT:1760648000.000100");
      assert.deepEqual(lines, []);
      assert.equal(client.calls["conversations.replies"], undefined);
    });

    it("asks Slack whether a reply's thread is mine", async () => {
      const { added, handle, envelope } = supportSetup(slackStub({ replies: [{ user: "U000ME" }] }));
      assert.equal(await handle(envelope(support({ ts: "1760648900.000100", thread_ts: "1760648000.000100" }))), "my thread");
      assert.equal(added.length, 1);
    });

    it("drops other messages without asking Slack, and replies in other threads, without logging", async () => {
      const client = slackStub({ replies: [{ user: "U000OTHER" }] });
      const { added, handle, envelope, lines } = supportSetup(client);
      assert.equal(await handle(envelope(support({}))), "support channel");
      assert.equal(client.calls["conversations.replies"], undefined);
      assert.equal(await handle(envelope(support({ ts: "1760648900.000100", thread_ts: "1760648000.000100" }))), "support channel");
      assert.equal(added.length, 0);
      assert.deepEqual(lines, []);
    });

    it("drops and logs a group mention in a reply outside my threads", async () => {
      const { added, handle, envelope, lines } = supportSetup(slackStub({ replies: [{ user: "U000OTHER" }] }));
      const reply = support({ ts: "1760648900.000100", thread_ts: "1760648000.000100", text: "<!subteam^S000GROUP> help" });
      assert.equal(await handle(envelope(reply)), "support channel");
      assert.equal(added.length, 0);
      assert.deepEqual(lines, ["dropped slack:C000SUPPORT:1760648900.000100: support channel (mentions group)"]);
    });

    it("keeps a message that mentions me", async () => {
      const { added, handle, envelope, lines } = supportSetup();
      assert.equal(await handle(envelope(support({ text: "<!subteam^S000GROUP> <@U000ME> help" }))), "mentions me");
      assert.equal(added.length, 1);
      assert.equal(added[0].mentions_me, true);
      assert.deepEqual(lines, []);
    });

    it("wins over watchChannels", async () => {
      const { added, handle, envelope } = setup(slackStub(), { supportChannels: ["C000WATCH"] });
      assert.equal(await handle(envelope(message({ channel: "C000WATCH" }))), "support channel");
      assert.equal(added.length, 0);
    });
  });

  describe("muted conversations", () => {
    const mutedSetup = (keys) => {
      const file = join(mkdtempSync(join(tmpdir(), "qitt-pipeline-muted-")), "muted.json");
      after(() => rmSync(file, { force: true }));
      writeMuted(file, new Map(keys.map((k) => [k, { at: "2025-10-16T21:00:00.000Z" }])));
      return setup(slackStub(), {}, new Muted({ file }));
    };

    it("drops replies in a muted thread of mine, and logs why", async () => {
      const { added, handle, envelope, lines } = mutedSetup(["slack:C000TEAM:1760648000.000100"]);
      assert.equal(await handle(envelope(message({ user: "U000ME", ts: "1760648000.000100" }))), "from me");
      assert.equal(await handle(envelope(message({ ts: "1760648800.000100", thread_ts: "1760648000.000100" }))), "muted");
      assert.equal(await handle(envelope(message({ ts: "1760648900.000100", thread_ts: "1760648000.000100", text: "<!subteam^S000GROUP> ping" }))), "muted");
      assert.deepEqual(lines, [
        "dropped slack:C000TEAM:1760648800.000100: muted slack:C000TEAM:1760648000.000100 (my thread)",
        "dropped slack:C000TEAM:1760648900.000100: muted slack:C000TEAM:1760648000.000100 (mentions group)",
      ]);
      assert.equal(added.length, 0);
    });

    it("still sends a message in a muted thread that mentions me", async () => {
      const { added, handle, envelope } = mutedSetup(["slack:C000TEAM:1760648000.000100"]);
      assert.equal(await handle(envelope(message({ ts: "1760648800.000100", thread_ts: "1760648000.000100", text: "<@U000ME> over to you" }))), "mentions me");
      assert.equal(added.length, 1);
    });

    it("still sends a direct mention in a muted DM or watched channel", async () => {
      const { added, handle, envelope } = mutedSetup(["slack:D000DM", "slack:C000WATCH"]);
      assert.equal(await handle(envelope(message({ channel: "D000DM", channel_type: "im", text: "<@U000ME> need you" }))), "im");
      assert.equal(await handle(envelope(message({ channel: "C000WATCH", text: "<@U000ME> need you" }))), "watched channel");
      assert.equal(await handle(envelope(message({ channel: "C000WATCH", ts: "1760648900.000100" }))), "muted");
      assert.equal(added.length, 2);
    });

    it("drops a whole muted DM, and leaves other conversations alone", async () => {
      const { added, handle, envelope } = mutedSetup(["slack:D000DM"]);
      assert.equal(await handle(envelope(message({ channel: "D000DM", channel_type: "im" }))), "muted");
      assert.equal(await handle(envelope(message({ channel: "D000OTHER", channel_type: "im" }))), "im");
      assert.equal(added.length, 1);
      assert.equal(added[0].id, "slack:D000OTHER:1760648700.000100");
    });
  });

  describe("my replies", () => {
    const dir = mkdtempSync(join(tmpdir(), "qitt-pipeline-replies-"));
    after(() => rmSync(dir, { recursive: true, force: true }));
    const repliesSetup = (muted, client = slackStub()) => {
      const added = [];
      const lines = [];
      const config = cfg();
      const conversations = new Conversations();
      const handle = createPipeline({
        cfg: config,
        threads: new ThreadTracker({ me: config.me, client }),
        directory: new Directory({ client }),
        batcher: { add: (e) => added.push(e) },
        muted,
        conversations,
        log: (line) => lines.push(line),
      });
      let n = 0;
      const envelope = (event) => ({ type: "event_callback", event_id: `Ev${++n}`, event });
      return { added, lines, handle, envelope };
    };
    const theirs = message({ text: "<@U000ME> can you look?", ts: "1760648000.000100" });
    const mine = (fields) => message({ user: "U000ME", text: "done", ts: "1760648800.000100", thread_ts: "1760648000.000100", ...fields });

    it("sends my reply in a thread qitt heard about right away, once", async () => {
      const { added, lines, handle, envelope } = repliesSetup();
      assert.equal(await handle(envelope(theirs)), "mentions me");
      assert.equal(await handle(envelope(mine())), "my reply");
      assert.equal(await handle(envelope(mine())), "duplicate message");
      assert.equal(added.length, 2);
      assert.equal(added[1].my_reply, true);
      assert.equal(added[1].source_key, "slack:C000TEAM:1760648000.000100");
      assert.deepEqual(lines, ["my reply slack:C000TEAM:1760648800.000100"]);
    });

    it("knows a conversation while its first message is still being looked up", async () => {
      const client = slackStub();
      let release;
      const gate = new Promise((resolve) => (release = resolve));
      const usersInfo = client.users.info;
      client.users.info = async (args) => (args.user === "U000OTHER" && (await gate), usersInfo(args));
      const { added, handle, envelope } = repliesSetup(undefined, client);
      const first = handle(envelope(theirs));
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(added.length, 0);
      assert.equal(await handle(envelope(mine())), "my reply");
      release();
      assert.equal(await first, "mentions me");
      assert.equal(added.length, 2);
    });

    it("drops my messages in conversations qitt never heard about, and edits or deletes", async () => {
      const { added, handle, envelope } = repliesSetup();
      assert.equal(await handle(envelope(mine())), "from me");
      assert.equal(await handle(envelope(mine({ ts: "1760648000.000100", thread_ts: undefined }))), "from me");
      assert.equal(await handle(envelope(theirs)), "mentions me");
      assert.equal(await handle(envelope(mine({ ts: "1760648900.000100", subtype: "message_changed" }))), "from me");
      assert.equal(await handle(envelope(mine({ ts: "1760649000.000100", subtype: "message_deleted", text: "" }))), "from me");
      assert.equal(added.length, 1);
    });

    it("treats a whole DM as one conversation", async () => {
      const { added, handle, envelope } = repliesSetup();
      const dm = { channel: "D000DM", channel_type: "im" };
      assert.equal(await handle(envelope(message({ ...dm, ts: "1760648000.000100" }))), "im");
      assert.equal(await handle(envelope(mine({ ...dm, thread_ts: undefined }))), "my reply");
      assert.equal(added.length, 2);
    });

    it("drops my reply in a muted conversation", async () => {
      const file = join(dir, "muted.json");
      writeMuted(file, new Map([["slack:C000TEAM:1760648000.000100", { at: "2025-10-16T21:00:00Z" }]]));
      const { added, handle, envelope } = repliesSetup(new Muted({ file }));
      assert.equal(await handle(envelope(theirs)), "mentions me");
      assert.equal(await handle(envelope(mine())), "from me");
      assert.equal(added.length, 1);
    });
  });
});
