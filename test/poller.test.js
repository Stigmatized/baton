import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { addAccount, removeAccount, setPolicy } from "../src/accounts.js";
import { main } from "../src/cli.js";
import { effectivePolicy, loadConfig } from "../src/config.js";
import { isAlive, readJson, readJsonLines } from "../src/fsutil.js";
import { profileDir } from "../src/paths.js";
import {
  BACKOFF_FIRST_MS,
  BACKOFF_MAX_MS,
  Poller,
  nextPollAt,
  readPollState,
} from "../src/poller.js";
import {
  probeDir,
  projectDirName,
  readPlanUsage,
  usageFromReport,
} from "../src/probe.js";
import { loadSnapshot } from "../src/state.js";
import { historyFile, recordReading } from "../src/usage.js";
import { Collect, REPO, accountsHome, testEnv, until } from "./helpers.js";

const FAKE_USAGE = join(REPO, "test", "fixtures", "fake-usage-claude.js");
const fakeLauncher = {
  command: process.execPath,
  prefix: [FAKE_USAGE],
  path: FAKE_USAGE,
};
const M = 60e3;
const H = 60 * M;
const T0 = Date.parse("2026-10-25T10:00:00Z");
const iso = (t) => new Date(t).toISOString();
const meter = (kind, group, percent, resetsAt, extra = {}) => ({
  kind,
  group,
  percent,
  resets_at: iso(resetsAt),
  severity: "normal",
  is_active: false,
  ...extra,
});
const report = (at, { scoped = 80 } = {}) => ({
  session: {},
  rate_limits: {
    limits: [
      meter("session", "session", 42, at + 2 * H, { is_active: true }),
      meter("weekly_all", "weekly", 63, at + 72 * H),
      ...(scoped == null
        ? []
        : [
            meter("weekly_scoped", "weekly", scoped, at + 48 * H, {
              scope: { model: { display_name: "Fable" } },
              severity: "warning",
            }),
          ]),
      { kind: "broken", group: "weekly", percent: null },
    ],
    extra_usage: {
      is_enabled: true,
      monthly_limit: 5000,
      used_credits: 1234,
      utilization: 24.68,
      currency: "USD",
    },
  },
});

async function baton(home, argv, extra = {}) {
  const stdout = new Collect();
  const stderr = new Collect();
  const code = await main(argv, {
    env: testEnv(home, extra),
    stdout,
    stderr,
  });
  return { code, out: stdout.text, err: stderr.text };
}

// A poller with a fake read and a clock the test moves.
function fakePoller(paths, { outcomes = {}, signedOut = [] } = {}) {
  const clock = { t: T0 };
  const calls = [];
  const poller = new Poller({
    paths,
    env: testEnv(paths.home),
    now: () => clock.t,
    launcher: fakeLauncher,
    auth: async (id) => ({ ok: true, loggedIn: !signedOut.includes(id) }),
    probe: async ({ id, claudePath }) => {
      calls.push({ id, at: clock.t, claudePath });
      const next = outcomes[id];
      const outcome = Array.isArray(next) ? next.shift() : next;
      return (
        outcome ?? usageFromReport(report(clock.t), { text: "", at: clock.t })
      );
    },
  });
  return { poller, clock, calls };
}

