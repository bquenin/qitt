# slack-bridge

The only long-running qitt process. It holds a Slack Socket Mode connection for a user-scoped
Slack app (DMs and group DMs), polls Slack search for the rest (mentions, my threads, watched
channels), keeps the messages qitt should see, and POSTs them in batches to the qitt thread's T3
webhook on localhost. It reads Slack and never writes to it.

## Slack app

- Socket Mode on, with an app-level token (`xapp-`, `connections:write`).
- User token scopes: `im:history`, `mpim:history`, `channels:history`, `groups:history`
  (thread lookups), `users:read`, `search:read` (search intake and saved for later; without it both
  pollers turn themselves off). Optional: `channels:read`, `groups:read` (names of channels in live
  events; search matches carry their own).
- User event subscriptions: `message.im` and `message.mpim` only. Do not subscribe to
  `message.channels` or `message.groups`: Slack caps an app at 30,000 events per workspace per hour,
  every message in every channel I can see counts against it, and over the cap Slack sends
  `app_rate_limited` once a minute and drops events, DMs included. Channel messages come from
  search instead; see Search intake.

## Local files

Nothing here is committed.

| Path | What |
| --- | --- |
| `~/.config/qitt/bridge.json` | Config; start from `config/example/bridge.json`. |
| `~/.config/qitt/secrets/slack-app-token` | `xapp-` token (mode 600). |
| `~/.config/qitt/secrets/slack-user-token` | `xoxp-` token (mode 600). |
| `~/.config/qitt/secrets/webhook-slack.local.url` | Local URL of the qitt Slack webhook task, read at every POST. |
| `~/.local/state/qitt/bridge-saved.json` | Saved items already seen (`channel:ts`), so a restart does not re-send. `--dry-run` uses `bridge-saved.dry-run.json`. |
| `~/.local/state/qitt/bridge-search.json` | Search cursor (where the next poll reads back from) and paging backlog, so a restart catches up from there. `--dry-run` uses `bridge-search.dry-run.json`. |
| `~/.local/state/qitt/bridge-delivered.json` | Message ids in batches already flushed (last 3 days), so neither a restart nor a catch-up re-sends them. `--dry-run` uses `bridge-delivered.dry-run.json`. |
| `~/.local/state/qitt/bridge-conversations.json` | Conversations qitt has heard about (last 14 days), so my replies there reach it (see My replies). `--dry-run` uses `bridge-conversations.dry-run.json`. |
| `~/.local/state/qitt/bridge-reconcile.json` | Reconciler window (where the next run reads from) and the conversations I posted in over the last 7 days (see Reconciler). `--dry-run` uses `bridge-reconcile.dry-run.json`. |
| `~/.local/state/qitt/muted.json` | Muted conversations, edited by `bin/qitt-mute`. The bridge only reads it. |
| `~/.local/state/qitt/logs/slack-bridge.log` | One line per batch and per error. Tokens and URLs are redacted. |

`bridge.json` fields:

- `me`: my Slack user id. My own messages are dropped unless they answer a conversation qitt has
  heard about (see My replies), but they teach the bridge which threads I am in.
- `groups`: user group ids whose mentions count as mentions of me.
- `watchChannels`: channel ids where every message is kept.
- `supportChannels`: channel ids where someone else answers (for example a support rotation). Only
  messages that mention me and replies in my threads are kept there; see What gets through.
- `ignoreBots` (default `true`): drop messages with `bot_id` or subtype `bot_message`.
- `batchWindowSeconds` (default `20`): how long a batch collects after its first event.
- `savedPollSeconds` (default `300`): how often to poll saved-for-later items; `0` turns the poller off.
- `searchPollSeconds` (default `60`): how often to poll search for channel messages and missed DMs;
  `0` turns it off, which leaves only live DMs.
- `reconcileMinutes` (default `15`): how often the reconciler reads my conversations from Slack and
  backfills what live events and search missed; `0` turns it off.
- `webhookUrlFile`: where the webhook URL lives.
- `mutedFile` (default `~/.local/state/qitt/muted.json`): the muted conversations; must match
  `QITT_MUTED_FILE` for `bin/qitt-mute` if that is set.
- `timezone` (default: the system timezone): IANA name, e.g. `America/New_York`, for the times on
  events (`time_local`) and the batch `window`. Keep it the same as the `Timezone` line in
  `context.md`.
