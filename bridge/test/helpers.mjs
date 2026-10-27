// Fake ids only: U000ME is me, S000GROUP my user group, C000TEAM a channel.
import { parseConfig } from "../lib/config.mjs";

export const cfg = (overrides = {}) =>
  parseConfig({ me: "U000ME", groups: ["S000GROUP"], watchChannels: ["C000WATCH"], webhookUrlFile: "/dev/null", ...overrides });

export const message = (fields = {}) => ({
  type: "message",
  channel: "C000TEAM",
  channel_type: "channel",
  user: "U000OTHER",
  text: "hello",
  ts: "1760648700.000100",
  ...fields,
});

// Stub of the Slack Web API methods the bridge calls, counting calls per method.
export const slackStub = ({ replies = [], fail = [] } = {}) => {
  const calls = {};
  const call = (name, result) => async (args) => {
    (calls[name] ??= []).push(args);
    if (fail.includes(name)) throw Object.assign(new Error("boom"), { data: { error: "fake_error" } });
    return result(args);
  };
  return {
    calls,
    conversations: {
      replies: call("conversations.replies", () => ({ messages: replies })),
      info: call("conversations.info", ({ channel }) => ({ channel: { name: `name-of-${channel}` } })),
    },
    users: {
      info: call("users.info", ({ user }) => ({ user: { real_name: `Real ${user}`, profile: { display_name: user === "U000NODISPLAY" ? "" : `disp-${user}` } } })),
    },
    chat: {
      getPermalink: call("chat.getPermalink", ({ channel, message_ts }) => ({ permalink: `https://example.invalid/${channel}/${message_ts}` })),
    },
  };
};
