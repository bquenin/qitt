// Which Slack message events reach qitt.
//
// Drop: my own messages, bot messages (when ignoreBots), edits/deletes/joins and every other
// subtype except thread_broadcast and file_share, and empty messages without files.
// Keep: DMs and group DMs, messages in watched channels, mentions of me or one of my user groups,
// and replies in threads I have posted in.
// Support channels: someone else answers there, so only mentions of me and replies in threads I
// have posted in are kept; group mentions and everything else are dropped.
const keptSubtypes = new Set(["thread_broadcast", "file_share"]);

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export const isBot = (event) => Boolean(event.bot_id) || event.subtype === "bot_message";

export const isReply = (event) => Boolean(event.thread_ts) && event.thread_ts !== event.ts;

export const threadKey = (channel, threadTs) => `${channel}:${threadTs}`;

// Returns why an event is dropped, or undefined when it may be kept.
export const dropReason = (event, cfg) => (event.user === cfg.me ? "from me" : contentDrop(event, cfg));

// dropReason without the "from me" check: bots, subtypes, and empty messages.
export const contentDrop = (event, cfg) => {
  if (cfg.ignoreBots && isBot(event)) return "bot";
  const subtype = event.subtype || undefined;
  if (subtype !== undefined && !keptSubtypes.has(subtype) && !(subtype === "bot_message" && !cfg.ignoreBots)) {
    return `subtype ${subtype}`;
  }
  if (!event.text?.trim() && !event.files?.length) return "empty";
  return undefined;
};

export const isSupport = (event, cfg) => cfg.supportChannels.includes(event.channel);

// Returns "support channel" for a top-level message in a support channel that does not mention me,
// or undefined. A reply there is left to keepReason, which keeps it only in a thread of mine. Wins
// over watchChannels and group mentions.
export const supportDrop = (event, cfg) =>
  isSupport(event, cfg) && !isReply(event) && !mentions(event.text, cfg).me ? "support channel" : undefined;

// <@U123> or <@U123|name> for me; <!subteam^S123> or <!subteam^S123|@name> for a group.
export const mentions = (text, cfg) => {
  const body = text ?? "";
  return {
    me: new RegExp(`<@${escape(cfg.me)}(?:\\|[^>]*)?>`).test(body),
    group: cfg.groups.some((g) => new RegExp(`<!subteam\\^${escape(g)}(?:\\|[^>]*)?>`).test(body)),
  };
};

// Everything keepReason can return.
export const keepReasons = new Set(["im", "mpim", "watched channel", "mentions me", "mentions group", "my thread"]);

// Returns why an event is kept, undefined when it is not, or null when a failed thread lookup left
// it undecided. Call only after dropReason returned undefined. In a support channel only a mention of
// me or a reply in my thread is kept.
export const keepReason = async (event, cfg, threads) => {
  if (event.channel_type === "im" || event.channel_type === "mpim") return event.channel_type;
  const support = isSupport(event, cfg);
  if (!support && cfg.watchChannels.includes(event.channel)) return "watched channel";
  const m = mentions(event.text, cfg);
  if (m.me) return "mentions me";
  if (!support && m.group) return "mentions group";
  if (!isReply(event)) return undefined;
  const mine = await threads.participated(event.channel, event.thread_ts);
  if (mine === null) return null;
  return mine ? "my thread" : undefined;
};

// Threads I have posted in. Learned from my own events as they arrive; on a miss, asked once per
// thread with conversations.replies and cached for the process lifetime. A failed lookup resolves
// to null (unknown), is not cached, and is asked again next time.
export class ThreadTracker {
  constructor({ me, client, log = () => {}, limit = 50000, maxPages = 50 }) {
    this.me = me;
    this.maxPages = maxPages;
    this.client = client;
    this.log = log;
    this.limit = limit;
    this.known = new Map(); // threadKey -> true | false | pending promise
  }

  #set(key, value) {
    this.known.set(key, value);
    if (this.known.size > this.limit) this.known.delete(this.known.keys().next().value);
  }

  // Pages through the thread until a message of mine turns up or the replies run out.
  async #scan(channel, ts) {
    let cursor;
    for (let page = 0; page < this.maxPages; page++) {
      const res = await this.client.conversations.replies({ channel, ts, limit: 200, ...(cursor && { cursor }) });
      if ((res.messages ?? []).some((m) => m.user === this.me)) return { found: true, complete: true };
      cursor = res.response_metadata?.next_cursor;
      if (!cursor) return { found: false, complete: true };
    }
    return { found: false, complete: false };
  }

  // True when the thread is already known to be mine; never asks Slack.
  knownMine(channel, threadTs) {
    return this.known.get(threadKey(channel, threadTs)) === true;
  }

  noteMine(event) {
    this.#set(threadKey(event.channel, event.thread_ts || event.ts), true);
  }

  // Every caller of a pending lookup shares one promise that already includes the final cache
  // check and error handling, so a reply of mine noted mid-lookup wins for all of them.
  participated(channel, threadTs) {
    const key = threadKey(channel, threadTs);
    if (this.known.has(key)) return Promise.resolve(this.known.get(key));
    const lookup = this.#scan(channel, threadTs)
      .then(({ found, complete }) => {
        // Cache "no" only after reading the whole thread. A scan cut short by the page cap fails
        // open: the reply goes to qitt (which can ignore it) and the thread is checked again next time.
        if (this.known.get(key) === lookup) {
          if (found || complete) this.#set(key, found);
          else this.known.delete(key);
        }
        if (!found && !complete) this.log(`thread ${key} longer than ${this.maxPages} pages; keeping the reply`);
        return this.known.get(key) === true || found || !complete;
      })
      .catch((err) => {
        if (this.known.get(key) === lookup) this.known.delete(key);
        this.log(`conversations.replies failed: ${err?.data?.error ?? err?.code ?? err?.message}`);
        return this.known.get(key) === true || null;
      });
    this.#set(key, lookup);
    return lookup;
  }
}
