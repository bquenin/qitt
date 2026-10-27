import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { eventlessEnvelope, guardSocket } from "../lib/guard.mjs";

describe("socket guard", () => {
  it("flags events_api envelopes without an event", () => {
    assert.deepEqual(eventlessEnvelope(JSON.stringify({ type: "events_api", envelope_id: "e1", payload: { type: "app_rate_limited" } })), { id: "e1", kind: "app_rate_limited" });
    assert.equal(eventlessEnvelope(JSON.stringify({ type: "events_api", envelope_id: "e2", payload: { event: { type: "message" } } })), undefined);
    assert.equal(eventlessEnvelope(JSON.stringify({ type: "hello" })), undefined);
    assert.equal(eventlessEnvelope("not json"), undefined);
  });

  it("acks and skips eventless envelopes, forwards the rest, and never rejects", async () => {
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
    const lines = [];
    listeners.ws_message = () => assert.fail("original listener must be removed");
    const skipped = [];
    guardSocket(socket, (l) => lines.push(l), (kind) => skipped.push(kind));
    listeners.ws_message(JSON.stringify({ type: "events_api", envelope_id: "e1", payload: { type: "app_rate_limited" } }), false);
    listeners.ws_message(JSON.stringify({ type: "events_api", envelope_id: "e2", payload: { event: { type: "message" } } }), false);
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(sent, ["e1"]);
    assert.deepEqual(skipped, ["app_rate_limited"]);
    assert.equal(forwarded.length, 1);
    assert.match(lines[0], /without event \(app_rate_limited\)/);
    assert.match(lines[1], /socket message error: library bug/);
  });
});
