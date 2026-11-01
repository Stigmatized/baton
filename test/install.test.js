import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  HOP_MARKER,
  applyPlan,
  hopCommandPath,
  installState,
  isBatonHandler,
  planInstall,
  planUninstall,
  settingsPath,
  statusLineCommand,
} from "../src/install.js";
import { CLI, tempHome, write } from "./helpers.js";

const NODE = "C:/Program Files/nodejs/node.exe";
const read = (f) => readFileSync(f, "utf8");
const json = (f) => JSON.parse(read(f));

function install(paths, opts = {}) {
  const plan = planInstall({ paths, nodePath: NODE, cliPath: CLI, ...opts });
  return { plan, applied: applyPlan(plan, { paths }) };
}

test("dry run: the plan shows the changes and writes nothing", (t) => {
  const { paths } = tempHome(t);
  write(settingsPath(paths), { theme: "dark" });
  const plan = planInstall({ paths, nodePath: NODE, cliPath: CLI });
  assert.equal(plan.files.length, 2);
  assert.ok(
    plan.files[0].diff.some(
      (l) => l.startsWith("+") && l.includes("statusline"),
    ),
  );
  assert.deepEqual(json(settingsPath(paths)), { theme: "dark" });
  assert.ok(!existsSync(hopCommandPath(paths)));
  assert.ok(!existsSync(paths.install));
});

test("install into settings without a status line or hooks, keeping the other keys", (t) => {
  const { paths } = tempHome(t);
  write(settingsPath(paths), {
    theme: "dark",
    permissions: { allow: ["Bash(ls:*)"] },
  });
  const { applied } = install(paths);
  assert.equal(applied.changed, true);
  const s = json(settingsPath(paths));
  assert.equal(s.theme, "dark");
  assert.deepEqual(s.permissions, { allow: ["Bash(ls:*)"] });
  assert.deepEqual(s.statusLine, {
    type: "command",
    command: statusLineCommand(NODE, CLI),
  });
  assert.equal(
    s.statusLine.command.startsWith("node "),
    true,
    "a node path with spaces runs as node from PATH",
  );
  for (const event of [
    "SessionStart",
    "UserPromptSubmit",
    "Stop",
    "StopFailure",
    "SessionEnd",
  ]) {
    const handlers = s.hooks[event].flatMap((g) => g.hooks);
    assert.equal(handlers.filter(isBatonHandler).length, 1, event);
    assert.equal(handlers[0].command, NODE);
    assert.equal(handlers[0].args[1], "hook");
  }
  assert.equal(
    s.hooks.StopFailure[0].matcher,
    undefined,
    "every API error ends a turn",
  );
  const hop = read(hopCommandPath(paths));
  assert.ok(hop.includes(HOP_MARKER));
  assert.ok(hop.includes("${CLAUDE_SESSION_ID}"));
  assert.ok(hop.includes("--to='$ARGUMENTS'"), "a name with spaces stays one");
  const record = json(paths.install);
  assert.equal(record.previousStatusLine, null);
  assert.ok(existsSync(join(applied.backup, "settings.json")));
  assert.deepEqual(JSON.parse(read(join(applied.backup, "settings.json"))), {
    theme: "dark",
    permissions: { allow: ["Bash(ls:*)"] },
  });
  const state = installState(paths);
  assert.equal(state.statusLine, true);
  assert.equal(state.hopCommand, true);
});

