// The batch as compact text for the qitt prompt: one numbered entry per event, the fields qitt
// needs and nothing else. Text is quoted as is; T3 frames the whole digest as untrusted data.

// Every line of text prefixed with "> ", indented under the entry's number.
const quote = (text) => text.split("\n").map((line) => `   > ${line}`.trimEnd());

// A name stays on its line, so it cannot start a fake entry.
const oneLine = (s) => s.replace(/\s+/g, " ").trim();

const author = (e) => {
  const name = e.user_name && oneLine(e.user_name);
  if (name && e.user_id) return `${name} (${e.user_id})`;
  if (name) return name;
  if (e.user_id) return `(${e.user_id})`;
  return "unknown author";
};

// A top-level message's source key is its id, so only a reply names its thread.
const where = (e) => {
  const place =
    e.channel_type === "im"
      ? "DM"
      : e.channel_type === "mpim"
        ? "group DM"
        : `#${e.channel_name ?? e.channel_id ?? "unknown channel"}`;
  return e.thread_ts ? `${place}, reply in thread ${e.source_key}` : place;
};

const flags = (e) => [
  e.mentions_me && "mentions me",
  e.mentions_group && "mentions my group",
  e.saved && (e.saved_at ? `saved ${e.saved_at}` : "saved"),
  e.my_reply && "my reply",
  e.support_channel && "support channel",
  e.backfill && "backfilled (missed by live events and search)",
  // Quoted, so a file name cannot pass for a flag or break the line.
  e.files?.length > 0 && `files: ${e.files.map((f) => JSON.stringify(f)).join(", ")}`,
].filter(Boolean);

const entry = (e, n) => {
  const link = e.permalink ? [`   ${e.permalink}`] : [];
  if (e.unsaved) return [`${n}. ${e.id} · unsaved (source key ${e.source_key})`, ...link];
  if (e.health) return [`${n}. bridge health · ${e.health} · ${e.time_local}`, ...quote(e.text)];
  const lines = [
    `${n}. ${[e.id, author(e), e.time_local].filter(Boolean).join(" · ")}`,
    `   ${[where(e), ...flags(e)].join(" · ")}`,
    ...link,
  ];
  if (e.text) lines.push(...quote(e.text));
  return lines;
};

// No window label: a saved message can be days old, and each entry carries its own dated time.
export const renderDigest = ({ count, events }) =>
  [`${count} ${count === 1 ? "event" : "events"}.`, "", ...events.flatMap((e, i) => entry(e, i + 1))].join("\n");