test("a usage report becomes a reading: both windows, the other meters, extra usage; no plan usage is 'unavailable'", () => {
  const ok = usageFromReport(report(T0), { at: T0 });
  assert.equal(ok.status, "ok");
  assert.deepEqual(ok.reading, {
    five_hour: { used: 42, resetsAt: iso(T0 + 2 * H) },
    seven_day: { used: 63, resetsAt: iso(T0 + 72 * H) },
  });
  assert.deepEqual(
    ok.limits.map((l) => [l.kind, l.group, l.label, l.used, l.active]),
    [
      ["session", "session", null, 42, true],
      ["weekly_all", "weekly", null, 63, false],
      ["weekly_scoped", "weekly", "Fable", 80, false],
    ],
  );
  assert.deepEqual(ok.extraUsage, {
    enabled: true,
    monthlyLimit: 5000,
    usedCredits: 1234,
    utilization: 24.68,
    currency: "USD",
  });
  // An empty list: the endpoint answered with no meters.
  assert.deepEqual(
    usageFromReport({ rate_limits: { limits: [] } }, { at: T0 }).reading,
    {},
  );
  assert.deepEqual(
    usageFromReport(
      { session: {}, rate_limits: null },
      { text: "Could not load your plan usage.\n", at: T0 },
    ),
    { status: "unavailable", reason: "Could not load your plan usage." },
  );
  assert.equal(
    usageFromReport({ rate_limits: null }, { at: T0 }).reason,
    "the plan usage could not be fetched",
  );
  const none = usageFromReport(undefined, { text: "", at: T0 });
  assert.equal(none.status, "unavailable");
  assert.match(none.reason, /no usage report/);
  const local = new Date(2026, 9, 25, 1, 0).getTime();
  assert.deepEqual(
    usageFromReport(
      { rate_limits: null },
      { text: "Usage data is rate limited until 3:14am.", at: local },
    ),
    {
      status: "rate-limited",
      until: new Date(2026, 9, 25, 3, 14).getTime(),
      reason: "Usage data is rate limited until 3:14am.",
    },
  );
  assert.equal(
    usageFromReport(
      { rate_limits: null },
      {
        text: "Usage endpoint is rate limited. Please try again in a moment.",
        at: T0,
      },
    ).until,
    null,
  );
  assert.equal(
    usageFromReport(undefined, {
      text: "Not logged in · Please run /login",
      at: T0,
    }).status,
    "signed-out",
  );
});

test("the strictest weekly limit in force decides: a model's own weekly limit over the all-models one until it resets", (t) => {
  const { paths } = accountsHome(t, ["acct1"]);
  const outcome = usageFromReport(report(T0), { at: T0 });
  recordReading(paths, "acct1", outcome.reading, {
    at: T0,
    source: "poll",
    refreshMs: 0,
    limits: outcome.limits,
    extraUsage: outcome.extraUsage,
  });
  const week = (now) =>
    loadSnapshot(paths, { now }).states[0].windows.seven_day;
  assert.deepEqual(
    [week(T0 + H).used, week(T0 + H).label, week(T0 + H).source],
    [80, "Fable", "poll"],
  );
  assert.equal(week(T0 + H).resetsAt, T0 + 48 * H);
  // A status line reading of the all-models window later: still the stricter.
  recordReading(
    paths,
    "acct1",
    { seven_day: { used: 70, resetsAt: iso(T0 + 72 * H) } },
    { at: T0 + 2 * H },
  );
  assert.equal(week(T0 + 3 * H).used, 80);
  // After the model's own limit reset, the all-models window again.
  assert.deepEqual(
    [week(T0 + 49 * H).used, week(T0 + 49 * H).label],
    [70, null],
  );
});

