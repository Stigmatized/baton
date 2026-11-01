import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { readJson, readJsonLines } from "../src/fsutil.js";
import {
  appendUsage,
  handleHook,
  handleStatusLine,
  overallUsage,
  ownStatusLine,
} from "../src/hooks.js";
import { loadConfig } from "../src/config.js";
import { makeTerminal } from "../src/term.js";
import { accountFromEnv, forward, profileDir } from "../src/paths.js";
import {
  readSessionFile,
  readTurnSamples,
  wrapperSessionFile,
} from "../src/sessions.js";
import { loadRejections, readReading } from "../src/usage.js";
import { CLI, accountsHome, testEnv, write } from "./helpers.js";

const SID = "6f0b2d4e-1c3a-4b5d-8e9f-0a1b2c3d4e5f";
const env2 = (paths, extra = {}) => ({
  CLAUDE_CONFIG_DIR: profileDir(paths, "acct2"),
  ...extra,
});
// For a status line as plain text, with the rich glyphs.
const plainEnv = (paths, extra = {}) =>
  env2(paths, { NO_COLOR: "1", BATON_GLYPHS: "rich", ...extra });

function allFiles(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { recursive: true }).map(String);
}

test("the account comes from CLAUDE_CONFIG_DIR: a Baton profile is its id; plain claude and any other folder are none", (t) => {
  const { paths } = accountsHome(t);
  assert.equal(accountFromEnv({}, paths), null);
  assert.equal(
    accountFromEnv({ CLAUDE_CONFIG_DIR: paths.claudeDir }, paths),
    null,
  );
  assert.equal(
    accountFromEnv({ CLAUDE_CONFIG_DIR: profileDir(paths, "acct2") }, paths),
    "acct2",
  );
  assert.equal(
    accountFromEnv(
      { CLAUDE_CONFIG_DIR: forward(profileDir(paths, "acct2")) + "/" },
      paths,
    ),
    "acct2",
  );
  assert.equal(
    accountFromEnv({ CLAUDE_CONFIG_DIR: join(paths.home, "elsewhere") }, paths),
    null,
  );
  // "default" is an ordinary id now: an account the operator named so.
  assert.equal(
    accountFromEnv(
      { CLAUDE_CONFIG_DIR: join(paths.accounts, "default") },
      paths,
    ),
    "default",
  );
});

test("session start, prompt, stop and session end are recorded for the session and its wrapper", (t) => {
  const { paths } = accountsHome(t);
  const env = env2(paths, { BATON_WRAPPER: "123-abcd" });
  handleHook(
    "session-start",
    {
      session_id: SID,
      source: "startup",
      cwd: "E:/w",
      transcript_path: "E:/t.jsonl",
      model: "m",
    },
    { env, paths },
  );
  const start = readSessionFile(paths, SID, "start.json");
  assert.deepEqual(
    [start.account, start.source, start.cwd, start.wrapper],
    ["acct2", "startup", "E:/w", "123-abcd"],
  );
  assert.equal(readJson(wrapperSessionFile(paths, "123-abcd")).session, SID);
  handleHook(
    "prompt",
    { session_id: SID, permission_mode: "acceptEdits", prompt: "hi" },
    { env, paths },
  );
  assert.deepEqual(
    (({ state, event, permissionMode }) => ({ state, event, permissionMode }))(
      readSessionFile(paths, SID, "turn.json"),
    ),
    { state: "running", event: "prompt", permissionMode: "acceptEdits" },
  );
  // The status line's reading becomes the turn-end sample.
  handleStatusLine(
    {
      session_id: SID,
      rate_limits: {
        five_hour: { used_percentage: 40, resets_at: 1792920000 },
      },
    },
    { env, paths },
  );
  handleHook(
    "stop",
    {
      session_id: SID,
      permission_mode: "acceptEdits",
      background_tasks: [
        { id: "1", type: "subagent", status: "running", agent_type: "Explore" },
      ],
    },
    { env, paths },
  );
  const turn = readSessionFile(paths, SID, "turn.json");
  assert.equal(turn.state, "idle");
  assert.deepEqual(turn.backgroundTasks, [
    { type: "subagent", status: "running", name: "Explore" },
  ]);
  assert.equal(readTurnSamples(paths, SID)[0].five_hour.used, 40);
  handleHook(
    "session-start",
    { session_id: SID, source: "compact" },
    { env, paths },
  );
  assert.ok(readSessionFile(paths, SID, "compact.json"));
  handleHook(
    "session-end",
    { session_id: SID, reason: "prompt_input_exit" },
    { env, paths },
  );
  assert.equal(
    readSessionFile(paths, SID, "end.json").reason,
    "prompt_input_exit",
  );
  assert.deepEqual(
    allFiles(paths.root).filter((f) => f.endsWith(".tmp")),
    [],
  );
});

