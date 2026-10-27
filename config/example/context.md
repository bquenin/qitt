# qitt local context

Copy to `~/.config/qitt/context.md` and fill in. This file is imported into the qitt and worker
charters and must never be committed. The charters are written in the owner's voice ("I", "me"):
everything they need to know about the owner and the workplace comes from here.

mode: live   # or shadow: decide and write what you would do, without launching (replays)

## Me

- Name: <full name> (first name: <how agents name me in messages, e.g. "Ada">)
- Role: <team, what I own, in one line>
- Timezone: <IANA name, e.g. America/New_York>, written `<label, e.g. ET>`. Keep it the same as
  `timezone` (and `timezoneLabel`, if set) in `bridge.json`.
- Slack user id: <U...>
- JIRA account id: <...>
- GitHub handles: <handle on each host>
- Manager: <name> (<Slack id>)

## T3

- qitt thread id: <thread id>
- Workers project id: <project id>  (root: ~/.local/state/qitt/projects/worker)
- Hand-work project ids (where I start threads myself): <project id>, ...
- qitt repo checkout: <path> (for `bin/qitt-mute`)

## Peer environments

Other T3 environments the hub reaches (`peerEnvironments` in the server settings; labels come
from `t3_environment_read`). One line per peer: its workers project there, and what only that
machine can do.

- <label> (<what it is, e.g. my laptop>): workers project id <project id>; use for <pages
  behind company sign-in, ...>

## My user groups

- <S...>: <team>. Mentions of it are asks for me, except in support channels.

## Support channels

Channels someone else answers (for example a support rotation); also `supportChannels` in
`bridge.json`. Messages that mention me personally, replies in threads I am part of, and messages
I saved are asks; group mentions and the rest are not.

- #<name> (<C...>): <who answers there>

## Systems I own

- <system, service, or area>: "someone else is on it" is not a reason to ignore these.

## Priority requesters

Handled first; the strongest case for pre-work.

- <name> (<Slack id>): <role, what they usually ask for>

## Out of scope

Requests qitt ignores, with the reason given here (for example work another agent or team
handles for me):

- <kind of request, and how to recognize it>: <reason, e.g. "handled by my review agent">

## Ticket playbooks

Kinds of JIRA ticket handled by a skill (see the charter). The daily sweep runs each one.

- <kind of ticket, and how to recognize it>: skill `<name>`

## Bots

- Actionable: <bot name>: <what to do with it>
- Ignore: <bot name>, ...

## Remind-only

Topics and people whose messages get a reminder line only, beyond the defaults in the charter:

- <...>

## Workers

For worker threads: where to find evidence, how to write as me, and how to reach pages behind
sign-in.

- Evidence sources: <skills and read-only tools workers should use, e.g. a logs or metrics
  skill, a cluster skill, a past-session search tool>
- Dashboards: <the dashboard catalog skill or links to start from for metrics, adoption, or cost
  questions; or none>
- Voice: <where my writing rules live, e.g. "a section of my global agent instructions"; or none>
- Sign-in: <signed-in cookie jars under ~/.config/qitt/secrets/ (`<site>-cookies.txt`, Netscape
  format), the sites they cover and how they are refreshed; or none>
- Needs my laptop: <peer label and what only it can open, e.g. pages behind a device-bound
  sign-in; or none>
