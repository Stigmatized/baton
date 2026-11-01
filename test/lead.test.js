import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { spawnSync } from "node:child_process";
import { mkdirSync, openSync, closeSync } from "node:fs";
import { join } from "node:path";
import { readJsonLines } from "../src/fsutil.js";
import { Lead } from "../src/lead.js";
import { profileDir } from "../src/paths.js";
import { endClaude, typeConsoleKeys } from "../src/terminate.js";
import { historyFile } from "../src/usage.js";
import {
  CLI,
  Collect,
  FAKE_CLAUDE,
  keyInput,
  tempHome,
  testEnv,
  until,
  write,
} from "./helpers.js";

const SID = "6f0b2d4e-1c3a-4b5d-8e9f-0a1b2c3d4e5f";
const H = 3600;

function consoleAvailable() {
  if (process.platform !== "win32") return false;
  try {
    closeSync(openSync("\\\\.\\CONIN$", "r+"));
    return true;
  } catch {
    return false;
  }
}

// Starts a Lead in this process with the fake claude.
function lead(
  t,
  {
    accounts = ["acct1", "acct2"],
    policy = {},
    runs,
    args = [],
    readings = {},
    countdown = 0.3,
    method = "kill",
  },
) {
  const { home, root, paths } = tempHome(t);
  const dir = join(root, "fake");
  mkdirSync(dir, { recursive: true });
  write(join(dir, "scenario.json"), { session: SID, runs });
  write(paths.config, {
    version: 1,
    accounts: accounts.map((a) =>
      typeof a === "string" ? { name: a, mark: "normal" } : a,
    ),
    policy: { minStayMinutes: 0, ...policy },
  });
  const now = Date.now();
  for (const [name, r] of Object.entries(readings))
    writeReading(paths, name, r, now);
  const input = keyInput();
  const output = new Collect();
  const signals = new EventEmitter();
  const instance = new Lead({
    poll: false,
    args,
    paths,
    env: testEnv(home, { FAKE_CLAUDE_DIR: dir }),
    cwd: root,
    claude: {
      command: process.execPath,
      prefix: [FAKE_CLAUDE],
      path: FAKE_CLAUDE,
    },
    end: (child) => endClaude(child, { method }),
    input,
    output,
    signals,
    pollMs: 40,
    tickMs: 40,
    countdownSeconds: countdown,
    settleMs: 50,
    stdio: "ignore",
  });
  const done = instance.run();
  return {
    lead: instance,
    done,
    dir,
    home,
    paths,
    input,
    output,
    signals,
    invocations: () => readJsonLines(join(dir, "invocations.jsonl")),
    steps: () => readJsonLines(join(dir, "steps.jsonl")),
    hops: () =>
      readJsonLines(historyFile(paths, "events", Date.now())).filter(
        (e) => e.type === "hop",
      ),
  };
}

// five / week: [used, resetsIn seconds]
function writeReading(paths, name, { five, week }, now = Date.now()) {
  const w = (v) =>
    v
      ? {
          used: v[0],
          resetsAt: new Date(now + v[1] * 1000).toISOString(),
          readAt: new Date(now).toISOString(),
        }
      : null;
  write(join(paths.usage, `${name}.json`), {
    account: name,
    at: new Date(now).toISOString(),
    five_hour: w(five),
    seven_day: w(week),
  });
}

const limited = (resetsIn = 2 * H) => [
  { hook: "session-start" },
  { statusline: { five_hour: [100, resetsIn], seven_day: [40, 72 * H] } },
  { hook: "prompt", permission_mode: "default" },
  {
    hook: "stop-failure",
    error: "rate_limit",
    last_assistant_message: "API Error: Rate limit reached",
  },
];
const promptOf = (inv) => inv.argv.at(-1);

