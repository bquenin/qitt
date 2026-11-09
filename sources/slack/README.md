# Slack source

Slack messages that are asks for me: DMs and group DMs, mentions of me or my user groups, replies
in threads I am part of, messages I save for later, and every message in the channels I choose to
watch.

| File | What |
| --- | --- |
| `qitt.md` | qitt's charter section: Slack triage, saved for later, my own replies, bridge health, muting, how to name Slack places. |
| `worker.md` | The workers' section: read the whole thread, reply only as a draft. |
| `intake.md` | Prompt of the Slack webhook task. It reads the batch's `digest`. |
| `deny.txt` | The Slack MCP server's send and schedule tools. |
| `bridge/` | `slack-bridge`: the process that reads Slack and posts batches to the webhook task. See [bridge/README.md](bridge/README.md). |

## What it needs

- A Slack app for the bridge ([bridge/README.md](bridge/README.md#slack-app)), and
  `~/.config/qitt/bridge.json` (start from `config/example/bridge.json`).
- A Slack MCP server for the agents: they read Slack and save drafts with it. `deny.txt` names its
  send tools as `mcp__slack-cli__slack_send_message` and `mcp__slack-cli__slack_schedule_message`.
  If your server has another name, run `QITT_SLACK_MCP_SERVER=<name> bin/install-profiles`; if its
  send tools have other names, edit `deny.txt`. A deny entry that matches no real tool denies
  nothing, so check the installed lists against your server's tools.
- The `slack` skill from your own Claude setup: how Slack drafts are formatted.

## Running

`bin/qitt-bridge` keeps the bridge running and `bin/qitt-mute` mutes a conversation for it. Both
are described in [bridge/README.md](bridge/README.md#running).
