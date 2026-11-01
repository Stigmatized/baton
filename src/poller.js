import { join } from "node:path";
import { resolveClaude } from "./claude-path.js";
import { effectivePolicy, loadConfig, nameOf } from "./config.js";
import { iso, ms, readJson, writeJsonAtomic } from "./fsutil.js";
import { profileEnv } from "./paths.js";
import { PROBE_TIMEOUT_MS, readPlanUsage } from "./probe.js";
import { recordReading } from "./usage.js";

// The usage poller: asks every signed-in account's plan usage (probe.js)
// and records it exactly like the status line does (usage/<id>.json and
// the readings history), with source "poll". It runs only inside a running
// baton instance (the menu, a baton session wrapper; poll-host.js elects one of
// them): when that instance starts if the last poll is older than
// usagePollMinutes, every usagePollMinutes, after an account is added,
// signed in or renamed, and on request (the menu's r; baton usage --refresh
// polls in its own process and exits). One account at a time, in the order
// of the accounts.
//
// ~/.baton/poll/state.json: { lastRunAt, running: { account, since } |
// null, accounts: { <id>: { at, status, reason, okAt, backoffUntil,
// backoffMs, failures } } }. status is ok, unavailable (the plan usage could
// not be fetched; the reason says why), rate-limited (the usage endpoint
// refused: Baton waits until the time it named, else 5 minutes, doubling up
// to 2 hours, before asking that account again), timeout, failed or
// signed-out (not asked).

export const BACKOFF_FIRST_MS = 5 * 60e3;
export const BACKOFF_MAX_MS = 2 * 3600e3;
const UNTIL_MAX_MS = 24 * 3600e3;

export const pollFile = (paths) => join(paths.root, "poll", "state.json");

export function readPollState(paths) {
  const raw = readJson(pollFile(paths), {});
  return {
    lastRunAt: typeof raw?.lastRunAt === "string" ? raw.lastRunAt : null,
    running:
      raw?.running && typeof raw.running === "object" ? raw.running : null,
    accounts:
      raw?.accounts && typeof raw.accounts === "object" ? raw.accounts : {},
  };
}

export const pollEveryMs = (policy) =>
  policy.usagePollMinutes > 0 ? policy.usagePollMinutes * 60e3 : null;

// When the next scheduled poll runs: the last run plus the interval (now,
// when none ran yet), or null when no baton instance runs (running: false)
// or the interval is 0.
export function nextPollAt(
  poll,
  policy,
  { running = true, now = Date.now() } = {},
) {
  const every = pollEveryMs(policy);
  if (!running || !every) return null;
  const last = ms(poll?.lastRunAt);
  return last === null ? now : Math.max(now, last + every);
}

export class Poller {
  constructor({
    paths,
    env = process.env,
    now = Date.now,
    query = null,
    probe = readPlanUsage,
    auth = null,
    launcher = null,
    timeoutMs = PROBE_TIMEOUT_MS,
    log = () => {},
    platform = process.platform,
    // For scheduled polls: whether this process may still poll (it holds
    // the poll lease); asked before each account.
    may = null,
    // Claude Code's processes at a low priority (the baton session wrapper).
    low = false,
  }) {
    this.may = may;
    this.low = low;
    this.paths = paths;
    this.env = env;
    this.now = now;
    this.query = query;
    this.probe = probe;
    this.authOf = auth;
    this.launcherOverride = launcher;
    this.timeoutMs = timeoutMs;
    this.log = log;
    this.platform = platform;
    this.queue = Promise.resolve();
    this.pending = 0;
    this.stopped = false;
    this.controller = new AbortController();
  }

  state() {
    return readPollState(this.paths);
  }

  save(change) {
    const state = this.state();
    change(state);
    writeJsonAtomic(pollFile(this.paths), state);
    return state;
  }

  // Stops: a read in progress ends at once (its claude with it); resolves
  // once nothing runs any more.
  stop() {
    this.stopped = true;
    this.controller.abort();
    return this.queue;
  }

  // A scheduled poll of every account when one is due (and none is queued).
  tick() {
    if (this.stopped || this.pending) return null;
    const policy = effectivePolicy(loadConfig(this.paths));
    const every = pollEveryMs(policy);
    if (!every) return null;
    const last = ms(this.state().lastRunAt);
    if (last !== null && this.now() - last < every) return null;
    return this.refresh({ reason: "schedule" });
  }