test(
  "automatic hop: a refusal ends claude at the turn end and resumes the conversation on the next account",
  { timeout: 60000 },
  async (t) => {
    const run = lead(t, {
      args: [
        "--model",
        "opus",
        "--add-dir",
        "extra",
        "--permission-mode",
        "acceptEdits",
        "first prompt",
      ],
      runs: [
        { steps: [...limited(), { wait: "end" }] },
        { steps: [{ hook: "session-start" }, { exit: 0 }] },
      ],
    });
    assert.equal(await run.done, 0);
    const [first, second] = run.invocations();
    assert.equal(
      first.configDir,
      profileDir(run.paths, "acct1"),
      "every account runs under its own profile",
    );
    assert.deepEqual(first.argv, [
      "--model",
      "opus",
      "--add-dir",
      "extra",
      "--permission-mode",
      "acceptEdits",
      "first prompt",
    ]);
    assert.equal(second.configDir, profileDir(run.paths, "acct2"));
    assert.equal(second.wrapper, first.wrapper);
    // Resume keeps the options, takes the live model and permission mode, drops the first prompt.
    assert.deepEqual(second.argv.slice(0, -1), [
      "--model",
      "claude-opus-5-5",
      "--add-dir",
      "extra",
      "--permission-mode",
      "manual",
      "--resume",
      SID,
    ]);
    assert.match(
      promptOf(second),
      /moved from account acct1 to account acct2 because acct1 reached its 5-hour limit/,
    );
    assert.match(promptOf(second), /resumeFromRunId/);
    assert.match(run.output.text, /moving this conversation to acct2 in 1 s/);
    assert.deepEqual(
      run.hops().map((h) => [h.from, h.to, h.reason]),
      [["acct1", "acct2", "refusal"]],
    );
  },
);

test(
  "stay: a key during the countdown keeps the conversation on its account and lets Claude Code wait",
  { timeout: 60000 },
  async (t) => {
    const run = lead(t, {
      countdown: 8,
      runs: [
        { steps: [...limited(), { wait: "end" }] },
        {
          steps: [
            { hook: "session-start" },
            { hook: "prompt" },
            { hook: "stop-failure", error: "rate_limit" },
            { sleep: 300 },
            { exit: 0 },
          ],
        },
      ],
    });
    await until(() => run.output.text.includes("moving this conversation"));
    await new Promise((r) => setTimeout(r, 650)); // past the grace period
    run.input.write("x");
    assert.equal(await run.done, 0);
    const invocations = run.invocations();
    assert.equal(invocations.length, 2);
    assert.equal(
      invocations[1].configDir,
      profileDir(run.paths, "acct1"),
      "stayed on acct1",
    );
    assert.match(promptOf(invocations[1]), /chose to stay on it/);
    assert.match(run.output.text, /staying on acct1/);
    assert.deepEqual(run.hops(), []);
  },
);

test(
  "Enter during the countdown hops at once; Ctrl+C quits with the resume command",
  { timeout: 60000 },
  async (t) => {
    const go = lead(t, {
      countdown: 30,
      runs: [
        { steps: [...limited(), { wait: "end" }] },
        { steps: [{ exit: 0 }] },
      ],
    });
    await until(() => go.output.text.includes("moving this conversation"));
    await new Promise((r) => setTimeout(r, 650));
    go.input.write("\r");
    assert.equal(await go.done, 0);
    assert.equal(go.invocations()[1].configDir, profileDir(go.paths, "acct2"));
    const quit = lead(t, {
      countdown: 30,
      runs: [{ steps: [...limited(), { wait: "end" }] }],
    });
    await until(() => quit.output.text.includes("moving this conversation"));
    await new Promise((r) => setTimeout(r, 650));
    quit.input.write("\x03");
    assert.equal(await quit.done, 130);
    assert.match(quit.output.text, new RegExp(`baton --resume ${SID}`));
    assert.equal(quit.invocations().length, 1);
  },
);

test(
  "no other account available: claude keeps running and Claude Code's own wait applies",
  { timeout: 60000 },
  async (t) => {
    const run = lead(t, {
      readings: { acct2: { five: [100, 3 * H], week: [10, 72 * H] } },
      runs: [{ steps: [...limited(1 * H), { sleep: 700 }, { exit: 0 }] }],
    });
    assert.equal(await run.done, 0);
    assert.equal(run.invocations().length, 1);
    const decision = run.lead.events.find(
      (e) => e.message === "turn end",
    ).decision;
    assert.deepEqual(
      [decision.type, decision.reason],
      ["wait-in-place", "all-blocked-current-first"],
    );
  },
);

test(
  "normal exit: baton exits with claude's code",
  { timeout: 60000 },
  async (t) => {
    const run = lead(t, {
      runs: [
        {
          steps: [
            { hook: "session-start" },
            { hook: "prompt" },
            { hook: "stop" },
            { exit: 7 },
          ],
        },
      ],
    });
    assert.equal(await run.done, 7);
    assert.equal(run.invocations().length, 1);
  },
);

