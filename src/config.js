import { ACCOUNT_ID_RE } from "./paths.js";
import { readJson, writeJsonAtomic } from "./fsutil.js";
import { cleanName, idFromName, sameName, validName } from "./names.js";

// ~/.baton/config.json: the accounts the operator added, in priority order,
// with their marks and threshold overrides, and the policy settings. There
// is no built-in account: Baton never interacts with the default Claude Code
// account.
export const CONFIG_VERSION = 1;

export const MARKS = ["preferred", "normal", "last-resort"];
export const MODES = ["smart", "order"];
export const END_METHODS = ["auto", "keys", "signal", "kill"];

// Every number the policy uses, with its default. Percentages are of a
// window's limit; times as named.
export const POLICY_DEFAULTS = Object.freeze({
  mode: "smart",
  fiveHour: 90, // 5-hour threshold: an account at or above it is blocked
  weekly: 95, // weekly threshold
  startReserve: 20, // 5-hour headroom an account needs to take new work
  planFactor: 1.5, // planned hop when headroom < planFactor x next-turn cost
  costSamples: 5, // turns in the moving average of a session's cost
  minStayMinutes: 30, // no planned or compaction hop sooner after arriving
  waitInPlaceMinutes: 20, // a 5-hour refusal resetting this soon waits in place
  waitInPlaceMaxHours: 24, // all blocked: the current account waits in place up to this
  rebalanceHorizonMinutes: 60, // compaction rebalance: blocked within this at the burn rate
  rebalanceMargin: 20, // ...and another account has this much more effective headroom
  burnWindowMinutes: 60, // readings used for a session's burn rate
  unknownRejectionHours: 5, // a refusal with no known reset blocks at most this long
  countdownSeconds: 10, // before an automatic hop
  maxReblocks: 3, // refusals right after a resume before Baton backs off
  reblockBackoffMinutes: 15,
  settleMs: 800, // wait after a turn ends for the last status line reading
  compactionRebalance: true, // rebalance at the cheap moment after a compaction
  usagePollMinutes: 30, // a running baton instance asks every signed-in account's usage this often (0: only on request)
  statusLineUsage: false, // add Baton's usage after the operator's own status line
});
const BOOLEANS = ["compactionRebalance", "statusLineUsage"];

const NUMBER_LIMITS = {
  fiveHour: [1, 100],
  weekly: [1, 100],
  startReserve: [0, 100],
  planFactor: [0, 100],
  costSamples: [1, 100],
  minStayMinutes: [0, 10080],
  waitInPlaceMinutes: [0, 10080],
  waitInPlaceMaxHours: [0, 168],
  rebalanceHorizonMinutes: [0, 10080],
  rebalanceMargin: [0, 100],
  burnWindowMinutes: [1, 10080],
  unknownRejectionHours: [0, 168],
  countdownSeconds: [0, 600],
  maxReblocks: [0, 100],
  reblockBackoffMinutes: [0, 10080],
  settleMs: [0, 60000],
  usagePollMinutes: [0, 1440],
};

export class ConfigError extends Error {}

export function checkPolicyValue(key, value) {
  if (key === "mode") {
    if (!MODES.includes(value))
      throw new ConfigError(`mode is one of ${MODES.join(", ")}.`);
    return value;
  }
  if (BOOLEANS.includes(key)) {
    const word = String(value).toLowerCase();
    if (value === true || ["true", "on", "yes", "1"].includes(word))
      return true;
    if (value === false || ["false", "off", "no", "0"].includes(word))
      return false;
    throw new ConfigError(`${key} is true or false.`);
  }
  if (!(key in NUMBER_LIMITS)) throw new ConfigError(`Unknown setting ${key}.`);
  const n = Number(value);
  const [lo, hi] = NUMBER_LIMITS[key];
  if (!Number.isFinite(n) || n < lo || n > hi)
    throw new ConfigError(`${key} takes a number from ${lo} to ${hi}.`);
  return n;
}

