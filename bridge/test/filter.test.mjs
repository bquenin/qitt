import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { dropReason, keepReason, mentions, supportDrop, ThreadTracker } from "../lib/filter.mjs";
import { cfg, message, slackStub } from "./helpers.mjs";

const keep = (event, config = cfg(), client = slackStub()) =>
  keepReason(event, config, new ThreadTracker({ me: config.me, client }));

describe("dropReason", () => {
  it("drops my own messages", () => assert.equal(dropReason(message({ user: "U000ME" }), cfg()), "from me"));
  it("drops bot messages by bot_id", () => assert.equal(dropReason(message({ bot_id: "B000BOT" }), cfg()), "bot"));
  it("drops bot_message subtype", () => assert.equal(dropReason(message({ subtype: "bot_message", user: undefined }), cfg()), "bot"));
  it("keeps bot messages when ignoreBots is false", () => {
    const config = cfg({ ignoreBots: false });
    assert.equal(dropReason(message({ bot_id: "B000BOT" }), config), undefined);
    assert.equal(dropReason(message({ subtype: "bot_message", bot_id: "B000BOT" }), config), undefined);
  });
  for (const subtype of ["message_changed", "message_deleted", "channel_join", "group_join", "channel_topic"]) {
    it(`drops subtype ${subtype}`, () => assert.equal(dropReason(message({ subtype }), cfg()), `subtype ${subtype}`));
  }
  it("keeps plain, thread_broadcast and file_share messages", () => {
    assert.equal(dropReason(message(), cfg()), undefined);
    assert.equal(dropReason(message({ subtype: "thread_broadcast", thread_ts: "1.0" }), cfg()), undefined);
    assert.equal(dropReason(message({ subtype: "file_share", files: [{ name: "a.png" }] }), cfg()), undefined);
  });
  it("drops empty text without files", () => {
    assert.equal(dropReason(message({ text: "" }), cfg()), "empty");
    assert.equal(dropReason(message({ text: "  " }), cfg()), "empty");
    assert.equal(dropReason(message({ text: undefined }), cfg()), "empty");
  });
  it("keeps empty text with files", () => assert.equal(dropReason(message({ text: "", files: [{ name: "a.png" }] }), cfg()), undefined));
});

describe("supportDrop", () => {
  const config = cfg({ supportChannels: ["C000SUPPORT"], watchChannels: ["C000SUPPORT"] });
  const inSupport = (fields) => supportDrop(message({ channel: "C000SUPPORT", ...fields }), config);
  it("drops top-level group mentions and plain messages in a support channel", () => {
    assert.equal(inSupport({ text: "<!subteam^S000GROUP|@team> help" }), "support channel");
    assert.equal(inSupport({}), "support channel");
  });
  it("leaves replies to keepReason", () => {
    assert.equal(inSupport({ ts: "1760648800.000100", thread_ts: "1760648000.000100" }), undefined);
  });
  it("keeps a personal mention in a support channel", () => {
    assert.equal(inSupport({ text: "<@U000ME> can you look" }), undefined);
    assert.equal(inSupport({ text: "<!subteam^S000GROUP> and <@U000ME|me>" }), undefined);
  });
  it("leaves other channels alone", () => {
    assert.equal(supportDrop(message({ text: "<!subteam^S000GROUP> help" }), config), undefined);
    assert.equal(supportDrop(message({ channel: "C000SUPPORT" }), cfg()), undefined);
  });
});

describe("mentions", () => {
  it("detects me in both forms", () => {
    assert.equal(mentions("hey <@U000ME> look", cfg()).me, true);
    assert.equal(mentions("hey <@U000ME|me> look", cfg()).me, true);
    assert.equal(mentions("hey <@U000MEX>", cfg()).me, false);
    assert.equal(mentions("U000ME", cfg()).me, false);
  });
  it("detects my groups in both forms", () => {
    assert.equal(mentions("<!subteam^S000GROUP> ping", cfg()).group, true);
    assert.equal(mentions("<!subteam^S000GROUP|@team> ping", cfg()).group, true);
    assert.equal(mentions("<!subteam^S000OTHER|@other> ping", cfg()).group, false);
    assert.equal(mentions(undefined, cfg()).group, false);
  });
});

