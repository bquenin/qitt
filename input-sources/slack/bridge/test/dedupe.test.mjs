import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Recent } from "../lib/dedupe.mjs";

describe("Recent", () => {
  it("remembers keys", () => {
    const recent = new Recent(10);
    assert.equal(recent.remember("a"), true);
    assert.equal(recent.remember("a"), false);
    assert.equal(recent.remember("b"), true);
  });
  it("forgets the oldest key past its limit", () => {
    const recent = new Recent(3);
    for (const key of ["a", "b", "c", "d"]) recent.remember(key);
    assert.equal(recent.keys.size, 3);
    assert.equal(recent.remember("b"), false);
    assert.equal(recent.remember("a"), true);
  });
});
