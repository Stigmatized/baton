import { readdirSync } from "node:fs";
import { join } from "node:path";
import { ACCOUNT_ID_RE } from "./paths.js";
import {
  appendJsonLine,
  iso,
  ms,
  readJson,
  writeJsonAtomic,
} from "./fsutil.js";

// Usage readings and refusals per account and window.
//
// usage/<account>.json      latest reading: { account, at, session, source,
//                           five_hour: { used, resetsAt, readAt } | null,
//                           seven_day: { ... } | null }
// rejected/<account>.<window>.json   the last refusal for that window
//                           (window five_hour, seven_day or unknown)
// history/readings-YYYY-MM.jsonl     every change of a reading
// history/events-YYYY-MM.jsonl       refusals, hops, sessions

export const WINDOWS = ["five_hour", "seven_day"];
export const REJECTION_WINDOWS = [...WINDOWS, "unknown"];
export const LIMIT_ERRORS = ["rate_limit", "billing_error"];

// Two readings belong to the same window period when their resets_at are
// within a few minutes: a reading's resets_at can move by a second between
// readings, while a real reset moves it by at least the window's length
// (5 hours, 7 days).
export const PERIOD_TOLERANCE_MS = 10 * 60e3;
export function samePeriod(a, b) {
  if (a == null || b == null) return a == null && b == null;
  const x = ms(a);
  const y = ms(b);
  if (x === null || y === null) return a === b;
  return Math.abs(x - y) <= PERIOD_TOLERANCE_MS;
}
const HOUR = 3600e3;

const month = (at) => new Date(at).toISOString().slice(0, 7);
export const historyFile = (paths, kind, at) =>
  join(paths.history, `${kind}-${month(at)}.jsonl`);

export function recordEvent(paths, event, at = Date.now()) {
  appendJsonLine(historyFile(paths, "events", at), { at: iso(at), ...event });
}

// The status line JSON's rate_limits as a reading (resets_at is epoch
// seconds there). Null when there is nothing to record.
export function readingFromStatusLine(input) {
  const limits = input?.rate_limits;
  if (!limits || typeof limits !== "object") return null;
  const out = {};
  for (const window of WINDOWS) {
    const w = limits[window];
    const used = Number(w?.used_percentage);
    if (!w || !Number.isFinite(used)) continue;
    const seconds = Number(w.resets_at);
    out[window] = {
      used,
      resetsAt:
        Number.isFinite(seconds) && seconds > 0 ? iso(seconds * 1000) : null,
    };
  }
  return Object.keys(out).length ? out : null;
}

const usageFile = (paths, account) => join(paths.usage, `${account}.json`);

export function readReading(paths, account) {
  return readJson(usageFile(paths, account));
}

// Records a reading (windows absent from it keep their previous value: Claude
// Code drops a window from its status line once it has reset). Writes only
// when a value changed or the stored reading is older than refreshMs, and
// appends each changed window to the history. Each window keeps where it
// came from (source: "statusline" from a session, "poll" from the usage
// poller) and when (readAt). A poll also brings the plan's other meters
// (limits, e.g. a model's own weekly limit) and the extra-usage spend; a
// status line reading keeps the last ones.
export function recordReading(
  paths,
  account,
  reading,
  {
    at = Date.now(),
    session = null,
    source = "statusline",
    refreshMs = 30e3,
    limits = undefined,
    extraUsage = undefined,
  } = {},
) {
  if (!ACCOUNT_ID_RE.test(account) || !reading)
    return { changed: false, written: false };
  const previous = readReading(paths, account);
  const next = {
    account,
    at: iso(at),
    session,
    source,
    five_hour: previous?.five_hour ?? null,
    seven_day: previous?.seven_day ?? null,
    limits: limits !== undefined ? limits : (previous?.limits ?? null),
    limitsAt: limits !== undefined ? iso(at) : (previous?.limitsAt ?? null),
    extraUsage:
      extraUsage !== undefined ? extraUsage : (previous?.extraUsage ?? null),
  };
  const changedWindows = [];
  for (const window of WINDOWS) {
    const w = reading[window];
    if (!w) continue;
    const before = previous?.[window];
    if (
      !before ||
      before.used !== w.used ||
      !samePeriod(before.resetsAt, w.resetsAt)
    )
      changedWindows.push(window);
    next[window] = {
      used: w.used,
      resetsAt: w.resetsAt ?? null,
      readAt: iso(at),
      source,
    };
  }
  const old = ms(previous?.at);
  if (
    !changedWindows.length &&
    limits === undefined &&
    old !== null &&
    at - old < refreshMs
  )
    return { changed: false, written: false };
  writeJsonAtomic(usageFile(paths, account), next);
  for (const window of changedWindows)
    appendJsonLine(historyFile(paths, "readings", at), {
      at: iso(at),
      account,
      window,
      used: next[window].used,
      resetsAt: next[window].resetsAt,
      session,
      source,
    });
  return { changed: changedWindows.length > 0, written: true, reading: next };
}