test("a usage refusal records the account as rejected for its window, with the session", (t) => {
  const { paths } = accountsHome(t);
  const env = env2(paths);
  const resets = Math.floor(Date.now() / 1000) + 3600;
  handleStatusLine(
    {
      session_id: SID,
      rate_limits: {
        five_hour: { used_percentage: 100, resets_at: resets },
        seven_day: { used_percentage: 50, resets_at: resets + 86400 },
      },
    },
    { env, paths },
  );
  handleHook(
    "stop-failure",
    {
      session_id: SID,
      error: "rate_limit",
      error_details: "429 Too Many Requests",
      last_assistant_message: "API Error: Rate limit reached",
    },
    { env, paths },
  );
  const r = loadRejections(paths, ["acct2"]).acct2.five_hour;
  assert.deepEqual(
    [r.session, r.error, r.until, r.untilSource],
    [SID, "rate_limit", new Date(resets * 1000).toISOString(), "reading"],
  );
  const turn = readSessionFile(paths, SID, "turn.json");
  assert.deepEqual(
    [turn.event, turn.error, turn.window],
    ["stop-failure", "rate_limit", "five_hour"],
  );
  // Another API error ends the turn but is no refusal.
  handleHook(
    "stop-failure",
    { session_id: SID, error: "server_error" },
    { env, paths },
  );
  assert.equal(readSessionFile(paths, SID, "turn.json").error, "server_error");
  assert.equal(Object.keys(loadRejections(paths, ["acct2"]).acct2).length, 1);
});

test("bad input never throws and writes nothing", (t) => {
  const { paths } = accountsHome(t);
  const env = env2(paths);
  for (const input of [
    null,
    undefined,
    7,
    "x",
    [],
    {},
    { session_id: "../../evil" },
    { session_id: "" },
    { session_id: SID, error: { nested: true }, error_details: { a: 1 } },
  ])
    for (const event of [
      "session-start",
      "prompt",
      "stop",
      "stop-failure",
      "session-end",
      "unknown-event",
    ])
      assert.doesNotThrow(() => handleHook(event, input, { env, paths }));
  assert.doesNotThrow(() => handleStatusLine(null, { env, paths }));
  assert.doesNotThrow(() =>
    handleStatusLine({ session_id: 5, rate_limits: "x" }, { env, paths }),
  );
  assert.ok(!existsSync(join(paths.root, "..", "..", "evil")));
  assert.deepEqual(
    allFiles(paths.sessions).filter((f) => !f.startsWith(SID)),
    [],
  );
  const foreign = { CLAUDE_CONFIG_DIR: join(paths.home, "not-baton") };
  handleHook(
    "prompt",
    { session_id: "7a0b2d4e-1c3a-4b5d-8e9f-0a1b2c3d4e5f" },
    { env: foreign, paths },
  );
  assert.ok(
    !existsSync(join(paths.sessions, "7a0b2d4e-1c3a-4b5d-8e9f-0a1b2c3d4e5f")),
  );
});