test(
  "manual hop with /hop: the request waits for the end of the turn",
  { timeout: 60000 },
  async (t) => {
    const run = lead(t, {
      runs: [
        {
          steps: [
            { hook: "session-start" },
            { hook: "prompt", prompt: "/hop" },
            { hop: "" },
            { sleep: 300 },
            { hook: "stop" },
            { wait: "end" },
          ],
        },
        { steps: [{ hook: "session-start" }, { exit: 0 }] },
      ],
    });
    assert.equal(await run.done, 0);
    const hop = run.steps().find((s) => s.kind === "hop");
    assert.equal(hop.code, 0);
    assert.match(hop.stdout, /moves from acct1 to acct2 when this turn ends/);
    // The request came in during the turn; the hop was decided on its Stop.
    const decided = run.lead.events.find((e) => e.message === "turn end");
    assert.deepEqual(
      [decided.event, decided.decision.reason],
      ["stop", "manual"],
    );
    assert.equal(
      run.lead.events.filter((e) => e.message === "turn end").length,
      1,
    );
    assert.match(promptOf(run.invocations()[1]), /the operator asked for it/);
    assert.deepEqual(
      run.hops().map((h) => h.reason),
      ["manual"],
    );
  },
);

test(
  "manual hop from another terminal while the conversation is between turns, to a named account",
  { timeout: 60000 },
  async (t) => {
    const run = lead(t, {
      accounts: ["acct1", "acct2", "acct3"],
      runs: [
        {
          steps: [
            { hook: "session-start" },
            { hook: "prompt" },
            { hook: "stop" },
            { wait: "end" },
          ],
        },
        { steps: [{ exit: 0 }] },
      ],
    });
    await until(() => run.steps().some((s) => s.kind === "waiting"));
    const r = spawnSync(process.execPath, [CLI, "hop", "--to", "acct3"], {
      env: testEnv(run.home),
      encoding: "utf8",
    });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /moves from acct1 to acct3 now/);
    assert.equal(await run.done, 0);
    assert.equal(
      run.invocations()[1].configDir,
      profileDir(run.paths, "acct3"),
    );
    const bad = spawnSync(process.execPath, [CLI, "hop"], {
      env: testEnv(run.home),
      encoding: "utf8",
    });
    assert.equal(bad.status, 1);
    assert.match(
      bad.stdout,
      /only work in sessions started with baton, and none is running/,
    );
  },
);

test(
  "Ctrl+C belongs to claude: baton ignores SIGINT and does not end or signal claude",
  { timeout: 60000 },
  async (t) => {
    const run = lead(t, {
      runs: [
        {
          steps: [
            { hook: "session-start" },
            { waitFile: "release" },
            { exit: 0 },
          ],
        },
      ],
    });
    await until(() => run.steps().some((s) => s.kind === "hook"));
    assert.ok(
      run.signals.listenerCount("SIGINT") > 0,
      "baton handles SIGINT itself",
    );
    run.signals.emit("SIGINT");
    run.signals.emit("SIGINT");
    if (process.platform === "win32") run.signals.emit("SIGBREAK");
    await new Promise((r) => setTimeout(r, 200));
    write(join(run.dir, "release"), "");
    assert.equal(await run.done, 0);
    assert.equal(
      run.lead.events.some((e) => e.message === "ending claude"),
      false,
    );
    assert.ok(
      run.steps().some((s) => s.kind === "exit"),
      "claude ran to its own end",
    );
    assert.equal(
      run.signals.listenerCount("SIGINT"),
      0,
      "handlers removed after",
    );
  },
);

test(
  "Ctrl+C typed on the Windows console reaches claude as a key, not baton",
  { skip: !consoleAvailable() && "needs a Windows console" },
  async (t) => {
    const run = lead(t, {
      runs: [
        {
          steps: [
            { hook: "session-start" },
            { keys: true },
            { waitFile: "release" },
            { exit: 0 },
          ],
        },
      ],
    });
    await until(() =>
      run
        .steps()
        .some((s) => s.kind === "keys-ready" || s.kind === "keys-unavailable"),
    );
    if (run.steps().some((s) => s.kind === "keys-unavailable")) {
      write(join(run.dir, "release"), "");
      await run.done;
      t.skip("the console cannot be read here");
      return;
    }
    assert.equal(await typeConsoleKeys(process.pid, [3]), "ok");
    await until(() => run.steps().some((s) => s.kind === "ctrl-c"));
    write(join(run.dir, "release"), "");
    assert.equal(await run.done, 0);
    assert.equal(
      run.lead.events.some((e) => e.message === "ending claude"),
      false,
    );
  },
);