- `timezoneLabel` (default: the zone's short name, e.g. `PT`, `ET`, `UTC`, `GMT+2`): the label
  written after each time.

## What gets through

Dropped: my messages (except my replies), bot messages, edits, deletes, joins and every other subtype except
`thread_broadcast` and `file_share`, and empty messages without files.

Kept: DMs and group DMs; channel messages that mention me (`<@me>`) or one of my groups
(`<!subteam^id>`); replies in threads I have posted in; anything in a watched channel. Thread
participation is learned from my own messages as they arrive (live or from search); for an unknown
thread the bridge asks `conversations.replies` once and caches the answer until it restarts.

In a support channel only messages that mention me (`<@me>`) and replies in threads I have posted
in are kept, flagged `support_channel`, so qitt knows someone else usually answers there. Group
mentions and everything else are dropped, even if the channel is also in `watchChannels`; a
dropped group mention is logged as `dropped slack:<channel>:<ts>: support channel (mentions group)`.
Replies in my threads get through because they are often addressed to me; when a support thread
stops needing me, qitt mutes it.
Saved-for-later items are not filtered, so saving a support-channel message still sends it.

### Muted conversations

When I tell qitt to stop following a conversation, it runs `bin/qitt-mute`:

```
bin/qitt-mute <source key | permalink> [note...]   # mute a thread (slack:<channel>:<thread ts>) or a channel or DM (slack:<channel>)
bin/qitt-mute --unmute <source key | permalink>
bin/qitt-mute --list
```

A permalink to a reply mutes its thread. A message that would be kept is dropped when its thread
or its channel is muted, unless it mentions me (`<@me>`); a group mention does not get through.
Each drop is logged as `dropped slack:<channel>:<ts>: muted <key> (<reason it would have been kept>)`.
A direct mention gets through even in a muted DM or watched channel, and saved items skip these
filters; my replies in a muted conversation are dropped. `qitt-mute` holds a lock (`muted.json.lock`) for
the whole read-change-write, so overlapping commands never lose a change. The bridge re-reads
`muted.json` when it changes, so a mute applies without a restart. A file that is not
`{"muted": {...}}` (an empty list is `{"muted": {}}`) is unreadable: the bridge keeps the last list
it read and logs each distinct error once, and `qitt-mute` refuses to edit it.

Events are deduped by Slack `event_id` (last 5000) and by message id: an id is held in memory
from the moment it is batched and written to `bridge-delivered.json` when its batch is flushed.
A message with the same author and `ts` as one already sent (`user:<user>:<ts>`) is a duplicate
too: adding someone to a DM copies its history into a new group DM under a new channel id, and
search finds those copies.

## Search intake

Every `searchPollSeconds` the bridge runs these `search.messages` queries with the user token,
newest first, and feeds each match through the same filters, dedupe, and batches as a live event:

| Query | For |
| --- | --- |
| `is:dm` | DMs and group DMs the socket missed (rate limit, reconnect, bridge down) |
| `<@me>`, `<!subteam^group>` per group | mentions |
| `is:thread with:<@me>` | replies in my threads, and my own replies, which mark threads as mine |
| `in:<#channel>` per watched channel | watched channels |

Search is fuzzy (a mention query also matches names), so the filters decide. Matches carry no
`bot_id`, so with `ignoreBots` their author is looked up with `users.info` (`is_bot`); a match
without a user counts as a bot. Channel names and permalinks come from the match. A match whose
author or thread lookup failed is judged again on the next poll, for as long as it is in the
window (about 10 minutes for a new message), and counted as `to retry` in the log line.

Each poll reads back to a cursor minus 10 minutes (search indexes with a lag), at most 24 hours.
The cursor is the previous poll's start, held back to the oldest message still waiting in an
unflushed batch, and kept in `bridge-search.json`, so after a restart the bridge catches up on
what it missed while down, including a batch the restart threw away. Without that file it reads
the last 10 minutes. An `app_rate_limited` envelope or a reconnect triggers a poll right away,
unless one started in the last 30 seconds. Channel messages reach qitt up to about a minute late.

A query reads newest first, 100 per page, up to 10 pages. Past that, the rest of its window is
read oldest first (from a date two days before the window), up to 10 more pages. If that does not
meet the newest-first side either, the cursor stays where reading stopped and the page reached is
saved as the query's backlog, so the next poll resumes there; nothing is skipped.

A failed poll is logged and retried next time from the same place. `missing_scope` or
`not_allowed_token_type` logs `search intake disabled: ...` once and stops polling until restart.

## Saved for later

Saving a message for later is how I flag that it matters, so the bridge polls my saved items
every `savedPollSeconds` with the user token and batches what changed. It lists them by searching
`is:saved` with `search.messages` (`search:read`, newest first, 100 per page, up to 20 pages).
Every poll reads the whole list, since removals are found by what is missing from it.

Search pages drift: a poll can return one message twice and drop another while the total stays
the same (seen near the end of a ~900-item list). The bridge dedupes the list, and treats
one with fewer distinct messages than search's total as drifted, logging
`(pages drifted, <n> of <total> items; removals skipped)`.

- A newly saved message becomes the normal event (below) plus `"saved": true` and
  `"saved_at": null` (search does not say when a message was saved). It skips the drop/keep filters. If the live copy of the
  same message is still waiting in the current batch, that event is marked saved instead of sent
  twice; if it already went out, it goes out again marked saved.
- A message removed from the list becomes
  `{"id", "source": "slack", "unsaved": true, "ts", "source_key", "permalink"}`, with no text.
  Removals are only reported when the whole list was read, and only after the message is missing
  from two whole lists in a row (about 10 minutes). A message that is back before then was never
  reported gone, so it is not sent again as saved. A poll that hits the page cap, or whose pages
  drifted, still sends new saves but skips removals and does not count as a miss.
- A batch holds at most one saved-for-later event per message, the latest state: a re-save while
  the removal is still waiting replaces it with the full saved event, and an unsave while the saved
  event is still waiting replaces it with the removal. A live message marked saved and then
  unsaved within one batch goes out as the plain live message.

Seen items are kept in `~/.local/state/qitt/bridge-saved.json`. `--dry-run` uses
`bridge-saved.dry-run.json` instead, so a dry run never marks saves as seen for the real bridge.

With no state file, the first poll reads the whole list, records every item as seen, and sends
only messages posted in the last 7 days. If the list is longer than the page cap or its pages
drifted, it records and sends nothing, logs it, and tries again on the next poll.

If search fails with `missing_scope` or `not_allowed_token_type`, the bridge logs
`saved-for-later polling disabled: ... the user token needs search:read` once and stops polling
until it restarts. Other errors are logged and retried on the next poll.

## My replies

I often answer a Slack thread myself, or send a draft an agent wrote, while a thread here is still
working on it, so qitt needs to hear that I replied. The bridge remembers the conversation of every
message from someone else it batches for qitt, saved items included (a Slack thread by its source
key; a DM or group DM as a whole, `slack:<channel>`), in `bridge-conversations.json` for 14 days
after the last one. A message of mine in one of them (top level or reply; edits, deletes and the
other dropped subtypes do not count) becomes the normal event for my message plus
`"my_reply": true`, logged as `my reply slack:<channel>:<ts>`, and is batched right away like any
other event. A muted conversation is skipped, and so is a conversation qitt never heard about,
which is where most of my messages go. Live events bring my DM replies; search brings my thread
replies (`is:thread with:<@me>`).

Slack does not say whether a message was typed or sent from a draft, and agents on other machines
draft too, so the bridge does not try to match drafts: qitt finds the thread that drafted a reply
by its text (see the qitt charter). Matching my messages against a drafts file written by a hook
on this machine, and holding my replies until the next batch, was tried first: it called an
unrelated post a sent draft, missed drafts made on other machines, and held a reply for hours on a
quiet afternoon.

## Reconciler

Live events and search can both miss a message: Slack drops live events while it rate-limits the
app, search indexes with a lag and reads back only 10 minutes, and a thread lookup can fail for
longer than a match stays in search's window. Every `reconcileMinutes` the reconciler reads, with
the user token, the conversations most likely to hold a message for me:

- conversations qitt has heard about (`bridge-conversations.json`, last 14 days): a thread with
  `conversations.replies`, a DM or group DM with `conversations.history` (top level only);
- conversations I posted in during the last 7 days, found with search `from:<@me>`: the thread of
  each channel reply or post of mine, and each DM or group DM. They are kept in
  `bridge-reconcile.json`, so each run searches only my messages since the previous one.

Every message in them goes through the same filters, dedupe, and batches as a live event, flagged
`backfill`. It reads only messages more than 15 minutes old, after live events and search had
their chance, so anything the pipeline keeps now was missed: it is logged as
`reconcile gap slack:<channel>:<ts> (<reason>)`, and other people's are reported to qitt (see
Bridge health; a message of mine can become my reply only because qitt heard about its
conversation after I posted).
Messages already sent are duplicates and messages the filters drop stay dropped.

