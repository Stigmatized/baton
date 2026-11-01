import test from "node:test";
import assert from "node:assert/strict";
import { POLICY_DEFAULTS } from "../src/config.js";
import {
  accountState,
  accountStates,
  burnRate,
  decideTurnEnd,
  decideWait,
  earliest,
  hoursToBlock,
  pickSpread,
  pickStart,
  turnCost,
} from "../src/policy.js";

const NOW = Date.parse("2026-10-25T12:00:00Z");
const M = 60e3;
const H = 60 * M;
const D = 24 * H;
const iso = (t) => new Date(t).toISOString();
const policy = { ...POLICY_DEFAULTS };

const account = (name, mark = "normal", extra = {}) => ({
  id: name,
  name,
  mark,
  fiveHour: null,
  weekly: null,
  ...extra,
});
// five / week: [used, resetsIn ms | null]
function reading({ five, week, readAgo = M }) {
  const w = (v) =>
    v
      ? {
          used: v[0],
          resetsAt: v[1] == null ? null : iso(NOW + v[1]),
          readAt: iso(NOW - readAgo),
        }
      : null;
  return { at: iso(NOW - readAgo), five_hour: w(five), seven_day: w(week) };
}
const rejection = (window, { at = NOW - M, until = null } = {}) => ({
  window,
  at: iso(at),
  until: until == null ? null : iso(until),
});
function states(list, p = policy) {
  return accountStates({
    accounts: list.map((x) => x.account),
    readings: Object.fromEntries(
      list.map((x) => [x.account.name, x.reading ?? null]),
    ),
    rejections: Object.fromEntries(
      list.map((x) => [x.account.name, x.rejections ?? {}]),
    ),
    policy: p,
    now: NOW,
  });
}
const one = (x, p = policy) => states([{ account: account("a"), ...x }], p)[0];

test("availableAt: a 5-hour block alone", () => {
  const s = one({ reading: reading({ five: [92, 2 * H], week: [50, 3 * D] }) });
  assert.deepEqual(s.blockedBy, ["five_hour"]);
  assert.equal(s.availableAt, NOW + 2 * H);
  assert.equal(s.availableKnown, true);
  assert.equal(s.windows.five_hour.headroom, -2);
});

test("availableAt: a weekly block alone", () => {
  const s = one({ reading: reading({ five: [10, 2 * H], week: [96, 3 * D] }) });
  assert.deepEqual(s.blockedBy, ["seven_day"]);
  assert.equal(s.availableAt, NOW + 3 * D);
});

test("availableAt: both windows blocked, the weekly reset dominates", () => {
  const s = one({ reading: reading({ five: [95, 2 * H], week: [97, 3 * D] }) });
  assert.deepEqual(s.blockedBy, ["five_hour", "seven_day"]);
  assert.equal(s.availableAt, NOW + 3 * D);
});

test("availableAt: under the thresholds is available now", () => {
  const s = one({
    reading: reading({ five: [89.9, 2 * H], week: [94, 3 * D] }),
  });
  assert.equal(s.blocked, false);
  assert.equal(s.availableAt, NOW);
  assert.ok(Math.abs(s.fiveHourHeadroom - 0.1) < 1e-9);
});

test("availableAt: a refusal blocks until its known end and a later reading with room supersedes it", () => {
  const blocked = one({
    reading: reading({ five: [60, 2 * H], week: [40, 3 * D], readAgo: 5 * M }),
    rejections: {
      five_hour: rejection("five_hour", { at: NOW - M, until: NOW + H }),
    },
  });
  assert.deepEqual(blocked.blockedBy, ["five_hour"]);
  assert.equal(blocked.availableAt, NOW + H);
  assert.equal(blocked.windows.five_hour.rejected, true);
  const superseded = one({
    reading: reading({ five: [30, 2 * H], week: [40, 3 * D], readAgo: 0 }),
    rejections: {
      five_hour: rejection("five_hour", { at: NOW - 5 * M, until: NOW + H }),
    },
  });
  assert.equal(superseded.blocked, false);
  const expired = one({
    rejections: {
      five_hour: rejection("five_hour", { at: NOW - 2 * H, until: NOW - M }),
    },
  });
  assert.equal(expired.blocked, false);
});

