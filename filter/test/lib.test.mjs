import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { loadFilterConfig, parseFilterConfig, readSecrets, signatureProblem } from "../lib.mjs";

const now = Date.parse("2025-10-16T21:05:00Z");
const sign = (secret, timestamp, delivery, body) =>
  `sha256=${createHmac("sha256", secret).update(`${timestamp}.${delivery}.${body}`).digest("hex")}`;

describe("filter config", () => {
  it("applies defaults", () => {
    assert.deepEqual(parseFilterConfig(), {
      secretFile: join(homedir(), ".config/qitt/secrets/relay-hmac-secret"),
      secretRequired: false,
      signatureHeader: "x-signature",
      timestampHeader: "x-timestamp",
      deliveryIdHeader: "x-delivery-id",
      maxSkewMs: 300_000,
    });
  });

  it("takes header names and the secret file from config", () => {
    const cfg = parseFilterConfig({
      secretFile: "~/hooks/secret",
      signatureHeader: "X-Hook-Signature",
      timestampHeader: "X-Hook-Timestamp",
      deliveryIdHeader: "X-Hook-Delivery-Id",
      maxSkewSeconds: 60,
    });
    assert.equal(cfg.secretFile, join(homedir(), "hooks/secret"));
    assert.equal(cfg.secretRequired, true);
    assert.equal(cfg.signatureHeader, "x-hook-signature");
    assert.equal(cfg.timestampHeader, "x-hook-timestamp");
    assert.equal(cfg.deliveryIdHeader, "x-hook-delivery-id");
    assert.equal(cfg.maxSkewMs, 60_000);
  });

  it("rejects bad config", () => {
    assert.throws(() => parseFilterConfig([]), /object/);
    assert.throws(() => parseFilterConfig({ signatureHeader: "X Sig" }), /signatureHeader/);
    assert.throws(() => parseFilterConfig({ timestampHeader: 1 }), /timestampHeader/);
    assert.throws(() => parseFilterConfig({ secretFile: "" }), /secretFile/);
    assert.throws(() => parseFilterConfig({ maxSkewSeconds: 0 }), /maxSkewSeconds/);
  });

  const dir = mkdtempSync(join(tmpdir(), "qitt-filter-test-"));
  after(() => rmSync(dir, { recursive: true, force: true }));

  it("loads a missing config file as defaults", () => {
    assert.deepEqual(loadFilterConfig(join(dir, "missing.json")), parseFilterConfig());
  });

  it("reads secrets, and requires an explicit secret file to exist", () => {
    const file = join(dir, "secret");
    writeFileSync(file, " one , two\n");
    assert.deepEqual(readSecrets({ secretFile: file, secretRequired: true }), ["one", "two"]);
    assert.deepEqual(readSecrets({ secretFile: join(dir, "none"), secretRequired: false }), []);
    assert.throws(() => readSecrets({ secretFile: join(dir, "none"), secretRequired: true }), /does not exist/);
    writeFileSync(file, " \n");
    assert.throws(() => readSecrets({ secretFile: file, secretRequired: false }), /empty/);
  });
});

describe("signatureProblem", () => {
  const cfg = parseFilterConfig({ signatureHeader: "X-Hook-Signature", timestampHeader: "X-Hook-Timestamp", deliveryIdHeader: "X-Hook-Delivery-Id" });
  const body = Buffer.from('{"id":"d-1"}');
  const headers = (fields) => ({
    "x-hook-timestamp": String(now),
    "x-hook-delivery-id": "d-1",
    "x-hook-signature": sign("s1", now, "d-1", body),
    ...fields,
  });
  const check = (h, secrets = ["s1"], at = now) => signatureProblem(h, body, { secrets, cfg, now: at });

  it("accepts a good signature under the configured headers", () => {
    assert.equal(check(headers()), undefined);
    assert.equal(check(headers({ "x-hook-timestamp": String(now / 1000), "x-hook-signature": sign("s1", now / 1000, "d-1", body) })), undefined);
  });
  it("accepts any secret during rotation", () => assert.equal(check(headers(), ["old", "s1"]), undefined));
  it("skips the check without secrets", () => assert.equal(check({}, []), undefined));
  it("rejects unsigned, stale, and bad deliveries", () => {
    assert.equal(check({}), "unsigned");
    assert.equal(check({ "x-signature": sign("s1", now, "d-1", body), "x-timestamp": String(now), "x-delivery-id": "d-1" }), "unsigned");
    assert.equal(check(headers(), ["s1"], now + 301_000), "stale timestamp");
    assert.equal(check(headers({ "x-hook-signature": sign("s2", now, "d-1", body) })), "bad signature");
    assert.equal(check(headers({ "x-hook-delivery-id": "d-2" })), "bad signature");
  });
});
