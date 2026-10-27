// bridge.json and token files. See config/example/bridge.json.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { checkTimezone, systemTimezone } from "./time.mjs";

export const expandHome = (path) => path.replace(/^~(?=\/|$)/, homedir());

const ids = (value, name) => {
  if (value === undefined) return [];
  if (!Array.isArray(value) || !value.every((v) => typeof v === "string")) throw new Error(`${name} must be an array of ids`);
  return value;
};

export const parseConfig = (raw) => {
  if (typeof raw?.me !== "string" || raw.me === "") throw new Error("me is required");
  const window = raw.batchWindowSeconds ?? 20;
  if (typeof window !== "number" || !(window > 0)) throw new Error("batchWindowSeconds must be a positive number");
  const savedPoll = raw.savedPollSeconds ?? 300;
  if (typeof savedPoll !== "number" || !(savedPoll >= 0)) throw new Error("savedPollSeconds must be a number, 0 to disable");
  const searchPoll = raw.searchPollSeconds ?? 60;
  if (typeof searchPoll !== "number" || !(searchPoll >= 0)) throw new Error("searchPollSeconds must be a number, 0 to disable");
  const reconcile = raw.reconcileMinutes ?? 15;
  if (typeof reconcile !== "number" || !(reconcile >= 0)) throw new Error("reconcileMinutes must be a number, 0 to disable");
  if (raw.timezone !== undefined) {
    const bad = new Error("timezone must be an IANA timezone name, e.g. America/New_York");
    if (typeof raw.timezone !== "string") throw bad;
    try {
      checkTimezone(raw.timezone);
    } catch {
      throw bad;
    }
  }
  if (raw.timezoneLabel !== undefined && (typeof raw.timezoneLabel !== "string" || raw.timezoneLabel.trim() === "")) {
    throw new Error("timezoneLabel must be a non-empty string");
  }
  return {
    me: raw.me,
    groups: ids(raw.groups, "groups"),
    watchChannels: ids(raw.watchChannels, "watchChannels"),
    supportChannels: ids(raw.supportChannels, "supportChannels"),
    ignoreBots: raw.ignoreBots ?? true,
    batchWindowSeconds: window,
    savedPollSeconds: savedPoll,
    searchPollSeconds: searchPoll,
    reconcileMinutes: reconcile,
    // Times on events and batch windows; defaults to the system timezone and its short name.
    timezone: raw.timezone ?? systemTimezone(),
    timezoneLabel: raw.timezoneLabel ?? null,
    webhookUrlFile: expandHome(raw.webhookUrlFile ?? "~/.config/qitt/secrets/webhook-slack.local.url"),
    mutedFile: expandHome(raw.mutedFile ?? "~/.local/state/qitt/muted.json"),
  };
};

export const loadConfig = (file) => parseConfig(JSON.parse(readFileSync(file, "utf8")));

// Reads a token and checks its prefix; the error never includes the token itself.
export const readToken = (file, prefix) => {
  const token = readFileSync(file, "utf8").trim();
  if (!token.startsWith(prefix)) throw new Error(`${file} does not hold a ${prefix} token`);
  return token;
};
