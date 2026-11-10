// @slack/socket-mode 3.1.0 assumes every events_api envelope carries payload.event and crashes
// on one that doesn't. This replaces its ws_message listener with one that acks and skips such
// envelopes, and turns any other parsing error into a log line instead of a fatal rejection. It also
// logs each hello: the app id and how many connections its app token has open, since Slack spreads
// events across them and another client on the same token would take a share.
import { timeLocal } from "./time.mjs";

const decode = (data) => (typeof data === "string" ? data : new TextDecoder().decode(data));

const parse = (raw) => {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined; // Not JSON: the library logs and ignores it.
  }
};

// For a parsed events_api envelope without an event: its id and payload type, and for
// app_rate_limited the workspace and the minute Slack started limiting it (epoch seconds).
// Otherwise undefined.
export const eventlessEnvelope = (msg) => {
  if (msg?.type !== "events_api" || msg.payload?.event) return undefined;
  const p = msg.payload ?? {};
  return { id: msg.envelope_id, kind: p.type ?? "unknown", team: p.team_id, minute: p.minute_rate_limited };
};

// "app_rate_limited, team T0123, since Thu 11/5 10:57 PT"; just the kind when that is all there is.
const describe = (s) =>
  [s.kind, s.team && `team ${s.team}`, typeof s.minute === "number" && `since ${timeLocal(new Date(s.minute * 1000))}`]
    .filter(Boolean)
    .join(", ");

// onSkipped(kind, { team, minute }) runs for each skipped envelope; app_rate_limited means Slack
// dropped events.
export const guardSocket = (socket, log, onSkipped = () => {}) => {
  socket.removeAllListeners("ws_message");
  socket.on("ws_message", (data, isBinary) => {
    if (!isBinary) {
      const msg = parse(decode(data));
      const skipped = eventlessEnvelope(msg);
      if (skipped) {
        log(`skipped events_api envelope without event (${describe(skipped)})`);
        if (skipped.id) socket.send(skipped.id).catch((err) => log(`ack failed: ${err?.message}`));
        onSkipped(skipped.kind, { team: skipped.team, minute: skipped.minute });
        return;
      }
      if (msg?.type === "hello") {
        const n = msg.num_connections ?? "?";
        log(`hello: app ${msg.connection_info?.app_id ?? "?"}, ${n} open connection${n === 1 ? "" : "s"}`);
      }
    }
    socket.onWebSocketMessage(data, isBinary).catch((err) => log(`socket message error: ${err?.message}`));
  });
};
