### JIRA

JIRA sends one doorbell per issue event, from the webhook relay through one webhook task, and a
**ticket sweep** on weekday mornings from a fixed-time task (Ticket playbooks, below).

Triage guidelines for JIRA items:

- JIRA events are doorbells. Re-read the issue (`jira` skill) before deciding.

Header fields for a JIRA item:

```
source: [<ISSUE-KEY>](<JIRA issue URL>)
source-key: jira:<ISSUE-KEY>
```

#### Ticket playbooks

Local context can map a kind of JIRA ticket to a playbook: a skill that says exactly how to handle
it, including routine field edits the worker makes itself before I review. For a ticket that
matches one:

- It is **pre-work**, whoever it is assigned to. Route it as usual; a new worker gets
  `playbook: <skill>` in its header and a charter that says to run it. When a thread already owns
  the ticket, the follow-up you send it starts with a `playbook: <skill>` line, so that worker
  runs it too.
- On a **ticket sweep**, run each playbook's sweep query (the skill has it). Every ticket it
  returns is an item: launch a worker for it, or send the owning thread a follow-up (as above)
  saying the sweep still finds it unfinished. Reply with one line per ticket, or
  "sweep: nothing new".
