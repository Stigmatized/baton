import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { main } from "../src/cli.js";
import { isAlive, readJson, readJsonLines } from "../src/fsutil.js";
import { Lead } from "../src/lead.js";
import {
  PollHost,
  leaseFile,
  pollHolder,
  requestPoll,
} from "../src/poll-host.js";
import { readPollState } from "../src/poller.js";
import { endClaude } from "../src/terminate.js";
import {
  CLI,
  Collect,
  REPO,
  accountsHome,
  keyInput,
  testEnv,
  until,
  write,
} from "./helpers.js";

const FIXTURES = join(REPO, "test", "fixtures");
const INSTANCE = join(FIXTURES, "poll-instance.js");
const BOTH = join(FIXTURES, "fake-claude-both.js");
const SID = "6f0b2d4e-1c3a-4b5d-8e9f-0a1b2c3d4e5f";

async function baton(home, argv, extra = {}) {
  const stdout = new Collect();
  const stderr = new Collect();
  const code = await main(argv, { env: testEnv(home, extra), stdout, stderr });
  return { code, out: stdout.text, err: stderr.text };
}

// A host whose poller is a recorder; the clock and the liveness are the test's.
function host(paths, { kind = "start", pid, clock, alive }) {
  const calls = [];
  const poller = {
    pending: 0,
    refresh: async ({ account, reason }) => {
      calls.push([account ?? "all", reason]);
      return [];
    },
    tick: () => {
      calls.push(["all", "schedule"]);
      return null;
    },
    stop: async () => {},
  };
  const h = new PollHost({
    paths,
    kind,
    pid,
    poller,
    now: () => clock.t,
    alive,
  });
  return { h, calls };
}

test("one baton instance holds the poll lease and polls; another takes over when it stops, dies or stops renewing", async (t) => {
  const { paths } = accountsHome(t, ["acct1", "acct2"]);
  const clock = { t: Date.parse("2026-10-25T10:00:00Z") };
  const dead = new Set();
  const alive = (pid) => !dead.has(pid);
  const a = host(paths, { kind: "menu", pid: 101, clock, alive });
  const b = host(paths, { kind: "start", pid: 102, clock, alive });
  const c = host(paths, { kind: "start", pid: 103, clock, alive });
  assert.equal(a.h.beat(), true);
  assert.equal(b.h.beat(), false);
  assert.equal(c.h.beat(), false);
  for (let i = 0; i < 5; i++) {
    clock.t += 3e3;
    a.h.beat();
    b.h.beat();
    c.h.beat();
  }
  // Only the holder ran the schedule.
  assert.equal(a.calls.length, 6);
  assert.deepEqual([b.calls, c.calls], [[], []]);
  assert.deepEqual(pollHolder(paths, { now: clock.t, alive }), {
    kind: "menu",
    pid: 101,
    since: new Date(Date.parse("2026-10-25T10:00:00Z")).toISOString(),
  });
  assert.ok(a.h.holds() && !b.h.holds());
  // A command asks for an account's poll: the holder takes it once.
  // (Request files sort by their millisecond: two in one millisecond would
  // come in a random order.)
  const asked = Date.now();
  requestPoll(paths, "acct2", "renamed", asked);
  requestPoll(paths, "acct2", "signed in", asked + 1);
  b.h.beat();
  assert.deepEqual(b.calls, [], "only the holder takes requests");
  a.h.beat();
  assert.deepEqual(a.calls.slice(-2), [
    ["acct2", "renamed"],
    ["all", "schedule"],
  ]);
  // The holder dies: the next instance takes the lease at once.
  dead.add(101);
  assert.equal(b.h.beat(), true);
  assert.equal(c.h.beat(), false);
  assert.equal(pollHolder(paths, { now: clock.t, alive }).pid, 102);
  // The holder stops renewing (hung): taken after 10 s.
  clock.t += 9e3;
  assert.equal(c.h.beat(), false);
  clock.t += 2e3;
  assert.equal(c.h.beat(), true);
  assert.equal(b.h.beat(), false, "it lost the lease and knows it");
  assert.equal(b.h.holds(), false);
  // The holder stops: it lets the lease go, and the last one leaves none.
  await c.h.stop();
  assert.equal(pollHolder(paths, { now: clock.t, alive }), null);
  assert.equal(b.h.beat(), true);
  await b.h.stop();
  await a.h.stop();
  assert.ok(!existsSync(leaseFile(paths)), "nobody polls");
  assert.equal(pollHolder(paths, { now: clock.t, alive }), null);
});