Each run reads from where the previous one ended, at most 24 hours back. The window stays put when
a read fails or stops at its 50-page cap, a thread lookup fails, or a batch is not flushed yet, so
the next run (or a restart) reads it again; the search for my messages likewise starts over from
its last complete pass. A conversation that is gone (`channel_not_found`, `thread_not_found`,
`not_in_channel`, `is_archived`) is logged once and skipped until restart; anything else, a
missing scope included, counts as a failed run. With no state file, the
first run starts from now and reads nothing. Calls are 1.5 seconds apart, since
`conversations.replies` and `conversations.history` allow about 50 a minute and live thread lookups
share that budget; about 70 conversations take under two minutes.

## Bridge health

A problem that can lose or delay messages becomes a `bridge_health` event in the next batch, so
qitt can tell me instead of it sitting in the log. Each kind goes out at most once an hour and is
logged as `health <kind>: <text>`:

| Kind | When |
| --- | --- |
| `slack_rate_limited` | Slack has sent `app_rate_limited` for 10 minutes without a 3-minute gap. |
| `search_failing` | Three search polls in a row failed. |
| `search_disabled` | Search turned itself off (`missing_scope`, `not_allowed_token_type`). |
| `missed_messages` | The reconciler backfilled messages; the text lists their ids. |
| `reconcile_failing` | Three reconciler runs in a row could not read everything, or threw. |

