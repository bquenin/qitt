# qitt

A chief of staff that lives inside [T3 Code](https://github.com/pingdotgg/t3code). One pinned T3
thread watches incoming Slack and JIRA requests, starts T3 worker threads that research each one
before I get to it, and keeps a live picture of all active work so I can ask it anything without
giving context. It never replies on my behalf: every output is proposed text that I review.

## How it works

```
Slack ⇢ slack-bridge (Socket Mode) ── POST localhost ─────────────────────┐
JIRA → HMAC-signing webhook relay → hook filter (/api/hooks/* only) ──────┤
                                                                          ▼
               T3 webhook scheduled task, bound to the pinned qitt thread
                                                                          ▼
  qitt (pinned) ── t3_thread_search (who owns this?) ── t3_thread_launch ──▶ worker threads
        ▲                                                                     │
        └────────────── worker posts "ready / blocked" via t3_thread_send ────┘
  + weekday ticket sweep task on qitt: playbook tickets the intake misses
  + planned: interval supervision pass + JQL backstop (not in this repo yet)
```

- **T3 constructs only.** qitt is a thread; intake and the ticket sweep are scheduled tasks bound to
  it. Code outside T3 exists only where something must hold a connection.
- **Never sends.** Output is proposed text; Slack send and schedule are denied in the profiles.
  Workers are research-only, except the routine JIRA field edits a ticket playbook lists and work
  the owner asks a worker for directly.
- **Runs on one always-on machine.** Events that arrive while it is down are lost, by design.

## Layout

| Path | What |
| --- | --- |
| `profiles/` | T3 project roots for qitt and its workers: charter (`CLAUDE.md`) and `.claude/settings.json`: a minimal deny list, and for qitt a 150k auto-compact window (every call re-reads the whole thread, and its durable state lives in the threads, not its context). |
| `skills/` | Skills installed into both profiles (e.g. `google-docs`: read Google Docs with the gws CLI). |
| `bin/` | `install-profiles` copies the profiles and your local `context.md` into place (re-run it after editing either); `qitt-filter` and `qitt-bridge` keep the filter and the Slack bridge running; `qitt-mute` mutes Slack conversations for the bridge. |
| `prompts/` | Prompt templates for the scheduled tasks: intake webhooks and the ticket sweep. |
| `docs/` | `setup.md`: how the thread, intake tasks, and endpoint are wired, and every config key. |
| `bridge/` | `slack-bridge`: Socket Mode client that filters, batches, and posts events to qitt's webhook. See [bridge/README.md](bridge/README.md). |
| `filter/` | Path filter that exposes only the T3 webhook routes, with optional HMAC signature checks (`bin/qitt-filter` runs it). |
| `replay/` | Export of past events and shadow-mode scoring of qitt's triage. |
| `config/example/` | Placeholder versions of the local config files. |

## Dependencies

- A [T3 Code](https://github.com/pingdotgg/t3code) server, with the qitt and worker projects
  registered (see [docs/setup.md](docs/setup.md)).
- Node.js 22.19 or later for the bridge and the filter; Python 3.9 or later for `replay/`.
- A Slack app for the bridge (see [bridge/README.md](bridge/README.md#slack-app)).
- A Slack MCP server for the agents (reading Slack, saving drafts). The profiles deny its send
  and schedule tools by name, `mcp__<server>__slack_send_message` and
  `mcp__<server>__slack_schedule_message`, with the server named `slack-cli` by default. If yours
  has another name, run `QITT_SLACK_MCP_SERVER=<name> bin/install-profiles`; if its send tools
  have other names, edit `profiles/*/.claude/settings.json`. A deny entry that does not match a
  real tool name denies nothing, so check the installed lists against your server's tools.
- Skills the charters call, from your own Claude setup: `jira` (read issues and JQL, and the field
  edits a ticket playbook lists) and `slack` (how Slack drafts are formatted). Ticket playbooks in
  `context.md` name further skills. `google-docs` ships in `skills/` and needs the `gws` CLI.

## Local data

The repo holds code and generic templates only. Everything specific to a workplace or a person
(names, timezone, people, Slack and JIRA IDs, hostnames, tokens, exported history, replay
results) stays on the machine and is never committed:

- `~/.config/qitt/` for config and secrets (start from `config/example/`; keys in
  [docs/setup.md](docs/setup.md#configuration))
- `~/.local/state/qitt/` for the installed profiles, exported history, replay runs, and logs

## Tests

```bash
npm test --prefix bridge
node --test "filter/test/*.test.mjs"
node --test "bin/test/*.test.mjs"
```