test("hooks are fast", (t) => {
  const { paths } = accountsHome(t);
  const env = env2(paths);
  const started = performance.now();
  for (let i = 0; i < 20; i++) {
    handleHook(
      "prompt",
      { session_id: SID, permission_mode: "default" },
      { env, paths },
    );
    handleHook("stop", { session_id: SID }, { env, paths });
  }
  const each = (performance.now() - started) / 40;
  t.diagnostic(`in-process handler: ${each.toFixed(2)} ms per event`);
  assert.ok(each < 25, `${each} ms`);
  const runs = [];
  for (let i = 0; i < 3; i++) {
    const t0 = performance.now();
    const r = spawnSync(process.execPath, [CLI, "hook", "stop"], {
      input: JSON.stringify({ session_id: SID }),
      env: testEnv(paths.home, env),
      encoding: "utf8",
    });
    runs.push(performance.now() - t0);
    assert.equal(r.status, 0);
    assert.equal(r.stdout, "", "a hook prints nothing");
  }
  const best = Math.min(...runs);
  t.diagnostic(
    `baton hook stop as a process: ${runs.map((r) => r.toFixed(0)).join(", ")} ms`,
  );
  assert.ok(best < 1500, `${best} ms`);
});

test("the hook command exits 0 silently on garbage", (t) => {
  const { paths } = accountsHome(t);
  for (const input of ["", "{", "null", "[1,2]", '{"session_id": 3}']) {
    const r = spawnSync(process.execPath, [CLI, "hook", "stop-failure"], {
      input,
      env: testEnv(paths.home),
      encoding: "utf8",
    });
    assert.equal(r.status, 0);
    assert.equal(r.stdout + r.stderr, "");
  }
});

test("the status line records the reading and prints Baton's own line when there was none", (t) => {
  const { paths } = accountsHome(t);
  const env = plainEnv(paths, { BATON_WRAPPER: "9-ffff" });
  const now = Date.now();
  const resets = Math.floor(now / 1000) + 3600;
  const out = handleStatusLine(
    {
      session_id: SID,
      model: { id: "claude-opus-5-5" },
      effort: { level: "high" },
      workspace: { current_dir: "E:/w" },
      rate_limits: {
        five_hour: { used_percentage: 42.4, resets_at: resets },
        seven_day: { used_percentage: 63, resets_at: resets + 86400 },
      },
    },
    { env, paths, now },
  );
  // The baton mark, the account, its windows; the other accounts have no
  // reading yet, so there is nothing to add for them.
  assert.equal(
    out.text,
    "\u257a\u2501\u2578 acct2 \u00b7 5h 42% \u00b7 week 63%",
  );
  assert.equal(readReading(paths, "acct2").five_hour.used, 42.4);
  const live = readSessionFile(paths, SID, "live.json");
  assert.deepEqual(
    [live.model, live.effort, live.cwd],
    ["claude-opus-5-5", "high", "E:/w"],
  );
  assert.equal(readJson(wrapperSessionFile(paths, "9-ffff")).session, SID);
  assert.equal(
    readJsonLines(join(paths.history, readdirSync(paths.history)[0])).length,
    2,
  );
  assert.equal(
    ownStatusLine(
      "a",
      { five_hour: { used: 99, resetsAt: new Date(now - 1).toISOString() } },
      now,
    ),
    "\u257a\u2501\u2578 a \u00b7 5h reset",
  );
  assert.equal(ownStatusLine(null, null, now), "");
});

// A reading for an account: used % in each window, resetting in an hour and
// in three days.
const readingOf = (now, five, week) => ({
  five_hour: {
    used: five,
    resetsAt: new Date(now + 3600e3).toISOString(),
    readAt: new Date(now - 60e3).toISOString(),
  },
  seven_day: {
    used: week,
    resetsAt: new Date(now + 3 * 864e5).toISOString(),
    readAt: new Date(now - 60e3).toISOString(),
  },
});

