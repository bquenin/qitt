import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, afterEach, describe, it, mock } from "node:test";
import { Batcher, buildBody, postBatch } from "../lib/batch.mjs";
import { configureTime } from "../lib/time.mjs";

configureTime({ timezone: "America/Los_Angeles" });

const event = (ts) => ({ id: `slack:C000TEAM:${ts}`, ts });
const settle = () => new Promise((resolve) => setImmediate(resolve));

describe("Batcher", () => {
  beforeEach(() => mock.timers.enable({ apis: ["setTimeout"] }));
  afterEach(() => mock.timers.reset());

  it("sends one body per window, starting at the first event", async () => {
    const bodies = [];
    const batcher = new Batcher({ windowMs: 20000, flush: (b) => bodies.push(b) });
    batcher.add(event("1760648700.000100"));
    mock.timers.tick(15000);
    batcher.add(event("1760648880.000100"));
    mock.timers.tick(4999);
    await settle();
    assert.equal(bodies.length, 0);
    mock.timers.tick(1);
    await settle();
    assert.equal(bodies.length, 1);
    assert.equal(bodies[0].count, 2);
    assert.equal(bodies[0].window, "14:05–14:08 PT");
    assert.deepEqual(bodies[0].events.map((e) => e.ts), ["1760648700.000100", "1760648880.000100"]);
    assert.match(bodies[0].id, /^[0-9a-f-]{36}$/);
  });

  it("starts a new window for events after a flush", async () => {
    const bodies = [];
    const batcher = new Batcher({ windowMs: 20000, flush: (b) => bodies.push(b) });
    batcher.add(event("1760648700.000100"));
    mock.timers.tick(20000);
    batcher.add(event("1760648760.000100"));
    mock.timers.tick(19999);
    await settle();
    assert.equal(bodies.length, 1);
    mock.timers.tick(1);
    await settle();
    assert.equal(bodies.length, 2);
    assert.equal(bodies[1].count, 1);
    assert.notEqual(bodies[0].id, bodies[1].id);
  });

  it("finds and replaces a waiting event by id", async () => {
    const bodies = [];
    const batcher = new Batcher({ windowMs: 20000, flush: (b) => bodies.push(b) });
    batcher.add(event("1760648700.000100"));
    assert.equal(batcher.find("slack:C000TEAM:1760648700.000100").ts, "1760648700.000100");
    assert.equal(batcher.find("slack:C000TEAM:0"), undefined);
    assert.equal(batcher.replace("slack:C000TEAM:1760648700.000100", { ...event("1760648700.000100"), saved: true }), true);
    assert.equal(batcher.replace("slack:C000TEAM:0", event("0")), false);
    mock.timers.tick(20000);
    await settle();
    assert.deepEqual(bodies[0].events, [{ ...event("1760648700.000100"), saved: true }]);
  });

  it("logs a failing flush instead of throwing", async () => {
    const lines = [];
    const batcher = new Batcher({ windowMs: 10, flush: () => Promise.reject(new Error("nope")), log: (l) => lines.push(l) });
    batcher.add(event("1760648700.000100"));
    mock.timers.tick(10);
    await settle();
    assert.match(lines[0], /flush error: nope/);
  });
});

describe("buildBody", () => {
  it("labels the window from the earliest to the latest message", () => {
    const body = buildBody([event("1760648880.000100"), event("1760648700.000100")], "batch-1");
    assert.deepEqual({ ...body, events: undefined, digest: undefined }, { id: "batch-1", count: 2, window: "14:05–14:08 PT", events: undefined, digest: undefined });
  });

  it("keeps the events and adds their digest", () => {
    const events = [event("1760648700.000100")];
    const body = buildBody(events, "batch-1");
    assert.equal(body.events, events);
    assert.match(body.digest, /^1 event\.\n\n1\. slack:C000TEAM:1760648700\.000100 · /);
  });
});

describe("postBatch", () => {
  const dir = mkdtempSync(join(tmpdir(), "qitt-bridge-test-"));
  after(() => rmSync(dir, { recursive: true, force: true }));
  const urlFile = join(dir, "webhook.url");
  const secretUrl = "http://127.0.0.1:9/api/hooks/task-1/secret-token";
  const body = buildBody([event("1760648700.000100")], "batch-1");

  const fakeFetch = (statuses) => {
    const calls = [];
    const impl = async (url, init) => {
      calls.push({ url, init });
      const status = statuses[Math.min(calls.length - 1, statuses.length - 1)];
      if (status instanceof Error) throw status;
      return { status, body: null };
    };
    return { calls, impl };
  };
  const post = (fetchImpl, lines, waits = []) =>
    postBatch(body, { urlFile, fetchImpl, log: (l) => lines.push(l), wait: async (ms) => waits.push(ms) });

  it("POSTs JSON once and logs count and status on 202", async () => {
    writeFileSync(urlFile, `${secretUrl}\n`);
    const fetch = fakeFetch([202]);
    const lines = [];
    assert.equal(await post(fetch.impl, lines), true);
    assert.equal(fetch.calls.length, 1);
    assert.equal(fetch.calls[0].url, secretUrl);
    assert.equal(fetch.calls[0].init.method, "POST");
    assert.equal(fetch.calls[0].init.headers["content-type"], "application/json");
    assert.deepEqual(JSON.parse(fetch.calls[0].init.body), body);
    assert.deepEqual(lines, ["batch batch-1 count=1 status=202"]);
  });

  it("retries with backoff until 202", async () => {
    writeFileSync(urlFile, secretUrl);
    const fetch = fakeFetch([500, Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } }), 202]);
    const lines = [];
    const waits = [];
    assert.equal(await post(fetch.impl, lines, waits), true);
    assert.equal(fetch.calls.length, 3);
    assert.deepEqual(waits, [2000, 8000]);
    assert.match(lines[0], /attempt 1\/3 failed: status=500/);
    assert.match(lines[1], /attempt 2\/3 failed: error=ECONNREFUSED/);
  });

  it("drops the batch after 3 failed attempts", async () => {
    writeFileSync(urlFile, secretUrl);
    const fetch = fakeFetch([200]);
    const lines = [];
    assert.equal(await post(fetch.impl, lines), false);
    assert.equal(fetch.calls.length, 3);
    assert.match(lines.at(-1), /batch batch-1 count=1 dropped after 3 attempts \(status=200\)/);
  });

  it("reads the URL file at every POST and never logs the URL", async () => {
    const fetch = fakeFetch([202]);
    const lines = [];
    writeFileSync(urlFile, secretUrl);
    await post(fetch.impl, lines);
    writeFileSync(urlFile, "http://127.0.0.1:9/api/hooks/task-1/rotated-token");
    await post(fetch.impl, lines);
    assert.deepEqual(fetch.calls.map((c) => c.url.split("/").at(-1)), ["secret-token", "rotated-token"]);
    rmSync(urlFile);
    await post(fetch.impl, lines);
    assert.match(lines.at(-1), /dropped/);
    assert.doesNotMatch(lines.join("\n"), /token|127\.0\.0\.1|webhook\.url/);
  });
});
