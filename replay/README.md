# Replay

Shadow-mode replay of past intake, to measure qitt's triage before it touches my inbox.
All data lives under `~/.local/state/qitt/replay/<window>/` and is never committed.

1. **Export** the window into `slack-events.jsonl`, `jira-events.jsonl`, `t3-threads.jsonl`, and
   `links.jsonl` (which events led to a T3 thread or a reply from me). Done read-only through the
   Slack MCP tools, the JIRA CLI, and T3's thread list (no exporter ships here). One JSON object per
   line, with the fields batch.py and score.py read:
   - `slack-events.jsonl`: `id`, `ts`, `thread_ts`, `channel_id`, `channel_type`, `channel_name`,
     `user_id`, `user_name`, `time_local`, `mentions_me`, `permalink`, `text`, `from_me`, `is_bot`
   - `jira-events.jsonl`: `id`, `timestamp` (ISO), `event`, `issue_key`, `summary`, `actor_id`,
     `actor_name`, `time_local`, `url`, `text`
   - `t3-threads.jsonl`: `thread_id`, `title`, `created_local`, `slack_links` (list)
   - `links.jsonl`: `event_id`, `t3_threads` (list of thread ids), `owner_replied` (bool)
2. **Batch:** `batch.py <dir> --hours 4` writes `batches.jsonl`, dropping bots and my own messages.
3. **Replay:** `mkdir -p <dir>/runs/<run>`, then launch a thread in the qitt project whose first
   message is `preamble.md` with
   `{{RUN_DIR}}` = `<dir>/runs/<run>`, `{{RUN}}` = the run name, and `{{LAST_BATCH}}` = the batch
   count. The thread handles one batch per turn and queues the next one to itself, appending its
   decisions to `<run>/decisions.jsonl`. It drives itself because T3 only lets a thread send while
   the caller has an active run, so an outside driver stops when its own turn ends.
4. **Score:** `score.py <dir> <run>` prints the decision × outcome matrix and headline numbers and
   writes `<run>/score.md` with the items worth reviewing by hand.
