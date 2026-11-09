import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { eventlessEnvelope, guardSocket } from "../lib/guard.mjs";
import { configureTime } from "../lib/time.mjs";

configureTime({ timezone: "America/Los_Angeles" });

const rateLimited = { type: "events_api", envelope_id: "e1", payload: { type: "app_rate_limited", team_id: "T000TEAM", minute_rate_limited: 1760648700 } };

const fakeSocket = () => {
  const listeners = {};
  const sent = [];
  const forwarded = [];
  const socket = {
    removeAllListeners: (name) => delete listeners[name],
    on: (name, fn) => (listeners[name] = fn),
    send: async (id) => sent.push(id),
    onWebSocketMessage: async (data) => {
      forwarded.push(data);
      throw new Error("library bug");
    },
  };
  listeners.ws_message = () => assert.fail("original listener must be removed");
  return { socket, listeners, sent, forwarded };
};

describe("socket guard", () => {
  it("flags events_api envelopes without an event, with the rate limit's workspace and minute", () => {
    assert.deepEqual(eventlessEnvelope(rateLimited), { id: "e1", kind: "app_rate_limited", team: "T000TEAM", minute: 1760648700 });
    assert.deepEqual(eventlessEnvelope({ type: "events_api", envelope_id: "e3", payload: {} }), { id: "e3", kind: "unknown", team: undefined, minute: undefined });
    assert.equal(eventlessEnvelope({ type: "events_api", envelope_id: "e2", payload: { event: { type: "message" } } }), undefined);
    assert.equal(eventlessEnvelope({ type: "hello" }), undefined);
    assert.equal(eventlessEnvelope(undefined), undefined);
  });

  it("acks and skips eventless envelopes, forwards the rest, and never rejects", async () => {
    const { socket, listeners, sent, forwarded } = fakeSocket();
    const lines = [];
    const skipped = [];
    guardSocket(socket, (l) => lines.push(l), (kind, info) => skipped.push([kind, info]));
    listeners.ws_message(JSON.stringify(rateLimited), false);
    listeners.ws_message(JSON.stringify({ type: "events_api", envelope_id: "e2", payload: { event: { type: "message" } } }), false);
    listeners.ws_message("not json", false);
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(sent, ["e1"]);
    assert.deepEqual(skipped, [["app_rate_limited", { team: "T000TEAM", minute: 1760648700 }]]);
    assert.equal(forwarded.length, 2);
    assert.equal(lines[0], "skipped events_api envelope without event (app_rate_limited, team T000TEAM, since Thu 10/16 14:05 PT)");
    assert.match(lines[1], /socket message error: library bug/);
  });

  it("logs the kind alone when an eventless envelope has no rate-limit fields", () => {
    const { socket, listeners } = fakeSocket();
    const lines = [];
    guardSocket(socket, (l) => lines.push(l));
    listeners.ws_message(JSON.stringify({ type: "events_api", envelope_id: "e1", payload: { type: "app_rate_limited" } }), false);
    assert.equal(lines[0], "skipped events_api envelope without event (app_rate_limited)");
  });

  it("logs each hello's app id and open connections, and still forwards it", async () => {
    const { socket, listeners, forwarded } = fakeSocket();
    const lines = [];
    guardSocket(socket, (l) => lines.push(l));
    listeners.ws_message(JSON.stringify({ type: "hello", num_connections: 2, connection_info: { app_id: "A000APP" } }), false);
    listeners.ws_message(new TextEncoder().encode(JSON.stringify({ type: "hello", num_connections: 1, connection_info: { app_id: "A000APP" } })), false);
    await new Promise((r) => setImmediate(r));
    assert.equal(forwarded.length, 2);
    assert.deepEqual(
      lines.filter((l) => l.startsWith("hello")),
      ["hello: app A000APP, 2 open connections", "hello: app A000APP, 1 open connection"],
    );
  });
});
