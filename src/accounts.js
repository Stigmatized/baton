import { existsSync } from "node:fs";
import {
  ConfigError,
  MARKS,
  checkPolicyValue,
  findAccount,
  loadConfig,
  saveConfig,
} from "./config.js";
import { cleanName, idFromName, nameProblem, sameName } from "./names.js";
import { profileDir } from "./paths.js";
import { linkProfile, unlinkProfile } from "./profile.js";
import { forgetCopies } from "./copies.js";

// Account management: the operations the CLI and the TUI share. Each takes
// the paths and plain arguments, changes config.json (and the profile folder
// for add/remove) and returns data; none prints.

export class AccountError extends Error {}

// Accounts are named by their name (case-insensitive, else their id) from
// the CLI; { by: "id" } names them by id (the menu). Every result carries
// both.
const need = (config, key, by = "name") => {
  const account = findAccount(config, key, { by });
  if (account) return account;
  throw new AccountError(
    config.accounts.length
      ? `No account named ${key}.`
      : `No account named ${key}: Baton has no accounts yet (baton account add <name>).`,
  );
};

// A name is any printable text (names.js), unique ignoring case.
function checkName(config, name, self = null) {
  const problem = nameProblem(name);
  if (problem) throw new AccountError(problem);
  const clean = cleanName(name);
  const taken = config.accounts.find(
    (a) => a !== self && sameName(a.name, clean),
  );
  if (taken)
    throw new AccountError(`${taken.name} is the name of another account.`);
  return clean;
}

// A new account's id: from its name at creation (names.js idFromName: lower
// case letters, digits, - and _), made unique among the ids and the folders
// in ~/.baton/accounts. It never changes after; folders, files, hook
// arguments and environment variables use it, never the name.
function newId(paths, config, name) {
  const base = idFromName(name);
  const used = (id) =>
    config.accounts.some((a) => a.id.toLowerCase() === id.toLowerCase()) ||
    existsSync(profileDir(paths, id));
  if (!used(base)) return base;
  for (let n = 2; ; n++) if (!used(`${base}-${n}`)) return `${base}-${n}`;
}

function checkMark(mark) {
  if (!MARKS.includes(mark))
    throw new AccountError(`A mark is one of ${MARKS.join(", ")}.`);
  return mark;
}

function checkThreshold(value, what) {
  if (value == null) return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 1 || n > 100)
    throw new AccountError(`${what} takes a percentage from 1 to 100.`);
  return n;
}

export function addAccount(
  paths,
  name,
  { mark = null, position = null, fileLinks = null } = {},
) {
  const config = loadConfig(paths);
  name = checkName(config, name);
  const account = {
    id: newId(paths, config, name),
    name,
    mark: checkMark(mark ?? "normal"),
    fiveHour: null,
    weekly: null,
  };
  const at = position == null ? config.accounts.length : Number(position) - 1;
  if (!Number.isInteger(at) || at < 0 || at > config.accounts.length)
    throw new AccountError(
      `--position takes 1 to ${config.accounts.length + 1}.`,
    );
  config.accounts.splice(at, 0, account);
  const existed = existsSync(profileDir(paths, account.id));
  const links = linkProfile(paths, account.id, { fileLinks });
  saveConfig(paths, config);
  return {
    account,
    position: at + 1,
    profile: profileDir(paths, account.id),
    existed,
    links,
  };
}

// A rename changes only the label: the id, the profile folder (which a
// running claude may use as CLAUDE_CONFIG_DIR), the files and the history
// stay, and everything shows the new name from then on.
export function renameAccount(paths, key, newName, { by = "name" } = {}) {
  const config = loadConfig(paths);
  const account = need(config, key, by);
  const from = account.name;
  account.name = checkName(config, newName, account);
  saveConfig(paths, config);
  return { id: account.id, from, to: account.name };
}

// Removing an account takes it out of Baton: never listed, picked, polled
// or launched under again. Its profile folder (with its sign-in) stays. The
// last account cannot go.
export function removeAccount(paths, key, { by = "name" } = {}) {
  const config = loadConfig(paths);
  const account = need(config, key, by);
  if (config.accounts.length === 1)
    throw new AccountError(
      `${account.name} is the only account and Baton needs one: add another (baton account add <name>) before removing it.`,
    );
  config.accounts = config.accounts.filter((a) => a !== account);
  const unlinked = unlinkProfile(paths, account.id);
  forgetCopies(paths, account.id);
  saveConfig(paths, config);
  return {
    id: account.id,
    name: account.name,
    profile: profileDir(paths, account.id),
    unlinked,
  };
}

// New order: the accounts given first, in that order; the rest keep theirs.
export function orderAccounts(paths, keys, { by = "name" } = {}) {
  const config = loadConfig(paths);
  const first = keys.map((k) => need(config, k, by));
  if (new Set(first).size !== first.length)
    throw new AccountError("An account appears twice.");
  const rest = config.accounts.filter((a) => !first.includes(a));
  config.accounts = [...first, ...rest];
  saveConfig(paths, config);
  return { order: config.accounts.map((a) => a.name) };
}

export function moveAccount(paths, key, position, { by = "name" } = {}) {
  const config = loadConfig(paths);
  const account = need(config, key, by);
  const at = Number(position) - 1;
  if (!Number.isInteger(at) || at < 0 || at >= config.accounts.length)
    throw new AccountError(`A position is 1 to ${config.accounts.length}.`);
  config.accounts = config.accounts.filter((a) => a !== account);
  config.accounts.splice(at, 0, account);
  saveConfig(paths, config);
  return { order: config.accounts.map((a) => a.name) };
}

// set: { mark, lastResort (true|false), fiveHour, weekly } (null clears a
// threshold override back to the policy default).
export function setAccount(paths, key, changes, { by = "name" } = {}) {
  const config = loadConfig(paths);
  const account = need(config, key, by);
  if (changes.mark !== undefined) account.mark = checkMark(changes.mark);
  if (changes.lastResort !== undefined)
    account.mark = changes.lastResort
      ? "last-resort"
      : account.mark === "last-resort"
        ? "normal"
        : account.mark;
  if (changes.fiveHour !== undefined)
    account.fiveHour = checkThreshold(changes.fiveHour, "--five-hour");
  if (changes.weekly !== undefined)
    account.weekly = checkThreshold(changes.weekly, "--weekly");
  saveConfig(paths, config);
  return { account };
}

export function setPolicy(paths, changes) {
  const config = loadConfig(paths);
  for (const [key, value] of Object.entries(changes)) {
    if (value === undefined) continue;
    try {
      if (value === null) delete config.policy[key];
      else config.policy[key] = checkPolicyValue(key, value);
    } catch (error) {
      throw new AccountError(
        error instanceof ConfigError ? error.message : String(error),
      );
    }
  }
  saveConfig(paths, config);
  return { policy: config.policy };
}
