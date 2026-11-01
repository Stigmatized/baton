import { thresholds } from "./config.js";
import { ms } from "./fsutil.js";
import { LIMIT_ERRORS, WINDOWS, samePeriod, strictestWeekly } from "./usage.js";

// The policy, as pure functions over plain data: no files, no clock, no
// output. Everything takes `now` (epoch ms) and the effective policy settings
// (config.js POLICY_DEFAULTS); the lead wrapper, the CLI and the TUI all
// decide through here.

const MINUTE = 60e3;
const HOUR = 60 * MINUTE;
export const WINDOW_LENGTH = { five_hour: 5 * HOUR, seven_day: 168 * HOUR };
export const WINDOW_LABEL = {
  five_hour: "5-hour",
  seven_day: "weekly",
  unknown: "usage",
};
const BUSY_TASKS = ["subagent", "workflow", "teammate"];

// One window of one account. A reading past its resets_at, or older than the
// window itself (5 h, 7 d), counts as reset: used 0. headroom = threshold -
// used. Blocked when headroom <= 0 or a refusal for the window is still in
// force; blockUntil is the latest known end of what blocks it (null when a
// blocking part has no known end).
export function windowState({
  window,
  reading,
  rejection,
  threshold,
  now,
  policy,
}) {
  const resetsAt = ms(reading?.resetsAt);
  const readAt = ms(reading?.readAt);
  let used = null;
  let reset = false;
  let stale = false;
  if (reading && Number.isFinite(reading.used)) {
    if (resetsAt !== null && resetsAt <= now) reset = true;
    else if (readAt !== null && now - readAt > WINDOW_LENGTH[window]) {
      reset = true;
      stale = true;
    }
    if (!reset) used = reading.used;
  }
  const headroom = threshold - (used ?? 0);
  const usageBlocked = used !== null && headroom <= 0;
  let rejected = false;
  let rejectedUntil = null;
  if (rejection) {
    const at = ms(rejection.at) ?? 0;
    const until = ms(rejection.until);
    const maxAge =
      window === "seven_day"
        ? WINDOW_LENGTH.seven_day
        : policy.unknownRejectionHours * HOUR;
    const expiry = until ?? at + maxAge;
    // A reading taken after the refusal that shows room again supersedes it.
    const superseded =
      used !== null && readAt !== null && readAt > at && used < threshold;
    if (expiry > now && !superseded) {
      rejected = true;
      rejectedUntil = until;
    }
  }
  const blocked = usageBlocked || rejected;
  let blockUntil = null;
  let blockKnown = true;
  if (blocked) {
    const ends = [];
    if (usageBlocked) ends.push(resetsAt);
    if (rejected) ends.push(rejectedUntil);
    blockKnown = ends.every((e) => e !== null);
    blockUntil = blockKnown ? Math.max(...ends) : null;
  }
  return {
    window,
    used,
    resetsAt: reset ? null : resetsAt,
    readAt,
    // Where the reading came from ("statusline", "poll") and, for a weekly
    // limit of one model, its label.
    source: reading?.source ?? null,
    label: reading?.label ?? null,
    reset,
    stale,
    threshold,
    headroom,
    blocked,
    usageBlocked,
    rejected,
    rejectedUntil,
    blockUntil,
    blockKnown,
  };
}

// A refusal Baton could not tie to a window blocks the whole account until
// its known end, or for unknownRejectionHours, or until a later reading shows
// every window under its threshold.
function unknownRejection(rejection, windows, now, policy) {
  if (!rejection) return null;
  const at = ms(rejection.at) ?? 0;
  const until = ms(rejection.until);
  const expiry = until ?? at + policy.unknownRejectionHours * HOUR;
  const answeredSince =
    WINDOWS.some((w) => windows[w].readAt !== null && windows[w].readAt > at) &&
    WINDOWS.every((w) => !windows[w].usageBlocked);
  if (expiry <= now || answeredSince) return null;
  return { at, until };
}