export function loadReadings(paths, names) {
  return Object.fromEntries(names.map((n) => [n, readReading(paths, n)]));
}

const rejectionFile = (paths, account, window) =>
  join(paths.rejected, `${account}.${window}.json`);

export function recordRejection(paths, account, rejection) {
  if (!ACCOUNT_ID_RE.test(account)) return;
  const window = REJECTION_WINDOWS.includes(rejection.window)
    ? rejection.window
    : "unknown";
  writeJsonAtomic(rejectionFile(paths, account, window), {
    account,
    window,
    at: rejection.at,
    until: rejection.until ?? null,
    untilSource: rejection.untilSource ?? "none",
    error: rejection.error ?? null,
    session: rejection.session ?? null,
    message: rejection.message ?? null,
  });
}

export function loadRejections(paths, names) {
  const out = Object.fromEntries(names.map((n) => [n, {}]));
  let files = [];
  try {
    files = readdirSync(paths.rejected);
  } catch {
    return out;
  }
  for (const file of files) {
    const m = /^(.+)\.(five_hour|seven_day|unknown)\.json$/.exec(file);
    if (!m || !(m[1] in out)) continue;
    const value = readJson(join(paths.rejected, file));
    if (value) out[m[1]][m[2]] = value;
  }
  return out;
}

const MONTHS = "jan feb mar apr may jun jul aug sep oct nov dec".split(" ");

// The reset time Claude Code prints in a limit message ("resets 3pm",
// "resets 3:20pm", "resets at 15:20", "resets Oct 27, 9am", "resets in 2h
// 30m"), read as local time. Null when there is none.
export const parseResetTime = (text, at = Date.now()) =>
  parseTimeAfter(text, "resets", at);

// The same after another word ("rate limited until 3:14am": "until").
export function parseTimeAfter(text, word, at = Date.now()) {
  if (typeof text !== "string" || !/^[a-z]+$/i.test(word)) return null;
  const rel = new RegExp(
    `\\b${word} in\\s+(?:(\\d+)\\s*h(?:ours?)?)?\\s*(?:(\\d+)\\s*m(?:in(?:utes?)?)?)?`,
    "i",
  ).exec(text);
  if (rel && (rel[1] || rel[2]))
    return at + (Number(rel[1] ?? 0) * 60 + Number(rel[2] ?? 0)) * 60e3;
  const abs = new RegExp(
    `\\b${word}\\s+(?:at\\s+)?(?:([A-Za-z]{3})[a-z]*\\.?\\s+(\\d{1,2}),?\\s+(?:at\\s+)?)?(\\d{1,2})(?::(\\d{2}))?\\s*([ap]\\.?m\\.?)?`,
    "i",
  ).exec(text);
  if (!abs) return null;
  let hour = Number(abs[3]);
  const minute = Number(abs[4] ?? 0);
  const ampm = abs[5]?.toLowerCase().replace(/\./g, "");
  if (!abs[4] && !ampm) return null; // a bare number is not a time
  if (ampm === "pm" && hour < 12) hour += 12;
  if (ampm === "am" && hour === 12) hour = 0;
  if (hour > 23 || minute > 59) return null;
  const base = new Date(at);
  if (abs[1]) {
    const monthIndex = MONTHS.indexOf(abs[1].toLowerCase());
    if (monthIndex < 0) return null;
    const date = new Date(
      base.getFullYear(),
      monthIndex,
      Number(abs[2]),
      hour,
      minute,
    );
    if (date.getTime() < at - 24 * HOUR)
      date.setFullYear(date.getFullYear() + 1);
    return date.getTime();
  }
  const date = new Date(
    base.getFullYear(),
    base.getMonth(),
    base.getDate(),
    hour,
    minute,
  );
  if (date.getTime() <= at) date.setDate(date.getDate() + 1);
  return date.getTime();
}

