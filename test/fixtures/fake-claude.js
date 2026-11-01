// A stand-in for the `claude` executable in the lead wrapper's tests. It
// logs how it was started, then plays the steps of its run from
// $FAKE_CLAUDE_DIR/scenario.json the way Claude Code would: it runs Baton's
// real hook and status line commands with hook JSON on stdin, under the
// CLAUDE_CONFIG_DIR / BATON_WRAPPER / BATON_HOME it was given.
//
// scenario.json: { "runs": [ { "steps": [ ... ] }, ... ] } (run n is the n-th
// start; the last run repeats). Steps:
//   { "hook": "session-start" | "prompt" | "stop" | "stop-failure" | "session-end", ...fields }
//   { "statusline": { "five_hour": [used, resetsInSeconds], "seven_day": [...] }, "model": "...", "effort": "..." }
//   { "hop": "<account or empty>" }        what /hop runs
//   { "sleep": ms }
//   { "waitFile": "<name in FAKE_CLAUDE_DIR>" }
//   { "exit": code }
//   { "keys": true }                       read the console in raw mode from now on (logs keys-ready)
//   { "wait": "end" }                      run until ended (SIGTERM, a kill, or two Ctrl+C keys)
import { appendFileSync, existsSync, openSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import tty from "node:tty";

const dir = process.env.FAKE_CLAUDE_DIR;
const cli = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "src",
  "cli.js",
);
const argv = process.argv.slice(2);
const log = (kind, data = {}) =>
  appendFileSync(
    join(dir, "steps.jsonl"),
    JSON.stringify({ at: Date.now(), pid: process.pid, kind, ...data }) + "\n",
  );

const invocations = existsSync(join(dir, "invocations.jsonl"))
  ? readFileSync(join(dir, "invocations.jsonl"), "utf8")
      .split("\n")
      .filter(Boolean).length
  : 0;
appendFileSync(
  join(dir, "invocations.jsonl"),
  JSON.stringify({
    argv,
    configDir: process.env.CLAUDE_CONFIG_DIR ?? null,
    wrapper: process.env.BATON_WRAPPER ?? null,
    cwd: process.cwd(),
    pid: process.pid,
  }) + "\n",
);
const scenario = JSON.parse(readFileSync(join(dir, "scenario.json"), "utf8"));
const run = scenario.runs[Math.min(invocations, scenario.runs.length - 1)];
const option = (name) => {
  const i = argv.lastIndexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const session =
  option("--resume") ??
  option("--session-id") ??
  scenario.session ??
  randomUUID();

function baton(args, input) {
  const result = spawnSync(process.execPath, [cli, ...args], {
    input: input === undefined ? "" : JSON.stringify(input),
    encoding: "utf8",
    env: process.env,
  });
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

const base = () => ({
  session_id: session,
  cwd: process.cwd(),
  transcript_path: join(dir, `${session}.jsonl`),
});

let ending = false;
function onEnd(how, code) {
  if (ending) return;
  ending = true;
  log("ended", { how, run: invocations });
  process.exit(code);
}
process.on("SIGTERM", () => onEnd("SIGTERM", 143));
process.on("SIGINT", () => log("sigint", { run: invocations }));

let watching = false;
function watchKeys() {
  if (watching) return;
  watching = true;
  let input = null;
  try {
    input = process.stdin.isTTY
      ? process.stdin
      : new tty.ReadStream(openSync("\\\\.\\CONIN$", "r+"));
    input.setRawMode(true);
  } catch (error) {
    log("keys-unavailable", {
      error: error.code ?? error.message,
      run: invocations,
    });
    return;
  }
  log("keys-ready", { run: invocations });
  process.on("exit", () => {
    try {
      input.setRawMode(false);
    } catch {
      // gone
    }
  });
  let last = 0;
  input.on("data", (chunk) => {
    for (const ch of chunk.toString("latin1")) {
      if (ch !== "\x03") continue;
      const now = Date.now();
      log("ctrl-c", { run: invocations });
      if (now - last < 1500) {
        try {
          input.setRawMode(false);
        } catch {
          // gone
        }
        onEnd("keys", 0);
      }
      last = now;
    }
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

for (const step of run.steps) {
  if (step.hook) {
    const { hook, ...fields } = step;
    const input = { ...base(), hook_event_name: hook, ...fields };
    if (hook === "session-start" && !input.source)
      input.source = argv.includes("--resume") ? "resume" : "startup";
    const r = baton(["hook", hook], input);
    log("hook", { hook, code: r.code, stdout: r.stdout, run: invocations });
  } else if (step.statusline) {
    const now = Math.floor(Date.now() / 1000);
    const limits = {};
    for (const [w, v] of Object.entries(step.statusline))
      limits[w] = {
        used_percentage: v[0],
        resets_at: v[1] == null ? undefined : now + v[1],
      };
    const r = baton(["statusline"], {
      ...base(),
      model: { id: step.model ?? "claude-opus-5-5", display_name: "Opus" },
      ...(step.effort ? { effort: { level: step.effort } } : {}),
      workspace: { current_dir: process.cwd() },
      rate_limits: limits,
    });
    log("statusline", { code: r.code, stdout: r.stdout, run: invocations });
  } else if ("hop" in step) {
    const r = baton([
      "hop",
      "--session",
      session,
      "--from-command",
      `--to=${step.hop ?? ""}`,
    ]);
    log("hop", { code: r.code, stdout: r.stdout, run: invocations });
  } else if (step.keys) watchKeys();
  else if (step.sleep) await sleep(step.sleep);
  else if (step.waitFile) {
    while (!existsSync(join(dir, step.waitFile))) await sleep(20);
  } else if ("exit" in step) {
    log("exit", { code: step.exit, run: invocations });
    process.exit(step.exit);
  } else if (step.wait === "end") {
    log("waiting", { run: invocations, session });
    // Never outlive a test that failed.
    // (well inside the tests' own timeout, so a failure shows as one).
    setTimeout(() => onEnd("abandoned", 99), 25e3);
    await new Promise(() => {});
  }
}
log("done", { run: invocations });