// An account's state: its windows, whether it is blocked and by what, when it
// is available (now; the latest end among its blocks, a weekly block
// dominating; null = unknown), its weekly urgency (weekly headroom per hour
// left before the weekly reset: headroom not used by then is lost) and its
// effective headroom (the smaller of the two).
export function accountState(
  account,
  { reading, rejections = {}, policy, now, index = 0 },
) {
  const limits = thresholds(account, policy);
  const windows = {};
  for (const w of WINDOWS)
    windows[w] = windowState({
      window: w,
      reading:
        w === "seven_day"
          ? strictestWeekly(reading, now)
          : reading?.[w]
            ? { source: reading.source ?? null, ...reading[w] }
            : null,
      rejection: rejections[w] ?? null,
      threshold: limits[w],
      now,
      policy,
    });
  const other = unknownRejection(rejections.unknown, windows, now, policy);
  const blockedBy = WINDOWS.filter((w) => windows[w].blocked);
  if (other) blockedBy.push("unknown");
  const blocked = blockedBy.length > 0;
  let availableAt = now;
  let availableKnown = true;
  if (blocked) {
    const ends = blockedBy.map((w) =>
      w === "unknown" ? other.until : windows[w].blockUntil,
    );
    availableKnown = ends.every((e) => e !== null);
    availableAt = availableKnown ? Math.max(...ends) : null;
  }
  const week = windows.seven_day;
  const hoursLeft =
    week.used !== null && week.resetsAt !== null
      ? Math.max((week.resetsAt - now) / HOUR, 1 / 60)
      : 168;
  return {
    id: account.id, // identity: every pick and decision names accounts by id
    name: account.name, // the label, for display
    mark: account.mark,
    index,
    windows,
    unknownRejection: other,
    blocked,
    blockedBy,
    availableAt,
    availableKnown,
    urgency: Math.max(0, week.headroom) / hoursLeft,
    fiveHourHeadroom: windows.five_hour.headroom,
    weeklyHeadroom: week.headroom,
    effectiveHeadroom: Math.min(windows.five_hour.headroom, week.headroom),
    readingAt: ms(reading?.at),
  };
}

export function accountStates({
  accounts,
  readings = {},
  rejections = {},
  policy,
  now,
}) {
  return accounts.map((account, index) =>
    accountState(account, {
      reading: readings[account.id] ?? null,
      rejections: rejections[account.id] ?? {},
      policy,
      now,
      index,
    }),
  );
}

const byOrder = (a, b) => a.index - b.index;

// The account that is available first: known times before unknown ones,
// earliest first, ties by order.
export function earliest(states) {
  return (
    [...states].sort(
      (a, b) =>
        Number(b.availableKnown) - Number(a.availableKnown) ||
        (a.availableKnown ? a.availableAt - b.availableAt : 0) ||
        byOrder(a, b),
    )[0] ?? null
  );
}

export const fiveHourOnly = (state) =>
  !!state &&
  state.blockedBy.length > 0 &&
  state.blockedBy.every((w) => w === "five_hour");

// Where new work (a lead session start, a resume, a hop) goes.
// smart: an unblocked preferred account with at least startReserve 5-hour
// headroom (first in order); else the normal account with the highest weekly
// urgency among those with that reserve (ties by order); else the unblocked
// non-last-resort account with the most 5-hour headroom; else a last-resort
// account (first in order). order: the first unblocked account in order, last
// resort only when every other is blocked. When nothing is open:
// { account: null, allBlocked: true, earliest, availableAt } over every
// account, excluded ones included.
export function pickStart(states, policy, { exclude = [] } = {}) {
  const open = states
    .filter((s) => !exclude.includes(s.id) && !s.blocked)
    .sort(byOrder);
  const chosen = (state, reason) => ({
    account: state.id,
    reason,
    allBlocked: false,
    availableAt: state.availableAt,
    availableKnown: true,
    state,
  });
  const lastResort = open.find((s) => s.mark === "last-resort");
  if (policy.mode === "order") {
    const first = open.find((s) => s.mark !== "last-resort");
    if (first) return chosen(first, "order");
    if (lastResort) return chosen(lastResort, "last-resort");
  } else {
    const reserve = policy.startReserve;
    const preferred = open.find(
      (s) => s.mark === "preferred" && s.fiveHourHeadroom >= reserve,
    );
    if (preferred) return chosen(preferred, "preferred");
    const normal = open
      .filter((s) => s.mark === "normal" && s.fiveHourHeadroom >= reserve)
      .sort((a, b) => b.urgency - a.urgency || byOrder(a, b))[0];
    if (normal) return chosen(normal, "urgency");
    const rest = open
      .filter((s) => s.mark !== "last-resort")
      .sort(
        (a, b) => b.fiveHourHeadroom - a.fiveHourHeadroom || byOrder(a, b),
      )[0];
    if (rest) return chosen(rest, "low-reserve");
    if (lastResort) return chosen(lastResort, "last-resort");
  }
  const first = earliest(states);
  return {
    account: null,
    reason: "all-blocked",
    allBlocked: true,
    earliest: first?.id ?? null,
    availableAt: first?.availableAt ?? null,
    availableKnown: first?.availableKnown ?? false,
    state: first,
  };
}

