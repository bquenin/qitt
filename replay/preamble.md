This thread is a **replay** of past intake, used to score your triage. Your charter applies, in
shadow mode, with these replay rules on top:

- Each turn handles one batch, starting with `batch 1`. Read batch n with
  `jq -r 'select(.batch == <n>) | .message' {{RUN_DIR}}/../../batches.jsonl` and triage it as if it
  had just arrived as an intake event at the batch's time.
- **Tools:** Bash, only to read the batch and to record and check your decisions, and
  `t3_thread_configuration` / `t3_thread_send` to drive the replay (below). Do not search threads,
  read Slack or JIRA, or launch anything: decide from the batch text and your earlier decisions in
  this thread. The current state of the world is in the future relative to the batch.
- **Routing:** the open work is what you would have launched earlier in this replay. Route each
  item by judgment as your charter says: a follow-up to one of those would-be workers, or new work.
- **Record your decisions** by appending one JSON object per decision line to
  `{{RUN_DIR}}/decisions.jsonl`:

  ```
  {"batch": <n>, "decision": "pre-work|brief-only|follow-up|remind|ignore", "event_ids": ["..."], "source_key": "...", "routed_to": "<source_key of the earlier pre-work item this continues, follow-up only>", "requester": "...", "ask": "<= 15 words", "title": "<worker title, pre-work only>", "reason": "<= 15 words"}
  ```

  Every event id in the batch must appear in exactly one line. Group events that belong to one
  item into one line. Check before moving on:

  ```
  python3 -I - <n> <<'EOF'
  import json,sys
  R='{{RUN_DIR}}'; n=int(sys.argv[1])
  b=next(json.loads(l) for l in open(R+'/../../batches.jsonl') if json.loads(l)['batch']==n)
  d=[json.loads(l) for l in open(R+'/decisions.jsonl') if l.strip()]
  got=[i for x in d if x.get('batch')==n for i in x['event_ids']]
  w=set(b['event_ids']); print('missing',len(w-set(got)),'dupes',len(got)-len(set(got)),'unknown',len(set(got)-w))
  EOF
  ```

  Fix the file if anything is off.
- **Drive the replay:** after batch n, if n < {{LAST_BATCH}}, queue the next turn to this thread with
  `t3_thread_send` (threadId from `t3_thread_configuration`, message `batch <n+1>`, mode `queue`,
  clientRequestId `qitt-replay-{{RUN}}-batch-<n+1>`). After batch {{LAST_BATCH}}, reply `replay done`.
- Reply each turn with your usual one-line-per-item summary, and nothing else.

Start now with `batch 1`.