test(
  "on Windows claude is ended by typing two Ctrl+C into the console, then resumed",
  { skip: !consoleAvailable() && "needs a Windows console" },
  async (t) => {
    const run = lead(t, {
      method: "keys",
      runs: [
        {
          steps: [
            { hook: "session-start" },
            { keys: true },
            ...limited().slice(1),
            { wait: "end" },
          ],
        },
        { steps: [{ exit: 0 }] },
      ],
    });
    const code = await run.done;
    const ended = run
      .steps()
      .find((s) => s.kind === "ended" || s.kind === "keys-unavailable");
    if (ended?.kind === "keys-unavailable") {
      t.skip("the console cannot be read here");
      return;
    }
    assert.equal(code, 0);
    assert.equal(ended.how, "keys");
    const result = run.lead.events.find(
      (e) => e.message === "claude ended",
    ).result;
    assert.deepEqual(
      [result.method, result.forced, result.rounds],
      ["keys", false, 1],
    );
    assert.equal(run.invocations().length, 2);
  },
);

test(
  "planned hop: when the next turn would not fit, the conversation moves between turns",
  { timeout: 60000 },
  async (t) => {
    // Over a second per turn: the fake's resets_at (now + 3 h, in whole
    // seconds) moves between readings, as a real one can; the turns still
    // belong to one window period. (This was the flake: with exact
    // comparison a slow run measured no cost and never hopped.)
    const turn = (used) => [
      { statusline: { five_hour: [used, 3 * H], seven_day: [10, 72 * H] } },
      { hook: "prompt" },
      { hook: "stop" },
      { sleep: 1100 },
    ];
    const run = lead(t, {
      runs: [
        {
          steps: [
            { hook: "session-start" },
            ...turn(50),
            ...turn(62),
            ...turn(76),
            { wait: "end" },
          ],
        },
        { steps: [{ exit: 0 }] },
      ],
    });
    assert.equal(await run.done, 0);
    const decisions = run.lead.events
      .filter((e) => e.message === "turn end")
      .map((e) => e.decision.reason);
    // 50: no cost yet; 62: cost 12, headroom 28 >= 18; 76: cost 13, headroom 14 < 19.5
    assert.deepEqual(decisions, ["stay", "stay", "planned"]);
    assert.match(
      promptOf(run.invocations()[1]),
      /was about to reach its 5-hour limit/,
    );
    assert.deepEqual(
      run.hops().map((h) => h.reason),
      ["planned"],
    );
  },
);

test(
  "planned hop: suppressed while subagents run; only a refusal moves the session then",
  { timeout: 60000 },
  async (t) => {
    const turn = (used, tasks = []) => [
      { statusline: { five_hour: [used, 3 * H], seven_day: [10, 72 * H] } },
      { hook: "prompt" },
      { hook: "stop", background_tasks: tasks },
      { sleep: 250 },
    ];
    const busy = [
      { id: "a1", type: "subagent", status: "running", agent_type: "Explore" },
    ];
    const run = lead(t, {
      runs: [
        {
          steps: [
            { hook: "session-start" },
            ...turn(50),
            ...turn(62),
            ...turn(76, busy),
            { sleep: 400 },
            { exit: 0 },
          ],
        },
      ],
    });
    assert.equal(await run.done, 0);
    const decisions = run.lead.events
      .filter((e) => e.message === "turn end")
      .map((e) => e.decision.reason);
    assert.deepEqual(decisions, ["stay", "stay", "busy"]);
    assert.equal(run.invocations().length, 1);
  },
);

test(
  "all blocked: claude closes, Baton counts down to the first account back and resumes there",
  { timeout: 60000 },
  async (t) => {
    const run = lead(t, {
      readings: { acct2: { five: [100, 6], week: [10, 72 * H] } },
      runs: [
        { steps: [...limited(2 * H), { wait: "end" }] },
        { steps: [{ hook: "session-start" }, { exit: 0 }] },
      ],
    });
    await until(() => run.output.text.includes("first back"));
    assert.match(
      run.output.text,
      /all 2 accounts at limit; acct2 is first back, its 5-hour window resets at/,
    );
    assert.equal(await run.done, 0);
    const second = run.invocations()[1];
    assert.equal(second.configDir, profileDir(run.paths, "acct2"));
    assert.match(
      promptOf(second),
      /every account was at its limit; Baton waited/,
    );
    assert.deepEqual(
      run.hops().map((h) => h.reason),
      ["all-blocked-wait"],
    );
  },
);

