import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { Delivered } from "../lib/delivered.mjs";
import { Conversations } from "../lib/conversations.mjs";
import { ThreadTracker } from "../lib/filter.mjs";
import { Directory } from "../lib/normalize.mjs";
import { createPipeline } from "../lib/pipeline.mjs";
import { matchEvent, SearchPoller, searchQueries, searchStatePath } from "../lib/search.mjs";
import { cfg, slackStub } from "./helpers.mjs";

const now = Date.parse("2025-10-16T21:05:00Z"); // Thu 10/16 14:05 PT
const at = (minutesAgo, n = 100) => `${Math.floor(now / 1000 - minutesAgo * 60)}.000${n}`;

const channels = {
  C000TEAM: { id: "C000TEAM", name: "team", is_channel: true },
  C000PRIV: { id: "C000PRIV", name: "priv", is_private: true },
  D000DM: { id: "D000DM", name: "U000OTHER", is_im: true, is_private: true },
  C000MPIM: { id: "C000MPIM", name: "mpdm-a--b-1", is_mpim: true, is_private: true },
  C000SUPPORT: { id: "C000SUPPORT", name: "support" },
};

// A search.messages match.
const match = (ts, { channel = "C000TEAM", thread_ts, ...fields } = {}) => ({
  channel: channels[channel],
  ts,
  user: "U000OTHER",
  text: `text ${ts}`,
  permalink: `https://example.invalid/archives/${channel}/p${ts.replace(".", "")}${thread_ts ? `?thread_ts=${thread_ts}&cid=${channel}` : ""}`,
  ...fields,
});

// slackStub plus search.messages serving results[query] in sort_dir order, paged by pageSize. An
// " after:<date>" suffix is accepted and ignored.
const client = ({ pageSize = 100, error, bots = [], replies = [], fail = [] } = {}) => {
  const c = slackStub({ replies, fail });
  c.results = {};
  c.search = {
    messages: async ({ query, page, count, sort_dir }) => {
      (c.calls["search.messages"] ??= []).push({ query, page, sort_dir });
      if (error) throw Object.assign(new Error("An API error occurred"), { data: { error } });
      const sign = sort_dir === "asc" ? -1 : 1;
      const all = [...(c.results[query.replace(/ after:\S+$/, "")] ?? [])].sort((a, b) => sign * (Number(b.ts) - Number(a.ts)));
      const size = Math.min(count, pageSize);
      const pages = Math.max(1, Math.ceil(all.length / size));
      return { messages: { matches: all.slice((page - 1) * size, page * size), paging: { page, pages } } };
    },
  };
  const info = c.users.info;
  c.users.info = async (args) => {
    const res = await info(args);
    return { user: { ...res.user, is_bot: bots.includes(args.user) } };
  };
  return c;
};

// Batched events are flushed (committed as delivered) at once unless flushLater.
const setup = ({ slack = client(), overrides = {}, stateFile = null, clock = () => now, delivered = new Delivered({ now: clock }), flushLater = false, maxPages, conversations } = {}) => {
  const config = cfg({ watchChannels: [], ...overrides });
  const added = [];
  const lines = [];
  const directory = new Directory({ client: slack });
  const handle = createPipeline({
    cfg: config,
    threads: new ThreadTracker({ me: config.me, client: slack }),
    directory,
    batcher: {
      add: (e) => {
        added.push(e);
        if (!flushLater) delivered.commit([e.id]);
      },
    },
    delivered,
    conversations,
  });
  const poller = new SearchPoller({ cfg: config, client: slack, directory, handle, delivered, stateFile, log: (l) => lines.push(l), now: clock, ...(maxPages && { maxPages }) });
  return { poller, slack, added, lines, handle, delivered };
};