describe("keepReason", () => {
  it("keeps DMs and group DMs", async () => {
    assert.equal(await keep(message({ channel: "D000DM", channel_type: "im" })), "im");
    assert.equal(await keep(message({ channel: "G000MPIM", channel_type: "mpim" })), "mpim");
  });
  it("keeps any message in a watched channel", async () => assert.equal(await keep(message({ channel: "C000WATCH" })), "watched channel"));
  it("keeps channel and private channel mentions", async () => {
    assert.equal(await keep(message({ text: "<@U000ME> hi" })), "mentions me");
    assert.equal(await keep(message({ channel_type: "group", text: "<!subteam^S000GROUP|@team> hi" })), "mentions group");
  });
  it("skips unrelated channel messages without asking Slack", async () => {
    const client = slackStub();
    assert.equal(await keep(message(), cfg(), client), undefined);
    assert.equal(client.calls["conversations.replies"], undefined);
  });
  it("skips replies in threads I am not in", async () => {
    const client = slackStub({ replies: [{ user: "U000OTHER" }] });
    assert.equal(await keep(message({ thread_ts: "1760648000.000100" }), cfg(), client), undefined);
  });
  it("leaves a reply undecided (null) when the thread lookup fails", async () => {
    const client = slackStub({ fail: ["conversations.replies"] });
    assert.equal(await keep(message({ thread_ts: "1760648000.000100" }), cfg(), client), null);
  });
  describe("in a support channel", () => {
    const config = cfg({ supportChannels: ["C000WATCH"] });
    const reply = (fields) => message({ channel: "C000WATCH", ts: "1760648800.000100", thread_ts: "1760648000.000100", ...fields });
    it("keeps a reply in my thread and a mention of me", async () => {
      assert.equal(await keep(reply(), config, slackStub({ replies: [{ user: "U000ME" }] })), "my thread");
      assert.equal(await keep(reply({ text: "<@U000ME> look" }), config), "mentions me");
    });
    it("skips other replies, even watched or with a group mention", async () => {
      const client = slackStub({ replies: [{ user: "U000OTHER" }] });
      assert.equal(await keep(reply(), config, client), undefined);
      assert.equal(await keep(reply({ text: "<!subteam^S000GROUP> help" }), config, client), undefined);
    });
  });
});