test("availableAt: a reading past its reset, or a 5-hour reading older than 5 h, counts as reset", () => {
  const past = one({ reading: reading({ five: [99, -M], week: [97, -M] }) });
  assert.equal(past.blocked, false);
  assert.equal(past.windows.five_hour.used, null);
  assert.equal(past.windows.five_hour.reset, true);
  assert.equal(past.windows.five_hour.headroom, 90);
  const old = one({
    reading: reading({ five: [99, H], week: [10, 3 * D], readAgo: 5 * H + M }),
  });
  assert.equal(old.windows.five_hour.stale, true);
  assert.equal(old.blocked, false);
  const recent = one({
    reading: reading({ five: [99, H], week: [10, 3 * D], readAgo: 4 * H }),
  });
  assert.equal(recent.blocked, true);
});

test("availableAt: an unknown reset of a blocking window is unknown; an unknown refusal expires", () => {
  const s = one({ reading: reading({ five: [95, null], week: [10, 3 * D] }) });
  assert.equal(s.blocked, true);
  assert.equal(s.availableKnown, false);
  assert.equal(s.availableAt, null);
  const refused = one({
    rejections: { five_hour: rejection("five_hour", { at: NOW - H }) },
  });
  assert.equal(refused.blocked, true);
  assert.equal(refused.availableKnown, false);
  const lapsed = one({
    rejections: { five_hour: rejection("five_hour", { at: NOW - 5 * H - M }) },
  });
  assert.equal(lapsed.blocked, false);
  const anyWindow = one({
    rejections: { unknown: rejection("unknown", { at: NOW - M }) },
  });
  assert.deepEqual(anyWindow.blockedBy, ["unknown"]);
  assert.equal(anyWindow.availableKnown, false);
  const answered = one({
    reading: reading({ five: [20, 2 * H], week: [20, 3 * D], readAgo: 0 }),
    rejections: { unknown: rejection("unknown", { at: NOW - M }) },
  });
  assert.equal(answered.blocked, false);
});

test("per-account thresholds override the policy", () => {
  const s = states([
    {
      account: account("a", "normal", { fiveHour: 50 }),
      reading: reading({ five: [55, H], week: [10, D] }),
    },
  ])[0];
  assert.equal(s.blocked, true);
  assert.equal(s.windows.five_hour.threshold, 50);
});

test("weekly urgency is weekly headroom per hour left before the weekly reset", () => {
  const s = one({ reading: reading({ five: [10, H], week: [35, 24 * H] }) });
  assert.ok(Math.abs(s.urgency - 60 / 24) < 1e-9);
  const unmeasured = one({});
  assert.ok(Math.abs(unmeasured.urgency - 95 / 168) < 1e-9);
});

test("start pick: an open preferred account with the 5-hour reserve comes first", () => {
  const list = states([
    {
      account: account("a"),
      reading: reading({ five: [10, H], week: [80, 10 * H] }),
    },
    {
      account: account("b", "preferred"),
      reading: reading({ five: [50, H], week: [10, 6 * D] }),
    },
  ]);
  const p = pickStart(list, policy);
  assert.equal(p.account, "b");
  assert.equal(p.reason, "preferred");
});

test("start pick: a preferred account below the reserve gives way to the most urgent normal account", () => {
  const list = states([
    {
      account: account("pref", "preferred"),
      reading: reading({ five: [75, H], week: [10, 6 * D] }),
    }, // 15 < 20
    {
      account: account("slow"),
      reading: reading({ five: [10, H], week: [50, 5 * D] }),
    }, // 45/120 = 0.375
    {
      account: account("soon"),
      reading: reading({ five: [10, H], week: [60, 24 * H] }),
    }, // 35/24 = 1.46
    { account: account("fresh") }, // 95/168 = 0.57
  ]);
  const p = pickStart(list, policy);
  assert.equal(p.account, "soon");
  assert.equal(p.reason, "urgency");
});

test("start pick: equal urgency goes by order", () => {
  const list = states([{ account: account("x") }, { account: account("y") }]);
  assert.equal(pickStart(list, policy).account, "x");
});

test("start pick: below the reserve everywhere, the most 5-hour headroom; last resort only when nothing else is open", () => {
  const list = states([
    {
      account: account("a"),
      reading: reading({ five: [85, H], week: [10, D] }),
    }, // headroom 5
    {
      account: account("b"),
      reading: reading({ five: [80, H], week: [10, D] }),
    }, // headroom 10
    { account: account("lr", "last-resort") },
  ]);
  const p = pickStart(list, policy);
  assert.equal(p.account, "b");
  assert.equal(p.reason, "low-reserve");
  const blocked = states([
    {
      account: account("a"),
      reading: reading({ five: [95, H], week: [10, D] }),
    },
    { account: account("lr", "last-resort") },
  ]);
  assert.deepEqual(
    [pickStart(blocked, policy).account, pickStart(blocked, policy).reason],
    ["lr", "last-resort"],
  );
});

