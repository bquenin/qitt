# Sources

A source is a place requests come from. Slack and JIRA ship in this repo, and you can add your
own: Teams, email, GitHub, a pager. Each source is one folder. qitt's core rules (triage, routing,
workers, the board) are the same whatever an event came from, so adding a source never touches
them. [architecture.md](architecture.md) shows where sources sit in the whole.

## What a source is made of

| File | Needed | What |
| --- | --- | --- |
| `qitt.md` | Always | qitt's charter section: what an event looks like, the `source` and `source-key` of an item, and the rules that apply only to this source. |
| `worker.md` | If workers need something specific | The workers' charter section: how to read an item in full, how a reply goes out, how to name places. |
| `intake.md` | If events come by webhook | The prompt of the webhook task that delivers this source's events to the qitt thread. |
| `deny.txt` | If the agents have a tool that sends there | Tool names to deny in both profiles, one per line, `#` for comments. This is what keeps "it never sends anything for its owner" true for the source. |
| `skills/` | Optional | Skills installed into both profiles, next to the shared ones in `skills/`. Each skill needs a name no other enabled source and no shared skill uses: the installer stops on a clash. |
| Anything else | Optional | A bridge, the prompt of a scheduled sweep, a README. The installer ignores them. |

[`sources/_template/`](../sources/_template/) has a skeleton of each file.
[`sources/slack/`](../sources/slack/) is a source with a bridge, and
[`sources/jira/`](../sources/jira/) is one without.

## Which sources are installed

`bin/install-profiles` reads the list of enabled sources from, in this order:

1. `QITT_SOURCES`, names separated by spaces or commas, for one run: `QITT_SOURCES="jira teams"`.
2. `~/.config/qitt/sources.txt`, one name per line (start from `config/example/sources.txt`).
3. Otherwise, `slack` and `jira`.

It looks each name up in `~/.config/qitt/sources/<name>/` first, then in `sources/<name>/` here.
So a source of your own, or your own version of one that ships, needs no fork, and its workplace
details stay out of the repo.

For each profile, the installer puts every enabled source's section under the **Sources** heading
of the charter, in the order listed, merges every `deny.txt` into the deny list, and copies
`skills/`. Re-run it after any change to a source, as you do after editing `context.md`.

## How events get in

Every source ends at the same place: a T3 webhook task bound to the qitt thread. There are two
ways to get there.

- **The service can call a webhook** (most trackers, pagers and code hosts, or a relay in front of
  them). Point it at the hook filter, with the task's path: `/api/hooks/<task id>/<token>`. The
  filter forwards only webhook routes to T3, checks the HMAC signature when you configure a
  secret, and drops duplicate deliveries. There is no code to write.
  [setup.md](setup.md#intake-endpoint) has the signature format.
- **Something must hold a connection or poll** (chat over a socket, a mailbox). Write a small
  bridge that runs on the same machine and POSTs JSON to the task's local URL.
  [`sources/slack/bridge/`](../sources/slack/bridge/) is a complete one: it filters, dedupes,
  batches, survives restarts, and reports its own health. Its batching and delivery code
  (`lib/batch.mjs`, `lib/delivered.mjs`) is a good place to start from.

Either way the body is JSON, and `intake.md` says how to read it, with `{{body.<field>}}`
placeholders. Prefer one placeholder that holds the events as compact text over a dump of the
JSON: it costs far fewer tokens, and T3 frames the value as untrusted data once.

## Writing `qitt.md`

Write it in the owner's voice ("I", "me"), like the rest of the charter: a charter is the owner's
instructions to the agent. Start at `### <Name>` and use `####` for sections below it. It must
say:

- **What one event looks like** as the prompt renders it, and what each flag means.
- **The header fields** of an item from this source:
  - `source`: how to write the link to where it arrived.
  - `source-key`: `<name>:<stable id of the conversation or item>`. Routing and search rely on
    this key being the same every time the same conversation comes back.
- **What counts as an ask there:** the triage guidelines only this source needs.
- **Anything it sends that is not an item to triage:** health notices, the owner's own replies,
  the result of a scheduled sweep. Say what to do with each.

The core charter already covers the five triage decisions, routing, the worker header, peer
environments, the board and the reply format. Don't repeat them.

## Writing `worker.md`

Three things, each in a line or two:

- **Read:** what "the source in full" means here, and the tool or skill to read it with.
- **Reply:** how a proposed reply goes out. As a draft saved in the source if it has drafts,
  otherwise as text in the brief. Never sent.
- **Names:** how to name this source's places and link to them, the way the owner sees them.

## Example: adding Microsoft Teams

Teams does not ship here. This is the path, not a tested module.

1. **Copy the template** to a folder of your own:

   ```bash
   mkdir -p ~/.config/qitt/sources
   cp -R sources/_template ~/.config/qitt/sources/teams
   ```

2. **Decide how events get in.** If something on your side can call a webhook when a message
   reaches you (a change notification, an automation flow), point it at the hook filter. If not,
   write a bridge that polls and posts batches on localhost, as the Slack one does.
3. **Fill in `qitt.md`:** what a Teams event looks like, `source-key: teams:<chat id>:<message
   id>` or whatever identifies a conversation for you, and what counts as an ask (a 1:1 chat, a
   mention, a reply in a thread you are part of).
4. **Fill in `worker.md`:** read the whole conversation with your Teams tool, and how a reply
   reaches you for review.
5. **List the send tools in `deny.txt`,** with the names your Teams MCP server really uses. Check
   them against the server's tool list: a name that matches nothing denies nothing.
6. **Enable it and reinstall:**

   ```bash
   printf 'slack\njira\nteams\n' >| ~/.config/qitt/sources.txt
   bin/install-profiles
   ```

7. **Create the webhook task.** In the qitt thread, ask it to create a webhook task with your
   `intake.md` as the prompt (a webhook task binds to the thread that creates it), and store the
   task's URL under `~/.config/qitt/secrets/` for your bridge or relay.
   [setup.md](setup.md#the-qitt-thread) has the details.
8. **Send one test event** and read qitt's reply before pointing real traffic at it. If it says
   the event comes from a source with no section, the install did not pick the source up.
