import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";

// Where everything lives. "home" is the user's home directory (BATON_HOME
// overrides it, which the tests use). Baton's accounts are only the ones the
// operator adds, each a Claude Code profile in ~/.baton/accounts/<id>; Baton
// never interacts with the default Claude Code account (~/.claude without
// CLAUDE_CONFIG_DIR): ~/.claude is only the shared base the profiles link
// to (projects, memory, settings, ...), and ~/.claude.json the source of the
// non-identity state a new profile is seeded with. Baton's own state is in
// ~/.baton.
export const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
// An account's stable id (config.js): its profile folder's name.
export const ACCOUNT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

export function resolveHome(env = process.env) {
  return resolve(env.BATON_HOME || homedir());
}

export function batonPaths(home) {
  const root = join(home, ".baton");
  return {
    home,
    root,
    config: join(root, "config.json"),
    install: join(root, "install.json"),
    accounts: join(root, "accounts"),
    usage: join(root, "usage"),
    rejected: join(root, "rejected"),
    sessions: join(root, "sessions"),
    wrappers: join(root, "wrappers"),
    history: join(root, "history"),
    backups: join(root, "backups"),
    logs: join(root, "logs"),
    tmp: join(root, "tmp"),
    // The shared base every profile links to, and the seed of a new
    // profile's .claude.json (never its identity, never its sign-in).
    claudeDir: join(home, ".claude"),
    claudeJson: join(home, ".claude.json"),
  };
}

export const pathsFor = (env = process.env) => batonPaths(resolveHome(env));

export const profileDir = (paths, id) => join(paths.accounts, id);

// The environment Claude Code runs with under an account's profile: its
// CLAUDE_CONFIG_DIR, whatever was set before. Baton never runs claude
// without one.
export function profileEnv(paths, id, env) {
  const out = { ...env };
  for (const key of Object.keys(out))
    if (key.toUpperCase() === "CLAUDE_CONFIG_DIR") delete out[key];
  out.CLAUDE_CONFIG_DIR = profileDir(paths, id);
  return out;
}

// Claude Code keeps a profile's global config (onboarding, trust, MCP
// servers, the signed-in account's identity) in <CLAUDE_CONFIG_DIR>/.claude.json.
export const globalConfigFile = (paths, id) =>
  join(profileDir(paths, id), ".claude.json");

export function samePath(a, b, platform = process.platform) {
  const x = resolve(a);
  const y = resolve(b);
  return platform === "win32" ? x.toLowerCase() === y.toLowerCase() : x === y;
}

export function isInside(child, parent, platform = process.platform) {
  const c = resolve(child) + sep;
  const p = resolve(parent) + sep;
  return platform === "win32"
    ? c.toLowerCase().startsWith(p.toLowerCase())
    : c.startsWith(p);
}

// Paths written into commands Claude Code runs through Git Bash need forward
// slashes (Git Bash eats unquoted backslashes).
export const forward = (path) => path.split(sep).join("/");

// The profile (its account id) a Claude Code process runs under, from its
// CLAUDE_CONFIG_DIR: a folder in ~/.baton/accounts is its name; anything
// else (plain claude without CLAUDE_CONFIG_DIR, ~/.claude, any other
// folder) is not Baton's: null. A rename changes only the label, so a
// running claude keeps resolving to the same account.
export function accountFromEnv(env, paths) {
  const dir = env.CLAUDE_CONFIG_DIR;
  if (!dir) return null;
  const resolved = resolve(dir);
  const parent = resolve(resolved, "..");
  if (!samePath(parent, paths.accounts)) return null;
  const name = resolved.slice(parent.length + 1);
  return ACCOUNT_ID_RE.test(name) ? name : null;
}