test("start pick in order mode: first unblocked in order, marks other than last resort ignored", () => {
  const p = { ...policy, mode: "order" };
  const list = states(
    [
      { account: account("lr", "last-resort") },
      {
        account: account("a"),
        reading: reading({ five: [95, H], week: [10, D] }),
      },
      {
        account: account("b"),
        reading: reading({ five: [85, H], week: [10, D] }),
      },
      { account: account("pref", "preferred") },
    ],
    p,
  );
  assert.equal(pickStart(list, p).account, "b");
  const allButLr = states(
    [
      {
        account: account("a"),
        reading: reading({ five: [95, H], week: [10, D] }),
      },
      { account: account("lr", "last-resort") },
    ],
    p,
  );
  assert.equal(pickStart(allButLr, p).account, "lr");
});

test("all blocked: the earliest availableAt wins, last resort included, ties by order, unknown last", () => {
  const list = states([
    {
      account: account("a"),
      reading: reading({ five: [95, 2 * H], week: [10, D] }),
    },
    {
      account: account("b"),
      reading: reading({ five: [95, null], week: [10, D] }),
    },
    {
      account: account("lr", "last-resort"),
      reading: reading({ five: [95, 30 * M], week: [10, D] }),
    },
    {
      account: account("c"),
      reading: reading({ five: [10, H], week: [99, 3 * D] }),
    },
  ]);
  const p = pickStart(list, policy);
  assert.equal(p.account, null);
  assert.equal(p.allBlocked, true);
  assert.equal(p.earliest, "lr");
  assert.equal(p.availableAt, NOW + 30 * M);
  const tie = states([
    {
      account: account("x"),
      reading: reading({ five: [95, H], week: [10, D] }),
    },
    {
      account: account("y"),
      reading: reading({ five: [95, H], week: [10, D] }),
    },
  ]);
  assert.equal(earliest(tie).name, "x");
  const unknown = states([
    {
      account: account("u1"),
      reading: reading({ five: [95, null], week: [10, D] }),
    },
    {
      account: account("u2"),
      reading: reading({ five: [95, null], week: [10, D] }),
    },
  ]);
  const pu = pickStart(unknown, policy);
  assert.equal(pu.earliest, "u1");
  assert.equal(pu.availableKnown, false);
});

test("background spread: effective headroom minus running cost, weighted by weekly urgency", () => {
  const list = states([
    {
      account: account("a"),
      reading: reading({ five: [20, H], week: [40, 5 * D] }),
    }, // room 55, urgency 55/120
    {
      account: account("b"),
      reading: reading({ five: [30, H], week: [45, 24 * H] }),
    }, // room 50, urgency 50/24 (top)
    { account: account("lr", "last-resort") },
  ]);
  // b: 50 x 1 = 50; a: 55 x (0.5 + 0.5 x 0.22) = 33.6
  assert.equal(pickSpread(list, policy).account, "b");
  // Agents already on b cost 30: b 20 x 1 = 20 < a 33.6
  assert.equal(
    pickSpread(list, policy, { runningCost: { b: 30 } }).account,
    "a",
  );
  const full = states([
    {
      account: account("a"),
      reading: reading({ five: [95, H], week: [10, D] }),
    },
    { account: account("lr", "last-resort") },
  ]);
  assert.equal(pickSpread(full, policy).account, "lr");
  const blocked = states([
    {
      account: account("a"),
      reading: reading({ five: [95, 2 * H], week: [10, D] }),
    },
    {
      account: account("b"),
      reading: reading({ five: [95, H], week: [10, D] }),
    },
  ]);
  const q = pickSpread(blocked, policy);
  assert.deepEqual([q.account, q.queue, q.at], ["b", true, NOW + H]);
  const preferred = states([
    {
      account: account("a"),
      reading: reading({ five: [0, H], week: [0, 2 * H] }),
    },
    {
      account: account("p", "preferred"),
      reading: reading({ five: [60, H], week: [60, 6 * D] }),
    }, // room 30 >= 20
  ]);
  assert.equal(pickSpread(preferred, policy).account, "p");
});

