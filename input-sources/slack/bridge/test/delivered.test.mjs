import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { Delivered, deliveredFilePath } from "../lib/delivered.mjs";

const now = Date.parse("2025-10-16T21:05:00Z");
const id = "slack:D1:1760648700.000100";
const ts = "1760648700.000100";

describe("delivered", () => {
  const dir = mkdtempSync(join(tmpdir(), "qitt-delivered-test-"));
  after(() => rmSync(dir, { recursive: true, force: true }));

  it("holds a remembered id as pending until its batch is committed", () => {
    const file = join(dir, "delivered.json");
    const a = new Delivered({ file, now: () => now });
    assert.equal(a.remember(id, ts), true);
    assert.equal(a.remember(id, ts), false);
    assert.equal(Math.floor(a.oldestPendingMs()), 1760648700000);
    assert.equal(existsSync(file), false);
    // A restart before the commit forgets it.
    assert.equal(new Delivered({ file, now: () => now }).has(id), false);

    a.commit([id, "slack:D1:not-pending"]);
    assert.equal(a.oldestPendingMs(), undefined);
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.deepEqual(Object.keys(JSON.parse(readFileSync(file, "utf8")).delivered), [id]);
    const b = new Delivered({ file, now: () => now });
    assert.equal(b.has(id), true);
    assert.equal(b.remember(id, ts), false);
  });

  it("treats a message under another id but a known alias as remembered, pending or committed", () => {
    const file = join(dir, "aliases.json");
    const d = new Delivered({ file, now: () => now });
    assert.equal(d.remember(id, ts, [`user:U1:${ts}`]), true);
    assert.equal(d.remember(`slack:C2:${ts}`, ts, [`user:U1:${ts}`]), false);
    assert.equal(d.remember(`slack:C2:${ts}`, ts, [`user:U2:${ts}`]), true);
    d.commit([id]);
    assert.deepEqual(Object.keys(JSON.parse(readFileSync(file, "utf8")).delivered).sort(), [id, `user:U1:${ts}`].sort());
    const restarted = new Delivered({ file, now: () => now });
    assert.equal(restarted.remember(`slack:C3:${ts}`, ts, [`user:U1:${ts}`]), false);
    assert.equal(Math.floor(d.oldestPendingMs()), 1760648700000);
  });

  it("teaches a known id from an older state file its alias", () => {
    const file = join(dir, "old-format.json");
    writeFileSync(file, JSON.stringify({ delivered: { [id]: ts } }));
    const d = new Delivered({ file, now: () => now });
    assert.equal(d.remember(id, ts, [`user:U1:${ts}`]), false);
    assert.deepEqual(Object.keys(JSON.parse(readFileSync(file, "utf8")).delivered).sort(), [id, `user:U1:${ts}`].sort());
    const restarted = new Delivered({ file, now: () => now });
    assert.equal(restarted.remember(`slack:C2:${ts}`, ts, [`user:U1:${ts}`]), false);
  });

  it("teaches a pending id its alias", () => {
    const d = new Delivered({ now: () => now });
    assert.equal(d.remember(id, ts), true);
    assert.equal(d.remember(id, ts, [`user:U1:${ts}`]), false);
    assert.equal(d.remember(`slack:C2:${ts}`, ts, [`user:U1:${ts}`]), false);
  });

  it("prunes committed ids older than keepSeconds", () => {
    const file = join(dir, "prune.json");
    const d = new Delivered({ file, keepSeconds: 3600, now: () => now });
    d.remember("old", String(now / 1000 - 7200));
    d.remember("new", String(now / 1000 - 60));
    d.commit(["old", "new"]);
    assert.deepEqual(Object.keys(JSON.parse(readFileSync(file, "utf8")).delivered), ["new"]);
  });

  it("works in memory and keeps dry-run state apart", () => {
    const d = new Delivered();
    assert.equal(d.remember("x", String(Date.now() / 1000)), true);
    d.commit(["x"]);
    assert.equal(d.has("x"), true);
    assert.equal(deliveredFilePath("/h", true), "/h/.local/state/qitt/bridge-delivered.dry-run.json");
  });
});
