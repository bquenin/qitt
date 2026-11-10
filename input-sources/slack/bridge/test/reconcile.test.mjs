import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { Conversations } from "../lib/conversations.mjs";
import { Delivered } from "../lib/delivered.mjs";
import { ThreadTracker } from "../lib/filter.mjs";
import { Directory } from "../lib/normalize.mjs";
import { createPipeline } from "../lib/pipeline.mjs";
import { parseKey, Reconciler } from "../lib/reconcile.mjs";
import { cfg, slackStub } from "./helpers.mjs";

const now = Date.parse("2025-10-16T21:05:00Z"); // Thu 10/16 14:05 PT
const at = (minutesAgo, n = 100) => `${Math.floor(now / 1000 - minutesAgo * 60)}.000${n}`;
const THREAD = at(120, 900); // a support thread qitt heard about two hours ago

// slackStub plus conversations.replies/history serving threads[channel:ts] and dms[channel] within
// [oldest, latest], and search.messages serving mine (my own matches).
// endless: channels whose history always has another page; minePages: pages search reports.
const client = ({ threads = {}, dms = {}, mine = [], fail = {}, endless = [], minePages = 1 } = {}) => {
  const c = slackStub();
  const failing = (name, key) => {
    if (fail[key]) throw Object.assign(new Error("boom"), { data: { error: fail[key] } });
  };
  const within = (messages, { oldest, latest }) => messages.filter((m) => Number(m.ts) >= Number(oldest) && Number(m.ts) <= Number(latest));
  c.conversations.replies = async (args) => {
    (c.calls["conversations.replies"] ??= []).push(args);
    failing("replies", `${args.channel}:${args.ts}`);
    const all = threads[`${args.channel}:${args.ts}`] ?? [];
    // Thread lookups (no window) see the whole thread; the parent always comes first.
    if (!args.oldest) return { messages: all };
    return { messages: [all[0], ...within(all.slice(1), args)].filter(Boolean) };
  };
  c.conversations.history = async (args) => {
    (c.calls["conversations.history"] ??= []).push(args);
    failing("history", args.channel);
    return { messages: within(dms[args.channel] ?? [], args), ...(endless.includes(args.channel) && { response_metadata: { next_cursor: "more" } }) };
  };
  c.search = {
    messages: async (args) => {
      (c.calls["search.messages"] ??= []).push(args);
      return { messages: { matches: mine, paging: { page: args.page, pages: minePages } } };
    },
  };
  return c;
};

const reply = (ts, fields = {}) => ({ user: "U000OTHER", text: `reply ${ts}`, ts, thread_ts: THREAD, ...fields });

const setup = ({ slack = client(), stateFile = null, heard = [`slack:C000SUPPORT:${THREAD}`] } = {}) => {
  const config = cfg({ supportChannels: ["C000SUPPORT"], reconcileMinutes: 15 });
  const added = [];
  const lines = [];
  const reports = [];
  const delivered = new Delivered({ now: () => now });
  const conversations = new Conversations({ now: () => now });
  for (const key of heard) conversations.seen.set(key, now - 3600_000);
  const handle = createPipeline({
    cfg: config,
    threads: new ThreadTracker({ me: config.me, client: slack }),
    directory: new Directory({ client: slack }),
    batcher: {
      add: (e) => {
        added.push(e);
        delivered.commit([e.id]);
      },
      hold: (e) => added.push(e),
    },
    conversations,
    delivered,
  });
  const reconciler = new Reconciler({
    cfg: config,
    client: slack,
    handle,
    conversations,
    delivered,
    health: { report: (kind, text) => reports.push([kind, text]) },
    stateFile,
    log: (l) => lines.push(l),
    now: () => now,
    pauseMs: 0,
  });
  return { reconciler, slack, added, lines, reports, delivered, handle };
};

