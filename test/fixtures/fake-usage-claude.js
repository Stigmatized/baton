// A stand-in for the `claude` executable in the usage poller's tests, run
// by the real Agent SDK (stream-json on stdin and stdout) or as `claude auth
// status --json`. It speaks just enough of the protocol: it answers the
// SDK's initialize request, and answers the "/usage" prompt with what
// Claude Code sends for it (a synthetic assistant message carrying
// usage_report, then a result).
//
// FAKE_USAGE_MODE   ok (default) | hang (never answers) | null (rate_limits
//                   null) | ratelimited (rate_limits null, "rate limited
//                   until 3:14am") | none (no usage_report at all)
// FAKE_USAGE_JSON   the rate_limits to send (JSON), for ok
// FAKE_USAGE_LOG    a file to log each start to (argv, config dir, env names)
// FAKE_USAGE_PID    a file to write this process's pid to
// FAKE_TRANSCRIPT   1: write a transcript for the working folder, the way a
//                   Claude Code that ignored --no-session-persistence would
// FAKE_LOGGED_IN    0: `auth status` says signed out
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

const argv = process.argv.slice(2);
const env = process.env;
if (argv[0] === "auth" && argv[1] === "status") {
  process.stdout.write(
    JSON.stringify({
      loggedIn: env.FAKE_LOGGED_IN !== "0",
      authMethod: env.FAKE_LOGGED_IN !== "0" ? "claude.ai" : "none",
    }) + "\n",
  );
  process.exit(0);
}
if (env.FAKE_USAGE_PID) writeFileSync(env.FAKE_USAGE_PID, String(process.pid));
if (env.FAKE_USAGE_LOG)
  appendFileSync(
    env.FAKE_USAGE_LOG,
    JSON.stringify({
      argv,
      configDir: env.CLAUDE_CONFIG_DIR ?? null,
      cwd: process.cwd(),
      envNames: Object.keys(env).filter((k) =>
        /^(CLAUDE|BATON|ANTHROPIC)/i.test(k),
      ),
      pid: process.pid,
    }) + "\n",
  );
if (env.FAKE_TRANSCRIPT === "1") {
  const config = env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");
  const dir = join(
    config,
    "projects",
    process.cwd().replace(/[^a-zA-Z0-9]/g, "-"),
  );
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "probe-session.jsonl"), '{"type":"user"}\n');
}

const mode = env.FAKE_USAGE_MODE ?? "ok";
const out = (message) => process.stdout.write(JSON.stringify(message) + "\n");
const rateLimits = () =>
  env.FAKE_USAGE_JSON
    ? JSON.parse(env.FAKE_USAGE_JSON)
    : {
        limits: [
          {
            kind: "session",
            group: "session",
            percent: 42,
            resets_at: new Date(Date.now() + 2 * 3600e3).toISOString(),
            severity: "normal",
            is_active: true,
          },
          {
            kind: "weekly_all",
            group: "weekly",
            percent: 63,
            resets_at: new Date(Date.now() + 72 * 3600e3).toISOString(),
            severity: "normal",
            is_active: false,
          },
        ],
        extra_usage: null,
      };

function answer() {
  const text =
    mode === "ratelimited"
      ? "Usage data is rate limited until 3:14am. Showing cached data."
      : mode === "null"
        ? "Could not load your plan usage."
        : "Current session 42% used";
  const message = {
    type: "assistant",
    session_id: "probe",
    uuid: "u1",
    parent_tool_use_id: null,
    message: {
      id: "m1",
      type: "message",
      role: "assistant",
      model: "<synthetic>",
      content: [{ type: "text", text }],
      stop_reason: "end_turn",
      usage: {},
    },
  };
  if (mode !== "none")
    message.usage_report = {
      session: {},
      rate_limits: mode === "ok" ? rateLimits() : null,
    };
  out({
    type: "system",
    subtype: "init",
    session_id: "probe",
    uuid: "u0",
    tools: [],
    mcp_servers: [],
    model: "x",
    permissionMode: "default",
    slash_commands: [],
    apiKeySource: "none",
    cwd: process.cwd(),
    output_style: "default",
  });
  out(message);
  out({
    type: "result",
    subtype: "success",
    session_id: "probe",
    uuid: "u2",
    is_error: false,
    result: text,
    duration_ms: 1,
    duration_api_ms: 0,
    num_turns: 0,
    total_cost_usd: 0,
    usage: {},
    modelUsage: {},
    permission_denials: [],
  });
}

const lines = createInterface({ input: process.stdin });
lines.on("line", (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  if (mode === "hang") return;
  if (message.type === "control_request")
    out({
      type: "control_response",
      response: {
        subtype: "success",
        request_id: message.request_id,
        response: { commands: [], models: [], account: {} },
      },
    });
  else if (message.type === "user") answer();
});
lines.on("close", () => {
  if (mode !== "hang") process.exit(0);
});
if (mode === "hang") setInterval(() => {}, 1000);