test("turn cost: moving average of per-turn deltas, skipping resets and other accounts", () => {
  const s = (t, acct, five, resets = "R1") => ({
    at: iso(NOW - t),
    account: acct,
    five_hour: { used: five, resetsAt: resets },
    seven_day: { used: 10 + five / 10, resetsAt: "W" },
  });
  const samples = [
    s(50 * M, "a", 10),
    s(40 * M, "a", 14),
    s(30 * M, "a", 20),
    s(25 * M, "a", 5, "R2"),
    s(20 * M, "a", 9, "R2"),
    s(10 * M, "b", 50),
    s(5 * M, "b", 52),
  ];
  const cost = turnCost(samples, policy);
  // a: 4, 6, (reset), 4; then b: 2 -> last five: 4, 6, 4, 2
  assert.equal(cost.five_hour, (4 + 6 + 4 + 2) / 4);
  assert.equal(turnCost([s(0, "a", 10)], policy).five_hour, null);
  assert.equal(turnCost(samples, { ...policy, costSamples: 2 }).five_hour, 3);
});

test("turn cost and burn rate: resets_at moving by seconds between readings is the same window", () => {
  // The status line's resets_at can differ by a second from one reading to
  // the next; only a real reset (hours later) starts a new period.
  const resets = NOW + 3 * H;
  const r = (t, used, jitter) => ({
    at: iso(NOW - t),
    account: "a",
    five_hour: { used, resetsAt: iso(resets + jitter) },
    seven_day: { used: 10, resetsAt: iso(NOW + 3 * D) },
  });
  const samples = [r(30 * M, 50, 0), r(20 * M, 62, 1000), r(10 * M, 76, 2000)];
  assert.equal(turnCost(samples, policy).five_hour, 13);
  assert.equal(burnRate(samples, policy, NOW).five_hour, 26 / (20 / 60));
  const reset = [
    r(30 * M, 90, 0),
    {
      ...r(20 * M, 5, 0),
      five_hour: { used: 5, resetsAt: iso(resets + 5 * H) },
    },
  ];
  assert.equal(turnCost(reset, policy).five_hour, null);
});

test("burn rate and hours to block", () => {
  const samples = [
    {
      at: iso(NOW - 30 * M),
      account: "a",
      five_hour: { used: 10, resetsAt: "R" },
      seven_day: { used: 50, resetsAt: "W" },
    },
    {
      at: iso(NOW),
      account: "a",
      five_hour: { used: 25, resetsAt: "R" },
      seven_day: { used: 51, resetsAt: "W" },
    },
  ];
  const burn = burnRate(samples, policy, NOW);
  assert.equal(burn.five_hour, 30);
  assert.equal(burn.seven_day, 2);
  const s = one({ reading: reading({ five: [70, 3 * H], week: [51, 3 * D] }) });
  // 20 points of 5-hour headroom at 30 %/h: 0.67 h, before the 3 h reset
  assert.ok(Math.abs(hoursToBlock(s, burn, NOW) - 20 / 30) < 1e-9);
  const resetsFirst = one({
    reading: reading({ five: [70, 20 * M], week: [51, 3 * D] }),
  });
  // 0.67 h > 0.33 h to the reset: the 5-hour window does not block; weekly 44/2 = 22 h
  assert.equal(hoursToBlock(resetsFirst, burn, NOW), 22);
});

const twoAccounts = (cur, other) =>
  states([
    { account: account("cur"), ...cur },
    { account: account("other"), ...other },
  ]);
const refuse = (s, window = "five_hour", session = {}) =>
  decideTurnEnd({
    now: NOW,
    policy,
    states: s,
    current: "cur",
    event: "stop-failure",
    failure: { error: "rate_limit", window },
    session,
  });

test("refusal: a 5-hour block resetting within 20 min waits in place", () => {
  const s = twoAccounts(
    { reading: reading({ five: [100, 10 * M], week: [20, D] }) },
    {},
  );
  assert.deepEqual(refuse(s), {
    type: "wait-in-place",
    reason: "reset-soon",
    at: NOW + 10 * M,
  });
});

test("refusal: a later 5-hour reset or a weekly block hops to the best open account", () => {
  const later = twoAccounts(
    { reading: reading({ five: [100, 2 * H], week: [20, D] }) },
    {},
  );
  assert.deepEqual(refuse(later), {
    type: "hop",
    to: "other",
    reason: "refusal",
    countdown: true,
  });
  const weekly = twoAccounts(
    { reading: reading({ five: [10, 10 * M], week: [100, D] }) },
    {},
  );
  assert.equal(refuse(weekly, "seven_day").type, "hop");
});

