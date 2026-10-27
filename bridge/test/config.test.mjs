import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { parseConfig, readToken } from "../lib/config.mjs";
import { systemTimezone } from "../lib/time.mjs";
import { redact } from "../lib/log.mjs";

describe("config", () => {
  it("applies defaults and expands ~", () => {
    assert.deepEqual(parseConfig({ me: "U000ME" }), {
      me: "U000ME",
      groups: [],
      watchChannels: [],
      supportChannels: [],
      ignoreBots: true,
      batchWindowSeconds: 20,
      savedPollSeconds: 300,
      searchPollSeconds: 60,
      reconcileMinutes: 15,
      timezone: systemTimezone(),
      timezoneLabel: null,
      webhookUrlFile: join(homedir(), ".config/qitt/secrets/webhook-slack.local.url"),
      mutedFile: join(homedir(), ".local/state/qitt/muted.json"),
    });
  });
  it("rejects bad config", () => {
    assert.throws(() => parseConfig({}), /me is required/);
    assert.throws(() => parseConfig({ me: "U000ME", groups: "S000GROUP" }), /groups/);
    assert.throws(() => parseConfig({ me: "U000ME", supportChannels: "C000SUPPORT" }), /supportChannels/);
    assert.throws(() => parseConfig({ me: "U000ME", batchWindowSeconds: 0 }), /batchWindowSeconds/);
    assert.throws(() => parseConfig({ me: "U000ME", savedPollSeconds: -1 }), /savedPollSeconds/);
    assert.throws(() => parseConfig({ me: "U000ME", savedPollSeconds: "300" }), /savedPollSeconds/);
    assert.throws(() => parseConfig({ me: "U000ME", searchPollSeconds: -1 }), /searchPollSeconds/);
    assert.throws(() => parseConfig({ me: "U000ME", reconcileMinutes: -1 }), /reconcileMinutes/);
    assert.throws(() => parseConfig({ me: "U000ME", timezone: "Mars/Olympus" }), /timezone must be an IANA/);
    assert.throws(() => parseConfig({ me: "U000ME", timezone: 1 }), /timezone must be an IANA/);
    assert.throws(() => parseConfig({ me: "U000ME", timezoneLabel: "" }), /timezoneLabel/);
  });
  it("takes an explicit timezone and label", () => {
    const c = parseConfig({ me: "U000ME", timezone: "Europe/Paris", timezoneLabel: "CET" });
    assert.equal(c.timezone, "Europe/Paris");
    assert.equal(c.timezoneLabel, "CET");
  });

  const dir = mkdtempSync(join(tmpdir(), "qitt-bridge-test-"));
  after(() => rmSync(dir, { recursive: true, force: true }));
  it("reads a token and checks its prefix without echoing it", () => {
    const file = join(dir, "token");
    writeFileSync(file, "xapp-fake-123\n");
    assert.equal(readToken(file, "xapp-"), "xapp-fake-123");
    assert.throws(() => readToken(file, "xoxp-"), (err) => !err.message.includes("fake-123"));
  });
});

describe("redact", () => {
  it("hides tokens and URLs", () => {
    const line = redact("got xoxp-1-2-abc and xapp-1-A0-xyz from http://127.0.0.1:1/api/hooks/a/b and wss://x.invalid/link?t=1");
    assert.doesNotMatch(line, /abc|xyz|hooks|127\.0\.0\.1|wss/);
  });
});
