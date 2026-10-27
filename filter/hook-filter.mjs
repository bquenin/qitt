#!/usr/bin/env node
// Expose only T3 webhook deliveries on a port reachable from outside this machine.
//
// POST/PUT/PATCH /api/hooks/<hookId>/<token> is forwarded to the local T3 server; GET /healthz
// answers "ok" for reachability checks; everything else gets 404. The token in the path is the
// webhook's authentication, so it never reaches the log.
//
// When the secret file exists (filter.json `secretFile`, default
// ~/.config/qitt/secrets/relay-hmac-secret; comma-separated for rotation), every delivery must
// carry an HMAC signature from the webhook relay: <signature header> = sha256=HMAC(secret,
// "<timestamp header>.<delivery id header>.<body>"), with a timestamp under maxSkewSeconds (default
// 5 minutes) old. Header names come from ~/.config/qitt/filter.json (see config/example/filter.json and lib.mjs). The
// Slack bridge posts to T3 directly on localhost, so this port only serves the relay.
//
// T3 only dedupes deliveries from its own relay, so retries are deduped here by the delivery id
// header (or the body's top-level "id") for an hour.
import { createServer, request } from "node:http";
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { loadFilterConfig, readSecrets, signatureProblem } from "./lib.mjs";

const port = Number(process.env.QITT_FILTER_PORT ?? 3780);
const t3Port = Number(process.env.QITT_T3_PORT ?? readFileSync(join(homedir(), ".t3/server-port"), "utf8").trim());
const logDir = join(homedir(), ".local/state/qitt/logs");
const maxBody = 1024 * 1024;
const hookPath = /^\/api\/hooks\/([^/]+)\/[^/]+$/;

mkdirSync(logDir, { recursive: true });
const log = (line) => appendFileSync(join(logDir, "hook-filter.log"), `${new Date().toISOString()} ${line}\n`);

let cfg, secrets;
try {
  cfg = loadFilterConfig(join(homedir(), ".config/qitt/filter.json"));
  secrets = readSecrets(cfg);
} catch (err) {
  log(`fatal: config: ${err.message}`);
  process.exit(1);
}

const seen = new Map(); // delivery id -> accepted at (ms)
const inflight = new Map(); // delivery id being forwarded -> { promise of accepted, resolve }
const dedupeMs = 60 * 60 * 1000;
const upstreamTimeoutMs = 15 * 1000;

const deliveryId = (body) => {
  try {
    const id = JSON.parse(body.toString("utf8"))?.id;
    return typeof id === "string" && id !== "" ? id : undefined;
  } catch {
    return undefined;
  }
};

const reply = (res, status, body) => {
  if (res.headersSent) return res.destroy();
  res.writeHead(status, { "content-type": "text/plain" });
  res.end(body);
};

createServer((req, res) => {
  const path = (req.url ?? "").split("?")[0];
  if (req.method === "GET" && path === "/healthz") return reply(res, 200, "ok\n");

  const match = hookPath.exec(path);
  if (!match || !["POST", "PUT", "PATCH"].includes(req.method ?? "")) {
    log(`${req.method} ${path.startsWith("/api/hooks/") ? "/api/hooks/…" : path.slice(0, 80)} 404`);
    return reply(res, 404, "not found\n");
  }
  let hook;
  try {
    hook = decodeURIComponent(match[1]).slice(-40);
  } catch {
    log(`${req.method} /api/hooks/… 400 malformed path`);
    return reply(res, 400, "bad request\n");
  }

  const chunks = [];
  let size = 0;
  req.on("data", (chunk) => {
    size += chunk.length;
    if (size > maxBody) {
      log(`${req.method} hook=${hook} 413`);
      reply(res, 413, "payload too large\n");
      req.destroy();
    } else chunks.push(chunk);
  });
  req.on("end", () => {
    if (res.writableEnded) return;
    const body = Buffer.concat(chunks);
    const problem = signatureProblem(req.headers, body, { secrets, cfg });
    if (problem !== undefined) {
      log(`${req.method} hook=${hook} 401 ${problem}`);
      return reply(res, 401, "unauthorized\n");
    }
    const id = req.headers[cfg.deliveryIdHeader] || deliveryId(body);
    const now = Date.now();
    for (const [key, at] of seen) if (now - at > dedupeMs) seen.delete(key);
    const duplicate = () => {
      log(`${req.method} hook=${hook} 202 duplicate`);
      res.writeHead(202, { "content-type": "application/json" });
      res.end(JSON.stringify({ duplicate: true }));
    };
    if (id !== undefined && seen.has(id)) return duplicate();
    // A retry that overlaps the first copy waits for its outcome: 202 only if T3 accepted it,
    // otherwise 502 so the sender retries again.
    if (id !== undefined && inflight.has(id)) {
      return inflight.get(id).promise.then((accepted) => {
        if (accepted) return duplicate();
        log(`${req.method} hook=${hook} 502 first copy failed`);
        reply(res, 502, "upstream unavailable\n");
      });
    }
    if (id !== undefined) {
      let resolve;
      const promise = new Promise((r) => (resolve = r));
      inflight.set(id, { promise, resolve });
    }
    let settled = false;
    const settle = (accepted) => {
      if (id === undefined || settled) return;
      settled = true;
      if (accepted) seen.set(id, now);
      inflight.get(id)?.resolve(accepted);
      inflight.delete(id);
    };
    const upstream = request(
      {
        host: "127.0.0.1",
        port: t3Port,
        method: req.method,
        path: req.url,
        headers: { "content-type": req.headers["content-type"] ?? "application/json", "content-length": body.length },
      },
      (up) => {
        log(`${req.method} hook=${hook} ${up.statusCode}`);
        settle(up.statusCode === 202);
        up.on("error", (err) => {
          log(`${req.method} hook=${hook} upstream response error ${err.code ?? err.message}`);
          res.destroy();
        });
        res.writeHead(up.statusCode ?? 502, { "content-type": up.headers["content-type"] ?? "text/plain" });
        up.pipe(res);
      },
    );
    upstream.setTimeout(upstreamTimeoutMs, () => upstream.destroy(new Error("timeout")));
    upstream.on("error", (err) => {
      settle(false);
      log(`${req.method} hook=${hook} 502 ${err.code ?? err.message}`);
      reply(res, 502, "upstream unavailable\n");
    });
    // The caller gave up before we answered: stop waiting on T3.
    res.on("close", () => {
      if (!res.writableFinished) upstream.destroy(new Error("caller disconnected"));
    });
    upstream.end(body);
  });
}).listen(port, "0.0.0.0", () =>
  log(
    `listening on 0.0.0.0:${port} -> 127.0.0.1:${t3Port}, signatures ${
      secrets.length ? `required (${cfg.signatureHeader}, ${cfg.timestampHeader}, ${cfg.deliveryIdHeader})` : "not configured"
    }`,
  ),
);