test("the status line draws all the accounts: a bar each and the mean 5-hour and weekly use of those with a reading, this account's from the live reading", (t) => {
  const { paths } = accountsHome(t); // acct1..acct4, this one is acct2
  const now = Date.now();
  write(join(paths.usage, "acct1.json"), readingOf(now, 20, 40));
  write(join(paths.usage, "acct3.json"), readingOf(now, 60, 80));
  // acct4 was never measured: left out of the mean, not counted as empty.
  // acct2's stored reading is old; the live one passed in is what counts.
  write(join(paths.usage, "acct2.json"), readingOf(now, 5, 5));
  const config = loadConfig(paths);
  const live = readingOf(now, 42, 63);
  const all = overallUsage(paths, config, "acct2", live, now);
  assert.equal(all.count, 4);
  assert.deepEqual(all.cells.five_hour, [
    { used: 20, limit: 90, current: false },
    { used: 42, limit: 90, current: true },
    { used: 60, limit: 90, current: false },
    { used: null, limit: 90, current: false },
  ]);
  assert.deepEqual(
    all.cells.seven_day.map((c) => c.used),
    [40, 63, 80, null],
  );
  assert.equal(Math.round(all.five_hour), 41); // (20 + 42 + 60) / 3
  assert.equal(all.seven_day, 61); // (40 + 63 + 80) / 3
  // A window past its reset is empty again.
  write(join(paths.usage, "acct3.json"), {
    ...readingOf(now, 60, 80),
    five_hour: {
      used: 60,
      resetsAt: new Date(now - 1).toISOString(),
      readAt: new Date(now - 3600e3).toISOString(),
    },
  });
  const after = overallUsage(paths, config, "acct2", live, now);
  assert.equal(Math.round(after.five_hour), 21); // (20 + 42 + 0) / 3
  assert.equal(after.seven_day, 61);
  // The live reading moves the figure at once; the others' stored ones do not.
  const busier = overallUsage(
    paths,
    config,
    "acct2",
    readingOf(now, 90, 63),
    now,
  );
  assert.equal(Math.round(busier.five_hour), 37); // (20 + 90 + 0) / 3

  const input = {
    session_id: SID,
    rate_limits: {
      five_hour: {
        used_percentage: 42,
        resets_at: Math.floor(now / 1000) + 3600,
      },
      seven_day: {
        used_percentage: 63,
        resets_at: Math.floor(now / 1000) + 86400,
      },
    },
  };
  const line = (extra = {}) =>
    handleStatusLine(input, { env: plainEnv(paths, extra), paths, now }).text;
  // One bar per account, as tall as its use (acct1 20%, acct2 the live 42%,
  // acct3 reset, acct4 never measured: a dot), then the mean.
  assert.equal(
    line(),
    "\u257a\u2501\u2578 acct2 \u00b7 5h 42% \u00b7 week 63% \u2503 5h \u2582\u2584\u2581\u00b7 21% \u00b7 week \u2584\u2585\u2587\u00b7 61%",
  );
  // The classic console's glyphs; a narrow terminal drops the overall part
  // first, then the windows.
  assert.equal(
    line({ BATON_GLYPHS: "plain" }),
    "=#= acct2 \u00b7 5h 42% \u00b7 week 63% | 5h .-_. 21% \u00b7 week -=*. 61%",
  );
  assert.equal(
    line({ COLUMNS: "40" }),
    "\u257a\u2501\u2578 acct2 \u00b7 5h 42% \u00b7 week 63%",
  );
  assert.equal(line({ COLUMNS: "12" }), "\u257a\u2501\u2578 acct2");
});

test("the overall bars: one account is one bar; with no one to compare with, or no reading among them, nothing is added", (t) => {
  const { paths } = accountsHome(t, ["a", "b"]);
  const now = Date.now();
  const reading = {
    five_hour: { used: 30, resetsAt: new Date(now + 3600e3).toISOString() },
  };
  assert.equal(
    ownStatusLine("a", reading, now, {
      overall: {
        count: 2,
        five_hour: 43,
        seven_day: null,
        cells: {
          five_hour: [
            { used: 30, limit: 90, current: true },
            { used: 55, limit: 90, current: false },
          ],
          seven_day: [
            { used: null, limit: 95, current: true },
            { used: null, limit: 95, current: false },
          ],
        },
      },
    }),
    "\u257a\u2501\u2578 a \u00b7 5h 30% \u2503 5h \u2583\u2585 43%",
  );
  // Without the per-account cells, the mean alone.
  assert.equal(
    ownStatusLine("a", reading, now, {
      overall: { count: 2, five_hour: 43, seven_day: null },
    }),
    "\u257a\u2501\u2578 a \u00b7 5h 30% \u2503 5h 43%",
  );
  // Nothing to compare with: one account, or no reading at all.
  for (const overall of [
    { count: 1, five_hour: 30, seven_day: null },
    { count: 2, five_hour: null, seven_day: null },
  ])
    assert.equal(
      ownStatusLine("a", reading, now, { overall }),
      "\u257a\u2501\u2578 a \u00b7 5h 30%",
    );
  write(join(paths.usage, "b.json"), {});
  assert.equal(
    overallUsage(paths, loadConfig(paths), "a", null, now).five_hour,
    null,
  );
});