  // Polls one account (its id) or all; resolves with an outcome per
  // account once they are done. Requests wait their turn.
  refresh({ account = null, reason = "request" } = {}) {
    this.pending++;
    const run = this.queue.then(() => this.run(account, reason));
    this.queue = run.catch(() => {});
    return run.finally(() => {
      this.pending--;
    });
  }

  async run(account, reason) {
    const config = loadConfig(this.paths);
    const ids = account ? [account] : config.accounts.map((a) => a.id);
    if (!account)
      this.save((s) => {
        s.lastRunAt = iso(this.now());
      });
    const results = [];
    try {
      for (const id of ids) {
        if (this.stopped) break;
        if (reason === "schedule" && this.may && !this.may()) break;
        results.push(await this.pollOne(id, reason));
      }
    } finally {
      this.save((s) => {
        s.running = null;
      });
    }
    return results;
  }

  launcher() {
    return (
      this.launcherOverride ??
      resolveClaude({
        configured: loadConfig(this.paths).claudePath,
        env: this.env,
        home: this.paths.home,
      })
    );
  }

  async signedIn(id, launcher) {
    if (this.authOf) return this.authOf(id, launcher);
    const { authStatusAsync } = await import("./doctor.js");
    return authStatusAsync(launcher, profileEnv(this.paths, id, this.env), {
      low: this.low,
    });
  }

  async pollOne(id, reason) {
    const config = loadConfig(this.paths);
    const account = config.accounts.find((a) => a.id === id);
    const name = nameOf(config, id);
    if (!account)
      return {
        id,
        name,
        status: "unknown",
        reason: "not one of Baton's accounts",
      };
    const at = this.now();
    const before = this.state().accounts[id] ?? {};
    const until = ms(before.backoffUntil);
    if (until !== null && until > at)
      return {
        id,
        name,
        status: "backoff",
        until: before.backoffUntil,
        reason: before.reason ?? null,
      };
    this.save((s) => {
      s.running = { account: id, since: iso(at), reason };
    });
    let launcher;
    try {
      launcher = this.launcher();
    } catch (error) {
      return this.record(
        id,
        name,
        { status: "failed", reason: error.message },
        at,
      );
    }
    const auth = await this.signedIn(id, launcher).catch(() => null);
    if (auth?.ok && auth.loggedIn === false)
      return this.record(
        id,
        name,
        { status: "signed-out", reason: `not signed in: baton login ${name}` },
        at,
      );
    const outcome = await this.probe({
      paths: this.paths,
      id,
      env: this.env,
      claudePath: launcher.path,
      query: this.query,
      timeoutMs: this.timeoutMs,
      now: this.now,
      platform: this.platform,
      signal: this.controller.signal,
      low: this.low,
    });
    if (this.stopped) return { id, name, status: "stopped" };
    return this.record(id, name, outcome, this.now());
  }

  record(id, name, outcome, at) {
    const before = this.state().accounts[id] ?? {};
    const entry = {
      at: iso(at),
      status: outcome.status,
      reason: outcome.reason ?? null,
      okAt: before.okAt ?? null,
      backoffUntil: null,
      backoffMs: null,
      failures: 0,
    };
    let reading = null;
    if (outcome.status === "ok") {
      reading =
        recordReading(this.paths, id, outcome.reading, {
          at,
          source: "poll",
          refreshMs: 0,
          limits: outcome.limits ?? null,
          extraUsage: outcome.extraUsage ?? null,
        }).reading ?? null;
      entry.okAt = iso(at);
    } else if (outcome.status !== "signed-out") {
      entry.failures = (before.failures ?? 0) + 1;
      if (outcome.status === "rate-limited") {
        if (outcome.until) {
          entry.backoffUntil = iso(Math.min(outcome.until, at + UNTIL_MAX_MS));
        } else {
          entry.backoffMs = Math.min(
            before.backoffMs ? before.backoffMs * 2 : BACKOFF_FIRST_MS,
            BACKOFF_MAX_MS,
          );
          entry.backoffUntil = iso(at + entry.backoffMs);
        }
      }
    }
    this.save((s) => {
      s.accounts[id] = entry;
    });
    this.log(
      `${name}: ${entry.status}${entry.reason ? ` (${entry.reason})` : ""}${entry.backoffUntil ? `; next ask after ${entry.backoffUntil}` : ""}`,
    );
    return { id, name, ...entry, reading };
  }
}
