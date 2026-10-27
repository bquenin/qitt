import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, beforeEach, describe, it, mock } from "node:test";
import { Batcher } from "../lib/batch.mjs";
import { Directory } from "../lib/normalize.mjs";
import { channelType, SavedPoller, stateFilePath } from "../lib/saved.mjs";
import { cfg, slackStub } from "./helpers.mjs";

const now = Date.parse("2025-10-16T21:05:00Z"); // Thu 10/16 14:05 PT
// Message times relative to now.
const recent = "1760600000.000100"; // 13 hours ago
const recent2 = "1760500000.000200"; // 1.7 days ago
const old = "1760000000.000100"; // 7.5 days ago

// A search.messages match for a saved message.
const match = (ts, { channel = "C000TEAM", thread_ts, ...fields } = {}) => ({
  channel: typeof channel === "string" ? { id: channel, name: `name-of-${channel}` } : channel,
  ts,
  user: "U000OTHER",
  text: `text ${ts}`,
  permalink: `https://example.invalid/p/${ts}${thread_ts ? `?thread_ts=${thread_ts}&cid=${channel}` : ""}`,
  ...fields,
});

// slackStub plus search.messages serving `saved` (newest first), paged by `pageSize`. `error`
// makes it fail with that Slack error code.
const client = ({ pageSize = 100, error } = {}) => {
  const c = slackStub();
  c.saved = [];
  c.search = {
    messages: async ({ query, sort, page, count }) => {
      (c.calls["search.messages"] ??= []).push({ query, sort, page, count });
      if (error) throw Object.assign(new Error("An API error occurred"), { data: { error } });
      const size = Math.min(count, pageSize);
      const pages = Math.max(1, Math.ceil(c.saved.length / size));
      return { messages: { matches: c.saved.slice((page - 1) * size, page * size), paging: { page, pages, count: size, total: c.saved.length } } };
    },
  };
  c.conversations.info = async ({ channel }) => {
    (c.calls["conversations.info"] ??= []).push(channel);
    return { channel: { name: `name-of-${channel}`, is_im: channel.startsWith("D") } };
  };
  return c;
};

const fakeBatcher = () => ({ events: [], add(e) { this.events.push(e); }, find: () => undefined });

