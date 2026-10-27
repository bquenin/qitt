#!/usr/bin/env node
// slack-bridge: hold a Socket Mode connection, keep the Slack messages qitt should see, and POST
// them in batches to qitt's T3 webhook on localhost. Read-only: it never writes to Slack.
//
//   node slack-bridge.mjs             run (bin/qitt-bridge keeps it running detached)
//   node slack-bridge.mjs --dry-run   print each batch body to stdout instead of POSTing
//
// The Slack app subscribes to DMs and group DMs only; channel messages (mentions, my threads,
// watched channels) come from polling search (lib/search.mjs), which also catches up DMs the
// socket missed. It also polls my saved-for-later items (lib/saved.mjs) and batches newly saved
// ones, and sends my own messages in conversations qitt has heard about (lib/conversations.mjs).
// Conversations muted with bin/qitt-mute are dropped unless a message mentions me (lib/muted.mjs).
// A reconciler reads the conversations I am in straight from Slack and backfills what live events
// and search missed (lib/reconcile.mjs); problems that can lose messages reach qitt as bridge
// health events (lib/health.mjs).
//
// Config: ~/.config/qitt/bridge.json (see config/example/bridge.json). Tokens:
// ~/.config/qitt/secrets/slack-app-token (xapp-, Socket Mode) and slack-user-token (xoxp-).
// State: ~/.local/state/qitt/bridge-{saved,search,delivered,conversations,reconcile}.json (.dry-run.json with --dry-run); mutes: ~/.local/state/qitt/muted.json. Log: ~/.local/state/qitt/logs/slack-bridge.log. A fatal start error exits non-zero.
import { SocketModeClient } from "@slack/socket-mode";
import { WebClient } from "@slack/web-api";
import { homedir } from "node:os";
import { join } from "node:path";
import { Batcher, postBatch } from "./lib/batch.mjs";
import { loadConfig, readToken } from "./lib/config.mjs";
import { Conversations, conversationsFilePath } from "./lib/conversations.mjs";
import { Delivered, deliveredFilePath } from "./lib/delivered.mjs";
import { ThreadTracker } from "./lib/filter.mjs";
import { errorText, fileLogger, slackLogger } from "./lib/log.mjs";
import { Directory } from "./lib/normalize.mjs";
import { guardSocket } from "./lib/guard.mjs";
import { Health } from "./lib/health.mjs";
import { Muted } from "./lib/muted.mjs";
import { createPipeline } from "./lib/pipeline.mjs";
import { Reconciler, reconcileStatePath } from "./lib/reconcile.mjs";
import { SavedPoller, stateFilePath } from "./lib/saved.mjs";
import { SearchPoller, searchStatePath } from "./lib/search.mjs";
import { configureTime } from "./lib/time.mjs";

const dryRun = process.argv.includes("--dry-run");
const configDir = join(homedir(), ".config/qitt");
const writeLog = fileLogger(join(homedir(), ".local/state/qitt/logs/slack-bridge.log"));
const log = (line) => {
  writeLog(line);
  if (dryRun) console.error(line);
};

const fatal = (what, err, detail = errorText(err)) => {
  log(`fatal: ${what}: ${detail}`);
  process.exit(1);
};
process.on("unhandledRejection", (err) => fatal("unhandled rejection", err));
process.on("uncaughtException", (err) => fatal("uncaught exception", err));
for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, () => {
    log(`stopping on ${signal}`);
    process.exit(0);
  });
}

let cfg, appToken, userToken;
try {
  cfg = loadConfig(join(configDir, "bridge.json"));
  appToken = readToken(join(configDir, "secrets/slack-app-token"), "xapp-");
  userToken = readToken(join(configDir, "secrets/slack-user-token"), "xoxp-");
  configureTime(cfg);
} catch (err) {
  fatal("config", err, err.message);
}

const slackLog = slackLogger(log);
const web = new WebClient(userToken, { logger: slackLog });
try {
  const auth = await web.auth.test();
  if (auth.user_id !== cfg.me) log("warning: bridge.json me is not the user token's user");
} catch (err) {
  fatal("auth.test", err);
}

const delivered = new Delivered({ file: deliveredFilePath(homedir(), dryRun) });
const send = dryRun
  ? (body) => {
      process.stdout.write(`${JSON.stringify(body, null, 2)}\n`);
      log(`batch ${body.id} count=${body.count} dry-run`);
    }
  : (body) => postBatch(body, { urlFile: cfg.webhookUrlFile, log });
// Message ids are committed as delivered once their batch leaves the batcher.
const flush = (body) => {
  delivered.commit(body.events.map((e) => e.id));
  return send(body);
};

const directory = new Directory({ client: web, log });
const conversations = new Conversations({ file: conversationsFilePath(homedir(), dryRun), log });
const batcher = new Batcher({
  windowMs: cfg.batchWindowSeconds * 1000,
  flush,
  log,
  onAdd: (e) => conversations.note(e, cfg.me),
});
const health = new Health({ batcher, log });
const handle = createPipeline({
  cfg,
  threads: new ThreadTracker({ me: cfg.me, client: web, log }),
  directory,
  batcher,
  muted: new Muted({ file: cfg.mutedFile, log }),
  conversations,
  log,
  delivered,
});
const search = new SearchPoller({
  cfg,
  client: web,
  directory,
  handle,
  delivered,
  health,
  stateFile: searchStatePath(homedir(), dryRun),
  log,
});
const reconciler = new Reconciler({
  cfg,
  client: web,
  handle,
  conversations,
  delivered,
  health,
  stateFile: reconcileStatePath(homedir(), dryRun),
  log,
});
const saved = new SavedPoller({
  cfg,
  client: web,
  directory,
  batcher,
  stateFile: stateFilePath(homedir(), dryRun),
  log,
});

const socket = new SocketModeClient({ appToken, logger: slackLog });
guardSocket(socket, log, (kind) => {
  if (kind !== "app_rate_limited") return;
  search.catchUp("app_rate_limited");
  health.rateLimited();
});

socket.on("slack_event", async ({ ack, type, body }) => {
  try {
    await ack();
  } catch (err) {
    log(`ack failed: ${errorText(err)}`);
  }
  if (type !== "events_api") return;
  try {
    await handle(body);
  } catch (err) {
    log(`event error: ${errorText(err)}`);
  }
});
let connections = 0;
socket.on("connected", () => {
  log("connected");
  if (++connections > 1) search.catchUp("reconnected");
});
socket.on("reconnecting", () => log("reconnecting"));

try {
  await socket.start();
} catch (err) {
  fatal("socket mode start", err);
}
log(`started${dryRun ? " (dry run)" : ""}: timezone ${cfg.timezone}, window ${cfg.batchWindowSeconds}s, ${cfg.groups.length} groups, ${cfg.watchChannels.length} watched channels, ${cfg.supportChannels.length} support channels, saved poll ${cfg.savedPollSeconds ? `${cfg.savedPollSeconds}s` : "off"}, search poll ${cfg.searchPollSeconds ? `${cfg.searchPollSeconds}s` : "off"}, reconcile ${cfg.reconcileMinutes ? `${cfg.reconcileMinutes}m` : "off"}`);
search.start();
saved.start();
reconciler.start();
