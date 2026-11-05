// Live event traffic. Slack delivers at most 30,000 events per workspace per app per 60 minutes;
// over that it drops live events, DMs included, and sends app_rate_limited once a minute while
// search and the reconciler catch up. Every message in every channel I am in counts, so this counts
// each events_api envelope by workspace, authorizing user, channel and event type, in one-minute
// buckets kept for an hour, to show which channels use the budget up. It logs the last
// reportMinutes every reportMinutes, and a workspace's last hour when Slack starts rate-limiting
// it. Ids only: it makes no Slack calls.
const minuteMs = 60_000;
const hourMinutes = 60;

const sum = (values) => [...values].reduce((a, b) => a + b, 0);

// [label, count] pairs of counts grouped by pick(fields), busiest first.
const group = (counts, pick) => {
  const groups = new Map();
  for (const [key, n] of counts) {
    const label = pick(key.split("\t"));
    groups.set(label, (groups.get(label) ?? 0) + n);
  }
  return [...groups].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
};

// "a 3, b 2, 4 others 5": the first top pairs, then how many more and their total.
const list = (pairs, top = Infinity, others = "others") => {
  const shown = pairs.slice(0, top).map(([label, n]) => `${label} ${n}`);
  const rest = pairs.slice(top);
  if (rest.length) shown.push(`${rest.length} ${others} ${sum(rest.map(([, n]) => n))}`);
  return shown.join(", ");
};

export class Traffic {
  constructor({ me, log = () => {}, now = () => Date.now(), reportMinutes = 10, top = 15, gapMs = 180_000 }) {
    this.me = me;
    this.log = log;
    this.now = now;
    this.reportMinutes = reportMinutes;
    this.top = top;
    this.gapMs = gapMs; // a rate-limit streak ends after this long without a notice, as in Health
    this.started = now();
    this.buckets = new Map(); // minute -> Map(key -> count)
    this.limited = new Map(); // workspace -> ms of its latest app_rate_limited
    this.timer = undefined;
  }

  // Counts one events_api payload: { team_id, authorizations, event }.
  count(body) {
    const event = body?.event ?? {};
    const auth = body?.authorizations?.[0];
    const channel = [event.channel, event.item?.channel, event.channel_id].find((c) => typeof c === "string") ?? "-";
    const key = [
      body?.team_id ?? "?",
      auth ? `${auth.user_id ?? "?"}${auth.is_bot ? " (bot)" : ""}` : "?",
      event.channel_type ? `${channel} (${event.channel_type})` : channel,
      event.subtype ? `${event.type}/${event.subtype}` : (event.type ?? "?"),
    ].join("\t");
    const minute = Math.floor(this.now() / minuteMs);
    let bucket = this.buckets.get(minute);
    if (!bucket) {
      bucket = new Map();
      this.buckets.set(minute, bucket);
      for (const m of this.buckets.keys()) if (m <= minute - hourMinutes) this.buckets.delete(m);
    }
    bucket.set(key, (bucket.get(key) ?? 0) + 1);
  }

  // Counts per key over the last `minutes` minutes, the current one included, for one workspace or all.
  #counts(minutes, team) {
    const from = Math.floor(this.now() / minuteMs) - minutes + 1;
    const counts = new Map();
    for (const [minute, bucket] of this.buckets) {
      if (minute < from) continue;
      for (const [key, n] of bucket) {
        if (team !== undefined && !key.startsWith(`${team}\t`)) continue;
        counts.set(key, (counts.get(key) ?? 0) + n);
      }
    }
    return counts;
  }

  // Logs the last `minutes` (at most an hour) in three lines: the total and each workspace's last
  // hour (what Slack holds against 30,000), events authorized for anyone but me, then the busiest
  // event types and channels. tag says why, team limits it to one workspace.
  report(minutes = this.reportMinutes, { team, tag } = {}) {
    const prefix = tag ? `traffic ${tag}` : "traffic";
    const uptime = Math.max(1, Math.ceil((this.now() - this.started) / minuteMs));
    const span = Math.min(minutes, hourMinutes, uptime);
    const counts = this.#counts(span, team);
    const total = sum(counts.values());
    if (!total) {
      this.log(`${prefix}: no live events in the last ${span}m`);
      return;
    }
    const hour = group(this.#counts(Math.min(hourMinutes, uptime), team), ([t]) => t);
    const others = group(counts, ([, auth]) => auth).filter(([auth]) => auth !== this.me && auth !== "?");
    this.log(
      `${prefix}: ${total} live events in the last ${span}m (~${Math.round((total * hourMinutes) / span)}/h); ` +
        `last ${Math.min(hourMinutes, uptime)}m by workspace: ${list(hour)}` +
        (others.length ? `; authorized for others: ${list(others, 5)}` : ""),
    );
    this.log(`${prefix} types: ${list(group(counts, ([, , , type]) => type), 10, "other types")}`);
    this.log(`${prefix} channels: ${list(group(counts, ([, , channel]) => channel), this.top, "other channels")}`);
  }

  // One app_rate_limited notice ({ team }): when it starts a workspace's streak, logs that
  // workspace's last hour, the traffic that went over the limit. True when it logged.
  rateLimited({ team } = {}) {
    const now = this.now();
    const key = team ?? "?";
    const last = this.limited.get(key);
    this.limited.set(key, now);
    if (last !== undefined && now - last <= this.gapMs) return false;
    this.report(hourMinutes, { team, tag: `at rate limit of ${key}` });
    return true;
  }

  start() {
    if (!this.reportMinutes || this.timer) return;
    this.timer = setInterval(() => this.report(), this.reportMinutes * minuteMs);
    this.timer.unref?.();
  }

  stop() {
    clearInterval(this.timer);
    this.timer = undefined;
  }
}