// Real processes: three instances on one home, the fake usage claude.
function instances(t, n, { paths, home, root }) {
  const log = join(root, "instances.jsonl");
  const claudes = join(root, "claudes.jsonl");
  const list = [];
  for (let i = 0; i < n; i++) {
    const child = spawn(process.execPath, [INSTANCE], {
      env: testEnv(home, {
        INSTANCE_LOG: log,
        INSTANCE_KIND: i ? "start" : "menu",
        FAKE_USAGE_LOG: claudes,
        HEARTBEAT_MS: "150",
        STALE_MS: "1500",
      }),
      stdio: ["pipe", "ignore", "pipe"],
    });
    child.stderr.on("data", () => {});
    list.push(child);
  }
  t.after(() => {
    for (const c of list) if (isAlive(c.pid)) c.kill("SIGKILL");
  });
  return {
    list,
    events: () => readJsonLines(log),
    claudes: () => readJsonLines(claudes),
    holder: () => readJson(leaseFile(paths))?.pid ?? null,
    exited: (c) =>
      new Promise((r) =>
        c.exitCode !== null || c.signalCode !== null ? r() : c.once("exit", r),
      ),
  };
}

test(
  "several instances: exactly one polls; another takes over when it exits or is killed; nothing runs after the last one",
  { timeout: 90000 },
  async (t) => {
    const ctx = accountsHome(t, ["acct1"]);
    const { paths } = ctx;
    // A poll every 0.6 s, so that each holder's turn shows.
    const config = readJson(paths.config);
    write(paths.config, { ...config, policy: { usagePollMinutes: 0.01 } });
    const run = instances(t, 3, ctx);
    await until(
      () => run.events().filter((e) => e.event === "ready").length === 3,
      20000,
    );
    await until(
      () => run.events().filter((e) => e.event === "polled").length >= 3,
      30000,
    );
    const first = run.holder();
    const pollers = new Set(
      run
        .events()
        .filter((e) => e.event === "polled")
        .map((e) => e.pid),
    );
    assert.deepEqual([...pollers], [first], "one instance polls");
    assert.equal(readPollState(paths).accounts.acct1.status, "ok");
    // Killed: another live instance takes over and polls.
    const victim = run.list.find((c) => c.pid === first);
    victim.kill("SIGKILL");
    await run.exited(victim);
    await until(() => run.holder() && run.holder() !== first, 10000);
    const second = run.holder();
    const killedAt = Date.now();
    await until(
      () =>
        run
          .events()
          .some(
            (e) => e.event === "polled" && e.pid === second && e.at > killedAt,
          ),
      20000,
    );
    // Exits (its stdin closes): the last one takes over.
    const leaving = run.list.find((c) => c.pid === second);
    leaving.stdin.end();
    await run.exited(leaving);
    assert.ok(
      run.events().some((e) => e.event === "stopped" && e.pid === second),
    );
    await until(() => run.holder() && run.holder() !== second, 10000);
    const third = run.holder();
    assert.ok(![first, second].includes(third));
    // The last instance exits: no lease, and no process of theirs survives.
    const last = run.list.find((c) => c.pid === third);
    last.stdin.end();
    await run.exited(last);
    assert.ok(!existsSync(leaseFile(paths)));
    assert.equal(pollHolder(paths), null);
    for (const c of run.list) assert.ok(!isAlive(c.pid), `instance ${c.pid}`);
    await until(() => run.claudes().every((c) => !isAlive(c.pid)), 10000).catch(
      () => {
        throw new Error(
          `claude still running: ${run
            .claudes()
            .filter((c) => isAlive(c.pid))
            .map((c) => c.pid)}`,
        );
      },
    );
    assert.match(
      (await baton(ctx.home, ["status"])).out,
      /Usage poll: no baton running: usage is checked while baton or baton view runs\./,
    );
  },
);

