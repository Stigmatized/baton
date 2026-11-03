import { statSync } from "node:fs";
import { join, resolve } from "node:path";
import { findOnPath } from "./claude-path.js";
import { readText } from "./fsutil.js";
import { forward, samePath } from "./paths.js";

// Baton as a PRIMED CLI launcher. When PRIMED CLI is on this machine (its
// data folder exists, or `primed` is on PATH), `baton install` writes
// <data>/launchers/baton.json, so PRIMED CLI can open a project in Baton and
// resume or continue a Claude Code conversation there; `baton uninstall`
// removes the file while it is still Baton's. <data> is PRIMED_CLI_HOME, else
// ~/.primed-cli in Baton's own home (BATON_HOME keeps the tests away from the
// real one). The file runs node + Baton's cli.js directly (exec form, like
// the hooks): no shell and no .cmd shim. Its format is PRIMED CLI's launcher
// schema, version 1.

export const LAUNCHER_ID = "baton";
export const LAUNCHER_SOURCE = "baton install";

const isDir = (p) => {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
};

export const primedHome = (paths, env = process.env) =>
  env.PRIMED_CLI_HOME
    ? resolve(env.PRIMED_CLI_HOME)
    : join(paths.home, ".primed-cli");

export const launcherPath = (data) =>
  join(data, "launchers", `${LAUNCHER_ID}.json`);

// PRIMED CLI keeps its data folder private: a folder Baton creates there is
// this user's only, and so is the launcher file, as PRIMED CLI writes its own.
export const PRIVATE = { dirMode: 0o700, mode: 0o600 };

// { found, data, file, program }: program is where `primed` is on PATH, looked
// up only when the data folder does not exist. findPrimed() -> path | null
// replaces the PATH lookup (the tests pass their own).
export function detectPrimed({
  paths,
  env = process.env,
  platform = process.platform,
  findPrimed = () => findOnPath("primed", { env, platform }),
}) {
  const data = primedHome(paths, env);
  const program = isDir(data) ? null : (findPrimed() ?? null);
  return {
    found: program !== null || isDir(data),
    data,
    file: launcherPath(data),
    program,
  };
}

// Braces are PRIMED CLI's placeholders: a path's own are doubled.
const literal = (text) => text.replace(/[{}]/g, "$&$&");

export function launcherDef(nodePath, cliPath) {
  return {
    schemaVersion: 1,
    id: LAUNCHER_ID,
    name: "Baton",
    description: "Claude Code on your accounts, one after another",
    program: forward(nodePath),
    args: [literal(forward(cliPath))],
    resumeArgs: ["--resume", "{conversation}"],
    continueArgs: ["--continue"],
    conversations: "claude-code",
    terminal: true,
    source: LAUNCHER_SOURCE,
  };
}

export const launcherText = (nodePath, cliPath) =>
  JSON.stringify(launcherDef(nodePath, cliPath), null, 2) + "\n";

export function parseLauncher(text) {
  try {
    const value = JSON.parse(text);
    return value && typeof value === "object" && !Array.isArray(value)
      ? value
      : null;
  } catch {
    return null;
  }
}

// Only a file Baton wrote is Baton's to remove.
export const isBatonLauncher = (value) =>
  value?.id === LAUNCHER_ID && value?.source === LAUNCHER_SOURCE;

// The registration, for doctor: state is absent (no PRIMED CLI), missing,
// current, stale (Baton's, but not what baton install writes now: node and
// cli say which path changed) or foreign (a baton.json that is not Baton's).
export function registrationState({
  paths,
  env = process.env,
  platform = process.platform,
  findPrimed,
  nodePath = process.execPath,
  cliPath,
}) {
  const primed = detectPrimed({ paths, env, platform, findPrimed });
  if (!primed.found) return { ...primed, state: "absent" };
  const text = readText(primed.file);
  if (text === null) return { ...primed, state: "missing" };
  if (text === launcherText(nodePath, cliPath))
    return { ...primed, state: "current" };
  const value = parseLauncher(text);
  if (!isBatonLauncher(value)) return { ...primed, state: "foreign" };
  const want = launcherDef(nodePath, cliPath);
  return {
    ...primed,
    state: "stale",
    node: !samePath(String(value.program), want.program, platform),
    cli: !samePath(
      String(Array.isArray(value.args) ? value.args[0] : ""),
      want.args[0],
      platform,
    ),
  };
}
