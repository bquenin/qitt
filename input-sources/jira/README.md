# JIRA input source

Issue events (assignments, comments, mentions) and a weekday sweep for the kinds of ticket a
playbook handles.

| File | What |
| --- | --- |
| `qitt.md` | qitt's charter section: JIRA events are doorbells, and ticket playbooks. |
| `worker.md` | The workers' section: read the issue with its comments and changelog. |
| `intake.md` | Prompt of the JIRA webhook task. It expects the relay's envelope ([docs/setup.md](../../docs/setup.md#body-shapes)). |
| `sweep.md` | Prompt of the fixed-time sweep task. |

There is no bridge: JIRA calls a webhook, so events come in through the hook filter.

## What it needs

- Something that turns JIRA events into webhook calls: a JIRA Automation rule or webhook, and a
  relay you run or subscribe to that POSTs each event to the hook filter, ideally signed
  ([docs/setup.md](../../docs/setup.md#intake-endpoint)). If your relay sends another shape than
  the envelope, adapt `intake.md`.
- The `jira` skill from your own Claude setup: reading issues and JQL, and the field edits a
  ticket playbook lists.
- Ticket playbooks, if you use them, are skills named in `~/.config/qitt/context.md`.
