import { ms, readJsonLines } from "./fsutil.js";
import { nameOf, thresholds } from "./config.js";
import { turnCost } from "./policy.js";
import { readTurnSamples } from "./sessions.js";
import { historyFile, samePeriod } from "./usage.js";

// Statistics from the append-only history: per account the usage over the
// last days (highest 5-hour use per day, last weekly use per day), refusals
// and hops per day, sessions per day, and the weekly headroom that was left
// when a weekly window reset (headroom = threshold - used; unused = 100 -
// used: allowance that was lost), and the sessions of the period with their
// hops and per-turn cost estimates.

const DAY = 864e5;
const localDate = (t) => {
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

function monthsBetween(from, to) {
  const out = [];
  const d = new Date(
    Date.UTC(new Date(from).getUTCFullYear(), new Date(from).getUTCMonth(), 1),
  );
  while (d.getTime() <= to) {
    out.push(d.getTime());
    d.setUTCMonth(d.getUTCMonth() + 1);
  }
  return out;
}

export function readHistory(paths, kind, from, to) {
  return monthsBetween(from, to)
    .flatMap((m) => readJsonLines(historyFile(paths, kind, m)))
    .filter((e) => {
      const t = ms(e.at);
      return t !== null && t >= from && t <= to;
    })
    .sort((a, b) => ms(a.at) - ms(b.at));
}

export function computeStats({
  paths,
  config,
  policy,
  now = Date.now(),
  days = 7,
}) {
  const since = now - days * DAY;
  // The history keeps account ids; what it shows is their current names.
  const label = (id) => nameOf(config, id);
  const hopView = (e) => ({
    at: e.at,
    session: e.session,
    from: label(e.from),
    to: label(e.to),
    fromId: e.from,
    toId: e.to,
    reason: e.reason,
  });
  // Weekly windows that reset in the period started up to a week earlier.
  const readings = readHistory(paths, "readings", since - 7 * DAY, now);
  const events = readHistory(paths, "events", since, now);
  const dates = [];
  for (let t = now - (days - 1) * DAY; t <= now + 1; t += DAY) {
    const date = localDate(t);
    if (!dates.includes(date)) dates.push(date);
  }
  if (!dates.includes(localDate(now))) dates.push(localDate(now));
  const perDay = () => Object.fromEntries(dates.map((d) => [d, 0]));
  const totals = { hops: perDay(), refusals: perDay(), sessions: perDay() };
  const hopReasons = {};
  for (const e of events) {
    const date = localDate(ms(e.at));
    if (!(date in totals.hops)) continue;
    if (e.type === "hop") {
      totals.hops[date]++;
      hopReasons[e.reason] = (hopReasons[e.reason] ?? 0) + 1;
    } else if (e.type === "refusal") totals.refusals[date]++;
    else if (e.type === "session" && ["startup", "clear"].includes(e.source))
      totals.sessions[date]++;
  }
  const accounts = config.accounts.map((account) => {
    const limit = thresholds(account, policy);
    const mine = readings.filter((r) => r.account === account.id);
    const daily = dates.map((date) => {
      const day = mine.filter((r) => localDate(ms(r.at)) === date);
      const five = day
        .filter((r) => r.window === "five_hour")
        .map((r) => r.used);
      const week = day.filter((r) => r.window === "seven_day");
      return {
        date,
        fiveHourMax: five.length ? Math.max(...five) : null,
        weeklyLast: week.length ? week.at(-1).used : null,
        refusals: events.filter(
          (e) =>
            e.type === "refusal" &&
            e.account === account.id &&
            localDate(ms(e.at)) === date,
        ).length,
        hopsIn: events.filter(
          (e) =>
            e.type === "hop" &&
            e.to === account.id &&
            localDate(ms(e.at)) === date,
        ).length,
        hopsOut: events.filter(
          (e) =>
            e.type === "hop" &&
            e.from === account.id &&
            localDate(ms(e.at)) === date,
        ).length,
      };
    });
    // The last reading of each weekly window period.
    const windows = [];
    for (const r of mine.filter(
      (r) => r.window === "seven_day" && r.resetsAt,
    )) {
      const at = windows.findIndex((w) => samePeriod(w.resetsAt, r.resetsAt));
      if (at >= 0) windows[at] = r;
      else windows.push(r);
    }
    const wasted = windows
      .filter((r) => ms(r.resetsAt) <= now && ms(r.resetsAt) >= since)
      .map((r) => ({
        resetAt: r.resetsAt,
        lastUsed: r.used,
        headroomLeft: Math.max(0, limit.seven_day - r.used),
        unused: Math.max(0, 100 - r.used),
      }));
    return {
      id: account.id,
      name: account.name,
      mark: account.mark,
      daily,
      wasted,
      refusals: daily.reduce((s, d) => s + d.refusals, 0),
      sessions: events.filter(
        (e) =>
          e.type === "session" &&
          e.account === account.id &&
          ["startup", "clear"].includes(e.source),
      ).length,
    };
  });
  const ids = [
    ...new Set(
      events
        .filter(
          (e) => e.session && ["session", "hop", "refusal"].includes(e.type),
        )
        .map((e) => e.session),
    ),
  ];
  const sessions = ids.map((id) => {
    const mine = events.filter((e) => e.session === id);
    const samples = readTurnSamples(paths, id);
    const cost = turnCost(samples, policy);
    return {
      id,
      firstSeen: mine[0]?.at ?? null,
      accounts: [
        ...new Set(
          mine.flatMap((e) => [e.account, e.from, e.to]).filter(Boolean),
        ),
      ].map(label),
      hops: mine.filter((e) => e.type === "hop").map(hopView),
      refusals: mine.filter((e) => e.type === "refusal").length,
      turns: samples.length,
      costPerTurn: cost,
    };
  });
  return {
    since: new Date(since).toISOString(),
    until: new Date(now).toISOString(),
    days: dates,
    totals,
    hopReasons,
    hops: events
      .filter((e) => e.type === "hop")
      .slice(-20)
      .map(hopView),
    accounts,
    sessions,
  };
}