There is no recovery event. Every kind but `missed_messages` repeats hourly while it lasts, so one
that has not repeated for more than an hour has cleared; `search_disabled` lasts until restart.

## Body

```json
{
  "id": "<batch uuid>",
  "count": 1,
  "window": "14:05–14:05 PT",
  "events": [
    {
      "id": "slack:<channel>:<ts>",
      "source": "slack",
      "channel_type": "channel",
      "channel_id": "<channel>",
      "channel_name": "<name, null for DMs>",
      "ts": "<ts>",
      "thread_ts": null,
      "source_key": "slack:<channel>:<thread_ts or ts>",
      "time_local": "Thu 10/16 14:05 PT",
      "user_id": "<user>",
      "user_name": "<display name or real name>",
      "mentions_me": true,
      "mentions_group": false,
      "text": "<message text>",
      "permalink": "<permalink or null>",
      "files": []
    }
  ],
  "digest": "<the events as text, below>"
}
```

`window` spans the earliest to the latest message in the batch. Times are in `timezone` with its
label (`America/Los_Angeles`, `PT`, in these examples). The webhook task's prompt
(`prompts/intake-slack.md`) reads only `digest` (`lib/digest.mjs`): one placeholder, so T3 frames
the batch as untrusted data once, and plain text instead of pretty-printed JSON, which costs far
fewer tokens. `events` stays in the body for `--dry-run` and tests. Each event becomes:

```
1 event.

1. slack:C0123456789:1760648700.000100 · Ada Lovelace (U0123456789) · Thu 10/16 14:05 PT
   #team-ci, reply in thread slack:C0123456789:1760648600.000100 · mentions me · files: "a.png"
   https://example.slack.com/archives/C0123456789/p1760648700000100?thread_ts=1760648600.000100
   > every line of the text, quoted
```

The second line is the place (`#<channel_name>`, `#<channel id>` when the name is unknown, `DM`,
or `group DM`), the thread's source key for a reply (a top-level message's source key is its id),
and only the flags that are true: `mentions me`, `mentions my group`, `saved`, `my reply`,
`support channel`, `backfilled (missed by live events and search)`, `files: "<name>", ...` (names
quoted, so one cannot pass for a flag). A removal from saved for later is
`N. <id> · unsaved (source key <key>)` and its link. A missing author is `(<user id>)` or
`unknown author`; empty text has no quote. A health event is
`N. bridge health · <kind> · <time>` and its text quoted. Text is not escaped: T3 already defuses mentions and
frame tags inside the framed value.

Delivery succeeds on HTTP 202; a
failed POST is retried twice with backoff, then the batch is dropped and logged. Messages posted
while the bridge is down are caught up by search (up to 24 hours); batches that fail while qitt is
down are lost, by design.

## Running

```bash
npm ci --prefix bridge          # once, and after dependency changes
bin/qitt-bridge                 # start if not running
bin/qitt-bridge stop
node bridge/slack-bridge.mjs --dry-run   # foreground; print batch bodies instead of POSTing
npm test --prefix bridge
```

Add `qitt-bridge ensure` to `~/.profile` so the bridge comes back after a restart. It is
silent and always exits 0. A fatal start error (bad token or config) exits the bridge non-zero and
is logged; the next `ensure` starts it again. Once connected, the Slack SDK reconnects on its own.