// Background agents (the phase 2 service): spread new agents across the
// unblocked accounts by effective headroom minus the estimated cost of the
// agents already running there, weighted by weekly urgency
// (score = headroom x (0.5 + 0.5 x urgency / highest urgency)), so the accounts
// run out together. Preferred accounts with startReserve left are filled
// first; last resort only when no other account has room; when nothing is
// open the work is queued for the earliest account at its availableAt.
export function pickSpread(states, policy, { runningCost = {} } = {}) {
  const open = states.filter((s) => !s.blocked);
  const room = (s) => s.effectiveHeadroom - (runningCost[s.id] ?? 0);
  const regular = open.filter((s) => s.mark !== "last-resort" && room(s) > 0);
  const preferred = regular.filter(
    (s) => s.mark === "preferred" && room(s) >= policy.startReserve,
  );
  const pool = preferred.length ? preferred : regular;
  if (pool.length) {
    const top = Math.max(...pool.map((s) => s.urgency));
    const score = (s) =>
      room(s) * (0.5 + 0.5 * (top > 0 ? s.urgency / top : 1));
    const best = [...pool].sort(
      (a, b) => score(b) - score(a) || byOrder(a, b),
    )[0];
    return {
      account: best.id,
      reason: "spread",
      score: score(best),
      queue: false,
    };
  }
  const lastResort = open
    .filter((s) => s.mark === "last-resort")
    .sort(byOrder)[0];
  if (lastResort)
    return { account: lastResort.id, reason: "last-resort", queue: false };
  const first = earliest(states);
  return {
    account: first?.id ?? null,
    reason: "all-blocked",
    queue: true,
    at: first?.availableAt ?? null,
    availableKnown: first?.availableKnown ?? false,
  };
}

// A session's cost per turn in each window: the moving average (last
// costSamples) of the used-% deltas between consecutive turn-end readings of
// that session on the same account and window period (a reset in between, or
// a drop, is skipped). Null where there is no sample yet.
export function turnCost(samples, policy) {
  const out = {};
  for (const w of WINDOWS) {
    const deltas = [];
    for (let i = 1; i < samples.length; i++) {
      const a = samples[i - 1];
      const b = samples[i];
      const x = a?.[w];
      const y = b?.[w];
      if (a.account !== b.account || !x || !y) continue;
      if (!Number.isFinite(x.used) || !Number.isFinite(y.used)) continue;
      if (!samePeriod(x.resetsAt, y.resetsAt) || y.used < x.used) continue;
      deltas.push(y.used - x.used);
    }
    const recent = deltas.slice(-policy.costSamples);
    out[w] = recent.length
      ? recent.reduce((s, d) => s + d, 0) / recent.length
      : null;
  }
  return out;
}

// The session's recent burn rate (% per hour) in each window: from the first
// to the last of its readings within burnWindowMinutes on the latest account
// and window period.
export function burnRate(samples, policy, now) {
  const since = now - policy.burnWindowMinutes * MINUTE;
  const out = {};
  for (const w of WINDOWS) {
    const points = samples.filter(
      (s) => (ms(s.at) ?? 0) >= since && Number.isFinite(s?.[w]?.used),
    );
    const last = points.at(-1);
    const same = points.filter(
      (p) =>
        p.account === last?.account &&
        samePeriod(p[w].resetsAt, last?.[w].resetsAt),
    );
    const first = same[0];
    const hours = first && last ? (ms(last.at) - ms(first.at)) / HOUR : 0;
    out[w] =
      hours > 0 ? Math.max(0, (last[w].used - first[w].used) / hours) : null;
  }
  return out;
}

// Hours until the account is blocked at the given burn rate (Infinity when a
// window resets first or nothing burns).
export function hoursToBlock(state, burn, now) {
  let best = Infinity;
  for (const w of WINDOWS) {
    const rate = burn?.[w];
    const ws = state.windows[w];
    if (!rate || rate <= 0) continue;
    const hours = Math.max(0, ws.headroom) / rate;
    const resetIn =
      ws.used !== null && ws.resetsAt !== null
        ? (ws.resetsAt - now) / HOUR
        : Infinity;
    if (hours < resetIn) best = Math.min(best, hours);
  }
  return best;
}

export const busyTasks = (tasks) =>
  (Array.isArray(tasks) ? tasks : []).filter((t) =>
    BUSY_TASKS.includes(t?.type),
  );

const none = (reason, extra = {}) => ({ type: "none", reason, ...extra });