test("this account's bar is underlined, the others' are not", () => {
  const now = Date.now();
  const reading = {
    five_hour: { used: 30, resetsAt: new Date(now + 3600e3).toISOString() },
  };
  const out = ownStatusLine("a", reading, now, {
    term: makeTerminal({ tty: false, depth: 24, glyphs: "rich", cols: 0 }),
    overall: {
      count: 2,
      five_hour: 43,
      seven_day: null,
      cells: {
        five_hour: [
          { used: 30, limit: 90, current: true },
          { used: 55, limit: 90, current: false },
        ],
      },
    },
  });
  // Underline (4) on the first bar only.
  assert.match(out, /\x1b\[4;[0-9;]+m\u2583/);
  assert.doesNotMatch(out, /\x1b\[4;[0-9;]+m\u2585/);
  assert.match(out, /\x1b\[[0-9;]+m\u2585/);
});

test("the status line is coloured like the menu where the terminal can show it, plain where not", () => {
  const now = Date.now();
  const reading = {
    five_hour: { used: 95, resetsAt: new Date(now + 3600e3).toISOString() },
  };
  const term = (depth) =>
    makeTerminal({ tty: false, depth, glyphs: "rich", cols: 0 });
  const true24 = ownStatusLine("a", reading, now, { term: term(24) });
  // The mark in the brand colour (#e4bc89), a use past its threshold in red.
  assert.match(true24, /\x1b\[1;38;2;228;188;137m\u257a\u2501\u2578/);
  assert.match(true24, /\x1b\[38;2;207;139;130m95%/);
  assert.equal(
    true24.replace(/\x1b\[[0-9;]*m/g, ""),
    "\u257a\u2501\u2578 a \u00b7 5h 95%",
  );
  assert.doesNotMatch(
    ownStatusLine("a", reading, now, { term: term(1) }),
    /\x1b/,
  );
});

test("the status line runs the operator's previous command with the same input", (t) => {
  const { paths, root } = accountsHome(t);
  const script = join(root, "mine.mjs");
  write(
    script,
    'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{process.stdout.write("mine:"+JSON.parse(s).session_id+":"+(process.env.CLAUDE_CONFIG_DIR?"profile":"default"))});',
  );
  write(paths.install, {
    previousStatusLine: {
      type: "command",
      command: `node "${forward(script)}"`,
    },
  });
  const input = JSON.stringify({
    session_id: SID,
    rate_limits: { five_hour: { used_percentage: 10, resets_at: 1792920000 } },
  });
  const r = spawnSync(process.execPath, [CLI, "statusline"], {
    input,
    env: testEnv(paths.home, env2(paths)),
    encoding: "utf8",
  });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, `mine:${SID}:profile`);
  assert.equal(
    readReading(paths, "acct2").five_hour.used,
    10,
    "recorded before passing on",
  );
});

test("appendUsage adds Baton's line after the operator's, on its last line, as far as the width allows", () => {
  const ours = (room) => (room === 0 || room >= 4 ? "OURS" : "");
  assert.equal(appendUsage("theirs\n", ours), "theirs  OURS\n");
  assert.equal(appendUsage("theirs", ours), "theirs  OURS", "no newline added");
  assert.equal(
    appendUsage("line one\nline two\n", ours),
    "line one\nline two  OURS\n",
    "on the last line",
  );
  // Their colour is closed before ours; widths count what is seen.
  const styled = () => "\x1b[1mOURS\x1b[0m";
  assert.equal(
    appendUsage("\x1b[36mtheirs", styled),
    "\x1b[36mtheirs\x1b[0m  \x1b[1mOURS\x1b[0m",
  );
  assert.equal(
    appendUsage("\x1b[36mabcdefgh\x1b[0m", ours, 20).includes("OURS"),
    true,
  );
  // Their line alone when theirs printed nothing, or there is no room left.
  assert.equal(appendUsage("", ours), "OURS\n");
  assert.equal(appendUsage("abcdefgh\n", ours, 10), "abcdefgh\n", "no room");
  assert.equal(appendUsage("abcdefgh\n", ours, 12), "abcdefgh\n", "2 left");
  assert.equal(
    appendUsage("abcdefgh\n", () => "WAY TOO WIDE", 20),
    "abcdefgh\n",
    "ours does not fit",
  );
});

test("with the operator's own status line, Baton's usage is added only when the policy says so", (t) => {
  const { paths } = accountsHome(t);
  write(paths.install, {
    previousStatusLine: { type: "command", command: "mine" },
  });
  const now = Date.now();
  const input = {
    session_id: SID,
    rate_limits: {
      five_hour: {
        used_percentage: 42,
        resets_at: Math.floor(now / 1000) + 3600,
      },
    },
  };
  const run = (env = plainEnv(paths)) =>
    handleStatusLine(input, { env, paths, now });
  // Off by default: only their command runs.
  assert.deepEqual(run(), { previous: "mine", usage: null });
  const config = loadConfig(paths);
  write(paths.config, {
    version: 1,
    accounts: config.accounts,
    policy: { statusLineUsage: true },
  });
  const on = run();
  assert.equal(on.previous, "mine");
  assert.equal(on.usage(0), "╺━╸ acct2 · 5h 42%");
  // Plain claude (no Baton profile) never gets it.
  assert.deepEqual(run({ NO_COLOR: "1" }), { previous: "mine" });
});

test("baton statusline prints the operator's line and, with statusLineUsage on, Baton's after it", (t) => {
  const { paths, root } = accountsHome(t);
  const script = join(root, "mine.mjs");
  write(
    script,
    'process.stdin.resume();process.stdin.on("end",()=>process.stdout.write("mine:ok\\n"));',
  );
  const setup = (policy) => {
    write(paths.install, {
      previousStatusLine: {
        type: "command",
        command: `node "${forward(script)}"`,
      },
    });
    write(paths.config, {
      version: 1,
      accounts: loadConfig(paths).accounts,
      policy,
    });
  };
  const input = JSON.stringify({
    session_id: SID,
    rate_limits: {
      five_hour: {
        used_percentage: 10,
        resets_at: Math.floor(Date.now() / 1000) + 3600,
      },
    },
  });
  const run = (extra = {}) =>
    spawnSync(process.execPath, [CLI, "statusline"], {
      input,
      env: testEnv(paths.home, plainEnv(paths, extra)),
      encoding: "utf8",
    });
  setup({});
  assert.equal(run().stdout, "mine:ok\n", "off by default: theirs as it is");
  setup({ statusLineUsage: true });
  assert.equal(run().stdout, "mine:ok  ╺━╸ acct2 · 5h 10%\n");
  // Too narrow for any of it: theirs only.
  assert.equal(run({ COLUMNS: "10" }).stdout, "mine:ok\n");
});

test("baton policy --status-line-usage turns the addition on and off, and it is off by default", (t) => {
  const { paths } = accountsHome(t);
  const policy = (...args) =>
    spawnSync(process.execPath, [CLI, "policy", ...args], {
      env: testEnv(paths.home),
      encoding: "utf8",
    });
  const value = () => JSON.parse(policy("--json").stdout).statusLineUsage;
  assert.equal(value(), false);
  assert.equal(policy("--status-line-usage", "true").status, 0);
  assert.equal(value(), true);
  assert.equal(policy("--status-line-usage", "maybe").status, 2);
  assert.equal(policy("--status-line-usage", "default").status, 0);
  assert.equal(value(), false);
});
