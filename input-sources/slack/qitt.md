### Slack

Slack messages arrive in batches from the bridge (`input-sources/slack/bridge/`), through one webhook
task. Each numbered event is `id · author (user id) · time`, then where it was posted with its
flags, the link, and the text quoted. The same batches also carry:

- **Saved-for-later events**: flagged `saved`, or `unsaved` entries (Saved for later, below).
- **My Slack replies**: flagged `my reply`, when I post in a conversation you already heard about,
  typed myself or sent from a draft an agent wrote (My Slack replies, below).
- **Bridge health events**: `bridge health · <kind>`, when the bridge may be losing or delaying
  messages (Bridge health, below).

In this thread I may also send **mute requests**: I tell you to stop following a conversation
(Muting a conversation, below).

Triage guidelines for Slack items:

- DMs and group DMs are usually asks; channel messages are asks when they mention me or a user group
  local context lists as mine, or are in a thread I am already part of.
- Support channels in local context are answered by someone else (for example a support rotation).
  The bridge sends only messages there that mention me personally, replies in threads I am part
  of (flagged `support channel`), and ones I saved. Triage and route a flagged reply like any other
  message in my thread: a follow-up to the thread that owns it, or pre-work if no thread owns it
  and it asks something of me; acks and replies meant for someone else are ignore. When I tell you
  a support thread goes on without me, mute it (below).
- Messages flagged `backfilled` reached you late: live events and search missed them, and the
  bridge's reconciler found them 15 to 30 minutes after they were posted. Triage them like the
  rest, but check the Slack thread first: I may already have answered.

Header fields for a Slack item:

```
source: [#<channel name>](<Slack permalink>) | [DM with <name>](<Slack permalink>)
source-key: slack:<channel id>:<thread ts>
```

A Slack reply uses its thread's key, from `reply in thread <key>`; a top-level message its own id.
Write `source` as in Slack names (below).

#### Saved for later

When I save a Slack message for later, I am telling you it matters. The bridge watches my saved
list and sends changes as intake events in the normal Slack batches:

- Flagged `saved`: a message I just saved (the save time is unknown). The rest of the entry is
  the usual message, even if it is old or the bridge would normally drop it.
  Triage and route it like any item, with two differences: never **ignore** it (if it asks
  nothing, write a brief-only line saying why I might have saved it), and say "saved by <my first
  name>" in the worker's charter. If it belongs to a thread that already owns the work, send it
  there as a follow-up noting I saved it.
- `unsaved` (id, source key, link, no text): I removed it from my list, so it is done from my
  side. Note it in your reply; do not chase it or its worker.

There is no saved-for-later task and no ledger. The situation board gets a **Saved for later**
section, first: each saved item that is still in my list (check `is:saved` with your Slack tool),
with its thread and state.

#### My Slack replies

When I post in a conversation the bridge already sent you (the same Slack thread, or the same DM),
my message arrives flagged `my reply`, usually within a minute. Slack does not say whether I typed
it or sent a draft an agent wrote, and agents on my other machines (peer environments) draft too.
It is not an intake item: never triage or ignore it.

1. Find the thread it belongs to, here and on every peer environment: the thread whose source is
   that Slack conversation, and any thread that proposed this text (`t3_thread_search` for a
   distinctive phrase of my message). Threads I started by hand count.
2. If a thread proposed this text (the same wording, or close to it with my edits), it was its
   draft: send it there with `t3_thread_send`, "<my first name> sent your draft in
   [#channel](permalink) at <time TZ>", then "as drafted" when the wording matches or only
   formatting differs, or my text quoted when I changed it. On the board, the item moves to
   **waiting on someone else**, unless its thread still has something for me.
3. Otherwise, only if the thread working on that conversation is still running or ready for me (it
   may propose a reply I already gave), send it with `t3_thread_send`: "<my first name> replied in
   [#channel](permalink) at <time TZ>:" and my message quoted. My replies to the same thread in one
   batch go in one message.
4. Otherwise do nothing and say nothing: the thread sees my reply when it next reads the
   conversation.

In your batch reply, one line per reply you forwarded: `sent draft → [title](t3-thread://v1/<threadId>)`
or `my reply → [title](t3-thread://v1/<threadId>)`.

#### Bridge health

A `bridge health · <kind>` entry is the bridge telling you it may be losing or delaying Slack
messages. It is not an intake item: never triage or route it, and launch no worker. Put one line
at the top of your batch reply, `bridge health · <kind> · <what it means for me>`, and on the
board while it lasts. The bridge sends no recovery event: every kind but `missed_messages` repeats
hourly while the problem lasts, so drop one from the board once it has not repeated for more than
an hour. `search_disabled` lasts until the bridge restarts; `missed_messages` is one-off.

- `missed_messages`: the reconciler backfilled messages live events and search missed; they are in
  the same or the next batch, flagged `backfilled`. Triage those as usual.
- `slack_rate_limited`, `search_failing`, `search_disabled`, `reconcile_failing`: messages are late
  or missing until it clears. Tell me once; the bridge README
  (`input-sources/slack/bridge/README.md`, Bridge health) says what each means.

#### Muting a conversation

When I tell you to stop following a Slack conversation ("mute this", "stop watching", "this is
going on without me"), by thread link, Slack link, or description:

1. Find its source key: the `source-key` in the owning worker's header, or the Slack permalink
   itself. A whole channel or DM is `slack:<channel id>`; mute that only when I ask for it.
2. Run `bin/qitt-mute <source key or permalink> <short note>` from the qitt repo checkout (path
   in local context). The bridge then drops new messages there before they reach you, except
   ones that mention me personally. My own replies there are dropped too; saved items still arrive.
3. Reply in one line: muted, with the Slack place and the thread link. Do not tell or settle the
   worker.

`bin/qitt-mute --unmute <key>` follows it again (when I ask, or when I re-engage there);
`bin/qitt-mute --list` shows what is muted. Only Slack conversations can be muted: for anything
else, say so.

#### Slack names

Everything you write (replies here, headers, follow-ups and messages to workers, the board) names
Slack places the way I see them in Slack, never by id:

- A channel is `#<channel name>`. A DM is "DM with <name>" (posted in `DM` or `group DM`, named
  from the author; plain "DM" if the author has no name either).
- A message link is `[#<channel name>](<permalink>)` or `[DM with <name>](<permalink>)`. Never a
  bare permalink, and never a bare channel id such as `C0123456789` in prose.
- When the event has no name (the place is an id such as `#C0123456789`, or an `unsaved` entry),
  take it from another event in the same channel or look it up with your Slack tool. Only if both
  fail, write `#<channel id>`; never guess a name.
- Ids stay only in machine keys (`source-key`, `requester`), where search needs them verbatim.
