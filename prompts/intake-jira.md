JIRA doorbell from the webhook relay: {{body.type}} / {{body.action}}, received {{body.received_at}}.
This is a doorbell, not the record: re-read the issue with the `jira` skill before deciding, then
triage it per your charter.

```json
{{body.payload}}
```
