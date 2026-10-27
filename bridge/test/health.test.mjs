import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Health } from "../lib/health.mjs";
import { configureTime } from "../lib/time.mjs";

configureTime({ timezone: "America/Los_Angeles" });

const start = Date.parse("2025-10-16T21:05:00Z"); // Thu 10/16 14:05 PT

const setup = () => {
  let clock = start;
  const added = [];
  const lines = [];
  const health = new Health({ batcher: { add: (e) => added.push(e) }, log: (l) => lines.push(l), now: () => clock });
  return { health, added, lines, tick: (minutes) => (clock += minutes * 60_000) };
};

describe("Health", () => {
  it("sends a bridge health event and logs it, once per kind per hour", () => {
    const { health, added, lines, tick } = setup();
    assert.equal(health.report("search_failing", "polls fail"), true);
    assert.deepEqual(added, [
      { id: `bridge:health:search_failing:${start}`, source: "bridge", health: "search_failing", ts: `${start / 1000}.000000`, time_local: "Thu 10/16 14:05 PT", text: "polls fail" },
    ]);
    assert.deepEqual(lines, ["health search_failing: polls fail"]);
    assert.equal(health.report("search_failing", "still failing"), false);
    assert.equal(health.report("missed_messages", "found 1"), true);
    tick(60);
    assert.equal(health.report("search_failing", "failing again"), true);
    assert.equal(added.length, 3);
  });

  it("reports app_rate_limited only once it has lasted 10 minutes", () => {
    const { health, added, tick } = setup();
    for (let i = 0; i < 10; i++) {
      assert.equal(health.rateLimited(), false);
      tick(1);
    }
    assert.equal(health.rateLimited(), true);
    assert.equal(added[0].health, "slack_rate_limited");
    assert.match(added[0].text, /since Thu 10\/16 14:05 PT/);
  });

  it("starts a new streak after a gap", () => {
    const { health, added, tick } = setup();
    health.rateLimited();
    tick(5);
    health.rateLimited();
    tick(4); // gap over 3 minutes: the streak restarts here
    health.rateLimited();
    tick(9);
    assert.equal(health.rateLimited(), false);
    assert.equal(added.length, 0);
  });
});