test(
  "a baton session is an instance: it polls while it runs, says so in baton status, and leaves nothing running",
  { timeout: 90000 },
  async (t) => {
    const ctx = accountsHome(t, ["acct1"]);
    const { paths, home, root } = ctx;
    const dir = join(root, "fake");
    mkdirSync(dir, { recursive: true });
    write(join(dir, "scenario.json"), {
      session: SID,
      runs: [{ steps: [{ waitFile: "done" }, { exit: 0 }] }],
    });
    const claudes = join(root, "claudes.jsonl");
    const lead = spawn(process.execPath, [CLI, "-p", "hello"], {
      env: testEnv(home, {
        BATON_CLAUDE: BOTH,
        FAKE_CLAUDE_DIR: dir,
        FAKE_USAGE_LOG: claudes,
      }),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    lead.stdout.on("data", (d) => (output += d));
    lead.stderr.on("data", (d) => (output += d));
    t.after(() => {
      if (isAlive(lead.pid)) lead.kill("SIGKILL");
    });
    // Its start polls (no poll yet), under the account's profile.
    await until(
      () => readJson(join(paths.usage, "acct1.json"))?.source === "poll",
      30000,
    );
    const status = (await baton(home, ["status"])).out;
    assert.match(
      status,
      new RegExp(
        `Usage poll: by baton \\(pid ${lead.pid}\\), every 30 min, next `,
      ),
    );
    write(join(dir, "done"), "");
    const code = await new Promise((r) => lead.once("exit", r));
    assert.equal(code, 0);
    assert.equal(output, "", "the poll prints nothing in claude's terminal");
    assert.equal(pollHolder(paths), null);
    assert.match(
      (await baton(home, ["status"])).out,
      /Usage poll: no baton running/,
    );
    for (const inv of readJsonLines(join(dir, "invocations.jsonl")))
      assert.ok(!isAlive(inv.pid), "the session's claude");
    for (const c of readJsonLines(claudes))
      assert.ok(!isAlive(c.pid), "the poll's claude");
  },
);

test(
  "a poll that hangs never holds up the session: the hop happens on time and the read ends with the wrapper",
  { timeout: 60000 },
  async (t) => {
    const { paths, home, root } = accountsHome(t, ["acct1", "acct2"]);
    const dir = join(root, "fake");
    mkdirSync(dir, { recursive: true });
    const H = 3600;
    write(join(dir, "scenario.json"), {
      session: SID,
      runs: [
        {
          steps: [
            { hook: "session-start" },
            {
              statusline: { five_hour: [100, 2 * H], seven_day: [40, 72 * H] },
            },
            { hook: "prompt", permission_mode: "default" },
            {
              hook: "stop-failure",
              error: "rate_limit",
              last_assistant_message: "API Error: Rate limit reached",
            },
            { wait: "end" },
          ],
        },
        { steps: [{ hook: "session-start" }, { exit: 0 }] },
      ],
    });
    const claudes = join(root, "claudes.jsonl");
    const output = new Collect();
    const started = Date.now();
    const lead = new Lead({
      args: [],
      paths,
      env: testEnv(home, {
        FAKE_CLAUDE_DIR: dir,
        FAKE_USAGE_MODE: "hang",
        FAKE_USAGE_LOG: claudes,
      }),
      cwd: root,
      claude: { command: process.execPath, prefix: [BOTH], path: BOTH },
      end: (child) => endClaude(child, { method: "kill" }),
      input: keyInput(),
      output,
      signals: new EventEmitter(),
      pollMs: 40,
      tickMs: 40,
      countdownSeconds: 0,
      settleMs: 50,
      stdio: "ignore",
    });
    assert.equal(await lead.run(), 0);
    assert.ok(Date.now() - started < 20000, "not held up by the hanging read");
    const invocations = readJsonLines(join(dir, "invocations.jsonl"));
    assert.equal(invocations.length, 2, "it hopped");
    assert.doesNotMatch(output.text, /poll|usage/i, "the poll said nothing");
    // The hanging read was started, and ended with the wrapper.
    const reads = readJsonLines(claudes);
    assert.ok(reads.length >= 1, "a read was running");
    await until(() => reads.every((c) => !isAlive(c.pid)), 10000);
    assert.equal(pollHolder(paths), null);
  },
);

test("baton serve is gone: not a command, not in the help", async (t) => {
  const { home } = accountsHome(t, ["acct1"]);
  const r = await baton(home, ["serve"]);
  assert.equal(r.code, 2);
  assert.match(r.err, /unknown command serve/);
  const help = (await baton(home, ["help"])).out;
  assert.doesNotMatch(help, /\bserve\b|service/);
  const usage = spawnSync(process.execPath, [CLI, "help", "usage"], {
    env: testEnv(home),
    encoding: "utf8",
  });
  assert.match(usage.stdout, /baton usage \[--refresh\] \[account\]/);
  assert.ok(
    !readFileSync(join(REPO, "README.md"), "utf8").includes("baton serve"),
  );
});
