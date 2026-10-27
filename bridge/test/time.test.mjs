import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { describe, it } from "node:test";
import { configureTime, currentTimezone, systemTimezone, timeLocal, tsDate, windowLocal } from "../lib/time.mjs";

const at = tsDate("1760648700.000100"); // 2025-10-16T21:05:00Z
const timeModule = new URL("../lib/time.mjs", import.meta.url).href;

// Runs time.mjs in a fresh process with TZ set, so nothing has configured it yet.
const withSystemTz = (tz, expr) =>
  execFileSync(
    process.execPath,
    ["--input-type=module", "-e", `const t = await import(${JSON.stringify(timeModule)}); process.stdout.write(String(${expr}));`],
    { env: { ...process.env, TZ: tz }, encoding: "utf8" },
  );

describe("time", () => {
  it("defaults to the system timezone", () => {
    assert.equal(withSystemTz("Asia/Tokyo", "t.currentTimezone()"), "Asia/Tokyo");
    assert.equal(withSystemTz("Asia/Tokyo", "t.timeLocal(t.tsDate('1760648700'))"), "Fri 10/17 06:05 GMT+9");
    assert.equal(withSystemTz("America/New_York", "t.timeLocal(t.tsDate('1760648700'))"), "Thu 10/16 17:05 ET");
    assert.equal(configureTime(), systemTimezone());
  });

  it("uses an explicit timezone", () => {
    assert.equal(configureTime({ timezone: "America/Los_Angeles" }), "America/Los_Angeles");
    assert.equal(currentTimezone(), "America/Los_Angeles");
    assert.equal(timeLocal(at), "Thu 10/16 14:05 PT");
    configureTime({ timezone: "Europe/Paris" });
    assert.equal(timeLocal(at), "Thu 10/16 23:05 GMT+2");
    assert.equal(timeLocal(tsDate("1765000800")), "Sat 12/6 07:00 GMT+1");
    configureTime({ timezone: "UTC" });
    assert.equal(timeLocal(at), "Thu 10/16 21:05 UTC");
    assert.equal(windowLocal(at, tsDate("1760648880")), "21:05–21:08 UTC");
  });

  it("uses an explicit label", () => {
    configureTime({ timezone: "America/New_York", timezoneLabel: "Eastern" });
    assert.equal(timeLocal(at), "Thu 10/16 17:05 Eastern");
    assert.equal(windowLocal(at, tsDate("1760648880")), "17:05–17:08 Eastern");
    configureTime({ timezone: "America/New_York", timezoneLabel: null });
    assert.equal(timeLocal(at), "Thu 10/16 17:05 ET");
  });

  it("rejects an unknown timezone", () => {
    assert.throws(() => configureTime({ timezone: "Mars/Olympus" }), RangeError);
  });
});
