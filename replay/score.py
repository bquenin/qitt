#!/usr/bin/env python3
"""Score a shadow-mode replay run against what actually happened.

Usage: score.py <replay dir> <run name>

Inputs (in the replay dir): batches.jsonl, links.jsonl, t3-threads.jsonl, slack-events.jsonl,
jira-events.jsonl, runs/<run>/decisions.jsonl. Writes runs/<run>/score.md (metrics plus the items
worth reviewing by hand) and prints the metrics.

Each decision line is one item. An item's ground truth is the strongest outcome among its events:
  worked    I started a T3 thread from one of its events
  handled   I replied in the same conversation or issue later in the window
  none      neither
"""
import json
import sys
from collections import Counter, defaultdict
from pathlib import Path

DECISIONS = ["pre-work", "brief-only", "follow-up", "remind", "ignore"]
TRUTHS = ["worked", "handled", "none"]


def load(path):
    if not path.exists():
        return []
    with path.open() as f:
        return [json.loads(line) for line in f if line.strip()]


def pct(n, d):
    return f"{100 * n / d:.0f}% ({n}/{d})" if d else "n/a"


def main():
    root, run = Path(sys.argv[1]), sys.argv[2]
    run_dir = root / "runs" / run
    links = {l["event_id"]: l for l in load(root / "links.jsonl")}
    events = {e["id"]: e for e in load(root / "slack-events.jsonl") + load(root / "jira-events.jsonl")}
    batches = load(root / "batches.jsonl")
    decisions = load(run_dir / "decisions.jsonl")

    def truth(event_ids):
        best = "none"
        for eid in event_ids:
            link = links.get(eid, {})
            if link.get("t3_threads"):
                return "worked"
            if link.get("owner_replied"):
                best = "handled"
        return best

    # Coverage: every replayed event should be decided exactly once.
    replayed = {eid for b in batches if any(d["batch"] == b["batch"] for d in decisions) for eid in b["event_ids"]}
    decided = Counter(eid for d in decisions for eid in d["event_ids"])
    missing = replayed - decided.keys()
    dupes = [eid for eid, n in decided.items() if n > 1]

    # A follow-up inherits the outcome credit of the item it was routed to, but only if qitt
    # pre-worked that source key earlier in the replay (decisions are appended in batch order).
    prework_keys = set()
    items = []
    for d in sorted(decisions, key=lambda d: d["batch"]):
        t = truth(d["event_ids"])
        # A follow-up names the item it continues (routed_to); older runs only have source_key.
        target = d.get("routed_to") or d["source_key"]
        items.append({**d, "truth": t, "covered_by_prework": d["decision"] == "pre-work"
                      or (d["decision"] == "follow-up" and target in prework_keys)})
        if d["decision"] == "pre-work":
            prework_keys.add(d["source_key"])

    matrix = defaultdict(Counter)
    for i in items:
        matrix[i["decision"]][i["truth"]] += 1

    worked = [i for i in items if i["truth"] == "worked"]
    prework = [i for i in items if i["decision"] == "pre-work"]
    ignored = [i for i in items if i["decision"] == "ignore"]

    # T3 threads that started from a Slack link no replayed event matches: the intake never saw them.
    linked_threads = {t for eid, l in links.items() if eid in replayed for t in l.get("t3_threads", [])}
    unseen = [t for t in load(root / "t3-threads.jsonl")
              if t.get("slack_links") and t["thread_id"] not in linked_threads]

    lines = [f"# Replay score: {run}", ""]
    lines += [f"- Batches replayed: {len({d['batch'] for d in decisions})} of {len(batches)}",
              f"- Events decided: {len(decided)} of {len(replayed)} replayed"
              f" (missing {len(missing)}, decided twice {len(dupes)})",
              f"- Items: {len(items)}", ""]
    lines += ["## Decision x outcome", "", "| decision | " + " | ".join(TRUTHS) + " | total |",
              "| --- | " + " | ".join("---" for _ in TRUTHS) + " | --- |"]
    for dec in DECISIONS:
        row = matrix.get(dec, Counter())
        lines.append(f"| {dec} | " + " | ".join(str(row[t]) for t in TRUTHS) + f" | {sum(row.values())} |")
    lines += ["", "## Headline", "",
              f"- **Recall on work I started:** {pct(sum(i['covered_by_prework'] for i in worked), len(worked))}"
              " of worked items were pre-worked (or routed to a pre-worked item)",
              f"- **Surfaced at all:** {pct(sum(i['decision'] != 'ignore' for i in worked), len(worked))}"
              " of worked items were not ignored",
              f"- **Pre-work I engaged with:** {pct(sum(i['truth'] != 'none' for i in prework), len(prework))}"
              " of pre-work items were worked or handled",
              f"- **Ignored but worked:** {sum(i['truth'] == 'worked' for i in ignored)} items;"
              f" ignored but handled: {sum(i['truth'] == 'handled' for i in ignored)}",
              f"- **Threads the intake never saw:** {len(unseen)} T3 threads started from a Slack link"
              " that matches no replayed event", ""]

    headline = list(lines)

    def review(title, rows):
        out = [f"## {title} ({len(rows)})", ""]
        for i in rows:
            ev = events.get(i["event_ids"][0], {})
            link = ev.get("permalink") or ev.get("url") or ""
            out.append(f"- b{i['batch']} {i['decision']} / {i['truth']} · {i.get('requester', '')} · "
                       f"{i.get('ask', '')} · _{i.get('reason', '')}_ · {link}")
        return out + [""]

    lines += review("Worked but not pre-worked", [i for i in worked if not i["covered_by_prework"]])
    lines += review("Pre-work with no engagement", [i for i in prework if i["truth"] == "none"])
    lines += review("Remind (check by hand)", [i for i in items if i["decision"] == "remind"])
    lines += [f"## Threads the intake never saw ({len(unseen)})", ""]
    lines += [f"- {t['created_pt']} · {t['title']} · {t['slack_links'][0]}" for t in unseen]

    (run_dir / "score.md").write_text("\n".join(lines) + "\n")
    print("\n".join(headline))
    print(f"full report: {run_dir / 'score.md'}")


if __name__ == "__main__":
    main()
