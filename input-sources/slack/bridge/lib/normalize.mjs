// Turn a kept Slack message event into the shape qitt reads.
import { isReply, isSupport, mentions } from "./filter.mjs";
import { timeLocal, tsDate } from "./time.mjs";

// Cached Slack lookups. A failed lookup yields null. Errors that will not go away on a retry (a
// missing scope, an unknown channel) stay cached as null; others are retried next time.
const permanentErrors = new Set(["missing_scope", "not_allowed_token_type", "channel_not_found", "user_not_found", "not_in_channel"]);
export class Directory {
  constructor({ client, log = () => {}, limit = 5000 }) {
    this.client = client;
    this.log = log;
    this.limit = limit;
    this.channels = new Map();
    this.users = new Map();
    this.permalinks = new Map();
  }

  #cached(map, key, what, load) {
    if (!map.has(key)) {
      const pending = load().catch((err) => {
        const code = err?.data?.error ?? err?.code ?? err?.message;
        if (!permanentErrors.has(code)) map.delete(key);
        this.log(`${what} failed: ${code}`);
        return null;
      });
      map.set(key, pending);
      if (map.size > this.limit) map.delete(map.keys().next().value);
    }
    return map.get(key);
  }

  // The conversations.info channel object, or null.
  channel(channel) {
    return this.#cached(this.channels, channel, "conversations.info", async () =>
      (await this.client.conversations.info({ channel })).channel ?? null,
    );
  }

  async channelName(channel) {
    return (await this.channel(channel))?.name ?? null;
  }

  // The users.info user object, or null.
  user(user) {
    if (!user) return Promise.resolve(null);
    return this.#cached(this.users, user, "users.info", async () => (await this.client.users.info({ user })).user ?? null);
  }

  async userName(user) {
    const u = await this.user(user);
    return u?.profile?.display_name || u?.real_name || u?.profile?.real_name || null;
  }

  // Search matches carry no bot_id, so bots are told apart by their user. Null when the lookup
  // failed: unknown, not "not a bot".
  async isBot(user) {
    const u = await this.user(user);
    return u ? Boolean(u.is_bot) : null;
  }

  permalink(channel, ts) {
    return this.#cached(this.permalinks, `${channel}:${ts}`, "chat.getPermalink", async () =>
      (await this.client.chat.getPermalink({ channel, message_ts: ts })).permalink ?? null,
    );
  }
}

export const normalize = async (event, cfg, directory) => {
  const dm = event.channel_type === "im" || event.channel_type === "mpim";
  const threadTs = isReply(event) ? event.thread_ts : null;
  const m = mentions(event.text, cfg);
  // Search matches bring the channel name and permalink along; live events need lookups.
  const [channelName, userName, permalink] = await Promise.all([
    dm ? null : (event.channel_name ?? directory.channelName(event.channel)),
    directory.userName(event.user),
    event.permalink ?? directory.permalink(event.channel, event.ts),
  ]);
  return {
    id: `slack:${event.channel}:${event.ts}`,
    source: "slack",
    channel_type: event.channel_type,
    channel_id: event.channel,
    channel_name: channelName,
    ts: event.ts,
    thread_ts: threadTs,
    source_key: `slack:${event.channel}:${threadTs ?? event.ts}`,
    time_local: timeLocal(tsDate(event.ts)),
    user_id: event.user ?? null,
    user_name: userName,
    mentions_me: m.me,
    mentions_group: m.group,
    text: event.text ?? "",
    permalink,
    files: (event.files ?? []).map((f) => f.name ?? f.title).filter(Boolean),
    // Someone else answers support channels, so qitt is told where the message is from.
    ...(isSupport(event, cfg) && { support_channel: true }),
    // Found by the reconciler (lib/reconcile.mjs) after live events and search missed it.
    ...(event.backfill && { backfill: true }),
  };
};