test(
  "all blocked: a reading that changes during the wait (an earlier reset) resumes at once",
  { timeout: 60000 },
  async (t) => {
    const run = lead(t, {
      accounts: ["acct1", "acct2", "acct3"],
      readings: {
        acct2: { five: [100, 600], week: [10, 72 * H] },
        acct3: { five: [100, 900], week: [10, 72 * H] },
      },
      runs: [
        { steps: [...limited(2 * H), { wait: "end" }] },
        { steps: [{ exit: 0 }] },
      ],
    });
    await until(() => run.output.text.includes("first back"));
    assert.match(run.output.text, /acct2 is first back/);
    // acct3 reports a fresh window (another session's status line).
    writeReading(run.paths, "acct3", { five: [3, 5 * H], week: [10, 72 * H] });
    const started = Date.now();
    assert.equal(await run.done, 0);
    assert.ok(Date.now() - started < 5000);
    assert.equal(
      run.invocations()[1].configDir,
      profileDir(run.paths, "acct3"),
    );
  },
);

test(
  "re-block after resuming: a new refusal re-picks; repeated ones back off with a clear message",
  { timeout: 60000 },
  async (t) => {
    const run = lead(t, {
      readings: { acct2: { five: [100, 5], week: [10, 72 * H] } },
      policy: {
        maxReblocks: 1,
        reblockBackoffMinutes: 0.03,
        waitInPlaceMinutes: 0,
      },
      runs: [
        // acct1 is refused; its 5-hour window resets in 9 s, acct2's in 5 s
        // (seconds of margin: the decision must come before either reset,
        // also on a loaded machine)
        { steps: [...limited(9), { wait: "end" }] },
        // on acct2: refused again right away (its reset did not happen after all)
        {
          steps: [
            { hook: "session-start" },
            {
              statusline: { five_hour: [100, 2 * H], seven_day: [10, 72 * H] },
            },
            { hook: "prompt" },
            { hook: "stop-failure", error: "rate_limit" },
            { wait: "end" },
          ],
        },
        { steps: [{ hook: "session-start" }, { exit: 0 }] },
      ],
    });
    assert.equal(await run.done, 0);
    const invocations = run.invocations();
    assert.deepEqual(
      invocations.map((i) => i.configDir),
      [
        profileDir(run.paths, "acct1"),
        profileDir(run.paths, "acct2"),
        profileDir(run.paths, "acct1"),
      ],
    );
    const decisions = run.lead.events
      .filter((e) => e.message === "turn end")
      .map((e) => e.decision.reason);
    assert.deepEqual(decisions, ["all-blocked-wait", "reblocked"]);
    assert.match(run.output.text, /refused again right after resuming/);
    assert.deepEqual(
      run.hops().map((h) => [h.to, h.reason]),
      [
        ["acct2", "all-blocked-wait"],
        ["acct1", "reblocked"],
      ],
    );
  },
);

test(
  "a conversation already running under another baton is refused",
  { timeout: 60000 },
  async (t) => {
    const first = lead(t, {
      args: ["--resume", SID],
      runs: [
        {
          steps: [
            { hook: "session-start" },
            { waitFile: "release" },
            { exit: 0 },
          ],
        },
      ],
    });
    await until(() => first.steps().some((s) => s.kind === "hook"));
    const output = new Collect();
    const second = new Lead({
      poll: false,
      args: ["--resume", SID],
      paths: first.paths,
      env: testEnv(first.home, { FAKE_CLAUDE_DIR: first.dir }),
      claude: {
        command: process.execPath,
        prefix: [FAKE_CLAUDE],
        path: FAKE_CLAUDE,
      },
      output,
      signals: new EventEmitter(),
      stdio: "ignore",
    });
    assert.equal(await second.run(), 1);
    assert.match(output.text, /already running under baton/);
    write(join(first.dir, "release"), "");
    assert.equal(await first.done, 0);
  },
);

test(
  "passthrough commands run under the picked account without the session machinery",
  { timeout: 60000 },
  async (t) => {
    const run = lead(t, {
      readings: { acct1: { five: [95, H], week: [10, 72 * H] } },
      args: ["-p", "hello"],
      runs: [{ steps: [{ exit: 3 }] }],
    });
    assert.equal(await run.done, 3);
    assert.equal(
      run.invocations()[0].configDir,
      profileDir(run.paths, "acct2"),
      "acct1 is blocked: acct2",
    );
  },
);
