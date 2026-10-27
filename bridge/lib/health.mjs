// Bridge health, told to qitt. A problem that can lose or delay messages becomes a bridge_health
// event in the next batch, so qitt can tell me instead of it sitting in the log. Each kind is sent
// at most once per quietMs; every report is logged.
import { timeLocal } from "./time.mjs";

export class Health {
  constructor({ batcher, log = () => {}, now = () => Date.now(), quietMs = 3600_000, rateLimitMs = 600_000, rateLimitGapMs = 180_000 }) {
    this.batcher = batcher;
    this.log = log;
    this.now = now;
    this.quietMs = quietMs;
    this.rateLimitMs = rateLimitMs;
    this.rateLimitGapMs = rateLimitGapMs;
    this.last = new Map(); // kind -> ms last sent
    this.streak = undefined; // { start, last } of app_rate_limited envelopes
  }

  // Sends one bridge_health event unless this kind went out in the last quietMs. True when sent.
  report(kind, text) {
    const now = this.now();
    if (now - (this.last.get(kind) ?? -Infinity) < this.quietMs) return false;
    this.last.set(kind, now);
    this.log(`health ${kind}: ${text}`);
    this.batcher.add({
      id: `bridge:health:${kind}:${now}`,
      source: "bridge",
      health: kind,
      ts: (now / 1000).toFixed(6),
      time_local: timeLocal(new Date(now)),
      text,
    });
    return true;
  }

  // Slack sends app_rate_limited about once a minute while it drops live events. A short burst is
  // left to search; a streak of rateLimitMs (no gap over rateLimitGapMs) is reported.
  rateLimited() {
    const now = this.now();
    if (!this.streak || now - this.streak.last > this.rateLimitGapMs) this.streak = { start: now, last: now };
    this.streak.last = now;
    if (now - this.streak.start < this.rateLimitMs) return false;
    return this.report(
      "slack_rate_limited",
      `Slack has been rate-limiting the bridge's live events (app_rate_limited) since ${timeLocal(new Date(this.streak.start))} and drops them meanwhile; search catches up within about a minute. The usual cause is the Slack app subscribing to more than message.im and message.mpim.`,
    );
  }
}
