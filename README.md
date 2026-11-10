# qitt

A proactive chief of staff that lives inside [T3 Code](https://github.com/pingdotgg/t3code).

- **Chief of staff.** One pinned thread watches the requests that reach its owner and keeps a
  live picture of all work in flight, so it can be asked anything without context.
- **Proactive.** It triages each request as it arrives and starts a worker thread to research it
  ahead of time. It never sends anything: every output is proposed text for the owner to review.
- **Vendor-agnostic.** It is built from T3 Code threads and scheduled tasks, and its rules are
  `AGENTS.md` files any coding agent reads. It has run on Claude only so far.
- **Customizable.** Its behaviour is plain Markdown: two charters written in the owner's voice,
  and a local context file for your people, priorities and playbooks.
- **Extendable.** Slack and JIRA ship as two folders under `sources/`. Teams, email or anything
  else is [one more folder](docs/sources.md).

## How it works

![qitt architecture: sources (Slack, JIRA, or your own) deliver events to webhook tasks bound to the pinned qitt thread in T3 Code, through a bridge on localhost or through the hook filter. qitt triages each item, sends follow-ups to the thread that owns the work or launches a worker thread, and workers report back ready or blocked. Send tools are denied, so the owner reviews and sends every reply.](docs/images/architecture.png)

- **T3 constructs only.** qitt is a thread; intake and the ticket sweep are scheduled tasks bound to
  it. Code outside T3 exists only where something must hold a connection.
- **Never sends.** Each source's send tools are denied for qitt and its workers. Workers are
  research-only, except the routine field edits a ticket playbook lists and work the owner asks a
  worker for directly.
- **Runs on one always-on machine.** Events that arrive while it is down are lost, by design.

[docs/architecture.md](docs/architecture.md) describes each part and how a request travels through
them. Planned, not in this repo yet: an interval supervision pass and a JQL backstop.

## Layout

| Path | What |
| --- | --- |
| `agents/` | The two agents qitt is made of, `qitt` and `worker`. For each, a charter (`AGENTS.md`) with the rules that hold for every source, and `.claude/settings.json` (for qitt a 150k auto-compact window: every call re-reads the whole thread, and its durable state lives in the threads, not its context). |
| `sources/` | One folder per source of requests: its charter sections, its webhook task's prompt, the send tools to deny, and a bridge if it needs one. `slack/` and `jira/` ship here; `_template/` is a skeleton for your own. |
| `bin/` | `install-agents` assembles each agent's T3 project root from its charter, the enabled sources and your local `context.md` (re-run it after editing any of them); `qitt-filter` and `qitt-bridge` keep the filter and the Slack bridge running; `qitt-mute` mutes Slack conversations for the bridge. |
| `docs/` | `architecture.md`: the parts and how a request travels. `sources.md`: what a source is made of and how to add one. `setup.md`: how the thread, intake tasks, and endpoint are wired, and every config key. |
| `filter/` | Path filter that exposes only the T3 webhook routes, with optional HMAC signature checks (`bin/qitt-filter` runs it). Shared by every source that calls a webhook. |
| `replay/` | Export of past events and shadow-mode scoring of qitt's triage. |
| `config/example/` | Placeholder versions of the local config files. |

## Dependencies

- A [T3 Code](https://github.com/pingdotgg/t3code) server, with the qitt and worker projects
  registered (see [docs/setup.md](docs/setup.md)).
- Node.js 22.19 or later for the installer, the bridge and the filter; Python 3.9 or later for
  `replay/`.
- What each source you enable needs:
  - [Slack](sources/slack/README.md): a Slack app for the bridge, a Slack MCP server for the
    agents (reading Slack, saving drafts; its send tools are denied), and the `slack` skill.
  - [JIRA](sources/jira/README.md): something that turns JIRA events into signed webhook calls,
    and the `jira` skill.
- Skills and MCP servers come from your own agent setup, not from this repo. `context.md` names
  the ones workers use for evidence, documents and ticket playbooks.

## Local data

The repo holds code and generic templates only. Everything specific to a workplace or a person
(names, timezone, people, Slack and JIRA IDs, hostnames, tokens, exported history, replay
results) stays on the machine and is never committed:

- `~/.config/qitt/` for config and secrets (start from `config/example/`; keys in
  [docs/setup.md](docs/setup.md#configuration)), and for sources of your own
- `~/.local/state/qitt/` for the installed project roots, exported history, replay runs, and logs

## Tests

```bash
npm test --prefix sources/slack/bridge
node --test "filter/test/*.test.mjs"
node --test "bin/test/*.test.mjs"
```