// What the lead session does at the end of a turn.
//   input: { now, policy, states, current, event: "stop" | "stop-failure",
//            failure: { error, window }, hopRequest: { to } | null,
//            session: { arrivedAt, stayUntil, vetoUntil, reblocks, compacted,
//                       backgroundTasks, cost, burn } }
//   result: { type: "none" | "wait-in-place" | "hop" | "wait", to, at, reason,
//             countdown }
// hop: end claude at this turn end and resume on `to` (after a countdown when
// `countdown`); wait: end claude, wait until `at`, then resume on `to`;
// wait-in-place: leave claude running (Claude Code's own wait-at-limit).
export function decideTurnEnd(input) {
  const { now, policy, states, current, event, failure, hopRequest } = input;
  const session = input.session ?? {};
  const cur = states.find((s) => s.id === current) ?? null;
  const others = { exclude: [current] };

  if (hopRequest) {
    const to = hopRequest.to || null;
    if (to) {
      if (to === current) return none("manual-same-account");
      if (!states.some((s) => s.id === to))
        return none("manual-unknown-account");
      return { type: "hop", to, reason: "manual", countdown: false };
    }
    const pick = pickStart(states, policy, others);
    if (pick.account)
      return {
        type: "hop",
        to: pick.account,
        reason: "manual",
        countdown: false,
      };
    return none("manual-no-account");
  }

  if (event === "stop-failure") {
    if (!LIMIT_ERRORS.includes(failure?.error)) return none("other-error");
    if (session.stayUntil && session.stayUntil > now) return none("stayed");
    if ((session.reblocks ?? 0) >= policy.maxReblocks) {
      const pick = pickStart(states, policy);
      const target = pick.account ?? pick.earliest ?? current;
      const ready = pick.account
        ? now
        : pick.availableKnown
          ? pick.availableAt
          : now;
      return {
        type: "wait",
        to: target,
        at: Math.max(ready, now + policy.reblockBackoffMinutes * MINUTE),
        reason: "reblocked",
      };
    }
    if (
      fiveHourOnly(cur) &&
      cur.availableKnown &&
      cur.availableAt - now <= policy.waitInPlaceMinutes * MINUTE
    )
      return {
        type: "wait-in-place",
        reason: "reset-soon",
        at: cur.availableAt,
      };
    const pick = pickStart(states, policy, others);
    if (pick.account)
      return {
        type: "hop",
        to: pick.account,
        reason: "refusal",
        countdown: true,
      };
    const first = pick.state;
    if (!first) return { type: "wait-in-place", reason: "no-accounts" };
    if (!first.availableKnown)
      return { type: "wait-in-place", reason: "all-blocked-unknown" };
    if (
      first.id === current &&
      fiveHourOnly(cur) &&
      first.availableAt - now <= policy.waitInPlaceMaxHours * HOUR
    )
      return {
        type: "wait-in-place",
        reason: "all-blocked-current-first",
        at: first.availableAt,
      };
    return {
      type: "wait",
      to: first.id,
      at: first.availableAt,
      reason: "all-blocked-wait",
    };
  }

  if (event !== "stop" || !cur) return none("not-a-turn-end");
  if (policy.mode !== "smart") return none("order-mode");
  if (session.vetoUntil && session.vetoUntil > now) return none("vetoed");
  if (busyTasks(session.backgroundTasks).length) return none("busy");
  if (
    session.arrivedAt &&
    now - session.arrivedAt < policy.minStayMinutes * MINUTE
  )
    return none("min-stay");

  const cost = session.cost ?? {};
  const short = WINDOWS.filter(
    (w) =>
      cost[w] != null && cur.windows[w].headroom < policy.planFactor * cost[w],
  );
  if (short.length) {
    const pick = pickStart(states, policy, others);
    const roomy =
      pick.account &&
      WINDOWS.every(
        (w) =>
          cost[w] == null ||
          pick.state.windows[w].headroom >= policy.planFactor * cost[w],
      );
    if (roomy)
      return {
        type: "hop",
        to: pick.account,
        reason: "planned",
        countdown: true,
        windows: short,
      };
    return none("planned-no-target", { windows: short });
  }

  if (session.compacted && policy.compactionRebalance !== false) {
    const hours = hoursToBlock(cur, session.burn, now);
    if (hours <= policy.rebalanceHorizonMinutes / 60) {
      const pick = pickStart(states, policy, others);
      if (
        pick.account &&
        pick.state.effectiveHeadroom >=
          cur.effectiveHeadroom + policy.rebalanceMargin
      )
        return {
          type: "hop",
          to: pick.account,
          reason: "compaction",
          countdown: true,
        };
    }
  }
  return none("stay");
}

// While the lead waits for an account (all blocked): resume as soon as any
// account is open, else keep the earliest known target (re-picked from fresh
// readings every time).
export function decideWait({ states, policy, target, at }) {
  const pick = pickStart(states, policy);
  if (pick.account)
    return { type: "resume", to: pick.account, reason: pick.reason };
  if (pick.state?.availableKnown)
    return { type: "wait", to: pick.state.id, at: pick.state.availableAt };
  return { type: "wait", to: target, at };
}
