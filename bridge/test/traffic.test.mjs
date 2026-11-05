import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Traffic } from "../lib/traffic.mjs";

const start = Date.parse("2025-10-16T21:05:00Z");

// An events_api payload: a channel message for me in T000TEAM unless fields say otherwise.
const envelope = ({ team = "T000TEAM", user = "U000ME", bot = false, ...event } = {}) => ({
  team_id: team,
  authorizations: [{ user_id: user, is_bot: bot }],
  event: { type: "message", channel: "C000TEAM", channel_type: "channel", ...event },
});

const setup = (options = {}) => {
  let clock = start;
  const lines = [];
  const traffic = new Traffic({ me: "U000ME", log: (l) => lines.push(l), now: () => clock, ...options });
  return { traffic, lines, tick: (minutes) => (clock += minutes * 60_000) };
};

describe("Traffic", () => {
  it("reports the last interval by workspace, type, and busiest channels", () => {
    const { traffic, lines, tick } = setup({ top: 2 });
    tick(1);
    for (let i = 0; i < 3; i++) traffic.count(envelope({ channel: "C000BUSY" }));
    for (let i = 0; i < 2; i++) traffic.count(envelope({ channel: "C000BUSY", subtype: "message_changed" }));
    traffic.count(envelope({ channel: "C000OTHER", channel_type: "group" }));
    traffic.count(envelope({ channel: "D000DM", channel_type: "im" }));
    tick(9);
    traffic.report();
    assert.deepEqual(lines, [
      "traffic: 7 live events in the last 10m (~42/h); last 10m by workspace: T000TEAM 7",
      "traffic types: message 5, message/message_changed 2",
      "traffic channels: C000BUSY (channel) 5, C000OTHER (group) 1, 1 other channels 1",
    ]);
  });

  it("says so when nothing came in", () => {
    const { traffic, lines, tick } = setup();
    tick(10);
    traffic.report();
    assert.deepEqual(lines, ["traffic: no live events in the last 10m"]);
  });

  it("names events authorized for anyone but me", () => {
    const { traffic, lines } = setup();
    traffic.count(envelope());
    traffic.count(envelope({ user: "U000OTHER" }));
    traffic.count(envelope({ user: "U000BOT", bot: true }));
    traffic.report();
    assert.match(lines[0], /; authorized for others: U000BOT \(bot\) 1, U000OTHER 1$/);
  });

  it("finds the channel of events that keep it elsewhere", () => {
    const { traffic, lines } = setup();
    traffic.count(envelope({ type: "reaction_added", channel: undefined, channel_type: undefined, item: { channel: "C000ITEM" } }));
    traffic.count(envelope({ type: "channel_created", channel: { id: "C000NEW" }, channel_type: undefined }));
    traffic.count({ event: { type: "message" } });
    traffic.report();
    assert.equal(lines[1], "traffic types: channel_created 1, message 1, reaction_added 1");
    assert.equal(lines[2], "traffic channels: - 2, C000ITEM 1");
    assert.match(lines[0], /by workspace: T000TEAM 2, \? 1$/);
  });

  it("forgets events older than an hour", () => {
    const { traffic, lines, tick } = setup();
    traffic.count(envelope({ channel: "C000OLD" }));
    tick(61);
    traffic.count(envelope({ channel: "C000NEW" }));
    traffic.report(60);
    assert.equal(traffic.buckets.size, 1);
    assert.equal(lines[0], "traffic: 1 live events in the last 60m (~1/h); last 60m by workspace: T000TEAM 1");
    assert.equal(lines[2], "traffic channels: C000NEW (channel) 1");
  });

  it("logs a workspace's last hour when its rate limit starts, once per streak", () => {
    const { traffic, lines, tick } = setup();
    tick(29);
    traffic.count(envelope({ channel: "C000BUSY" }));
    traffic.count(envelope({ channel: "C000BUSY" }));
    traffic.count(envelope({ team: "T000ELSE", channel: "C000ELSE" }));
    tick(1);
    assert.equal(traffic.rateLimited({ team: "T000TEAM" }), true);
    assert.deepEqual(lines, [
      "traffic at rate limit of T000TEAM: 2 live events in the last 30m (~4/h); last 30m by workspace: T000TEAM 2",
      "traffic at rate limit of T000TEAM types: message 2",
      "traffic at rate limit of T000TEAM channels: C000BUSY (channel) 2",
    ]);
    tick(1);
    assert.equal(traffic.rateLimited({ team: "T000TEAM" }), false);
    assert.equal(traffic.rateLimited({ team: "T000ELSE" }), true);
    tick(4); // over 3 minutes without a notice: a new streak
    assert.equal(traffic.rateLimited({ team: "T000TEAM" }), true);
    assert.equal(traffic.rateLimited({}), true);
    assert.match(lines.at(-3), /^traffic at rate limit of \?: 3 live events/);
  });

  it("reports on a timer unless turned off", () => {
    const off = setup({ reportMinutes: 0 }).traffic;
    off.start();
    assert.equal(off.timer, undefined);
    const on = setup().traffic;
    on.start();
    assert.notEqual(on.timer, undefined);
    on.stop();
    assert.equal(on.timer, undefined);
  });
});
