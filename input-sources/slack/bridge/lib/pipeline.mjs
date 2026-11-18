// One Socket Mode envelope (or a search match wrapped as one) in, at most one normalized event
// into the batcher.
import { Recent } from "./dedupe.mjs";
import { contentDrop, dropReason, isSupport, keepReason, mentions, supportDrop } from "./filter.mjs";
import { normalize } from "./normalize.mjs";

// Returns a handler that resolves to the reason the event was kept or skipped (for tests).
// delivered remembers the message ids already batched (lib/delivered.mjs persists them once the
// batch is flushed). muted (a Muted) is optional: kept messages in a muted conversation are dropped
// unless they mention me personally. conversations (a Conversations) is optional: with it, every
// message of mine outside a muted conversation is batched flagged my_reply, so the thread that
// drafted it, or the one working on that conversation, learns I posted; without it my messages are
// always dropped. Slack cannot tell a sent draft from a typed message, and a draft can start a
// conversation qitt never heard about (a top-level post, a first DM) or answer a thread it never
// saw, so qitt finds the drafting thread by the text. conversation_known says whether qitt heard
// about the conversation, so it knows whether a thread can already be working on it.
export const createPipeline = ({ cfg, threads, directory, batcher, muted, conversations, log = () => {}, limit = 5000, delivered = new Recent(limit) }) => {
  const eventIds = new Recent(limit);
  return async (body) => {
    if (body?.event_id && !eventIds.remember(body.event_id)) return "duplicate event";
    const event = body?.event;
    if (event?.type !== "message") return "not a message";
    if (event.user === cfg.me) {
      threads.noteMine(event);
      if (conversations && !contentDrop(event, cfg) && !muted?.match(event)) {
        const id = `slack:${event.channel}:${event.ts}`;
        if (!delivered.remember(id, event.ts)) return "duplicate message";
        const known = conversations.knows(event);
        batcher.add({ ...(await normalize(event, cfg, directory)), my_reply: true, conversation_known: known });
        log(`my reply ${id}${known ? "" : " (conversation new to qitt)"}`);
        return "my reply";
      }
    }
    // In a support channel, a group mention is the one drop worth a log line: it reached qitt before
    // support channels existed. The rest of a busy support channel stays out of the log.
    const supportDropped = () => {
      if (mentions(event.text, cfg).group) log(`dropped slack:${event.channel}:${event.ts}: support channel (mentions group)`);
      return "support channel";
    };
    const drop = dropReason(event, cfg) ?? supportDrop(event, cfg);
    if (drop === "support channel") return supportDropped();
    if (drop) return drop;
    const keep = await keepReason(event, cfg, threads);
    if (keep === null) return "thread lookup failed";
    if (!keep) return isSupport(event, cfg) ? supportDropped() : "not relevant";
    const mute = mentions(event.text, cfg).me ? undefined : muted?.match(event);
    if (mute) {
      log(`dropped slack:${event.channel}:${event.ts}: muted ${mute} (${keep})`);
      return "muted";
    }
    // The same author and ts in another channel is a copy (a DM's history copied into a new group
    // DM when someone is added), not a new message.
    const aliases = event.user ? [`user:${event.user}:${event.ts}`] : [];
    if (!delivered.remember(`slack:${event.channel}:${event.ts}`, event.ts, aliases)) return "duplicate message";
    // Learned before the Slack lookups, so a reply of mine handled meanwhile finds it.
    conversations?.note(event, cfg.me);
    batcher.add(await normalize(event, cfg, directory));
    return keep;
  };
};