test("refusal with every account blocked: wait in place when the current one is first back on a 5-hour block", () => {
  const s = twoAccounts(
    { reading: reading({ five: [100, H], week: [20, D] }) },
    { reading: reading({ five: [100, 2 * H], week: [20, D] }) },
  );
  assert.deepEqual(refuse(s), {
    type: "wait-in-place",
    reason: "all-blocked-current-first",
    at: NOW + H,
  });
});

test("refusal with every account blocked: close and wait for another account that is first back", () => {
  const s = twoAccounts(
    { reading: reading({ five: [100, 2 * H], week: [20, D] }) },
    { reading: reading({ five: [100, 42 * M], week: [20, D] }) },
  );
  assert.deepEqual(refuse(s), {
    type: "wait",
    to: "other",
    at: NOW + 42 * M,
    reason: "all-blocked-wait",
  });
});

test("refusal with every account blocked: a weekly block on the current account is waited out with claude closed", () => {
  const s = twoAccounts(
    { reading: reading({ five: [10, H], week: [100, 10 * H] }) },
    { reading: reading({ five: [10, H], week: [100, 20 * H] }) },
  );
  assert.deepEqual(refuse(s, "seven_day"), {
    type: "wait",
    to: "cur",
    at: NOW + 10 * H,
    reason: "all-blocked-wait",
  });
  const unknown = twoAccounts(
    { reading: reading({ five: [100, null], week: [10, D] }) },
    { reading: reading({ five: [100, null], week: [10, D] }) },
  );
  assert.equal(refuse(unknown).reason, "all-blocked-unknown");
});

test("refusal: a stay keeps the session in place; repeated refusals right after resuming back off", () => {
  const s = twoAccounts(
    { reading: reading({ five: [100, 2 * H], week: [20, D] }) },
    {},
  );
  assert.equal(refuse(s, "five_hour", { stayUntil: NOW + H }).reason, "stayed");
  const backoff = refuse(s, "five_hour", { reblocks: 3 });
  assert.equal(backoff.type, "wait");
  assert.equal(backoff.reason, "reblocked");
  assert.equal(backoff.to, "other");
  assert.equal(backoff.at, NOW + 15 * M);
});

const stop = (s, session) =>
  decideTurnEnd({
    now: NOW,
    policy,
    states: s,
    current: "cur",
    event: "stop",
    session,
  });

test("planned hop: headroom below 1.5x the next-turn cost moves at this turn end", () => {
  const s = twoAccounts(
    { reading: reading({ five: [80, 2 * H], week: [20, 3 * D] }) },
    { reading: reading({ five: [10, H], week: [10, 3 * D] }) },
  );
  // 5-hour headroom 10 < 1.5 x 8 = 12
  assert.deepEqual(stop(s, { cost: { five_hour: 8, seven_day: 1 } }), {
    type: "hop",
    to: "other",
    reason: "planned",
    countdown: true,
    windows: ["five_hour"],
  });
  // 10 >= 1.5 x 6 = 9: stays
  assert.equal(
    stop(s, { cost: { five_hour: 6, seven_day: 1 } }).reason,
    "stay",
  );
});

test("planned hop: never while subagents or a workflow run, nor within minStay, nor in order mode", () => {
  const s = twoAccounts(
    { reading: reading({ five: [80, 2 * H], week: [20, 3 * D] }) },
    {},
  );
  const cost = { five_hour: 8, seven_day: 1 };
  assert.equal(
    stop(s, {
      cost,
      backgroundTasks: [{ type: "subagent", status: "running" }],
    }).reason,
    "busy",
  );
  assert.equal(
    stop(s, {
      cost,
      backgroundTasks: [{ type: "workflow", status: "running" }],
    }).reason,
    "busy",
  );
  assert.equal(
    stop(s, { cost, backgroundTasks: [{ type: "shell", status: "running" }] })
      .type,
    "hop",
  );
  assert.equal(stop(s, { cost, arrivedAt: NOW - 10 * M }).reason, "min-stay");
  assert.equal(stop(s, { cost, arrivedAt: NOW - 31 * M }).type, "hop");
  const order = { ...policy, mode: "order" };
  assert.equal(
    decideTurnEnd({
      now: NOW,
      policy: order,
      states: s,
      current: "cur",
      event: "stop",
      session: { cost },
    }).reason,
    "order-mode",
  );
});

