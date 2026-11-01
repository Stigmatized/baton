import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseClaudeArgs, resumeArgs } from "../src/claude-args.js";
import { findOnPath, resolveClaude, shimTarget } from "../src/claude-path.js";
import { tempHome } from "./helpers.js";

const SID = "6f0b2d4e-1c3a-4b5d-8e9f-0a1b2c3d4e5f";

test("which conversation a command line opens, and whether it is an interactive session", () => {
  assert.deepEqual(parseClaudeArgs([]).session, { mode: "new", id: null });
  assert.deepEqual(parseClaudeArgs(["-r", SID]).session, {
    mode: "resume",
    id: SID,
  });
  assert.deepEqual(parseClaudeArgs(["--resume=" + SID]).session, {
    mode: "resume",
    id: SID,
  });
  assert.deepEqual(parseClaudeArgs(["--resume"]).session, {
    mode: "picker",
    id: null,
  });
  assert.deepEqual(parseClaudeArgs(["-r", "--model", "opus"]).session, {
    mode: "picker",
    id: null,
  });
  assert.deepEqual(parseClaudeArgs(["-c"]).session, {
    mode: "continue",
    id: null,
  });
  assert.deepEqual(parseClaudeArgs(["--session-id", SID]).session, {
    mode: "new",
    id: SID,
  });
  assert.equal(
    parseClaudeArgs(["-r", SID, "--fork-session"]).session.mode,
    "fork",
  );
  assert.equal(parseClaudeArgs(["fix the bug"]).interactive, true);
  for (const passthrough of [
    ["-p", "hi"],
    ["--print"],
    ["--version"],
    ["auth", "status"],
    ["mcp", "list"],
    ["--bg"],
    ["-h"],
  ])
    assert.equal(
      parseClaudeArgs(passthrough).interactive,
      false,
      passthrough.join(" "),
    );
  const parsed = parseClaudeArgs([
    "--model",
    "opus",
    "--add-dir",
    "a",
    "b",
    "do it",
  ]);
  assert.deepEqual(
    parsed.options.find((o) => o.name === "--add-dir").values,
    ["a", "b", "do it"],
    "commander reads a prompt after --add-dir as a directory too",
  );
  assert.deepEqual(parseClaudeArgs(["--model", "opus", "do it"]).positionals, [
    "do it",
  ]);
});

test("resume keeps what --resume does not restore and drops the session selection and the prompt", () => {
  const parsed = parseClaudeArgs([
    "--model",
    "opus",
    "--add-dir",
    "../shared",
    "../more",
    "--mcp-config",
    "mcp.json",
    "--settings",
    "s.json",
    "--plugin-dir",
    "plugins",
    "--fallback-model",
    "sonnet",
    "--permission-mode",
    "acceptEdits",
    "-n",
    "work",
    "--continue",
    "first prompt",
  ]);
  const args = resumeArgs(parsed, SID, "carry on");
  assert.deepEqual(args, [
    "--model",
    "opus",
    "--add-dir",
    "../shared",
    "../more",
    "--mcp-config",
    "mcp.json",
    "--settings",
    "s.json",
    "--plugin-dir",
    "plugins",
    "--fallback-model",
    "sonnet",
    "--permission-mode",
    "acceptEdits",
    "--resume",
    SID,
    "carry on",
  ]);
  // --resume ends the variadic --add-dir, so the prompt is the prompt.
  const reparsed = parseClaudeArgs(args);
  assert.deepEqual(reparsed.positionals, ["carry on"]);
  assert.deepEqual(reparsed.session, { mode: "resume", id: SID });
  assert.deepEqual(
    resumeArgs(parseClaudeArgs(["-r", SID, "--worktree", "w1", "--tmux"]), SID),
    ["--resume", SID],
  );
});