describe("SavedPoller", () => {
  const dir = mkdtempSync(join(tmpdir(), "qitt-bridge-test-"));
  after(() => rmSync(dir, { recursive: true, force: true }));
  let n = 0;
  const setup = ({ slack = client(), stateFile = join(dir, `state-${++n}.json`), config = cfg(), batcher = fakeBatcher(), maxPages } = {}) => {
    const lines = [];
    const poller = new SavedPoller({ cfg: config, client: slack, directory: new Directory({ client: slack }), batcher, stateFile, log: (l) => lines.push(l), now: () => now, ...(maxPages && { maxPages }) });
    return { poller, slack, batcher, stateFile, lines };
  };

  it("first run reads every page, records everything, and sends only last week's messages", async () => {
    const { poller, slack, batcher, stateFile } = setup({ slack: client({ pageSize: 1 }) });
    slack.saved = [match(recent, { thread_ts: "1760590000.000100" }), match(recent2, { channel: "D000DM" }), match(old)];
    assert.deepEqual(await poller.poll(), { sent: 2, unsaved: 0 });
    assert.deepEqual(slack.calls["search.messages"].map((c) => [c.query, c.sort, c.page]), [["is:saved", "timestamp", 1], ["is:saved", "timestamp", 2], ["is:saved", "timestamp", 3]]);
    assert.deepEqual(batcher.events.map((e) => e.id), [`slack:C000TEAM:${recent}`, `slack:D000DM:${recent2}`]);
    const [first, dm] = batcher.events;
    assert.equal(first.saved, true);
    assert.equal(first.saved_at, null);
    assert.equal(first.unsaved, undefined);
    assert.equal(first.channel_type, "channel");
    assert.equal(first.channel_name, "name-of-C000TEAM");
    assert.equal(first.user_name, "disp-U000OTHER");
    assert.equal(first.text, `text ${recent}`);
    assert.equal(first.thread_ts, "1760590000.000100");
    assert.equal(first.source_key, "slack:C000TEAM:1760590000.000100");
    assert.equal(first.permalink, `https://example.invalid/C000TEAM/${recent}`);
    assert.equal(dm.channel_type, "im");
    assert.equal(dm.channel_name, null);
    const state = JSON.parse(readFileSync(stateFile, "utf8"));
    assert.deepEqual(Object.keys(state.seen).sort(), [`C000TEAM:${old}`, `C000TEAM:${recent}`, `D000DM:${recent2}`]);
  });

  it("first run that hits the page cap seeds nothing, sends nothing, and retries", async () => {
    const slack = client({ pageSize: 1 });
    const { poller, batcher, stateFile, lines } = setup({ slack, maxPages: 2 });
    slack.saved = [match(recent), match(recent2), match(old)];
    assert.equal(await poller.poll(), "incomplete");
    assert.equal(slack.calls["search.messages"].length, 2);
    assert.equal(batcher.events.length, 0);
    assert.equal(existsSync(stateFile), false);
    assert.match(lines[0], /more than 2 pages of saved items; not seeding/);
    poller.maxPages = 3;
    assert.deepEqual(await poller.poll(), { sent: 2, unsaved: 0 });
  });

  it("sends one saved event for a newly saved item, bypassing filters", async () => {
    const { poller, slack, batcher } = setup();
    slack.saved = [match(recent)];
    await poller.poll();
    batcher.events.length = 0;
    // Old message, from a bot, in an unwatched channel, mentioning nobody: still sent.
    slack.saved = [match(recent), match("1700000000.000100", { bot_id: "B000BOT" })];
    assert.deepEqual(await poller.poll(), { sent: 1, unsaved: 0 });
    assert.equal(batcher.events.length, 1);
    assert.equal(batcher.events[0].id, "slack:C000TEAM:1700000000.000100");
    assert.equal(batcher.events[0].saved, true);
    assert.deepEqual(await poller.poll(), { sent: 0, unsaved: 0 });
    assert.equal(batcher.events.length, 1);
  });

  it("falls back to the match's channel when conversations.info fails", async () => {
    const slack = client();
    slack.conversations.info = async () => {
      throw Object.assign(new Error("An API error occurred"), { data: { error: "missing_scope" } });
    };
    const { poller, batcher } = setup({ slack });
    await poller.poll();
    slack.saved = [match("1760600100.000100", { channel: { id: "C000MPIM", name: "mpdm-a--b-1", is_mpim: true } })];
    await poller.poll();
    slack.saved.push(match("1760600200.000100", { channel: { id: "C000PRIV", name: "priv", is_private: true } }));
    await poller.poll();
    assert.deepEqual(
      batcher.events.map((e) => [e.channel_type, e.channel_name]),
      [
        ["mpim", null],
        ["group", "priv"],
      ],
    );
  });

  it("sends one unsaved event, without text, for a removed item", async () => {
    const { poller, slack, batcher } = setup();
    slack.saved = [match(recent), match(recent2, { thread_ts: "1760400000.000100" })];
    await poller.poll();
    batcher.events.length = 0;
    slack.saved = [slack.saved[0]];
    assert.deepEqual(await poller.poll(), { sent: 0, unsaved: 0 }); // first miss: not yet
    assert.equal(batcher.events.length, 0);
    assert.deepEqual(await poller.poll(), { sent: 0, unsaved: 1 });
    assert.deepEqual(batcher.events, [
      {
        id: `slack:C000TEAM:${recent2}`,
        source: "slack",
        unsaved: true,
        ts: recent2,
        source_key: "slack:C000TEAM:1760400000.000100",
        permalink: `https://example.invalid/C000TEAM/${recent2}`,
      },
    ]);
    assert.deepEqual(await poller.poll(), { sent: 0, unsaved: 0 });
  });

  it("does not flap when search pages drift: one item twice, another missing", async () => {
    const { poller, slack, batcher, lines } = setup({ slack: client({ pageSize: 2 }) });
    const all = [match(recent), match(recent2), match(old), match("1759000000.000100")];
    slack.saved = all;
    await poller.poll(); // first run
    batcher.events.length = 0;
    lines.length = 0;
    // Drift: total still 4, the oldest item replaced by a repeat of another.
    slack.saved = [all[0], all[1], all[2], all[2]];
    assert.deepEqual(await poller.poll(), { sent: 0, unsaved: 0 });
    assert.match(lines[0], /pages drifted, 3 of 4 items; removals skipped/);
    // A drifted list never counts as a miss, however often it happens.
    await poller.poll();
    assert.deepEqual(batcher.events, []);
    // The item is back: nothing is sent.
    slack.saved = all;
    assert.deepEqual(await poller.poll(), { sent: 0, unsaved: 0 });
    assert.deepEqual(batcher.events, []);
  });

  it("does not resend an item missing from one whole list and back on the next", async () => {
    const { poller, slack, batcher, stateFile } = setup();
    slack.saved = [match(recent), match(old)];
    await poller.poll(); // first run
    batcher.events.length = 0;
    slack.saved = [match(recent)];
    assert.deepEqual(await poller.poll(), { sent: 0, unsaved: 0 });
    assert.equal(JSON.parse(readFileSync(stateFile, "utf8")).seen[`C000TEAM:${old}`].missed, 1);
    slack.saved = [match(recent), match(old)];
    assert.deepEqual(await poller.poll(), { sent: 0, unsaved: 0 });
    assert.equal(JSON.parse(readFileSync(stateFile, "utf8")).seen[`C000TEAM:${old}`].missed, undefined);
    // The miss count was reset: one more miss is again only a first miss.
    slack.saved = [match(recent)];
    assert.deepEqual(await poller.poll(), { sent: 0, unsaved: 0 });
    assert.deepEqual(batcher.events, []);
  });

  it("leaves a pending miss alone on a drifted list, and clears it when the item shows up there", async () => {
    const { poller, slack, batcher, stateFile } = setup({ slack: client({ pageSize: 2 }) });
    const [a, b, c, d] = [match(recent), match(recent2), match(old), match("1759000000.000100")];
    const missed = () => JSON.parse(readFileSync(stateFile, "utf8")).seen[`C000TEAM:${d.ts}`].missed;
    slack.saved = [a, b, c, d];
    await poller.poll(); // first run
    batcher.events.length = 0;
    slack.saved = [a, b, c];
    await poller.poll(); // whole list without d: first miss
    assert.equal(missed(), 1);
    // Drifted list without d: the count stays at 1, nothing is sent.
    slack.saved = [a, b, c, c, c];
    assert.deepEqual(await poller.poll(), { sent: 0, unsaved: 0 });
    assert.equal(missed(), 1);
    // Drifted list with d: the miss is cleared, and d is not announced again.
    slack.saved = [a, b, d, d, d];
    assert.deepEqual(await poller.poll(), { sent: 0, unsaved: 0 });
    assert.equal(missed(), undefined);
    // So the next whole list without d is a first miss again, not a removal.
    slack.saved = [a, b, c];
    assert.deepEqual(await poller.poll(), { sent: 0, unsaved: 0 });
    assert.equal(missed(), 1);
    // A drifted list without d, then a whole one: the second whole miss removes it.
    slack.saved = [a, b, c, c, c];
    await poller.poll();
    slack.saved = [a, b, c];
    assert.deepEqual(await poller.poll(), { sent: 0, unsaved: 1 });
    assert.deepEqual(batcher.events.map((e) => [e.id, e.unsaved]), [[`slack:C000TEAM:${d.ts}`, true]]);
  });

  it("does not seed from a drifted first list", async () => {
    const { poller, slack, lines, stateFile } = setup({ slack: client({ pageSize: 2 }) });
    slack.saved = [match(recent), match(recent2), match(recent2)];
    assert.equal(await poller.poll(), "incomplete");
    assert.match(lines[0], /pages drifted \(2 of 3 items\); not seeding/);
    assert.equal(existsSync(stateFile), false);
  });

  it("skips removals but still sends new saves when a later poll hits the page cap", async () => {
    const slack = client({ pageSize: 1 });
    const { poller, batcher, lines } = setup({ slack });
    slack.saved = [match(recent), match(recent2)];
    await poller.poll();
    batcher.events.length = 0;
    poller.maxPages = 1;
    slack.saved = [match("1760640000.000100"), ...slack.saved];
    assert.deepEqual(await poller.poll(), { sent: 1, unsaved: 0 });
    assert.equal(batcher.events.filter((e) => e.unsaved).length, 0);
    assert.match(lines.at(-1), /removals skipped/);
    // The items beyond the cap stay seen: no resend once the whole list fits again.
    poller.maxPages = 20;
    assert.deepEqual(await poller.poll(), { sent: 0, unsaved: 0 });
  });

  it("keeps state across a restart and does not resend", async () => {
    const slack = client();
    slack.saved = [match(recent)];
    const first = setup({ slack });
    await first.poller.poll();
    assert.equal(first.batcher.events.length, 1);
    const second = setup({ slack, stateFile: first.stateFile });
    assert.deepEqual(await second.poller.poll(), { sent: 0, unsaved: 0 });
    assert.equal(second.batcher.events.length, 0);
    slack.saved = [];
    const third = setup({ slack, stateFile: first.stateFile });
    assert.deepEqual(await third.poller.poll(), { sent: 0, unsaved: 0 });
    // The first miss survives a restart.
    const fourth = setup({ slack, stateFile: first.stateFile });
    assert.deepEqual(await fourth.poller.poll(), { sent: 0, unsaved: 1 });
  });

  for (const code of ["missing_scope", "not_allowed_token_type"]) {
    it(`disables itself on ${code} without throwing`, async () => {
      const { poller, slack, lines, stateFile } = setup({ slack: client({ error: code }) });
      assert.equal(await poller.poll(), "disabled");
      assert.equal(await poller.poll(), "disabled");
      assert.equal(slack.calls["search.messages"].length, 1);
      assert.deepEqual(lines, [`saved-for-later polling disabled: search.messages failed with ${code}; the user token needs search:read`]);
      assert.equal(existsSync(stateFile), false);
    });
  }

  it("logs other errors and retries on the next poll", async () => {
    const { poller, slack, lines } = setup({ slack: client({ error: "ratelimited" }) });
    assert.equal(await poller.poll(), "error");
    assert.equal(await poller.poll(), "error");
    assert.equal(slack.calls["search.messages"].length, 2);
    assert.match(lines[0], /saved-for-later poll failed: ratelimited/);
  });

  describe("timers", () => {
    beforeEach(() => mock.timers.enable({ apis: ["setInterval", "setTimeout"] }));
    afterEach(() => mock.timers.reset());

    const settle = () => new Promise((resolve) => setImmediate(resolve));
    const flushed = async (bodies) => {
      mock.timers.tick(20000);
      await settle();
      return bodies.at(-1);
    };
    const realBatcher = () => {
      const bodies = [];
      return { bodies, batcher: new Batcher({ windowMs: 20000, flush: (b) => bodies.push(b) }) };
    };

    it("savedPollSeconds 0 never calls the API", () => {
      const { poller, slack } = setup({ config: cfg({ savedPollSeconds: 0 }) });
      assert.equal(poller.start(), false);
      mock.timers.tick(3600 * 1000);
      assert.equal(slack.calls["search.messages"], undefined);
    });

    it("polls at start and every savedPollSeconds", async () => {
      const { poller, slack } = setup({ config: cfg({ savedPollSeconds: 60 }) });
      assert.equal(poller.start(), true);
      await settle();
      mock.timers.tick(60000);
      await settle();
      mock.timers.tick(60000);
      poller.stop();
      mock.timers.tick(60000);
      assert.equal(slack.calls["search.messages"].length, 3);
    });

    it("replaces a waiting removal with the full saved event on a re-save", async () => {
      const { bodies, batcher } = realBatcher();
      const { poller, slack } = setup({ batcher });
      slack.saved = [match(recent)];
      await poller.poll(); // first run: sent
      await flushed(bodies);
      slack.saved = [];
      await poller.poll(); // first miss
      await poller.poll(); // removal waits in the batch
      slack.saved = [match(recent)];
      assert.deepEqual(await poller.poll(), { sent: 1, unsaved: 0 });
      const body = await flushed(bodies);
      assert.equal(bodies.length, 2);
      assert.equal(body.count, 1);
      const [event] = body.events;
      assert.equal(event.id, `slack:C000TEAM:${recent}`);
      assert.equal(event.saved, true);
      assert.equal(event.unsaved, undefined);
      assert.equal(event.text, `text ${recent}`);
      assert.equal(event.permalink, `https://example.invalid/C000TEAM/${recent}`);
    });

    it("replaces a waiting saved event with the removal on an unsave", async () => {
      const { bodies, batcher } = realBatcher();
      const { poller, slack } = setup({ batcher });
      await poller.poll(); // seed an empty state
      slack.saved = [match(recent)];
      await poller.poll(); // saved event waits in the batch
      slack.saved = [];
      await poller.poll(); // first miss
      assert.deepEqual(await poller.poll(), { sent: 0, unsaved: 1 });
      const body = await flushed(bodies);
      assert.equal(body.count, 1);
      assert.deepEqual(body.events[0], {
        id: `slack:C000TEAM:${recent}`,
        source: "slack",
        unsaved: true,
        ts: recent,
        source_key: `slack:C000TEAM:${recent}`,
        permalink: `https://example.invalid/C000TEAM/${recent}`,
      });
    });

    it("sends a live copy saved and unsaved within one window as the plain live message", async () => {
      const { bodies, batcher } = realBatcher();
      const { poller, slack } = setup({ batcher });
      await poller.poll(); // seed an empty state
      batcher.add({ id: `slack:C000TEAM:${recent}`, ts: recent, text: "live" });
      slack.saved = [match(recent)];
      await poller.poll();
      slack.saved = [];
      await poller.poll(); // first miss
      await poller.poll();
      const body = await flushed(bodies);
      assert.deepEqual(body.events, [{ id: `slack:C000TEAM:${recent}`, ts: recent, text: "live" }]);
    });

    it("marks a live copy still in the batch as saved instead of sending it twice", async () => {
      const { bodies, batcher } = realBatcher();
      const { poller, slack } = setup({ batcher });
      await poller.poll(); // seed an empty state
      batcher.add({ id: `slack:C000TEAM:${recent}`, ts: recent, text: "live" });
      slack.saved = [match(recent)];
      await poller.poll();
      await flushed(bodies);
      assert.equal(bodies.length, 1);
      assert.equal(bodies[0].count, 1);
      assert.equal(bodies[0].events[0].text, "live");
      assert.equal(bodies[0].events[0].saved, true);
      // Already sent: a later save goes out again, marked saved.
      batcher.add({ id: `slack:C000OTHER:${recent}`, ts: recent });
      await flushed(bodies);
      slack.saved.push(match(recent, { channel: "C000OTHER" }));
      await poller.poll();
      await flushed(bodies);
      assert.equal(bodies.length, 3);
      assert.equal(bodies[2].events[0].id, `slack:C000OTHER:${recent}`);
      assert.equal(bodies[2].events[0].saved, true);
    });
  });
});

describe("stateFilePath", () => {
  it("keeps dry-run state apart from the real bridge's", () => {
    assert.equal(stateFilePath("/home/me", false), "/home/me/.local/state/qitt/bridge-saved.json");
    assert.equal(stateFilePath("/home/me", true), "/home/me/.local/state/qitt/bridge-saved.dry-run.json");
  });
});

describe("channelType", () => {
  it("reads conversations.info, falling back to the id", () => {
    assert.equal(channelType("C000TEAM", { is_mpim: true }), "mpim");
    assert.equal(channelType("C000TEAM", { is_private: true }), "group");
    assert.equal(channelType("C000TEAM", {}), "channel");
    assert.equal(channelType("D000DM", null), "im");
    assert.equal(channelType("G000PRIV", null), "group");
    assert.equal(channelType("C000TEAM", null), "channel");
  });
});
