#!/usr/bin/env python3
"""Writes architecture.svg, the diagram in docs/architecture.md. Standard library only.

    python3 docs/images/architecture.py

Then render architecture.png from it at twice the size, with any SVG renderer. With Chrome:

    chrome --headless --hide-scrollbars --force-device-scale-factor=2 --window-size=1530,912 \
        --screenshot=docs/images/architecture.png docs/images/architecture.svg

Text is laid out by hand: every line of a box is one string below, so check the PNG after an edit.
"""
from pathlib import Path
from xml.sax.saxutils import escape

W, H = 1530, 912
FONT = "Helvetica, Arial, sans-serif"
INK, MUTED = "#27272a", "#52525b"
BLUE, BLUE_FILL, BLUE_TITLE = "#2f6db5", "#eaf2fb", "#1e4f8a"
GREEN, GREEN_FILL, GREEN_TITLE = "#2f855a", "#edf7ef", "#22543d"
GREY, GREY_FILL = "#71717a", "#f4f4f5"

out = []


def rect(x, y, w, h, fill, stroke, width=2, rx=12, dash=None):
    extra = f' stroke-dasharray="{dash}"' if dash else ""
    out.append(
        f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="{rx}" fill="{fill}" '
        f'stroke="{stroke}" stroke-width="{width}"{extra}/>'
    )


def text(x, y, string, size=12.5, weight="normal", fill=INK, anchor="start"):
    out.append(
        f'<text x="{x}" y="{y}" font-family="{FONT}" font-size="{size}" font-weight="{weight}" '
        f'fill="{fill}" text-anchor="{anchor}">{escape(string)}</text>'
    )


def group(x, y, w, h, title, fill, stroke, title_fill):
    rect(x, y, w, h, fill, stroke, rx=16)
    text(x + 18, y + 28, title, 17, "bold", title_fill)


def box(x, y, w, h, title, lines, stroke=BLUE, fill="#ffffff", width=2, dash=None, title_fill=INK):
    rect(x, y, w, h, fill, stroke, width, dash=dash)
    text(x + 16, y + 26, title, 15, "bold", title_fill)
    for i, line in enumerate(lines):
        text(x + 16, y + 48 + 18 * i, line)


def arrow(points):
    path = " ".join(f"{'M' if i == 0 else 'L'}{x},{y}" for i, (x, y) in enumerate(points))
    out.append(f'<path d="{path}" fill="none" stroke="{INK}" stroke-width="1.6" marker-end="url(#head)"/>')


def label(x, y, lines, anchor="middle"):
    for i, line in enumerate(lines):
        text(x, y + 15 * i, line, 11.5, fill=MUTED, anchor=anchor)


out.append(f'<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{H}" viewBox="0 0 {W} {H}">')
out.append(
    '<defs><marker id="head" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" '
    f'orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="{INK}"/></marker></defs>'
)
out.append(f'<rect x="0" y="0" width="{W}" height="{H}" fill="#ffffff"/>')

text(30, 42, "qitt: a proactive chief of staff inside T3 Code", 24, "bold")
text(30, 68, "One pinned thread reads the requests that reach its owner, decides what each one needs, and hands the "
     "research to worker threads, so a brief and a proposed", 14, fill=MUTED)
text(30, 88, "reply are ready ahead of time. It never sends anything for its owner. Every source of requests is a "
     "module, and the core does not change when one is added.", 14, fill=MUTED)

# Sources: one module per place requests come from.
group(30, 110, 350, 662, "Sources: one module each", GREEN_FILL, GREEN, GREEN_TITLE)
box(50, 160, 310, 150, "Slack", [
    "slack-bridge holds a Socket Mode",
    "connection for DMs and polls search for",
    "mentions and the owner's threads. It",
    "filters, dedupes and batches. It only reads.",
], GREEN)
box(50, 330, 310, 112, "JIRA", [
    "An automation rule calls a webhook relay",
    "on each issue event. The relay signs",
    "every delivery (HMAC).",
], GREEN)
box(50, 462, 310, 130, "Your source", [
    "Teams, email, GitHub, a pager: its own",
    "webhooks through the filter, or a small",
    "bridge that posts on localhost.",
], GREEN, dash="7 5")
box(50, 630, 310, 132, "Tools for the agents", [
    "MCP servers and skills to read each",
    "source and save drafts. Each module",
    "lists the send tools to deny, so nothing",
    "goes out in the owner's name.",
], GREEN)