test("resume takes the session's live model, effort and permission mode", () => {
  const parsed = parseClaudeArgs([
    "--model",
    "opus",
    "--permission-mode",
    "plan",
  ]);
  assert.deepEqual(
    resumeArgs(parsed, SID, null, {
      model: "claude-sonnet-5",
      effort: "high",
      permissionMode: "acceptEdits",
    }),
    [
      "--model",
      "claude-sonnet-5",
      "--effort",
      "high",
      "--permission-mode",
      "acceptEdits",
      "--resume",
      SID,
    ],
  );
  // Without --model on the original line, the resumed session keeps its own model.
  assert.deepEqual(
    resumeArgs(parseClaudeArgs([]), SID, null, { model: "claude-sonnet-5" }),
    ["--resume", SID],
  );
  // "default" is the CLI's "manual".
  assert.deepEqual(
    resumeArgs(parseClaudeArgs([]), SID, null, { permissionMode: "default" }),
    ["--permission-mode", "manual", "--resume", SID],
  );
  // Bypass mode is not restored by a terminal resume: passed again.
  assert.deepEqual(
    resumeArgs(
      parseClaudeArgs(["--allow-dangerously-skip-permissions"]),
      SID,
      null,
      { permissionMode: "bypassPermissions" },
    ),
    [
      "--allow-dangerously-skip-permissions",
      "--permission-mode",
      "bypassPermissions",
      "--resume",
      SID,
    ],
  );
  assert.deepEqual(
    resumeArgs(parseClaudeArgs(["--dangerously-skip-permissions"]), SID, null, {
      permissionMode: "bypassPermissions",
    }),
    ["--dangerously-skip-permissions", "--resume", SID],
  );
  // Left bypass mode during the session: bypass stays available, not forced.
  assert.deepEqual(
    resumeArgs(parseClaudeArgs(["--dangerously-skip-permissions"]), SID, null, {
      permissionMode: "acceptEdits",
    }),
    [
      "--allow-dangerously-skip-permissions",
      "--permission-mode",
      "acceptEdits",
      "--resume",
      SID,
    ],
  );
});

test("Windows resolution: PATHEXT order per folder, explicit paths, and npm shims run without a shell", (t) => {
  const { root } = tempHome(t);
  const a = join(root, "a dir");
  const b = join(root, "b");
  mkdirSync(a, { recursive: true });
  mkdirSync(b, { recursive: true });
  writeFileSync(join(a, "claude.cmd"), "@echo off\r\n");
  writeFileSync(join(b, "claude.exe"), "");
  const env = { PATH: `"${a}";${b}`, PATHEXT: ".COM;.EXE;.BAT;.CMD" };
  assert.equal(
    findOnPath("claude", { env, platform: "win32" }),
    join(a, "claude.cmd"),
  );
  // The shim in the first folder cannot be read for a target: resolution fails clearly.
  assert.throws(() => resolveClaude({ env, platform: "win32" }), /shell shim/);
  const pkg = join(a, "node_modules", "@anthropic-ai", "claude-code");
  mkdirSync(pkg, { recursive: true });
  writeFileSync(join(pkg, "cli.js"), "");
  writeFileSync(
    join(a, "claude.cmd"),
    '@ECHO off\r\nIF EXIST "%dp0%\\node.exe" (\r\n  SET "_prog=%dp0%\\node.exe"\r\n) ELSE (\r\n  SET "_prog=node"\r\n)\r\nendLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@anthropic-ai\\claude-code\\cli.js" %*\r\n',
  );
  assert.equal(shimTarget(join(a, "claude.cmd")), join(pkg, "cli.js"));
  assert.deepEqual(
    resolveClaude({ env, platform: "win32", nodePath: "NODE" }),
    {
      command: "NODE",
      prefix: [join(pkg, "cli.js")],
      path: join(pkg, "cli.js"),
    },
  );
  assert.deepEqual(resolveClaude({ env: { PATH: b }, platform: "win32" }), {
    command: join(b, "claude.exe"),
    prefix: [],
    path: join(b, "claude.exe"),
  });
  assert.deepEqual(
    resolveClaude({
      configured: join(b, "claude.exe"),
      env: {},
      platform: "win32",
    }).command,
    join(b, "claude.exe"),
  );
  const home = join(root, "home");
  mkdirSync(join(home, ".local", "bin"), { recursive: true });
  writeFileSync(join(home, ".local", "bin", "claude.exe"), "");
  assert.equal(
    resolveClaude({ env: { PATH: "" }, platform: "win32", home }).command,
    join(home, ".local", "bin", "claude.exe"),
  );
  assert.throws(
    () => resolveClaude({ env: { PATH: "" }, platform: "win32" }),
    /not on PATH/,
  );
});