describe("Reconciler", () => {
  const dir = mkdtempSync(join(tmpdir(), "qitt-reconcile-test-"));
  after(() => rmSync(dir, { recursive: true, force: true }));
  let n = 0;
  const state = (cursor, extra = {}) => {
    const file = join(dir, `${++n}.json`);
    writeFileSync(file, JSON.stringify({ cursor, ...extra }));
    return file;
  };

  it("parses conversation keys", () => {
    assert.deepEqual(parseKey("slack:C1:1.2"), { key: "slack:C1:1.2", channel: "C1", threadTs: "1.2" });
    assert.deepEqual(parseKey("slack:D1"), { key: "slack:D1", channel: "D1" });
    assert.equal(parseKey("slack"), undefined);
  });

  it("starts from now on its first run, reading nothing", async () => {
    const stateFile = join(dir, "first.json");
    const { reconciler, slack } = setup({ stateFile });
    assert.deepEqual(await reconciler.run(), { conversations: 0, read: 0, backfilled: 0, failed: false });
    assert.equal(JSON.parse(readFileSync(stateFile, "utf8")).cursor, now - 900_000);
    assert.equal(slack.calls["conversations.replies"], undefined);
  });

  it("backfills a reply in my support thread that was missed, and tells health", async () => {
    // Regression: I replied in the thread, then the requester's reply never reached qitt.
    const slack = client({
      threads: {
        [`C000SUPPORT:${THREAD}`]: [
          { user: "U000OTHER", text: "question", ts: THREAD, thread_ts: THREAD },
          reply(at(25, 1), { user: "U000ME", text: "my answer" }),
          reply(at(20, 2)),
          reply(at(5, 3)), // too fresh: live events and search still have it
        ],
      },
    });
    const stateFile = state(now - 30 * 60_000);
    const { reconciler, added, lines, reports, delivered } = setup({ slack, stateFile });
    // My reply went out as a sent draft.
    delivered.remember(`slack:C000SUPPORT:${at(25, 1)}`, at(25, 1));
    delivered.commit([`slack:C000SUPPORT:${at(25, 1)}`]);
    assert.deepEqual(await reconciler.run(), { conversations: 1, read: 2, backfilled: 1, failed: false });
    assert.equal(added.length, 1);
    assert.equal(added[0].id, `slack:C000SUPPORT:${at(20, 2)}`);
    assert.equal(added[0].backfill, true);
    assert.equal(added[0].support_channel, true);
    assert.ok(lines.includes(`reconcile gap slack:C000SUPPORT:${at(20, 2)} (my thread)`));
    assert.equal(reports.length, 1);
    assert.equal(reports[0][0], "missed_messages");
    assert.match(reports[0][1], /found 1 message that live events and search missed/);
    assert.equal(JSON.parse(readFileSync(stateFile, "utf8")).cursor, now - 900_000);

    // A run right after has nothing new to read, and sends nothing twice.
    assert.deepEqual(await reconciler.run(), { conversations: 0, read: 0, backfilled: 0, failed: false });
    assert.equal(added.length, 1);
  });

  it("sends nothing already delivered, and leaves filtered messages dropped", async () => {
    const slack = client({
      threads: {
        [`C000SUPPORT:${THREAD}`]: [
          { user: "U000ME", text: "question", ts: THREAD, thread_ts: THREAD },
          reply(at(20, 1)),
          reply(at(19, 2), { bot_id: "B000BOT" }),
          reply(at(18, 3), { subtype: "channel_join" }),
        ],
      },
    });
    const { reconciler, added, reports, handle } = setup({ slack, stateFile: state(now - 30 * 60_000) });
    // Search already sent the first reply.
    assert.equal(await handle({ event: { type: "message", channel: "C000SUPPORT", channel_type: "channel", ...reply(at(20, 1)) } }), "my thread");
    assert.deepEqual(await reconciler.run(), { conversations: 1, read: 3, backfilled: 0, failed: false });
    assert.equal(added.length, 1);
    assert.deepEqual(reports, []);
  });

  it("reads the threads and DMs I posted in, found by search", async () => {
    const MINE = at(60, 7);
    const slack = client({
      mine: [
        { channel: { id: "C000TEAM", name: "team" }, ts: at(50, 1), permalink: `https://x.invalid/archives/C000TEAM/p1?thread_ts=${MINE}&cid=C000TEAM` },
        { channel: { id: "D000DM", is_im: true }, ts: at(40, 2) },
      ],
      threads: { [`C000TEAM:${MINE}`]: [{ user: "U000OTHER", text: "q", ts: MINE }, reply(at(50, 1), { user: "U000ME", thread_ts: MINE }), reply(at(20, 3), { thread_ts: MINE })] },
      dms: { D000DM: [{ user: "U000OTHER", text: "dm", ts: at(20, 4) }] },
    });
    const stateFile = state(now - 30 * 60_000);
    const { reconciler, added } = setup({ slack, stateFile, heard: [] });
    assert.deepEqual(await reconciler.run(), { conversations: 2, read: 2, backfilled: 2, failed: false });
    assert.deepEqual(
      added.map((e) => [e.id, e.channel_type]),
      [
        [`slack:C000TEAM:${at(20, 3)}`, "channel"],
        [`slack:D000DM:${at(20, 4)}`, "im"],
      ],
    );
    assert.match(slack.calls["search.messages"][0].query, /^from:<@U000ME> after:2025-10-07$/);
    // My conversations are kept, so a restart reads them without searching a week again.
    const saved = JSON.parse(readFileSync(stateFile, "utf8"));
    assert.deepEqual(Object.keys(saved.mine).sort(), ["slack:C000TEAM:" + MINE, "slack:D000DM"]);
    assert.equal(saved.mineSearched, now);
  });

  it("reads again after a failed read, and skips a conversation that is gone", async () => {
    const slack = client({
      threads: { [`C000SUPPORT:${THREAD}`]: [{ user: "U000ME", ts: THREAD }, reply(at(20, 1))] },
      fail: { [`C000SUPPORT:${THREAD}`]: "ratelimited", "history:D000GONE": "x", D000GONE: "channel_not_found" },
    });
    const stateFile = state(now - 30 * 60_000);
    const { reconciler, lines } = setup({ slack, stateFile, heard: [`slack:C000SUPPORT:${THREAD}`, "slack:D000GONE"] });
    const result = await reconciler.run();
    assert.equal(result.failed, true);
    assert.equal(JSON.parse(readFileSync(stateFile, "utf8")).cursor, now - 30 * 60_000);
    assert.ok(lines.includes(`reconcile: reading slack:C000SUPPORT:${THREAD} failed: ratelimited`));
    assert.ok(lines.includes("reconcile: reading slack:D000GONE failed: channel_not_found; skipped until restart"));

    delete slack.calls["conversations.history"];
    await reconciler.run();
    assert.equal(slack.calls["conversations.history"], undefined);
  });

  it("reads again a conversation or a search of mine cut short by the page cap", async () => {
    const slack = client({
      dms: { D000BUSY: [{ user: "U000OTHER", text: "dm", ts: at(20, 1) }] },
      endless: ["D000BUSY"],
      mine: [{ channel: { id: "C000TEAM", name: "team" }, ts: at(50, 2) }],
      minePages: 5,
    });
    const stateFile = state(now - 30 * 60_000);
    const { reconciler, lines } = setup({ slack, stateFile, heard: ["slack:D000BUSY"] });
    reconciler.maxPages = 2;
    const result = await reconciler.run();
    assert.equal(result.failed, true);
    const saved = JSON.parse(readFileSync(stateFile, "utf8"));
    assert.equal(saved.cursor, now - 30 * 60_000);
    assert.equal(saved.mineSearched, undefined);
    assert.ok(lines.includes("reconcile: D000BUSY has more than 2 pages in the window; reading it again next run"));
    assert.ok(lines.includes("reconcile: more than 2 pages of my messages; kept the newest, searching again next run"));
  });

  it("counts a missing scope as a failure, not a gone conversation", async () => {
    const slack = client({ fail: { D000DM: "missing_scope" } });
    const stateFile = state(now - 30 * 60_000);
    const { reconciler } = setup({ slack, stateFile, heard: ["slack:D000DM"] });
    assert.equal((await reconciler.run()).failed, true);
    assert.equal(JSON.parse(readFileSync(stateFile, "utf8")).cursor, now - 30 * 60_000);
    assert.equal(reconciler.gone.size, 0);
  });

  it("reports runs that throw", async () => {
    const { reconciler, reports } = setup({ stateFile: state(now - 30 * 60_000) });
    reconciler.conversations = { recent: () => { throw new Error("disk full"); } };
    for (let i = 0; i < 3; i++) assert.equal(await reconciler.run(), "error");
    assert.equal(reports[0][0], "reconcile_failing");
  });

  it("reports runs that keep failing", async () => {
    const slack = client({ fail: { [`C000SUPPORT:${THREAD}`]: "ratelimited" } });
    const { reconciler, reports } = setup({ slack, stateFile: state(now - 30 * 60_000) });
    await reconciler.run();
    await reconciler.run();
    assert.deepEqual(reports, []);
    await reconciler.run();
    assert.equal(reports[0][0], "reconcile_failing");
  });

  it("does nothing when reconcileMinutes is 0", async () => {
    const config = cfg({ reconcileMinutes: 0 });
    const reconciler = new Reconciler({ cfg: config, client: client(), handle: async () => "im" });
    assert.equal(reconciler.start(), false);
    assert.equal(await reconciler.run(), "disabled");
  });
});
