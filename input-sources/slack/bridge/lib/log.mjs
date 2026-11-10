// File logging for the bridge. Every line is redacted: tokens and URLs (the webhook URL carries
// its token in the path) never reach the log, even inside library error messages.
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export const redact = (text) =>
  String(text)
    .replace(/\bxox[a-z]-[A-Za-z0-9-]+/g, "xox?-…")
    .replace(/\bxapp-[A-Za-z0-9-]+/g, "xapp-…")
    .replace(/\b(?:https?|wss?):\/\/\S+/g, "<url>");

export const fileLogger = (file) => {
  mkdirSync(dirname(file), { recursive: true });
  return (line) => appendFileSync(file, `${new Date().toISOString()} ${redact(line)}\n`);
};

// Short, token-free description of an error: Slack's error code, a system error code, or the message.
export const errorText = (err) => err?.data?.error ?? err?.code ?? err?.cause?.code ?? err?.message ?? String(err);

// @slack/logger interface: keep warnings and errors, drop the chatty levels.
export const slackLogger = (log) => ({
  debug() {},
  info() {},
  warn: (...args) => log(`slack: ${args.join(" ")}`),
  error: (...args) => log(`slack error: ${args.join(" ")}`),
  setLevel() {},
  getLevel: () => "warn",
  setName() {},
});
