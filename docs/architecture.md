# Architecture

qitt is a chief of staff that lives inside [T3 Code](https://t3.codes/). One pinned thread reads
the requests that reach its owner, decides what each one needs, and hands the research to worker
threads, so a brief and a proposed reply are waiting before the owner looks. This page describes
the parts, how a request travels through them, and where a new source plugs in.

![qitt architecture. Sources on the left, one module each: Slack through slack-bridge, JIRA through a signing webhook relay, and a source of your own. Outside callers go through the hook filter. In the T3 Code server, one webhook task per source wakes the pinned qitt thread, which launches worker threads, sends follow-ups to threads that already own the work, and reaches peer T3 servers. Workers read the source and save drafts; send tools are denied. The owner asks qitt questions, reads the board and the briefs, and sends the drafts.](images/architecture.png)

The diagram is generated: edit [`images/architecture.py`](images/architecture.py), which writes
`architecture.svg`, then render the PNG as its header says.

## Two rules

Everything else follows from these.

1. **It never sends anything for its owner.** qitt and its workers produce text to review: a
   brief, a proposed reply, a draft saved where the answer would go. Each source lists the tools
   that send in the owner's name, and `bin/install-profiles` denies them in both profiles, so the
   rule holds even if a prompt is wrong. The only things a worker changes unasked are the routine
   field edits a ticket playbook lists.
2. **T3 constructs only.** qitt is a thread, its workers are threads, and its triggers are
   scheduled tasks bound to the thread. There is no database, queue or daemon of qitt's own: the
   state is the threads, which is also where the owner reads it. Code outside T3 exists only where
   something must hold a connection (a bridge) or stand between outside callers and T3 (the hook
   filter).

## Parts

| Part | Where | What it does |
| --- | --- | --- |
| Sources | `sources/<name>/` here, or `~/.config/qitt/sources/<name>/` | One module per place requests come from. A module brings its charter sections, its webhook task's prompt, the send tools to deny, and a bridge if it needs one. Slack and JIRA ship here. See [sources.md](sources.md). |
| Slack bridge | `sources/slack/bridge/`, kept running by `bin/qitt-bridge` | Holds a Socket Mode connection for DMs and polls Slack search for mentions, the owner's threads and watched channels. It filters, dedupes and batches what qitt should see, and POSTs each batch to the Slack webhook task on localhost. It reads Slack and never writes to it. |
| Hook filter | `filter/`, kept running by `bin/qitt-filter` | The only port outside callers reach. It forwards `POST`, `PUT` and `PATCH` on `/api/hooks/*` to T3 and answers 404 to everything else, checks each delivery's HMAC signature when a secret is configured, and drops duplicate deliveries. |
| Webhook tasks | T3 scheduled tasks, created by the qitt thread | One per source. Each delivery becomes a turn in the qitt thread, with the module's `intake.md` as its prompt. |
| Sweep task | A T3 fixed-time task, created by the qitt thread | Weekday mornings: asks qitt to run each ticket playbook's sweep, for the tickets the JIRA intake never sees. |
| qitt | The pinned thread, in the `qitt` T3 project (`profiles/qitt/`) | Triage, routing, launching workers, and the board of all work in flight. |
| Workers | Threads in the `qitt workers` T3 project (`profiles/worker/`) | One per request. A worker reads the source in full, gathers evidence, writes a brief with a proposed reply, and reports one line back to qitt. |
| Local context | `~/.config/qitt/context.md` | Everything about the owner and the workplace: who the owner is, whose requests come first, which channels someone else answers, what is out of scope, the ticket playbooks. The charters import a copy of it. |
| Peer environments | Other T3 servers, for example a laptop | qitt lists, searches and launches threads there, for work only that machine can do. |

## How a request travels

1. **Something reaches the owner in a source:** a DM, a mention, a comment on a ticket.
2. **The source delivers it to its webhook task.** The Slack bridge batches messages (20 seconds
   by default) and POSTs them on localhost. A service that calls webhooks, such as JIRA, goes
   through the hook filter, which is the only way in from outside.
3. **The task wakes qitt** with the event and the source's prompt.
4. **qitt triages each item** into exactly one of five decisions:
   - **ignore:** nothing is asked of the owner. One line with the reason.
   - **remind:** people matters and anything confidential. One line, never a worker.
   - **brief-only:** a judgment call with nothing to look up. A one-paragraph note.
   - **follow-up:** it continues work a thread already owns. qitt sends it to that thread.
   - **pre-work:** it can be researched. qitt routes it, which may start a worker.
5. **qitt routes.** Before starting anything it lists open threads, searches settled ones, and
   looks on peer environments: is this new work, or the next message in something a thread
   already owns? This is a judgment call, and it is the hard part. Threads the owner started by
   hand count as owners of their work too.
6. **A worker does the research.** It gets a header (requester, source, source key, charter) and
   the quoted event. It reads the source in full, gathers evidence, and ends with a brief: the
   ask, findings with links, a recommendation, and a proposed reply. If the source has drafts, the
   reply is saved as a draft where the answer would go.
7. **The worker reports back** one line to qitt, `ready:` or `blocked:`, and qitt updates its
   board.
8. **The owner does the rest:** reads the brief, edits the draft, sends it, and settles the
   thread. qitt never settles one.

The owner can also ask qitt anything in its thread. It answers questions about the work it tracks
itself, and sends anything that needs research to a worker.

## What the installer assembles

The charters in `profiles/` hold only the rules that are true for every source. For each profile,
`bin/install-profiles` writes into `~/.local/state/qitt/projects/`:

```
CLAUDE.md               the core charter
                        + the qitt.md (or worker.md) of every enabled source, under "Sources"
                        + an import of the local context
context.local.md        a copy of ~/.config/qitt/context.md
.claude/settings.json   the profile's settings + every enabled source's deny.txt
.claude/skills/         skills/ + each enabled source's skills/
```

So adding or removing a source never edits the core: it changes which sections the installer
puts under **Sources**, and which tools it denies.

The charters, the source sections and the local context are written in the owner's voice ("I",
"me"), because they are the owner's instructions to the agents. The rest of the documentation is
not.