describe("ThreadTracker", () => {
  const reply = (fields = {}) => message({ ts: "1760648800.000100", thread_ts: "1760648000.000100", ...fields });

  it("keeps replies in a thread I posted in, learned from my own event", async () => {
    const client = slackStub();
    const threads = new ThreadTracker({ me: "U000ME", client });
    threads.noteMine(message({ user: "U000ME", ts: "1760648000.000100" }));
    assert.equal(await keepReason(reply(), cfg(), threads), "my thread");
    assert.equal(client.calls["conversations.replies"], undefined);
  });

  it("learns from my reply too (thread_ts, not ts)", async () => {
    const threads = new ThreadTracker({ me: "U000ME", client: slackStub() });
    threads.noteMine(reply({ user: "U000ME", ts: "1760648700.000900" }));
    assert.equal(await threads.participated("C000TEAM", "1760648000.000100"), true);
  });

  it("asks conversations.replies once per thread on a miss and caches the answer", async () => {
    const client = slackStub({ replies: [{ user: "U000OTHER" }, { user: "U000ME" }] });
    const threads = new ThreadTracker({ me: "U000ME", client });
    assert.equal(await keepReason(reply(), cfg(), threads), "my thread");
    assert.equal(await keepReason(reply({ ts: "1760648900.000100" }), cfg(), threads), "my thread");
    assert.deepEqual(client.calls["conversations.replies"], [{ channel: "C000TEAM", ts: "1760648000.000100", limit: 200 }]);
  });

  it("caches a negative answer", async () => {
    const client = slackStub({ replies: [{ user: "U000OTHER" }] });
    const threads = new ThreadTracker({ me: "U000ME", client });
    assert.equal(await threads.participated("C000TEAM", "1.0"), false);
    assert.equal(await threads.participated("C000TEAM", "1.0"), false);
    assert.equal(client.calls["conversations.replies"].length, 1);
  });

  it("coalesces concurrent lookups", async () => {
    const client = slackStub({ replies: [{ user: "U000ME" }] });
    const threads = new ThreadTracker({ me: "U000ME", client });
    const answers = await Promise.all([threads.participated("C000TEAM", "1.0"), threads.participated("C000TEAM", "1.0")]);
    assert.deepEqual(answers, [true, true]);
    assert.equal(client.calls["conversations.replies"].length, 1);
  });

  it("gives every waiting caller the participation noted while the lookup was pending", async () => {
    let finish;
    const client = {
      conversations: { replies: () => new Promise((resolve) => (finish = resolve)) },
    };
    const threads = new ThreadTracker({ me: "U000ME", client });
    const first = threads.participated("C000TEAM", "1.0");
    const second = threads.participated("C000TEAM", "1.0");
    threads.noteMine(message({ user: "U000ME", ts: "1.0" }));
    finish({ messages: [{ user: "U000OTHER" }] });
    assert.deepEqual(await Promise.all([first, second]), [true, true]);
    assert.equal(await threads.participated("C000TEAM", "1.0"), true);
  });

  it("handles a failed lookup for every waiting caller", async () => {
    const client = slackStub({ fail: ["conversations.replies"] });
    const threads = new ThreadTracker({ me: "U000ME", client });
    const answers = await Promise.all([threads.participated("C000TEAM", "1.0"), threads.participated("C000TEAM", "1.0")]);
    assert.deepEqual(answers, [null, null]);
  });

  it("reads every page of a long thread before deciding", async () => {
    const pages = [
      { messages: [{ user: "U000OTHER" }], response_metadata: { next_cursor: "p2" } },
      { messages: [{ user: "U000OTHER" }], response_metadata: { next_cursor: "p3" } },
      { messages: [{ user: "U000ME" }], response_metadata: { next_cursor: "" } },
    ];
    const calls = [];
    const client = { conversations: { replies: async (args) => (calls.push(args), pages[calls.length - 1]) } };
    const threads = new ThreadTracker({ me: "U000ME", client });
    assert.equal(await threads.participated("C000TEAM", "1.0"), true);
    assert.deepEqual(calls.map((c) => c.cursor), [undefined, "p2", "p3"]);
  });

  it("keeps replies in a thread too long to scan, without caching the answer", async () => {
    let calls = 0;
    const lines = [];
    const client = { conversations: { replies: async () => (calls++, { messages: [{ user: "U000OTHER" }], response_metadata: { next_cursor: "more" } }) } };
    const threads = new ThreadTracker({ me: "U000ME", client, maxPages: 2, log: (l) => lines.push(l) });
    assert.equal(await threads.participated("C000TEAM", "1.0"), true);
    assert.equal(await threads.participated("C000TEAM", "1.0"), true);
    assert.equal(calls, 4);
    assert.match(lines[0], /longer than 2 pages; keeping the reply/);
  });

  it("treats a failed lookup as unknown, logs it, and retries later", async () => {
    const lines = [];
    const client = slackStub({ fail: ["conversations.replies"] });
    const threads = new ThreadTracker({ me: "U000ME", client, log: (l) => lines.push(l) });
    assert.equal(await threads.participated("C000TEAM", "1.0"), null);
    assert.equal(await threads.participated("C000TEAM", "1.0"), null);
    assert.equal(client.calls["conversations.replies"].length, 2);
    assert.match(lines[0], /conversations\.replies failed: fake_error/);
  });
});