// Which window a refusal is about and until when, from what the StopFailure
// hook knows: the error text (Claude Code names the "session limit" (5-hour)
// or a "weekly"/per-model weekly limit and usually prints the reset) and the
// account's latest reading.
export function inferRejection({
  error,
  message,
  details,
  reading,
  at = Date.now(),
}) {
  const text = [message, details]
    .filter((t) => typeof t === "string")
    .join(" ");
  let window = null;
  if (
    /weekly|7-day|seven[- ]day|opus limit|sonnet limit|fable limit/i.test(text)
  )
    window = "seven_day";
  else if (/session limit|5-hour|five[- ]hour/i.test(text))
    window = "five_hour";
  const current = (w) => {
    const r = reading?.[w];
    const resets = ms(r?.resetsAt);
    return r && (resets === null || resets > at) ? r : null;
  };
  if (!window && error === "rate_limit") {
    const week = current("seven_day");
    const five = current("five_hour");
    if (week && week.used >= 99.5) window = "seven_day";
    else if (five && five.used >= 99.5) window = "five_hour";
    else if (five || week)
      window =
        (five?.used ?? -1) >= (week?.used ?? -1) ? "five_hour" : "seven_day";
  }
  if (!window) window = "unknown";
  const fromMessage = parseResetTime(text, at);
  if (fromMessage && fromMessage > at)
    return { window, until: iso(fromMessage), untilSource: "message" };
  const r = window === "unknown" ? null : current(window);
  const resets = ms(r?.resetsAt);
  if (resets && resets > at)
    return { window, until: iso(resets), untilSource: "reading" };
  return { window, until: null, untilSource: "none" };
}

// The plan's weekly meters other than the all-models one (a model's own
// weekly limit, from a poll) are kept in the reading's limits. The policy
// works from the strictest weekly limit in force: the all-models window, or
// a scoped one that is fuller and has not reset yet (a poll's value is a
// floor: use only grows until the reset).
export const isWeeklyMeter = (row) =>
  row?.group === "weekly" || /^weekly/.test(String(row?.kind ?? ""));
const WEEK = 168 * HOUR;
export function strictestWeekly(reading, now = Date.now()) {
  const base = reading?.seven_day ?? null;
  let best =
    base && Number.isFinite(base.used)
      ? { ...base, source: base.source ?? reading.source ?? null, label: null }
      : null;
  const readAt = ms(reading?.limitsAt);
  if (!Array.isArray(reading?.limits) || readAt === null) return best ?? base;
  for (const row of reading.limits) {
    if (!isWeeklyMeter(row) || row.kind === "weekly_all") continue;
    if (!Number.isFinite(row.used)) continue;
    const resets = ms(row.resetsAt);
    if (resets !== null ? resets <= now : now - readAt > WEEK) continue;
    if (best && best.used >= row.used) continue;
    best = {
      used: row.used,
      resetsAt: row.resetsAt ?? null,
      readAt: reading.limitsAt,
      source: "poll",
      label: row.label ?? row.kind,
    };
  }
  return best ?? base;
}