# The one piece between outside callers and T3.
box(420, 330, 180, 262, "Hook filter", [
    "The only port open to",
    "outside callers.",
    "",
    "Forwards /api/hooks/*",
    "to T3, checks the",
    "HMAC signature, and",
    "drops duplicates.",
], GREY, GREY_FILL)

# T3 Code: everything qitt is made of.
group(650, 110, 520, 662, "T3 Code server, on one always-on machine", BLUE_FILL, BLUE, BLUE_TITLE)
box(670, 160, 480, 118, "Scheduled tasks, bound to the qitt thread", [
    "One webhook task per source: each delivery becomes a turn in the qitt",
    "thread, with the module's intake.md as its prompt. Plus a weekday sweep.",
])
box(670, 328, 480, 200, "qitt: the pinned thread", [
    "Charter = core rules + one section per installed source + the local",
    "context, assembled by bin/install-agents.",
    "",
    "For each item it decides: nothing needed, a reminder, a short brief,",
    "a follow-up in the thread that owns it, or a new worker.",
    "It searches open, settled and peer threads before starting one,",
    "and keeps the board of all work in flight.",
], width=3.5, title_fill=BLUE_TITLE)
box(670, 620, 230, 132, "Worker threads", [
    "One per request. Read the source",
    "in full, gather evidence, write",
    "a brief and a proposed reply.",
    "Research only.",
])
box(920, 620, 230, 132, "Hand-started threads", [
    "Work the owner began by hand",
    "owns its follow-ups too. qitt sends",
    "them there, which wakes the thread.",
])

# Outside the server.
box(1250, 160, 250, 118, "Two rules", [
    "1. It never sends for its owner.",
    "2. T3 constructs only: threads",
    "and scheduled tasks.",
], GREY, GREY_FILL)
box(1250, 328, 250, 200, "The owner", [
    "Asks qitt anything, without giving",
    "context.",
    "",
    "Reads the briefs, edits the drafts",
    "and sends them.",
    "Settles threads when they are done.",
], GREY)
box(1250, 620, 250, 132, "Peer T3 servers", [
    "For example a laptop, for work",
    "only that machine can do. qitt",
    "lists, searches and launches",
    "threads there.",
], GREY)

# How a request travels.
arrow([(360, 205), (670, 205)])
label(515, 197, ["batches, POST on localhost"])
arrow([(360, 386), (420, 386)])
arrow([(360, 527), (420, 527)])
arrow([(510, 330), (510, 250), (670, 250)])
label(592, 268, ["signed deliveries"])
arrow([(910, 278), (910, 328)])
label(920, 308, ["each delivery wakes qitt"], "start")
arrow([(690, 528), (690, 620)])
label(698, 568, ["t3_thread_launch", "+ work-item header"], "start")
arrow([(826, 620), (826, 528)])
label(834, 576, ["ready / blocked"], "start")
arrow([(1035, 528), (1035, 620)])
label(1027, 568, ["follow-up,", "t3_thread_send"], "end")
arrow([(1105, 528), (1105, 574), (1375, 574), (1375, 620)])
label(1272, 566, ["list, search, launch"])
arrow([(1250, 398), (1150, 398)])
label(1211, 390, ["questions"])
arrow([(1150, 458), (1250, 458)])
label(1211, 450, ["the board"])
arrow([(670, 696), (360, 696)])
label(515, 688, ["read the source, save drafts"])

# What a module is.
rect(30, 802, 1470, 84, "#ffffff", GREY, 1.5)
text(48, 834, "A source module is a folder.", 13.5, "bold")
text(236, 834, "sources/<name>/ holds qitt.md and worker.md (charter sections), intake.md (the webhook task's prompt), "
     "deny.txt (send tools to block) and, if it needs one, a bridge.", 13.5)
text(48, 860, "List it in ~/.config/qitt/sources.txt, run bin/install-agents, and have the qitt thread create its "
     "webhook task. A module of your own can also live in ~/.config/qitt/sources/, outside the repo.", 13.5)

out.append("</svg>")
Path(__file__).with_name("architecture.svg").write_text("\n".join(out) + "\n")