test("a poll is recorded like a status line reading, with source poll; a status line reading after it keeps the other meters", async (t) => {
  const { home, paths } = accountsHome(t, ["acct1"]);
  const { poller, clock } = fakePoller(paths);
  // Real time here: `baton usage` reads the clock.
  const at = (clock.t = Date.now());
  const [result] = await poller.refresh({ account: "acct1" });
  assert.equal(result.status, "ok");
  const stored = readJson(join(paths.usage, "acct1.json"));
  assert.equal(stored.source, "poll");
  assert.equal(stored.five_hour.source, "poll");
  assert.equal(stored.seven_day.used, 63);
  assert.equal(stored.limits.length, 3);
  assert.equal(stored.limitsAt, iso(at));
  assert.equal(stored.extraUsage.usedCredits, 1234);
  const history = readJsonLines(historyFile(paths, "readings", at));
  assert.deepEqual(
    history.map((h) => [h.account, h.window, h.used, h.source]),
    [
      ["acct1", "five_hour", 42, "poll"],
      ["acct1", "seven_day", 63, "poll"],
    ],
  );
  // A session's status line then reports the 5-hour window only.
  recordReading(
    paths,
    "acct1",
    { five_hour: { used: 50, resetsAt: iso(at + 2 * H) } },
    { at: Date.now() },
  );
  const after = readJson(join(paths.usage, "acct1.json"));
  assert.equal(after.five_hour.source, "statusline");
  assert.equal(after.seven_day.source, "poll");
  assert.equal(after.limits.length, 3);
  const usage = await baton(home, ["usage"]);
  assert.match(usage.out, /^ *5-hour .* 50% +resets /m);
  assert.match(usage.out, /^ *weekly .* 80% +resets /m);
  assert.match(
    usage.out,
    /Read +5-hour from session just now · weekly polled just now \(weekly: Fable's own limit\)/,
  );
  assert.match(usage.out, /Limits +Fable weekly 80%/);
  assert.match(
    usage.out,
    /Extra usage +on, 12\.34 USD used of 50\.00 USD this month/,
  );
  assert.match(usage.out, /Usage poll +polled just now/);
  assert.match(
    usage.out,
    /Usage poll: no baton running: usage is checked while baton or baton view runs./,
  );
  const status = await baton(home, ["status"]);
  assert.match(status.out, /Usage poll: no baton running/);
});

test("the schedule: every account at the start, then every usagePollMinutes; a changed interval applies at once; 0 polls only on request", async (t) => {
  const { paths } = accountsHome(t, ["acct1"]);
  addAccount(paths, "acct2");
  const { poller, clock, calls } = fakePoller(paths);
  t.after(() => poller.stop());
  await poller.tick();
  assert.deepEqual(
    calls.map((c) => c.id),
    ["acct1", "acct2"],
  );
  assert.equal(calls[0].claudePath, FAKE_USAGE);
  assert.equal(readPollState(paths).lastRunAt, iso(T0));
  const policy = () => effectivePolicy(loadConfig(paths));
  assert.equal(
    nextPollAt(readPollState(paths), policy(), { now: T0 }),
    T0 + 30 * M,
  );
  assert.equal(
    nextPollAt(readPollState(paths), policy(), { running: false, now: T0 }),
    null,
  );
  clock.t = T0 + 29 * M;
  assert.equal(poller.tick(), null);
  clock.t = T0 + 30 * M;
  await poller.tick();
  assert.equal(calls.length, 4);
  setPolicy(paths, { usagePollMinutes: 10 });
  clock.t = T0 + 39 * M;
  assert.equal(poller.tick(), null);
  clock.t = T0 + 40 * M;
  await poller.tick();
  assert.equal(calls.length, 6);
  // One account on request: the schedule stays.
  clock.t = T0 + 45 * M;
  const [one] = await poller.refresh({ account: "acct2", reason: "menu" });
  assert.equal(one.name, "acct2");
  assert.equal(calls.at(-1).id, "acct2");
  assert.equal(readPollState(paths).lastRunAt, iso(T0 + 40 * M));
  setPolicy(paths, { usagePollMinutes: 0 });
  clock.t = T0 + 600 * M;
  assert.equal(poller.tick(), null);
  assert.equal(
    nextPollAt(readPollState(paths), policy(), { now: clock.t }),
    null,
  );
  // Requests wait their turn; a removed account is not polled.
  removeAccount(paths, "acct1");
  const all = await poller.refresh();
  assert.deepEqual(
    all.map((r) => r.id),
    ["acct2"],
  );
  assert.equal(
    (await poller.refresh({ account: "acct1" }))[0].status,
    "unknown",
  );
});

test("back-off: the rate limit's own time, else 5 minutes doubling up to 2 hours; a reading clears it", async (t) => {
  const { paths } = accountsHome(t, ["acct1"]);
  const limited = (until = null) => ({
    status: "rate-limited",
    until,
    reason: "Usage endpoint is rate limited",
  });
  const { poller, clock, calls } = fakePoller(paths, {
    outcomes: {
      acct1: [
        limited(T0 + 40 * M),
        ...Array.from({ length: 7 }, () => limited()),
      ],
    },
  });
  const ask = async () => (await poller.refresh({ account: "acct1" }))[0];
  const first = await ask();
  assert.equal(first.status, "rate-limited");
  assert.equal(first.backoffUntil, iso(T0 + 40 * M));
  clock.t = T0 + 10 * M;
  const waiting = await ask();
  assert.equal(waiting.status, "backoff");
  assert.equal(waiting.until, iso(T0 + 40 * M));
  assert.equal(calls.length, 1, "not asked while it waits");
  clock.t = T0 + 40 * M;
  const waits = [];
  for (let i = 0; i < 7; i++) {
    const r = await ask();
    assert.equal(r.status, "rate-limited");
    waits.push(r.backoffMs);
    clock.t = Date.parse(r.backoffUntil);
  }
  assert.deepEqual(
    waits.map((w) => w / M),
    [5, 10, 20, 40, 80, 120, 120],
  );
  assert.equal(BACKOFF_FIRST_MS, 5 * M);
  assert.equal(BACKOFF_MAX_MS, 2 * H);
  assert.equal(readPollState(paths).accounts.acct1.failures, 8);
  const ok = await ask();
  assert.equal(ok.status, "ok");
  assert.deepEqual(
    [ok.backoffUntil, ok.backoffMs, ok.failures, ok.okAt],
    [null, null, 0, iso(clock.t)],
  );
});

test("a signed-out account is skipped and marked; the others are polled", async (t) => {
  const { home, paths } = accountsHome(t, ["acct1"]);
  addAccount(paths, "acct2");
  const { poller, calls } = fakePoller(paths, { signedOut: ["acct2"] });
  const results = await poller.refresh();
  assert.deepEqual(
    results.map((r) => [r.id, r.status]),
    [
      ["acct1", "ok"],
      ["acct2", "signed-out"],
    ],
  );
  assert.deepEqual(
    calls.map((c) => c.id),
    ["acct1"],
  );
  assert.ok(!existsSync(join(paths.usage, "acct2.json")));
  const status = (await baton(home, ["status"])).out;
  assert.match(status, /USAGE POLL/);
  assert.match(status, /acct2 +signed out: not polled/);
  assert.match(status, /^ *acct2 .* Sign in$/m);
});

test("the read runs the installed claude under the profile with nothing loaded, and leaves no transcript behind", async (t) => {
  const { root, home, paths } = accountsHome(t, ["acct1"]);
  addAccount(paths, "acct2");
  const log = join(root, "probe-log.jsonl");
  const env = testEnv(home, {
    FAKE_USAGE_LOG: log,
    FAKE_TRANSCRIPT: "1",
    CLAUDE_CONFIG_DIR: join(root, "elsewhere"),
    CLAUDE_CODE_SESSION_ID: "6f0b2d4e-1c3a-4b5d-8e9f-0a1b2c3d4e5f",
    BATON_WRAPPER: "w1",
    CLAUDECODE: "1",
  });
  for (const id of ["acct1", "acct2"]) {
    const r = await readPlanUsage({
      paths,
      id,
      env,
      claudePath: FAKE_USAGE,
      timeoutMs: 30e3,
    });
    assert.equal(r.status, "ok", JSON.stringify(r));
    assert.deepEqual(r.reading.five_hour.used, 42);
  }
  const runs = readJsonLines(log);
  assert.equal(runs.length, 2);
  for (const run of runs) {
    for (const flag of [
      "--no-session-persistence",
      "--setting-sources=",
      "--tools=",
      "--strict-mcp-config",
      "--max-turns=1",
    ])
      assert.ok(run.argv.includes(flag), `${flag} in ${run.argv.join(" ")}`);
    assert.ok(!run.argv.some((a) => a.startsWith("--resume")));
    for (const name of [
      "CLAUDE_CODE_SESSION_ID",
      "BATON_WRAPPER",
      "CLAUDECODE",
    ])
      assert.ok(!run.envNames.includes(name), `${name} is not passed on`);
    assert.equal(run.cwd.toLowerCase(), probeDir(paths).toLowerCase());
  }
  assert.equal(
    runs[0].configDir,
    profileDir(paths, "acct1"),
    "always the account's own profile",
  );
  assert.equal(runs[1].configDir, profileDir(paths, "acct2"));
  const name = projectDirName(probeDir(paths));
  for (const base of [paths.claudeDir, profileDir(paths, "acct2")])
    assert.ok(
      !existsSync(join(base, "projects", name)),
      `no transcript in ${base}`,
    );
});

test("a claude that hangs is ended after the timeout, its process with it; an SDK that never answers too", async (t) => {
  const { root, home, paths } = accountsHome(t, ["acct1"]);
  const pidFile = join(root, "hang.pid");
  const started = Date.now();
  const r = await readPlanUsage({
    paths,
    id: "acct1",
    env: testEnv(home, { FAKE_USAGE_MODE: "hang", FAKE_USAGE_PID: pidFile }),
    claudePath: FAKE_USAGE,
    timeoutMs: 1500,
  });
  assert.equal(r.status, "timeout");
  assert.match(r.reason, /no answer in 2 s; claude was ended/);
  assert.ok(Date.now() - started < 15000);
  const pid = Number(readFileSync(pidFile, "utf8"));
  await until(() => !isAlive(pid), 10000);
  // A query function that never yields and ignores the abort.
  let aborted = false;
  const stuck = await readPlanUsage({
    paths,
    id: "acct1",
    env: testEnv(home),
    claudePath: FAKE_USAGE,
    timeoutMs: 200,
    query: ({ options }) => {
      options.abortController.signal.addEventListener("abort", () => {
        aborted = true;
      });
      return {
        [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => {}) }),
        close() {},
      };
    },
  });
  assert.equal(stuck.status, "timeout");
  assert.ok(aborted, "the SDK was told to stop");
  // One that fails outright.
  const failed = await readPlanUsage({
    paths,
    id: "acct1",
    env: testEnv(home),
    claudePath: FAKE_USAGE,
    query: () => {
      throw new Error("spawn claude ENOENT");
    },
  });
  assert.deepEqual(failed, { status: "failed", reason: "spawn claude ENOENT" });
});