test("planned hop: no target with room for the next turn means staying", () => {
  const s = twoAccounts(
    { reading: reading({ five: [80, 2 * H], week: [20, 3 * D] }) },
    { reading: reading({ five: [82, H], week: [10, 3 * D] }) },
  );
  assert.equal(
    stop(s, { cost: { five_hour: 8, seven_day: 1 } }).reason,
    "planned-no-target",
  );
});

test("compaction: rebalance when the account would block within an hour and another is clearly better", () => {
  const s = twoAccounts(
    { reading: reading({ five: [70, 3 * H], week: [30, 3 * D] }) },
    { reading: reading({ five: [10, H], week: [10, 3 * D] }) },
  );
  const burn = { five_hour: 30, seven_day: 1 };
  assert.deepEqual(stop(s, { compacted: true, burn }), {
    type: "hop",
    to: "other",
    reason: "compaction",
    countdown: true,
  });
  assert.equal(stop(s, { compacted: false, burn }).reason, "stay");
  assert.equal(
    stop(s, { compacted: true, burn: { five_hour: 10, seven_day: 1 } }).reason,
    "stay",
  ); // 2 h away
  const close = twoAccounts(
    { reading: reading({ five: [70, 3 * H], week: [30, 3 * D] }) },
    { reading: reading({ five: [55, H], week: [10, 3 * D] }) },
  );
  assert.equal(stop(close, { compacted: true, burn }).reason, "stay"); // 35 < 20 + 20
  const off = { ...policy, compactionRebalance: false };
  assert.equal(
    decideTurnEnd({
      now: NOW,
      policy: off,
      states: s,
      current: "cur",
      event: "stop",
      session: { compacted: true, burn },
    }).reason,
    "stay",
    "switched off",
  );
});

test("manual hop: to the named account, to the best other one, or not at all", () => {
  const s = twoAccounts({}, {});
  const manual = (hopRequest) =>
    decideTurnEnd({
      now: NOW,
      policy,
      states: s,
      current: "cur",
      event: "stop",
      hopRequest,
      session: {},
    });
  assert.deepEqual(manual({ to: "other" }), {
    type: "hop",
    to: "other",
    reason: "manual",
    countdown: false,
  });
  assert.deepEqual(manual({ to: null }), {
    type: "hop",
    to: "other",
    reason: "manual",
    countdown: false,
  });
  assert.equal(manual({ to: "cur" }).reason, "manual-same-account");
  const blocked = twoAccounts(
    {},
    { reading: reading({ five: [99, H], week: [1, D] }) },
  );
  assert.equal(
    decideTurnEnd({
      now: NOW,
      policy,
      states: blocked,
      current: "cur",
      event: "idle",
      hopRequest: { to: null },
    }).reason,
    "manual-no-account",
  );
});

test("waiting: resume as soon as any account opens, otherwise follow the earliest", () => {
  const blocked = twoAccounts(
    { reading: reading({ five: [100, 2 * H], week: [20, D] }) },
    { reading: reading({ five: [100, 42 * M], week: [20, D] }) },
  );
  assert.deepEqual(
    decideWait({ states: blocked, policy, target: "other", at: NOW + 42 * M }),
    { type: "wait", to: "other", at: NOW + 42 * M },
  );
  const earlier = twoAccounts(
    { reading: reading({ five: [100, 10 * M], week: [20, D] }) },
    { reading: reading({ five: [100, 42 * M], week: [20, D] }) },
  );
  assert.deepEqual(
    decideWait({ states: earlier, policy, target: "other", at: NOW + 42 * M }),
    { type: "wait", to: "cur", at: NOW + 10 * M },
  );
  const open = twoAccounts(
    { reading: reading({ five: [100, 2 * H], week: [20, D] }) },
    { reading: reading({ five: [5, 5 * H], week: [20, D], readAgo: 0 }) },
  );
  assert.equal(
    decideWait({ states: open, policy, target: "other", at: NOW + 42 * M })
      .type,
    "resume",
  );
});

test("accountState is pure and keeps the account's order index", () => {
  const s = accountState(account("z"), {
    reading: null,
    policy,
    now: NOW,
    index: 4,
  });
  assert.equal(s.index, 4);
  assert.equal(s.blocked, false);
});