## Where things live

| Place | What |
| --- | --- |
| This repo | Code and generic templates only. |
| `~/.config/qitt/` | Config and secrets: `context.md`, `sources.txt`, sources of your own, `bridge.json`, `filter.json`, and `secrets/` (tokens, webhook URLs, the relay's HMAC secret; mode 600). |
| `~/.local/state/qitt/` | The installed profiles, the bridge's state files, mutes, logs, replay data. |
| T3 Code | The threads and the scheduled tasks, which are all of qitt's working state. |

## Trust boundaries

- **One port faces outside.** Only the hook filter is reachable from a relay, never T3's own
  port. It accepts webhook routes only, and with a secret configured it accepts signed deliveries
  only.
- **A request is data, not instructions.** T3 frames a webhook body as untrusted data in the
  prompt, and the worker charter says the same: a request tells a worker what the requester
  wants from the owner, not what to do.
- **Nothing goes out in the owner's name.** Send tools are denied by name in both profiles, per
  source.
- **Workplace details stay on the machine.** Names, ids, channels and tokens live under
  `~/.config/qitt/`, never in the repo.

## When things fail

- **The machine is down.** qitt runs on one always-on machine. Events that arrive while it is
  down are lost, by design. Slack is the exception: when the bridge comes back, search catches up
  on up to 24 hours of messages.
- **The bridge is losing or delaying messages.** It says so in its next batch, as a health event
  that qitt puts at the top of its reply. A reconciler re-reads the owner's recent conversations
  and backfills what live events and search both missed.
- **A peer is unreachable.** qitt says so on the board, routes with what it can see, and tries
  again at its next turn.
- **The thread grows without end.** qitt's profile compacts its context at 150k tokens. That is
  safe because its durable state is in the threads, not in its memory: it rebuilds the picture
  from them whenever it routes or shows the board.

Before letting qitt act on a new setup, `replay/` runs it in shadow mode over past events and
scores what it would have done.