test("rate_limits null, a rate limited endpoint and no report, through the real SDK", async (t) => {
  const { home, paths } = accountsHome(t, ["acct1"]);
  const read = (mode) =>
    readPlanUsage({
      paths,
      id: "acct1",
      env: testEnv(home, { FAKE_USAGE_MODE: mode }),
      claudePath: FAKE_USAGE,
      timeoutMs: 30e3,
    });
  assert.deepEqual(await read("null"), {
    status: "unavailable",
    reason: "Could not load your plan usage.",
  });
  const limited = await read("ratelimited");
  assert.equal(limited.status, "rate-limited");
  assert.ok(limited.until > Date.now());
  assert.equal((await read("none")).status, "unavailable");
});

test("on request: baton usage --refresh [account] polls in its own process, which exits when it is done", async (t) => {
  const { home, paths } = accountsHome(t, ["acct1"]);
  addAccount(paths, "acct2");
  const extra = { BATON_CLAUDE: FAKE_USAGE };
  const all = await baton(home, ["usage", "--refresh"], extra);
  assert.equal(all.code, 0, all.err);
  assert.match(all.out, /acct1 +5-hour 42% · weekly 63% +polled now$/m);
  assert.match(all.out, /acct2 +5-hour 42% · weekly 63% +polled now$/m);
  const before = readJson(join(paths.usage, "acct1.json")).at;
  const one = await baton(home, ["usage", "--refresh", "acct2"], extra);
  assert.equal(one.code, 0, one.err);
  assert.doesNotMatch(one.out, /acct1/);
  assert.equal(readJson(join(paths.usage, "acct1.json")).at, before);
  const signedOut = await baton(home, ["usage", "--refresh", "acct2"], {
    ...extra,
    FAKE_LOGGED_IN: "0",
  });
  assert.match(signedOut.out, /acct2 +signed out: not polled$/m);
  assert.equal(
    (await baton(home, ["usage", "--refresh", "nobody"], extra)).code,
    2,
  );
});
