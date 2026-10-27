#!/usr/bin/env python3
"""Turn exported Slack and JIRA events into replay batches for a shadow-mode qitt thread.

Usage: batch.py <replay dir> [--hours N] [--timezone IANA-NAME]

Reads slack-events.jsonl and jira-events.jsonl from the replay dir and writes batches.jsonl there:
one line per batch, {"batch": n, "start": iso, "end": iso, "event_ids": [...], "message": "..."}.
Batch labels are in --timezone (default: the system timezone); event times are the exported
`time_local` labels.

Mirrors what the live intake would deliver: bot messages and my own messages are dropped (qitt
decides before I reply), and events are grouped into fixed windows in time order.
"""
import argparse
import json
from datetime import datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo


def load(path):
    if not path.exists():
        return []
    with path.open() as f:
        return [json.loads(line) for line in f if line.strip()]


def slack_items(rows):
    for e in rows:
        if e.get("from_me") or e.get("is_bot"):
            continue
        root = e.get("thread_ts") or e["ts"]
        yield {
            "id": e["id"],
            "at": datetime.fromtimestamp(float(e["ts"]), timezone.utc),
            "lines": [
                f"- id: {e['id']}",
                f"  source: slack {e['channel_type']}"
                + (f" #{e['channel_name']}" if e.get("channel_name") and e["channel_type"] == "channel" else ""),
                f"  source-key: slack:{e['channel_id']}:{root}",
                f"  from: {e['user_name']} ({e['user_id']})",
                f"  time: {e['time_local']}",
                f"  mentions me: {'yes' if e.get('mentions_me') else 'no'}",
                f"  link: {e['permalink']}",
                "  text: |",
                *("    " + line for line in (e.get("text") or "").splitlines() or [""]),
            ],
        }


def jira_items(rows):
    for e in rows:
        yield {
            "id": e["id"],
            "at": datetime.fromisoformat(e["timestamp"].replace("Z", "+00:00")),
            "lines": [
                f"- id: {e['id']}",
                f"  source: jira {e['event']}",
                f"  source-key: jira:{e['issue_key']}",
                f"  issue: {e['issue_key']} {e.get('summary', '')}",
                f"  from: {e['actor_name']} ({e['actor_id']})",
                f"  time: {e['time_local']}",
                f"  link: {e['url']}",
                "  text: |",
                *("    " + line for line in (e.get("text") or "").splitlines() or [""]),
            ],
        }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("dir", type=Path)
    # Whole hours only: windows start on the hour, so a fractional window could open before its events.
    ap.add_argument("--hours", type=int, default=4)
    ap.add_argument("--timezone", help="IANA name for batch labels (default: system timezone)")
    args = ap.parse_args()
    if args.hours < 1:
        ap.error("--hours must be at least 1")
    # None converts to the system timezone, with its DST rules at each date.
    tz = ZoneInfo(args.timezone) if args.timezone else None

    items = sorted(
        [*slack_items(load(args.dir / "slack-events.jsonl")), *jira_items(load(args.dir / "jira-events.jsonl"))],
        key=lambda i: i["at"],
    )
    window = timedelta(hours=args.hours)
    batches, current, start = [], [], None
    for item in items:
        if start is None or item["at"] >= start + window:
            if current:
                batches.append((start, current))
            # Align windows to the hour so batch boundaries are easy to read.
            start = item["at"].replace(minute=0, second=0, microsecond=0)
            current = []
        current.append(item)
    if current:
        batches.append((start, current))

    out = args.dir / "batches.jsonl"
    with out.open("w") as f:
        for n, (start, group) in enumerate(batches, 1):
            end = start + window
            label = f"{start.astimezone(tz):%a %-m/%-d %H:%M}–{end.astimezone(tz):%H:%M %Z}"
            message = "\n".join(
                [f"Intake batch {n} ({label}), {len(group)} events:", "", *(l for i in group for l in i["lines"])]
            )
            f.write(json.dumps({
                "batch": n,
                "start": start.isoformat(),
                "end": end.isoformat(),
                "event_ids": [i["id"] for i in group],
                "message": message,
            }) + "\n")
    print(f"{len(items)} events -> {len(batches)} batches of {args.hours:g}h in {out}")


if __name__ == "__main__":
    main()