// An account has a stable id and a name. The id keys everything on disk
// (its profile folder ~/.baton/accounts/<id>, usage/<id>.json, the history,
// the sessions, the copies) and is what the hooks resolve from
// CLAUDE_CONFIG_DIR; the name is a label the operator can change at any
// time (names.js: any printable text).
export { ACCOUNT_ID_RE };

function normalizeAccount(raw) {
  if (!raw || typeof raw !== "object") return null;
  // Without an id (edited by hand): the name when it can be one, else one
  // made from it.
  const id =
    typeof raw.id === "string" && ACCOUNT_ID_RE.test(raw.id)
      ? raw.id
      : typeof raw.name === "string" && ACCOUNT_ID_RE.test(raw.name)
        ? raw.name
        : validName(raw.name)
          ? idFromName(raw.name)
          : null;
  if (!id) return null;
  const name = validName(raw.name) ? cleanName(raw.name) : id;
  const mark = MARKS.includes(raw.mark)
    ? raw.mark
    : raw.lastResort
      ? "last-resort"
      : "normal";
  const threshold = (v) =>
    v == null || !Number.isFinite(Number(v)) ? null : Number(v);
  return {
    id,
    name,
    mark,
    fiveHour: threshold(raw.fiveHour),
    weekly: threshold(raw.weekly),
  };
}

export function normalizeConfig(raw) {
  const accounts = [];
  for (const entry of Array.isArray(raw?.accounts) ? raw.accounts : []) {
    const account = normalizeAccount(entry);
    if (
      account &&
      !accounts.some(
        (a) => a.id === account.id || sameName(a.name, account.name),
      )
    )
      accounts.push(account);
  }
  const policy = {};
  for (const [key, value] of Object.entries(raw?.policy ?? {})) {
    try {
      policy[key] = checkPolicyValue(key, value);
    } catch {
      // An unknown or out-of-range setting falls back to its default.
    }
  }
  return {
    version: CONFIG_VERSION,
    accounts,
    policy,
    endMethod: END_METHODS.includes(raw?.endMethod) ? raw.endMethod : "auto",
    claudePath: typeof raw?.claudePath === "string" ? raw.claudePath : null,
  };
}

// Reads config.json (what is missing or invalid falls back to its default).
export const loadConfig = (paths) =>
  normalizeConfig(readJson(paths.config, null) ?? {});

// An account by its name (case-insensitive), else by its id (the CLI);
// by: "id" finds by id only (the menu, the lead).
export function findAccount(config, key, { by = "name" } = {}) {
  if (key == null) return null;
  if (by === "id") return config.accounts.find((a) => a.id === key) ?? null;
  return (
    config.accounts.find((a) => sameName(a.name, key)) ??
    config.accounts.find((a) => a.id === key) ??
    null
  );
}
export const nameOf = (config, id) =>
  config.accounts.find((a) => a.id === id)?.name ?? id;

export function saveConfig(paths, config) {
  const out = {
    version: CONFIG_VERSION,
    accounts: config.accounts.map((a) => ({
      id: a.id,
      name: a.name,
      mark: a.mark,
      ...(a.fiveHour != null ? { fiveHour: a.fiveHour } : {}),
      ...(a.weekly != null ? { weekly: a.weekly } : {}),
    })),
    policy: config.policy,
    ...(config.endMethod !== "auto" ? { endMethod: config.endMethod } : {}),
    ...(config.claudePath ? { claudePath: config.claudePath } : {}),
  };
  writeJsonAtomic(paths.config, out);
}

export const effectivePolicy = (config) => ({
  ...POLICY_DEFAULTS,
  ...config.policy,
});

export function thresholds(account, policy) {
  return {
    five_hour: account.fiveHour ?? policy.fiveHour,
    seven_day: account.weekly ?? policy.weekly,
  };
}
