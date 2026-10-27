// Local-time labels in the owner's timezone: "Thu 10/16 14:05 ET" for events, "14:02–14:05 ET"
// for batch windows. configureTime() sets the zone from bridge.json (`timezone`, an IANA name, and
// optionally `timezoneLabel`); until then, and when `timezone` is unset, the system timezone is used.

export const systemTimezone = () => new Intl.DateTimeFormat().resolvedOptions().timeZone;

// Throws a RangeError for a name Intl does not know.
export const checkTimezone = (timeZone) => new Intl.DateTimeFormat("en-US", { timeZone }) && timeZone;

const zoneName = (format, date) => format.formatToParts(date).find((p) => p.type === "timeZoneName")?.value;

let state;

// Without a label, a zone's short generic name is used when it has one ("PT", "ET"), otherwise its
// short name at that date ("UTC", "GMT+2").
export const configureTime = ({ timezone, timezoneLabel } = {}) => {
  const timeZone = checkTimezone(timezone ?? systemTimezone());
  const clock = new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  const generic = new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "shortGeneric" });
  const short = new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "short" });
  const label =
    timezoneLabel != null
      ? () => timezoneLabel
      : (date) => {
          const name = zoneName(generic, date);
          return name && /^[A-Z]{1,5}$/.test(name) ? name : (zoneName(short, date) ?? timeZone);
        };
  state = { timeZone, clock, label };
  return timeZone;
};

configureTime();

export const currentTimezone = () => state.timeZone;

const parts = (date) => Object.fromEntries(state.clock.formatToParts(date).map((p) => [p.type, p.value]));

export const tsDate = (ts) => new Date(Number(ts) * 1000);

export const timeLocal = (date) => {
  const p = parts(date);
  return `${p.weekday} ${p.month}/${p.day} ${p.hour}:${p.minute} ${state.label(date)}`;
};

const clock = (date) => {
  const p = parts(date);
  return `${p.hour}:${p.minute}`;
};

export const windowLocal = (from, to) => `${clock(from)}–${clock(to)} ${state.label(to)}`;
