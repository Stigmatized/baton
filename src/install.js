import {
  existsSync,
  lstatSync,
  mkdirSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { diffLines } from "./diff.js";
import {
  iso,
  readJson,
  readText,
  writeFileAtomic,
  writeJsonAtomic,
} from "./fsutil.js";
import { HOOK_EVENTS } from "./hooks.js";
import { forward } from "./paths.js";

// `baton install` / `baton uninstall`: the only changes Baton makes to account
// 1's ~/.claude (shared by every profile):
//  - settings.json: a status line command (`baton statusline`, which records
//    rate_limits and then runs the operator's previous status line command if
//    there was one), and command hooks (exec form: node + Baton's cli.js, no
//    shell) for SessionStart, UserPromptSubmit, Stop, StopFailure and
//    SessionEnd;
//  - commands/hop.md: the /hop command.
// Every change is planned first (the plan is what --dry-run shows), the
// previous files are backed up under ~/.baton/backups/<time>/, writes are
// atomic, and running it again changes nothing. Uninstall removes exactly
// Baton's entries and puts the previous status line back.

export const HOP_MARKER = "(installed by Baton)";
const HOOK_NAMES = Object.values(HOOK_EVENTS);

export const settingsPath = (paths) => join(paths.claudeDir, "settings.json");
export const hopCommandPath = (paths) =>
  join(paths.claudeDir, "commands", "hop.md");

export function isBatonHandler(handler) {
  return (
    handler?.type === "command" &&
    Array.isArray(handler.args) &&
    handler.args.length >= 3 &&
    handler.args[1] === "hook" &&
    /[\\/]src[\\/]cli\.js$/i.test(String(handler.args[0])) &&
    handler.args[2] in HOOK_EVENTS
  );
}

export const isBatonStatusLine = (statusLine) =>
  typeof statusLine?.command === "string" &&
  /cli\.js"?\s+statusline\b/.test(statusLine.command);

// A command line both Git Bash and PowerShell run: an absolute node path
// cannot be quoted at the start of a PowerShell command, so a node path with
// spaces is replaced by `node` from PATH.
export function nodeCommand(nodePath) {
  const node = forward(nodePath);
  return /\s/.test(node) ? "node" : node;
}

export const statusLineCommand = (nodePath, cliPath) =>
  `${nodeCommand(nodePath)} "${forward(cliPath)}" statusline`;

export function hookHandler(nodePath, cliPath, event) {
  return {
    type: "command",
    command: forward(nodePath),
    args: [forward(cliPath), "hook", event],
    timeout: 10,
  };
}

export function hopCommandText(cliPath) {
  return [
    "---",
    `description: Move this conversation to another account at the end of this turn ${HOP_MARKER}`,
    'argument-hint: "[account]"',
    "allowed-tools: Bash(node:*)",
    "disable-model-invocation: true",
    "---",
    // Quoted: an account name may hold spaces and any character.
    `!\`node "${forward(cliPath)}" hop --session "\${CLAUDE_SESSION_ID}" --from-command --to='$ARGUMENTS'\``,
    "",
    "Baton was asked to move this conversation to another account; its answer is above. If it accepted, the move happens when this turn ends: reply with one short line saying so and do nothing else. If it refused, tell the operator why in one line.",
    "",
  ].join("\n");
}

function jsonFormat(text) {
  if (!text) return { indent: 2, eol: "\n", trailing: true };
  const m = /\n([ \t]+)"/.exec(text);
  return {
    indent: m ? m[1] : 2,
    eol: text.includes("\r\n") ? "\r\n" : "\n",
    trailing: /\r?\n$/.test(text),
  };
}

const render = (value, format) => {
  const text = JSON.stringify(value, null, format.indent).replace(
    /\n/g,
    format.eol,
  );
  return format.trailing ? text + format.eol : text;
};

export class InstallError extends Error {}

function readSettings(file) {
  const text = readText(file);
  if (text === null || !text.trim()) return { text, value: {} };
  try {
    const value = JSON.parse(text);
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error("not an object");
    return { text, value };
  } catch (error) {
    throw new InstallError(
      `${file} is not valid JSON (${error.message}); fix it first.`,
    );
  }
}

const clone = (v) => JSON.parse(JSON.stringify(v));

function withoutBatonHooks(hooks) {
  const out = {};
  for (const [event, groups] of Object.entries(hooks ?? {})) {
    if (!Array.isArray(groups)) {
      out[event] = groups;
      continue;
    }
    const kept = [];
    for (const group of groups) {
      if (!group || !Array.isArray(group.hooks)) {
        kept.push(group);
        continue;
      }
      const handlers = group.hooks.filter((h) => !isBatonHandler(h));
      if (handlers.length === group.hooks.length) kept.push(group);
      else if (handlers.length) kept.push({ ...group, hooks: handlers });
    }
    if (kept.length) out[event] = kept;
  }
  return out;
}

const hasBatonHooks = (hooks) =>
  Object.values(hooks ?? {}).some((groups) =>
    (Array.isArray(groups) ? groups : []).some((g) =>
      g?.hooks?.some?.(isBatonHandler),
    ),
  );

function sameBatonHooks(hooks, desired) {
  for (const [event, handler] of Object.entries(desired)) {
    const found = (hooks?.[event] ?? [])
      .flatMap((g) => (Array.isArray(g?.hooks) ? g.hooks : []))
      .filter(isBatonHandler);
    if (
      found.length !== 1 ||
      JSON.stringify(found[0]) !== JSON.stringify(handler)
    )
      return false;
  }
  const extra = Object.keys(hooks ?? {}).filter(
    (event) =>
      !(event in desired) &&
      (hooks[event] ?? []).some?.((g) => g?.hooks?.some?.(isBatonHandler)),
  );
  return extra.length === 0;
}

// planInstall -> { files: [{ path, before, after, diff }], items, record, notes }
// (items: what each piece comes to, { name: hooks | statusline | hop, action }).
export function planInstall({ paths, nodePath = process.execPath, cliPath }) {
  const file = settingsPath(paths);
  const { text, value } = readSettings(file);
  const record = readJson(paths.install);
  const settings = clone(value);
  const notes = [];

  // What each piece comes to, for the screen: action is add, update or same.
  const items = [];

  const desiredHooks = {};
  for (const [name, event] of Object.entries(HOOK_EVENTS))
    desiredHooks[event] = hookHandler(nodePath, cliPath, name);
  if (sameBatonHooks(settings.hooks, desiredHooks))
    items.push({ name: "hooks", action: "same", events: HOOK_NAMES });
  else {
    const had = hasBatonHooks(settings.hooks);
    const hooks = withoutBatonHooks(settings.hooks);
    for (const [event, handler] of Object.entries(desiredHooks))
      hooks[event] = [...(hooks[event] ?? []), { hooks: [handler] }];
    settings.hooks = hooks;
    items.push({
      name: "hooks",
      action: had ? "update" : "add",
      events: HOOK_NAMES,
    });
  }

  const command = statusLineCommand(nodePath, cliPath);
  let previousStatusLine = record?.previousStatusLine ?? null;
  const current = settings.statusLine;
  if (isBatonStatusLine(current)) {
    if (current.command !== command)
      settings.statusLine = { ...current, command };
    items.push({
      name: "statusline",
      action: current.command === command ? "same" : "update",
    });
  } else {
    previousStatusLine = current ?? null;
    const keep = {};
    for (const key of ["padding", "refreshInterval", "hideVimModeIndicator"])
      if (current && key in current) keep[key] = current[key];
    settings.statusLine = { type: "command", command, ...keep };
    items.push({ name: "statusline", action: "add" });
    if (current)
      notes.push(
        "Your status line command stays: Baton runs it after recording usage. To see Baton's usage after it: baton policy --status-line-usage true.",
      );
  }

  const files = [];
  const format = jsonFormat(text);
  const after = render(settings, format);
  if (after !== text)
    files.push({
      path: file,
      before: text,
      after,
      diff: diffLines(text, after),
    });

  const hopFile = hopCommandPath(paths);
  const hopBefore = readText(hopFile);
  const hopAfter = hopCommandText(cliPath);
  if (hopBefore !== null && !hopBefore.includes(HOP_MARKER)) {
    notes.push(
      `${hopFile} is your own command; Baton leaves it and does not install /hop (use baton hop).`,
    );
    items.push({ name: "hop", action: "skip", path: hopFile });
  } else if (hopBefore !== hopAfter) {
    files.push({
      path: hopFile,
      before: hopBefore,
      after: hopAfter,
      diff: diffLines(hopBefore, hopAfter),
    });
    items.push({
      name: "hop",
      action: hopBefore === null ? "add" : "update",
      path: hopFile,
    });
  } else items.push({ name: "hop", action: "same", path: hopFile });

  return {
    files,
    notes,
    items,
    record: {
      version: 1,
      cli: forward(cliPath),
      node: forward(nodePath),
      settingsPath: file,
      commandPath: hopFile,
      previousStatusLine,
      hooks: Object.keys(desiredHooks),
    },
  };
}

export function planUninstall({ paths }) {
  const file = settingsPath(paths);
  const { text, value } = readSettings(file);
  const record = readJson(paths.install);
  const settings = clone(value);
  const notes = [];
  const items = [];
  const hadHooks = hasBatonHooks(settings.hooks);
  if (settings.hooks) {
    const hooks = withoutBatonHooks(settings.hooks);
    if (Object.keys(hooks).length) settings.hooks = hooks;
    else delete settings.hooks;
  }
  items.push({
    name: "hooks",
    action: hadHooks ? "remove" : "absent",
    events: HOOK_NAMES,
  });
  if (isBatonStatusLine(settings.statusLine)) {
    const restored = Boolean(record?.previousStatusLine);
    if (restored) settings.statusLine = record.previousStatusLine;
    else delete settings.statusLine;
    items.push({ name: "statusline", action: "remove", restored });
  } else {
    items.push({ name: "statusline", action: "absent" });
    if (settings.statusLine && record?.previousStatusLine)
      notes.push(
        "The status line was changed after install; Baton leaves it as it is.",
      );
  }
  const files = [];
  const after =
    text === null && !Object.keys(settings).length
      ? null
      : render(settings, jsonFormat(text));
  if (after !== text && !(text === null && after === null))
    files.push({
      path: file,
      before: text,
      after,
      diff: diffLines(text, after),
    });
  const hopFile = hopCommandPath(paths);
  const hopBefore = readText(hopFile);
  const ours = hopBefore !== null && hopBefore.includes(HOP_MARKER);
  if (ours)
    files.push({
      path: hopFile,
      before: hopBefore,
      after: null,
      diff: diffLines(hopBefore, null),
    });
  items.push({
    name: "hop",
    action: ours ? "remove" : "absent",
    path: hopFile,
  });
  return { files, notes, items, record: null };
}

// Writes a plan: backups first, then each file atomically (through a
// symbolic link to its target), then the record. Returns the backup folder.
const recordKey = (r) =>
  r ? JSON.stringify({ ...r, installedAt: null, backup: null }) : null;

export function planIsNoop(plan, paths) {
  const existing = readJson(paths.install);
  return (
    !plan.files.length &&
    (plan.record ? recordKey(existing) === recordKey(plan.record) : !existing)
  );
}

export function applyPlan(plan, { paths, now = Date.now() }) {
  if (planIsNoop(plan, paths)) return { changed: false, backup: null };
  const stamp = iso(now).replace(/[:.]/g, "-");
  let backup = null;
  for (const f of plan.files) {
    if (f.before === null) continue;
    backup = join(paths.backups, stamp);
    mkdirSync(backup, { recursive: true });
    writeFileAtomic(
      join(backup, f.path === settingsPath(paths) ? "settings.json" : "hop.md"),
      f.before,
    );
  }
  for (const f of plan.files) {
    let target = f.path;
    try {
      if (lstatSync(target).isSymbolicLink()) target = realpathSync(target);
    } catch {
      // a new file
    }
    if (f.after === null) rmSync(target, { force: true });
    else writeFileAtomic(target, f.after);
  }
  if (plan.record)
    writeJsonAtomic(paths.install, {
      ...plan.record,
      installedAt: iso(now),
      backup: backup ?? readJson(paths.install)?.backup ?? null,
    });
  else rmSync(paths.install, { force: true });
  return { changed: true, backup };
}

// Whether Baton's pieces are in settings.json (for doctor and status).
export function installState(paths) {
  let settings = {};
  try {
    settings = readSettings(settingsPath(paths)).value;
  } catch {
    return { ok: false, error: "settings.json is not valid JSON" };
  }
  const hooks = {};
  for (const [name, event] of Object.entries(HOOK_EVENTS)) {
    const handler = (settings.hooks?.[event] ?? [])
      .flatMap((g) => (Array.isArray(g?.hooks) ? g.hooks : []))
      .find(isBatonHandler);
    hooks[event] = handler
      ? {
          installed: true,
          cliExists: existsSync(handler.args[0]),
          nodeExists: existsSync(handler.command),
          name,
        }
      : { installed: false, name };
  }
  const hop = readText(hopCommandPath(paths));
  return {
    ok: true,
    statusLine: isBatonStatusLine(settings.statusLine),
    hooks,
    hopCommand: hop !== null && hop.includes(HOP_MARKER),
    record: readJson(paths.install),
  };
}
