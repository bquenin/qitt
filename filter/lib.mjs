// Config and signature check for hook-filter.mjs. Config: ~/.config/qitt/filter.json, optional
// (see config/example/filter.json); every key has a default.
import { createHmac, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";

const expandHome = (path) => path.replace(/^~(?=\/|$)/, homedir());

export const defaultSecretFile = "~/.config/qitt/secrets/relay-hmac-secret";

// Node lower-cases incoming header names, so they are compared lower-cased.
const header = (raw, key, fallback) => {
  const value = raw[key] ?? fallback;
  if (typeof value !== "string" || !/^[A-Za-z0-9-]+$/.test(value)) throw new Error(`${key} must be an HTTP header name`);
  return value.toLowerCase();
};

export const parseFilterConfig = (raw = {}) => {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw new Error("filter config must be an object");
  if (raw.secretFile !== undefined && (typeof raw.secretFile !== "string" || raw.secretFile === "")) {
    throw new Error("secretFile must be a path");
  }
  const skew = raw.maxSkewSeconds ?? 300;
  if (typeof skew !== "number" || !(skew > 0)) throw new Error("maxSkewSeconds must be a positive number");
  return {
    secretFile: expandHome(raw.secretFile ?? defaultSecretFile),
    // An explicit secretFile must exist; the default one turns signatures on only when present.
    secretRequired: raw.secretFile !== undefined,
    signatureHeader: header(raw, "signatureHeader", "X-Signature"),
    timestampHeader: header(raw, "timestampHeader", "X-Timestamp"),
    deliveryIdHeader: header(raw, "deliveryIdHeader", "X-Delivery-Id"),
    maxSkewMs: skew * 1000,
  };
};

export const loadFilterConfig = (file) =>
  parseFilterConfig(existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {});

// Comma-separated secrets, for rotation. No file means signatures are not checked.
export const readSecrets = ({ secretFile, secretRequired }) => {
  if (!existsSync(secretFile)) {
    if (secretRequired) throw new Error(`secretFile ${secretFile} does not exist`);
    return [];
  }
  const secrets = readFileSync(secretFile, "utf8").split(",").map((s) => s.trim()).filter(Boolean);
  if (secrets.length === 0) throw new Error(`secretFile ${secretFile} is empty`);
  return secrets;
};

// Returns undefined when the request is acceptable, or the reason it is not. The signature is
// "sha256=" + hex HMAC-SHA256(secret, "<timestamp>.<delivery id>.<body>").
export const signatureProblem = (headers, body, { secrets, cfg, now = Date.now() }) => {
  if (secrets.length === 0) return undefined;
  const signature = headers[cfg.signatureHeader];
  const timestamp = headers[cfg.timestampHeader];
  const delivery = headers[cfg.deliveryIdHeader];
  if (!signature || !timestamp || !delivery) return "unsigned";
  // Unix milliseconds or seconds, or an ISO date.
  const n = Number(timestamp);
  const at = /^\d+$/.test(timestamp) ? (n > 1e12 ? n : n * 1000) : Date.parse(timestamp);
  if (!Number.isFinite(at) || Math.abs(now - at) > cfg.maxSkewMs) return "stale timestamp";
  const got = Buffer.from(signature);
  for (const secret of secrets) {
    const mac = createHmac("sha256", secret).update(`${timestamp}.${delivery}.`).update(body).digest("hex");
    const want = Buffer.from(`sha256=${mac}`);
    if (got.length === want.length && timingSafeEqual(got, want)) return undefined;
  }
  return "bad signature";
};