test("install wraps an existing status line and keeps existing hooks; again is a no-op", (t) => {
  const { paths } = tempHome(t);
  const mine = {
    type: "command",
    command: "~/.claude/statusline.sh",
    padding: 2,
    refreshInterval: 5,
  };
  const myHook = {
    matcher: "Bash",
    hooks: [{ type: "command", command: "echo pre" }],
  };
  const myStop = { hooks: [{ type: "command", command: "notify-send done" }] };
  write(settingsPath(paths), {
    statusLine: mine,
    hooks: { PreToolUse: [myHook], Stop: [myStop] },
  });
  const first = install(paths);
  assert.ok(first.plan.notes.some((n) => n.includes("status line")));
  const s = json(settingsPath(paths));
  assert.equal(s.statusLine.padding, 2);
  assert.equal(s.statusLine.refreshInterval, 5);
  assert.notEqual(s.statusLine.command, mine.command);
  assert.deepEqual(json(paths.install).previousStatusLine, mine);
  assert.deepEqual(s.hooks.PreToolUse, [myHook]);
  assert.deepEqual(s.hooks.Stop[0], myStop);
  assert.equal(s.hooks.Stop.length, 2);
  const text = read(settingsPath(paths));
  const second = install(paths);
  assert.equal(second.applied.changed, false);
  assert.equal(second.plan.files.length, 0);
  assert.equal(read(settingsPath(paths)), text);
  assert.deepEqual(
    json(paths.install).previousStatusLine,
    mine,
    "the wrapped status line is remembered across installs",
  );
});

test("install follows Baton moving: its entries are replaced, not duplicated", (t) => {
  const { paths } = tempHome(t);
  write(settingsPath(paths), {});
  install(paths);
  install(paths, {
    cliPath: join(CLI, "..", "..", "..", "baton-moved", "src", "cli.js"),
  });
  const s = json(settingsPath(paths));
  for (const groups of Object.values(s.hooks))
    assert.equal(
      groups.flatMap((g) => g.hooks).filter(isBatonHandler).length,
      1,
    );
  assert.ok(s.statusLine.command.includes("baton-moved"));
});

test("formatting is kept: indentation, CRLF and the trailing newline", (t) => {
  const { paths } = tempHome(t);
  write(settingsPath(paths), '{\r\n    "theme": "dark"\r\n}\r\n');
  install(paths);
  const text = read(settingsPath(paths));
  assert.ok(
    text.startsWith(
      '{\r\n    "theme": "dark",\r\n    "hooks": {\r\n        "SessionStart"',
    ),
  );
  assert.ok(text.endsWith("}\r\n"));
  assert.ok(!/[^\r]\n/.test(text));
});

test("uninstall restores the previous status line and removes exactly Baton's entries", (t) => {
  const { paths } = tempHome(t);
  const mine = { type: "command", command: "~/.claude/statusline.sh" };
  const myStop = { hooks: [{ type: "command", command: "notify-send done" }] };
  const original = {
    theme: "dark",
    statusLine: mine,
    hooks: { Stop: [myStop] },
  };
  write(settingsPath(paths), original);
  install(paths);
  const plan = planUninstall({ paths });
  assert.equal(plan.files.length, 2);
  const { changed, backup } = applyPlan(plan, { paths });
  assert.equal(changed, true);
  assert.deepEqual(json(settingsPath(paths)), original);
  assert.ok(!existsSync(hopCommandPath(paths)));
  assert.ok(!existsSync(paths.install));
  assert.ok(existsSync(join(backup, "settings.json")));
  assert.equal(applyPlan(planUninstall({ paths }), { paths }).changed, false);
});

test("uninstall without a previous status line removes Baton's; a new settings.json is created and removed cleanly", (t) => {
  const { paths } = tempHome(t);
  install(paths);
  assert.ok(json(settingsPath(paths)).statusLine);
  applyPlan(planUninstall({ paths }), { paths });
  assert.deepEqual(json(settingsPath(paths)), {});
});

test("an operator's own /hop command is left alone", (t) => {
  const { paths } = tempHome(t);
  write(hopCommandPath(paths), "my own hop\n");
  const { plan } = install(paths);
  assert.ok(plan.notes.some((n) => n.includes("your own command")));
  assert.equal(read(hopCommandPath(paths)), "my own hop\n");
  applyPlan(planUninstall({ paths }), { paths });
  assert.equal(read(hopCommandPath(paths)), "my own hop\n");
});

test("settings.json that is not JSON is refused", (t) => {
  const { paths } = tempHome(t);
  write(settingsPath(paths), "{ nope");
  assert.throws(
    () => planInstall({ paths, nodePath: NODE, cliPath: CLI }),
    /not valid JSON/,
  );
  assert.equal(read(settingsPath(paths)), "{ nope");
  assert.deepEqual(
    readdirSync(paths.home).filter((f) => f === ".baton"),
    [],
  );
});
