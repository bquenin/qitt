# Setup

How qitt is wired on the machine that runs it. Anything with a name, hostname, id, or token lives
under `~/.config/qitt/` and is never committed.

## Profiles

`bin/install-profiles` installs the qitt and worker T3 project roots. Register them as T3 projects
once (`qitt`, `qitt workers`) and put the workers project id in `~/.config/qitt/context.md`. Set
`QITT_SLACK_MCP_SERVER` when running it if your Slack MCP server is not named `slack-cli` (see the
README, Dependencies).

The installer also copies `~/.config/qitt/context.md` into each root as `context.local.md`
(mode 600), which the charters import as `@context.local.md`. Claude Code loads imports from
inside the project without asking, but an import from outside it (including through a symlink)
needs an approval that headless threads never give, so the file is copied. **Re-run
`bin/install-profiles` after editing `context.md`**; threads started afterwards see the new
version. `QITT_CONTEXT=<path>` installs another file (for tests). If the file is missing, the
installer warns and leaves the import out, and the charters fall back: workers read
`~/.config/qitt/context.md` themselves, and qitt stays in shadow mode.

## The qitt thread

Launch a thread in the qitt project, pin it, and have it create its own intake tasks (a webhook
task binds to the thread that creates it): `schedule_task` with `{"type": "webhook"}`, one per
source, prompts from `prompts/intake-slack.md` and `prompts/intake-jira.md`. Saved-for-later
items come from the Slack bridge, in the same Slack batches (see below); there is no separate task.

The ticket sweep is a fixed-time task, also created by the qitt thread: weekday mornings, prompt
from `prompts/ticket-sweep.md`. It catches playbook tickets the JIRA intake never sees (tickets
assigned to someone else).

Without T3 Connect, `schedule_task` returns no webhook URL. The local route is
`/api/hooks/<url-encoded task id>/<webhook token>`; the token is in T3's state database
(`scheduled_tasks.webhook_token`). Store each URL in `~/.config/qitt/secrets/` (mode 600).

## Intake endpoint

JIRA events reach T3 through a webhook relay you run or subscribe to (anything that can POST JSON
to a URL, ideally signing each delivery with HMAC), and the hook filter on this machine.

- `bin/qitt-filter` keeps `filter/hook-filter.mjs` running on port 3780 (`QITT_FILTER_PORT`);
  call `qitt-filter ensure` from `~/.profile` so it comes back after a restart.
- The filter forwards only `POST|PUT|PATCH /api/hooks/*` to T3 and answers `GET /healthz`;
  everything else is 404. It dedupes deliveries by the delivery id header (or the body's `id`)
  for an hour, since T3 only dedupes deliveries from its own relay.
- When the secret file exists, every delivery must carry the relay's signature: the signature
  header is `sha256=` + hex HMAC-SHA256 of `<timestamp>.<delivery id>.<body>` with that secret,
  and the timestamp (Unix seconds or milliseconds, or an ISO date) must be under
  `maxSkewSeconds` old. Configure the relay to sign with the same secret. Header names and the
  secret file are set in `~/.config/qitt/filter.json` (below). T3's own webhook signature check
  can't be used: it signs the body alone.
- The Slack bridge posts to T3 directly on localhost, not through the filter, so the filter's
  port only serves the relay.

### Exposing the endpoint

Make only the filter's port reachable from the relay, never T3's own port: the filter is what
limits outside callers to `/api/hooks/*`. How depends on the host (a port share, a tunnel, a
reverse proxy). If the external URL changes, update the webhook URLs in `~/.config/qitt/secrets/`
and the relay's subscription.

## Slack bridge

`bin/qitt-bridge` keeps `bridge/slack-bridge.mjs` running under a restart loop; `~/.profile` calls
`qitt-bridge ensure`. It reads `~/.config/qitt/bridge.json` and the two Slack tokens in
`~/.config/qitt/secrets/`, and posts batches to T3 on localhost (not through the filter). It also
polls my saved-for-later items (needs `search:read` on the user token) and sends new saves and
removals as events in the same batches. Details in [bridge/README.md](../bridge/README.md).

## Configuration

Start from `config/example/`. Nothing here is committed.

| File | What |
| --- | --- |
| `~/.config/qitt/context.md` | Copied into both profiles by `bin/install-profiles` and imported by the charters (re-run it after editing): who the owner is (name, first name, timezone, ids), T3 project and thread ids, peer environments, user groups, support channels, systems owned, priority requesters, out-of-scope requests, ticket playbooks, bots, remind-only topics, and a **Workers** section (evidence sources, dashboards, voice rules, sign-in helpers, what needs the laptop). |
| `~/.config/qitt/bridge.json` | Slack bridge config. Keys in [bridge/README.md](../bridge/README.md#local-files), including `timezone` and `timezoneLabel`. |
| `~/.config/qitt/filter.json` | Optional hook filter config; every key has a default (below). |
| `~/.config/qitt/secrets/` | Slack tokens, webhook URLs, the relay's HMAC secret, cookie jars (mode 600). |

`filter.json` keys:

- `secretFile` (default `~/.config/qitt/secrets/relay-hmac-secret`): the HMAC secret,
  comma-separated to rotate. With the default, signatures are required only when the file exists;
  a `secretFile` set explicitly must exist, or the filter does not start.
- `signatureHeader` (default `X-Signature`), `timestampHeader` (default `X-Timestamp`),
  `deliveryIdHeader` (default `X-Delivery-Id`): the header names your relay sends.
- `maxSkewSeconds` (default `300`): how old a delivery's timestamp may be.

The timezone appears twice: `timezone` in `bridge.json` sets the times on Slack events, and the
`Timezone` line in `context.md` tells the agents which zone and label to write. Keep them the
same. Both default to the system timezone.

## Body shapes

- **Slack** (bridge): `{"id": "<batch id>", "count": n, "window": "<label>", "events": [...],
  "digest": "<text>"}`. The prompt reads only `digest`, the batch rendered as compact text (see
  [bridge/README.md](../bridge/README.md#body)).
- **JIRA** (relay): an envelope `{"id", "source", "type", "action", "received_at", "payload"}`,
  where `payload` is the JIRA webhook body. If your relay sends another shape, adapt
  `prompts/intake-jira.md`.