describe("search intake", () => {
  const dir = mkdtempSync(join(tmpdir(), "qitt-search-test-"));
  after(() => rmSync(dir, { recursive: true, force: true }));

  it("queries DMs, mentions, groups, my threads, and watched channels", () => {
    assert.deepEqual(searchQueries(cfg({ watchChannels: ["C000WATCH"] })), [
      "is:dm",
      "<@U000ME>",
      "<!subteam^S000GROUP>",
      "is:thread with:<@U000ME>",
      "in:<#C000WATCH>",
    ]);
  });

  it("builds a live-shaped event from a match", () => {
    assert.deepEqual(matchEvent(match("1760648700.000100", { thread_ts: "1760648000.000100" })), {
      type: "message",
      channel: "C000TEAM",
      channel_type: "channel",
      channel_name: "team",
      user: "U000OTHER",
      text: "text 1760648700.000100",
      ts: "1760648700.000100",
      thread_ts: "1760648000.000100",
      permalink: "https://example.invalid/archives/C000TEAM/p1760648700000100?thread_ts=1760648000.000100&cid=C000TEAM",
      files: [],
    });
    assert.equal(matchEvent(match("1.1", { channel: "C000MPIM" })).channel_type, "mpim");
    assert.equal(matchEvent(match("1.1", { channel: "D000DM" })).channel_type, "im");
    assert.equal(matchEvent(match("1.1", { channel: "C000PRIV" })).channel_type, "group");
  });

  it("keeps what the filters keep, from every query, once each", async () => {
    const { poller, slack, added } = setup();
    const mention = match(at(3), { text: "<@U000ME> look" });
    slack.results = {
      "is:dm": [match(at(2), { channel: "D000DM" }), match(at(4), { channel: "C000MPIM" })],
      "<@U000ME>": [mention, match(at(5), { text: "about alice, not a mention" })],
      "<!subteam^S000GROUP>": [match(at(6), { text: "<!subteam^S000GROUP|@team> help" }), mention],
    };
    assert.deepEqual(await poller.poll(), { matched: 5, kept: 4, retry: 0 });
    assert.deepEqual(
      added.map((e) => [e.channel_type, e.channel_name, e.mentions_me, e.mentions_group]),
      [
        ["channel", "team", false, true],
        ["mpim", null, false, false],
        ["channel", "team", true, false],
        ["im", null, false, false],
      ],
    );
    // Names and permalinks come from the match, not from lookups.
    assert.equal(slack.calls["conversations.info"], undefined);
    assert.equal(slack.calls["chat.getPermalink"], undefined);
    assert.equal(added[2].permalink, mention.permalink);
  });

  it("keeps replies in my threads, learning them from my own replies", async () => {
    const { poller, slack, added } = setup();
    slack.results["is:thread with:<@U000ME>"] = [
      match(at(5, 1), { user: "U000ME", thread_ts: at(30) }),
      match(at(4, 2), { thread_ts: at(30) }),
    ];
    assert.deepEqual(await poller.poll(), { matched: 2, kept: 1, retry: 0 });
    assert.equal(added[0].source_key, `slack:C000TEAM:${at(30)}`);
    assert.equal(slack.calls["conversations.replies"], undefined);
  });

  it("drops bot matches and support-channel group mentions", async () => {
    const { poller, slack, added } = setup({ slack: client({ bots: ["B000BOT"] }), overrides: { supportChannels: ["C000SUPPORT"] } });
    slack.results = {
      "is:dm": [match(at(2), { channel: "D000DM", user: "B000BOT" })],
      "<!subteam^S000GROUP>": [match(at(3), { channel: "C000SUPPORT", text: "<!subteam^S000GROUP> help" })],
    };
    assert.deepEqual(await poller.poll(), { matched: 2, kept: 0, retry: 0 });
    assert.equal(added.length, 0);
  });

  it("does not resend what the live socket already delivered", async () => {
    const { poller, slack, added, handle } = setup();
    const dm = { type: "message", channel: "D000DM", channel_type: "im", user: "U000OTHER", text: "hi", ts: at(1) };
    assert.equal(await handle({ event_id: "Ev1", event: dm }), "im");
    slack.results["is:dm"] = [match(at(1), { channel: "D000DM" })];
    assert.deepEqual(await poller.poll(), { matched: 1, kept: 0, retry: 0 });
    assert.equal(added.length, 1);
  });

  it("does not resend a DM's history copied into a new group DM", async () => {
    const { poller, slack, added } = setup();
    slack.results["is:dm"] = [match(at(3), { channel: "D000DM" })];
    assert.deepEqual(await poller.poll(), { matched: 1, kept: 1, retry: 0 });
    // Someone was added to the DM: same author and ts, new channel.
    slack.results["is:dm"].push(match(at(3), { channel: "C000MPIM" }), match(at(2), { channel: "C000MPIM" }));
    assert.deepEqual(await poller.poll(), { matched: 2, kept: 1, retry: 0 });
    assert.deepEqual(added.map((e) => e.id), [`slack:D000DM:${at(3)}`, `slack:C000MPIM:${at(2)}`]);
  });

  it("does not resend a copy of a message sent before aliases existed", async () => {
    const deliveredFile = join(dir, "old-delivered.json");
    writeFileSync(deliveredFile, JSON.stringify({ delivered: { [`slack:D000DM:${at(3)}`]: at(3) } }));
    const { poller, slack, added } = setup({ delivered: new Delivered({ file: deliveredFile, now: () => now }) });
    // Search sees the original (already sent) before the copy.
    slack.results["is:dm"] = [match(at(3), { channel: "D000DM" }), match(at(3), { channel: "C000MPIM" })];
    assert.deepEqual(await poller.poll(), { matched: 2, kept: 0, retry: 0 });
    assert.equal(added.length, 0);
  });

  it("reads back to the cursor minus the overlap, and skips matches it has already judged", async () => {
    let clock = now;
    const { poller, slack, added } = setup({ clock: () => clock });
    slack.results["is:dm"] = [match(at(9), { channel: "D000DM" }), match(at(12), { channel: "D000DM" })];
    // No state: only the overlap (10 minutes) is read.
    assert.deepEqual(await poller.poll(), { matched: 1, kept: 1, retry: 0 });
    clock = now + 60_000;
    slack.results["is:dm"].push(match(at(1), { channel: "D000DM" }));
    assert.deepEqual(await poller.poll(), { matched: 1, kept: 1, retry: 0 });
    assert.equal(added.length, 2);
  });

  it("stops paging at the first page older than the window", async () => {
    const { poller, slack } = setup({ slack: client({ pageSize: 2 }) });
    slack.results["is:dm"] = [1, 2, 3, 4, 5, 20, 21, 22, 23].map((m) => match(at(m), { channel: "D000DM" }));
    await poller.poll();
    const pages = slack.calls["search.messages"].filter((c) => c.query === "is:dm").map((c) => c.page);
    assert.deepEqual(pages, [1, 2, 3]);
  });

  it("catches up from the saved cursor after a restart, at most 24 hours back", async () => {
    const stateFile = join(dir, "search.json");
    const deliveredFile = join(dir, "delivered.json");
    writeFileSync(stateFile, JSON.stringify({ cursor: now - 3 * 3600_000 }));
    writeFileSync(deliveredFile, JSON.stringify({ delivered: { [`slack:D000DM:${at(120)}`]: at(120) } }));
    const { poller, slack, added, lines } = setup({ stateFile, delivered: new Delivered({ file: deliveredFile, now: () => now }) });
    slack.results["is:dm"] = [60, 120, 180, 200].map((m) => match(at(m), { channel: "D000DM" }));
    // 200 minutes ago is before last poll minus the overlap; 120 was already delivered.
    assert.deepEqual(await poller.poll(), { matched: 3, kept: 2, retry: 0 });
    assert.deepEqual(added.map((e) => e.ts), [at(180), at(60)]);
    assert.equal(JSON.parse(readFileSync(stateFile, "utf8")).cursor, now);
    // Each id with its user:<user>:<ts> alias, the seeded one included (it learns its alias).
    assert.deepEqual(Object.keys(JSON.parse(readFileSync(deliveredFile, "utf8")).delivered).length, 6);
    assert.match(lines[0], /^search: 2 kept of 3 new matches since /);

    writeFileSync(stateFile, JSON.stringify({ cursor: now - 3 * 24 * 3600_000 }));
    const later = setup({ stateFile });
    later.slack.results["is:dm"] = [match(at(23 * 60), { channel: "D000DM" }), match(at(25 * 60), { channel: "D000DM" })];
    assert.deepEqual(await later.poller.poll(), { matched: 1, kept: 1, retry: 0 });
  });

  it("reads the rest oldest first when newest first runs out of pages", async () => {
    const stateFile = join(dir, "cap.json");
    writeFileSync(stateFile, JSON.stringify({ cursor: now - 3600_000 }));
    const { poller, slack, added } = setup({ slack: client({ pageSize: 2 }), stateFile, maxPages: 3 });
    // 7 DMs in the window: 6 newest first (3 pages), then oldest first up to the page that reaches
    // the newest-first side.
    slack.results["is:dm"] = [1, 2, 3, 4, 5, 6, 7, 90].map((m) => match(at(m), { channel: "D000DM" }));
    assert.deepEqual(await poller.poll(), { matched: 7, kept: 7, retry: 0 });
    const dm = slack.calls["search.messages"].filter((c) => c.query.startsWith("is:dm"));
    assert.deepEqual(dm.map((c) => [c.sort_dir, c.page, c.query]), [
      ["desc", 1, "is:dm"],
      ["desc", 2, "is:dm"],
      ["desc", 3, "is:dm"],
      ["asc", 1, "is:dm after:2025-10-14"],
      ["asc", 2, "is:dm after:2025-10-14"],
    ]);
    assert.equal(JSON.parse(readFileSync(stateFile, "utf8")).cursor, now);
    assert.equal(added.length, 7);
  });

  it("goes on from where reading stopped when both directions run out of pages", async () => {
    const stateFile = join(dir, "cap2.json");
    writeFileSync(stateFile, JSON.stringify({ cursor: now - 3600_000 }));
    let clock = now;
    const { poller, slack, added, lines } = setup({ slack: client({ pageSize: 1 }), stateFile, maxPages: 2, clock: () => clock });
    // Window starts 70 minutes ago (cursor minus the overlap). Newest first reads 1 and 2, oldest
    // first 80 (before the window) and 69. Unread: 3 to 60.
    slack.results["is:dm"] = [1, 2, 3, 30, 40, 50, 60, 69, 80].map((m) => match(at(m), { channel: "D000DM" }));
    assert.deepEqual(await poller.poll(), { matched: 3, kept: 3, retry: 0 });
    const state = JSON.parse(readFileSync(stateFile, "utf8"));
    assert.equal(state.cursor, Number(at(69)) * 1000 + 600_000);
    assert.deepEqual(state.backlog, { "is:dm": { after: "2025-10-14", page: 2 } });
    assert.match(lines[0], /more than 2 pages; read through /);
    clock = now + 60_000;
    // Each poll resumes at the page it stopped on (69 and 60, then 60 and 50, ...) until the
    // oldest-first side meets the newest-first side.
    for (let i = 0; i < 10 && Object.keys(poller.backlog).length; i++) await poller.poll();
    assert.deepEqual(added.map((e) => e.ts).sort(), [1, 2, 3, 30, 40, 50, 60, 69].map((m) => at(m)).sort());
    assert.deepEqual(JSON.parse(readFileSync(stateFile, "utf8")).backlog, {});
  });

  it("keeps the backlog page when a later query in the poll fails", async () => {
    const stateFile = join(dir, "cap-fail.json");
    writeFileSync(stateFile, JSON.stringify({ cursor: now - 3600_000, backlog: { "is:dm": { after: "2025-10-14", page: 1 } } }));
    const slack = client({ pageSize: 1 });
    const { poller } = setup({ slack, stateFile, maxPages: 2 });
    slack.results["is:dm"] = [1, 2, 3, 30, 40, 50, 60, 69, 80].map((m) => match(at(m), { channel: "D000DM" }));
    const search = slack.search.messages;
    slack.search.messages = async (args) => {
      if (args.query === "<@U000ME>") throw Object.assign(new Error("An API error occurred"), { data: { error: "ratelimited" } });
      return search(args);
    };
    assert.equal(await poller.poll(), "error");
    assert.deepEqual(poller.backlog, { "is:dm": { after: "2025-10-14", page: 1 } });
    assert.deepEqual(JSON.parse(readFileSync(stateFile, "utf8")).backlog, { "is:dm": { after: "2025-10-14", page: 1 } });
  });

  it("judges a match again when its thread lookup or author lookup failed", async () => {
    const slack = client({ fail: ["conversations.replies", "users.info"] });
    const { poller, added } = setup({ slack });
    slack.results["is:thread with:<@U000ME>"] = [match(at(4), { thread_ts: at(30) }), match(at(3), { thread_ts: at(31) })];
    assert.deepEqual(await poller.poll(), { matched: 2, kept: 0, retry: 2 });
    assert.equal(slack.calls["conversations.replies"], undefined);
    slack.users.info = async ({ user }) => ({ user: { id: user, is_bot: false } });
    assert.deepEqual(await poller.poll(), { matched: 2, kept: 0, retry: 2 });
    assert.equal(slack.calls["conversations.replies"].length, 2);
    slack.conversations.replies = async () => ({ messages: [{ user: "U000ME" }] });
    assert.deepEqual(await poller.poll(), { matched: 2, kept: 2, retry: 0 });
    assert.equal(added.length, 2);
  });

  it("holds the cursor back to batched messages that are not flushed yet", async () => {
    const stateFile = join(dir, "pending.json");
    writeFileSync(stateFile, JSON.stringify({ cursor: now - 3600_000 }));
    const { poller, slack, delivered } = setup({ stateFile, flushLater: true });
    slack.results["is:dm"] = [match(at(20), { channel: "D000DM" })];
    await poller.poll();
    assert.equal(Math.round(JSON.parse(readFileSync(stateFile, "utf8")).cursor / 1000), Math.round(Number(at(20)) + 600));
    // After a restart the batch is gone; the next poll finds the message again.
    const restarted = setup({ stateFile, flushLater: true });
    restarted.slack.results["is:dm"] = slack.results["is:dm"];
    assert.deepEqual(await restarted.poller.poll(), { matched: 1, kept: 1, retry: 0 });
    delivered.commit([`slack:D000DM:${at(20)}`]);
  });

  it("keeps its place when a query fails, and turns itself off without search:read", async () => {
    const stateFile = join(dir, "fail.json");
    writeFileSync(stateFile, JSON.stringify({ cursor: now - 3600_000 }));
    const failing = setup({ slack: client({ error: "ratelimited" }), stateFile });
    assert.equal(await failing.poller.poll(), "error");
    assert.equal(JSON.parse(readFileSync(stateFile, "utf8")).cursor, now - 3600_000);
    assert.match(failing.lines[0], /search poll failed: ratelimited/);
    const reports = [];
    failing.poller.health = { report: (kind, text) => reports.push([kind, text]) };
    await failing.poller.poll();
    assert.deepEqual(reports, []);
    await failing.poller.poll();
    assert.equal(reports.length, 1);
    assert.equal(reports[0][0], "search_failing");
    assert.match(reports[0][1], /last 3 search polls failed \(latest: ratelimited\)/);

    const { poller, lines } = setup({ slack: client({ error: "missing_scope" }) });
    assert.equal(await poller.poll(), "disabled");
    assert.equal(await poller.poll(), "disabled");
    assert.equal(lines.length, 1);
    assert.match(lines[0], /search intake disabled/);
  });

  it("runs a catch-up asked for mid-poll right after it", async () => {
    const { poller, slack, lines } = setup();
    const first = poller.poll();
    assert.equal(await poller.catchUp("app_rate_limited"), "queued");
    await first;
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(slack.calls["search.messages"].length, 8);
    assert.deepEqual(lines, ["search catch-up: app_rate_limited"]);
    // A poll just ran, so the next app_rate_limited a minute's tick away does nothing.
    assert.equal(await poller.catchUp("app_rate_limited"), "recent");
    assert.equal(slack.calls["search.messages"].length, 8);
  });

  it("is off when searchPollSeconds is 0", async () => {
    const { poller } = setup({ overrides: { searchPollSeconds: 0 } });
    assert.equal(poller.start(), false);
    assert.equal(await poller.poll(), "disabled");
  });

  it("keeps dry-run state apart", () => {
    assert.equal(searchStatePath("/h", false), "/h/.local/state/qitt/bridge-search.json");
    assert.equal(searchStatePath("/h", true), "/h/.local/state/qitt/bridge-search.dry-run.json");
  });

  describe("my replies", () => {
    it("sends my reply in a DM qitt heard about once, live and again from search", async () => {
      const conversations = new Conversations({ now: () => now });
      conversations.seen.set("slack:D000DM", now - 3600_000);
      const { poller, slack, added, handle } = setup({ conversations });
      const dm = match(at(5), { channel: "D000DM", user: "U000ME" });
      const live = { type: "message", channel: "D000DM", channel_type: "im", user: "U000ME", text: dm.text, ts: dm.ts };
      assert.equal(await handle({ event_id: "Ev1", event: live }), "my reply");
      slack.results["is:dm"] = [dm];
      assert.deepEqual(await poller.poll(), { matched: 1, kept: 0, retry: 0 });
      assert.equal(added.length, 1);
      assert.equal(added[0].my_reply, true);
    });

    it("sends my reply search finds first, and not again live", async () => {
      const conversations = new Conversations({ now: () => now });
      conversations.seen.set("slack:D000DM", now - 3600_000);
      const { poller, slack, added, handle } = setup({ conversations, flushLater: true });
      const dm = match(at(5), { channel: "D000DM", user: "U000ME" });
      slack.results["is:dm"] = [dm];
      assert.deepEqual(await poller.poll(), { matched: 1, kept: 1, retry: 0 });
      const live = { type: "message", channel: "D000DM", channel_type: "im", user: "U000ME", text: dm.text, ts: dm.ts };
      assert.equal(await handle({ event_id: "Ev2", event: live }), "duplicate message");
      assert.equal(added.length, 1);
    });
  });
});
