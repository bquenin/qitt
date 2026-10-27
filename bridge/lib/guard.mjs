// @slack/socket-mode 3.1.0 assumes every events_api envelope carries payload.event and crashes
// on one that doesn't. This replaces its ws_message listener with one that acks and skips such
// envelopes, and turns any other parsing error into a log line instead of a fatal rejection.
const decode = (data) => (typeof data === "string" ? data : new TextDecoder().decode(data));

// Returns the payload type of an events_api envelope without an event, or undefined.
export const eventlessEnvelope = (raw) => {
  try {
    const e = JSON.parse(raw);
    if (e?.type === "events_api" && !e.payload?.event) return { id: e.envelope_id, kind: e.payload?.type ?? "unknown" };
  } catch {
    // Not JSON: the library logs and ignores it.
  }
  return undefined;
};

// onSkipped(kind) runs for each skipped envelope; app_rate_limited means Slack dropped events.
export const guardSocket = (socket, log, onSkipped = () => {}) => {
  socket.removeAllListeners("ws_message");
  socket.on("ws_message", (data, isBinary) => {
    if (!isBinary) {
      const skipped = eventlessEnvelope(decode(data));
      if (skipped) {
        log(`skipped events_api envelope without event (${skipped.kind})`);
        if (skipped.id) socket.send(skipped.id).catch((err) => log(`ack failed: ${err?.message}`));
        onSkipped(skipped.kind);
        return;
      }
    }
    socket.onWebSocketMessage(data, isBinary).catch((err) => log(`socket message error: ${err?.message}`));
  });
};
