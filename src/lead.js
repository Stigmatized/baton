import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { isSessionId, parseClaudeArgs, resumeArgs } from "./claude-args.js";
import { resolveClaude } from "./claude-path.js";
import { keyPrompt } from "./countdown.js";
import { loadConfig, nameOf } from "./config.js";
import { iso, ms, readJson, writeJsonAtomic } from "./fsutil.js";
import { profileDir } from "./paths.js";
import {
  burnRate,
  decideTurnEnd,
  decideWait,
  pickStart,
  turnCost,
} from "./policy.js";
import { carryTrust, linkProfile } from "./profile.js";
import { continuePrompt, hopLine, stayPrompt, waitLine } from "./prompts.js";
import {
  acquireLock,
  pruneSessions,
  readSessionFile,
  readTurnSamples,
  releaseLock,
  removeWrapper,
  validId,
  wrapperFile,
  wrapperSessionFile,
} from "./sessions.js";
import { loadSnapshot } from "./state.js";
import { NO_ACCOUNTS } from "./format.js";
import { PollHost } from "./poll-host.js";
import { endClaude } from "./terminate.js";
import { notice, terminalFor } from "./term.js";
import { LIMIT_ERRORS, recordEvent } from "./usage.js";

// The lead wrapper (`baton [claude args]`): starts `claude` under the
// picked account with the terminal attached and stays its parent. It learns
// the conversation from the SessionStart hook (BATON_WRAPPER ties the hook to
// this wrapper), holds the session's lock, follows the turns through the
// files the hooks write, and at a turn end asks the policy (policy.js
// decideTurnEnd) whether to stay, wait in place, hop or wait for an account.
// To hop it ends claude (terminate.js), shows one line with a countdown, and
// resumes the same conversation with `claude --resume <id> "<continue
// prompt>"` under the next account. Ctrl+C belongs to claude: Baton ignores
// SIGINT/SIGBREAK while claude runs (claude, in the same console and process
// group, gets them itself).

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function runLead(options) {
  return new Lead(options).run();
}

export class Lead {
  constructor({
    args = [],
    paths,
    env = process.env,
    cwd = process.cwd(),
    claude = null,
    spawnClaude = (command, argv, opts) => spawn(command, argv, opts),
    end = null,
    input = process.stdin,
    output = process.stderr,
    signals = process,
    now = Date.now,
    pollMs = 250,
    tickMs = 1000,
    countdownSeconds = null,
    settleMs = null,
    stdio = "inherit",
    platform = process.platform,
    // The wrapper is a baton instance: while it runs it takes its turn at
    // the usage poll, silently, at a low priority and never in the way of
    // the session (poll-host.js); poll: false (tests) leaves it out.
    poll = true,
  }) {
    this.pollEnabled = poll;
    this.pollHost = null;
    this.args = args;
    this.paths = paths;
    this.env = env;
    this.cwd = cwd;
    this.claude = claude;
    this.spawnClaude = spawnClaude;
    this.endOverride = end;
    this.input = input;
    this.output = output;
    this.term = terminalFor(output, env);
    this.signals = signals;
    this.now = now;
    this.pollMs = pollMs;
    this.tickMs = tickMs;
    this.countdownOverride = countdownSeconds;
    this.settleOverride = settleMs;
    this.stdio = stdio;
    this.platform = platform;
    this.parsed = parseClaudeArgs(args);
    this.wrapper = `${process.pid}-${randomBytes(4).toString("hex")}`;
    this.sessionId = isSessionId(this.parsed.session.id)
      ? this.parsed.session.id
      : null;
    this.account = null;
    this.arrivedAt = null;
    this.launchedAt = 0;
    this.lastTurnAt = 0;
    this.lastStopAt = 0;
    this.lastHopAt = 0;
    this.permissionMode = null;
    this.stayUntil = 0;
    this.vetoUntil = 0;
    this.reblocks = 0;
    this.resumedByBaton = false;
    this.okSinceResume = false;
    this.state = "starting";
    this.events = []; // what happened, for tests and the log
  }

  // An account's current name (the operator may rename it while this runs).
  label(id) {
    try {
      return nameOf(loadConfig(this.paths), id);
    } catch {
      return id;
    }
  }

  say(line) {
    this.output.write(`${notice(line, this.term)}\n`);
  }

  log(message, data = {}) {
    const entry = { at: iso(this.now()), message, ...data };
    this.events.push(entry);
    try {
      mkdirSync(this.paths.logs, { recursive: true });
      appendFileSync(
        join(this.paths.logs, `lead-${this.wrapper}.log`),
        JSON.stringify(entry) + "\n",
      );
    } catch {
      // logging never stops the session
    }
  }

  register(extra = {}) {
    try {
      writeJsonAtomic(wrapperFile(this.paths, this.wrapper), {
        pid: process.pid,
        wrapper: this.wrapper,
        account: this.account,
        session: this.sessionId,
        startedAt: iso(this.startedAt ?? this.now()),
        cwd: this.cwd,
        state: this.state,
        ...extra,
      });
    } catch {
      // the registry is informational
    }
  }

  launcher() {
    if (!this.claude) {
      const { config } = loadSnapshot(this.paths, { now: this.now() });
      this.claude = resolveClaude({
        configured: config.claudePath,
        env: this.env,
        platform: this.platform,
        home: this.paths.home,
      });
    }
    return this.claude;
  }

  profileEnv(account) {
    const env = { ...this.env };
    for (const key of Object.keys(env))
      if (key.toUpperCase() === "CLAUDE_CONFIG_DIR") delete env[key];
    // Always a profile of Baton's: never the default Claude Code account.
    env.CLAUDE_CONFIG_DIR = profileDir(this.paths, account);
    env.BATON_WRAPPER = this.wrapper;
    return env;
  }

  prepare(account) {
    try {
      const report = linkProfile(this.paths, account);
      const problems = report.filter((r) =>
        ["conflict", "removed-unsafe-link"].includes(r.action),
      );
      if (problems.length) this.log("profile problems", { account, problems });
    } catch (error) {
      this.say(
        `baton: could not refresh the ${this.label(account)} profile: ${error.message}`,
      );
    }
  }

  async run() {
    const ignore = () => {};
    const signalNames =
      this.platform === "win32"
        ? ["SIGINT", "SIGBREAK"]
        : ["SIGINT", "SIGQUIT"];
    for (const name of signalNames) this.signals.on(name, ignore);
    this.startedAt = this.now();
    try {
      return await this.main();
    } finally {
      for (const name of signalNames) this.signals.off(name, ignore);
      if (this.sessionId) releaseLock(this.paths, this.sessionId, this.wrapper);
      removeWrapper(this.paths, this.wrapper);
      // The poll goes with the wrapper: its lease, and a read in progress.
      await this.pollHost?.stop().catch(() => {});
    }
  }

  async main() {
    if (!loadConfig(this.paths).accounts.length) {
      this.say(`baton: ${NO_ACCOUNTS}`);
      return 1;
    }
    let launcher;
    try {
      launcher = this.launcher();
    } catch (error) {
      this.say(`baton: ${error.message}`);
      return 1;
    }
    if (this.pollEnabled)
      this.pollHost = new PollHost({
        paths: this.paths,
        kind: "start",
        env: this.env,
        launcher,
        low: true,
      }).start();
    try {
      pruneSessions(this.paths, { now: this.now() });
    } catch {
      // housekeeping only
    }
    const snapshot = loadSnapshot(this.paths, { now: this.now() });
    const pick = pickStart(snapshot.states, snapshot.policy);
    let account = pick.account;
    if (!account) {
      account = pick.earliest ?? snapshot.states[0].id;
      this.say(
        `baton: every account is at its limit; starting on ${this.label(account)}, the first back${pick.availableKnown ? ` (${new Date(pick.availableAt).toLocaleTimeString()})` : ""}. Claude Code's own wait applies.`,
      );
    }
    if (!this.parsed.interactive) return this.passthrough(launcher, account);
    if (this.sessionId) {
      const lock = acquireLock(
        this.paths,
        this.sessionId,
        this.lockOwner(account),
      );
      if (!lock.ok) {
        this.say(
          `baton: conversation ${this.sessionId} is already running under baton (pid ${lock.holder?.pid ?? "?"}); one conversation runs in one process at a time.`,
        );
        return 1;
      }
    }
    let launch = { account, args: this.args, cwd: this.cwd, reason: "start" };
    for (;;) {
      const outcome = await this.runClaude(launcher, launch);
      if (outcome.type === "exit") return outcome.code;
      const next = await this.afterEnd(outcome);
      if (next.type === "quit") return next.code;
      launch = this.resumeLaunch(next);
    }
  }

  lockOwner(account) {
    return {
      pid: process.pid,
      wrapper: this.wrapper,
      at: iso(this.now()),
      account,
    };
  }

  async passthrough(launcher, account) {
    this.prepare(account);
    const child = this.spawn(launcher, account, this.args, this.cwd);
    if (!child) return 1;
    const { code } = await new Promise((resolve) =>
      child.once("exit", (c, signal) =>
        resolve({ code: c ?? (signal ? 1 : 0) }),
      ),
    );
    return code;
  }

  spawn(launcher, account, args, cwd) {
    try {
      const child = this.spawnClaude(
        launcher.command,
        [...launcher.prefix, ...args],
        {
          env: this.profileEnv(account),
          cwd,
          stdio: this.stdio,
          windowsHide: false,
        },
      );
      child.on("error", (error) =>
        this.log("spawn error", { error: error.message }),
      );
      return child;
    } catch (error) {
      this.say(`baton: could not start claude: ${error.message}`);
      return null;
    }
  }

  async runClaude(launcher, launch) {
    if (launch.from && launch.from !== launch.account)
      try {
        carryTrust(this.paths, launch.from, launch.account, launch.cwd);
      } catch (error) {
        this.log("trust carry failed", { error: error.message });
      }
    this.prepare(launch.account);
    if (this.account !== launch.account) this.arrivedAt = this.now();
    this.account = launch.account;
    this.launchedAt = this.now();
    this.state = "running";
    this.register();
    this.log("launch", {
      account: launch.account,
      args: launch.args,
      reason: launch.reason,
    });
    const child = this.spawn(launcher, launch.account, launch.args, launch.cwd);
    if (!child) return { type: "exit", code: 1 };
    let exitInfo = null;
    const exited = new Promise((resolve) => {
      child.once("exit", (code, signal) => {
        exitInfo = { code, signal };
        resolve(exitInfo);
      });
      child.once("error", (error) => {
        exitInfo = { code: 1, signal: null, error };
        resolve(exitInfo);
      });
    });
    while (!exitInfo) {
      await Promise.race([exited, sleep(this.pollMs)]);
      if (exitInfo) break;
      let decision = null;
      try {
        decision = await this.poll(() => exitInfo !== null);
      } catch (error) {
        this.log("poll error", { error: error.message, stack: error.stack });
      }
      if (!decision || exitInfo) continue;
      this.state = "ending";
      this.register({ decision: decision.type, target: decision.to ?? null });
      this.log("ending claude", { decision });
      const { config } = loadSnapshot(this.paths, { now: this.now() });
      const end =
        this.endOverride ??
        ((c) =>
          endClaude(c, { method: config.endMethod, platform: this.platform }));
      const result = await end(child);
      await exited;
      this.log("claude ended", { result, exit: exitInfo });
      return { type: decision.type, decision, end: result };
    }
    if (exitInfo.error)
      this.say(`baton: claude could not run: ${exitInfo.error.message}`);
    this.log("claude exited", { exit: exitInfo });
    return { type: "exit", code: exitInfo.code ?? (exitInfo.signal ? 1 : 0) };
  }

  switchSession(id) {
    if (this.sessionId === id) return;
    if (this.sessionId) releaseLock(this.paths, this.sessionId, this.wrapper);
    const lock = acquireLock(this.paths, id, this.lockOwner(this.account));
    if (!lock.ok)
      this.log("session lock held elsewhere", {
        session: id,
        holder: lock.holder,
      });
    const previous = this.sessionId;
    this.sessionId = id;
    this.register();
    this.log("session", { session: id, previous });
  }

  // One look at the session's files. Returns a decision to end claude
  // (type hop|wait) or null.
  async poll(isExited) {
    const mapped = readJson(wrapperSessionFile(this.paths, this.wrapper));
    if (mapped && validId(mapped.session) && mapped.session !== this.sessionId)
      this.switchSession(mapped.session);
    const id = this.sessionId;
    if (!id) return null;
    let turn = readSessionFile(this.paths, id, "turn.json");
    const hop = readSessionFile(this.paths, id, "hop.json");
    const turnAt = ms(turn?.at) ?? 0;
    const hopAt = ms(hop?.at) ?? 0;
    if (turn?.permissionMode && turnAt >= this.launchedAt)
      this.permissionMode = turn.permissionMode;
    const pendingHop =
      hop && hopAt > this.lastHopAt && hopAt >= this.launchedAt ? hop : null;
    const freshTurnEnd =
      turn &&
      turn.state === "idle" &&
      turnAt > this.lastTurnAt &&
      turnAt >= this.launchedAt;
    const running = turn?.state === "running" && turnAt >= this.launchedAt;
    if (!freshTurnEnd && !(pendingHop && !running)) return null;

    let event = null;
    let failure = null;
    if (freshTurnEnd) {
      this.lastTurnAt = turnAt;
      event = turn.event;
      failure =
        turn.event === "stop-failure"
          ? { error: turn.error, window: turn.window, until: turn.until }
          : null;
      if (event === "stop") {
        this.okSinceResume = true;
        this.reblocks = 0;
      }
      if (
        event === "stop-failure" &&
        LIMIT_ERRORS.includes(turn.error) &&
        this.resumedByBaton &&
        !this.okSinceResume
      )
        this.reblocks++;
    }
    if (pendingHop) this.lastHopAt = hopAt;

    const policyNow = loadSnapshot(this.paths, { now: this.now() }).policy;
    if (event === "stop" && !pendingHop) {
      // Let the last status line reading of the turn land, and give up if a
      // new turn starts meanwhile.
      const settle = this.settleOverride ?? policyNow.settleMs;
      if (settle > 0) await sleep(settle);
      if (isExited()) return null;
      turn = readSessionFile(this.paths, id, "turn.json");
      if ((ms(turn?.at) ?? 0) > this.lastTurnAt) return null;
    }

    const now = this.now();
    const snapshot = loadSnapshot(this.paths, { now });
    const samples = readTurnSamples(this.paths, id);
    const live = readSessionFile(this.paths, id, "live.json");
    if (
      live?.reading &&
      live.account === this.account &&
      (ms(live.at) ?? 0) > (ms(samples.at(-1)?.at) ?? 0)
    )
      samples.push({ at: live.at, account: live.account, ...live.reading });
    const compact = readSessionFile(this.paths, id, "compact.json");
    const compacted =
      (ms(compact?.at) ?? 0) > this.lastStopAt &&
      (ms(compact?.at) ?? 0) >= this.launchedAt;
    const decision = decideTurnEnd({
      now,
      policy: snapshot.policy,
      states: snapshot.states,
      current: this.account,
      event: event ?? "idle",
      failure,
      hopRequest: pendingHop ? { to: pendingHop.to || null } : null,
      session: {
        arrivedAt: this.arrivedAt,
        stayUntil: this.stayUntil,
        vetoUntil: this.vetoUntil,
        reblocks: this.reblocks,
        compacted,
        backgroundTasks: turn?.backgroundTasks ?? [],
        cost: turnCost(samples, snapshot.policy),
        burn: burnRate(samples, snapshot.policy, now),
      },
    });
    if (event === "stop") this.lastStopAt = turnAt;
    this.log("turn end", { event, failure, hopRequest: pendingHop, decision });
    if (decision.type === "hop" || decision.type === "wait")
      return {
        ...decision,
        failure,
        from: this.account,
        states: snapshot.states,
        policy: snapshot.policy,
      };
    return null;
  }

  // After claude was ended: the countdown or the wait, then where to resume.
  async afterEnd(outcome) {
    const d = outcome.decision;
    const from = this.account;
    const policy = d.policy;
    const window = d.failure?.window ?? d.windows?.[0] ?? null;
    const until = ms(d.failure?.until);
    if (d.type === "hop") {
      const seconds = this.countdownOverride ?? policy.countdownSeconds;
      if (!d.countdown || seconds <= 0) {
        this.say(
          hopLine({
            from: this.label(from),
            to: this.label(d.to),
            reason: d.reason,
            window,
            until,
            now: this.now(),
          }),
        );
        return {
          type: "resume",
          to: d.to,
          reason: d.reason,
          from,
          window,
          until,
        };
      }
      this.state = "countdown";
      this.register({ target: d.to });
      const deadline = this.now() + seconds * 1000;
      const result = await keyPrompt({
        input: this.input,
        output: this.output,
        tickMs: Math.min(this.tickMs, 1000),
        now: this.now,
        onTick: (t) =>
          t >= deadline
            ? { result: "go" }
            : {
                line: notice(
                  hopLine({
                    from: this.label(from),
                    to: this.label(d.to),
                    reason: d.reason,
                    window,
                    until,
                    now: t,
                    seconds: Math.ceil((deadline - t) / 1000),
                  }),
                  this.term,
                ),
              },
      });
      if (result === "quit") return this.quit();
      if (result === "stay") return this.stay(from, d, window, until);
      return {
        type: "resume",
        to: d.to,
        reason: d.reason,
        from,
        window,
        until,
      };
    }
    // wait: every account is blocked (or the readings proved wrong).
    this.state = "waiting";
    let target = d.to;
    let at = d.at;
    this.register({ target, until: iso(at) });
    const result = await keyPrompt({
      input: this.input,
      output: this.output,
      tickMs: this.tickMs,
      now: this.now,
      onTick: (t) => {
        // Fresh readings every tick: another session may report an earlier reset.
        const snapshot = loadSnapshot(this.paths, { now: t });
        if (d.reason !== "reblocked" || t >= at) {
          const w = decideWait({
            states: snapshot.states,
            policy: snapshot.policy,
            target,
            at,
          });
          if (w.type === "resume") return { result: { go: w.to } };
          if (w.to !== target || w.at !== at) {
            target = w.to;
            at = w.at;
            this.register({ target, until: iso(at) });
          }
          if (at <= t) at = t + 60e3; // not open yet although due: look again in a minute
        }
        const state = snapshot.states.find((s) => s.id === target);
        const blocking =
          state?.blockedBy.length === 1 && state.blockedBy[0] !== "unknown"
            ? state.blockedBy[0]
            : null;
        return {
          line: notice(
            waitLine({
              total: snapshot.states.length,
              to: this.label(target),
              window: blocking,
              at,
              now: t,
              reason: d.reason,
            }),
            this.term,
          ),
        };
      },
    });
    if (result === "quit") return this.quit();
    if (result === "stay" || result === "go")
      return this.stay(from, d, window, until);
    return {
      type: "resume",
      to: result.go,
      reason: d.reason === "reblocked" ? "reblocked" : "all-blocked-wait",
      from,
      window,
      until,
    };
  }

  quit() {
    if (this.sessionId)
      this.say(
        `baton: stopped. Resume the conversation with: baton --resume ${this.sessionId}`,
      );
    return { type: "quit", code: 130 };
  }

  stay(from, d, window, until) {
    const limited = ["refusal", "all-blocked-wait", "reblocked"].includes(
      d.reason,
    );
    const now = this.now();
    if (limited) {
      const state = d.states.find((s) => s.id === from);
      this.stayUntil =
        state?.availableKnown && state.availableAt > now
          ? state.availableAt
          : now + d.policy.unknownRejectionHours * 3600e3;
    } else this.vetoUntil = now + d.policy.minStayMinutes * 60e3;
    this.say(`baton: staying on ${this.label(from)}.`);
    return {
      type: "resume",
      to: from,
      from,
      reason: "stay",
      prompt: limited
        ? stayPrompt({ account: this.label(from), window, until, now })
        : null,
      window,
      until,
    };
  }

  resumeLaunch(next) {
    const id = this.sessionId;
    const live = readSessionFile(this.paths, id, "live.json");
    const start = readSessionFile(this.paths, id, "start.json");
    const cwd =
      [live?.cwd, start?.cwd, this.cwd].find((c) => c && existsSync(c)) ??
      this.cwd;
    const prompt =
      next.prompt !== undefined
        ? next.prompt
        : continuePrompt({
            from: this.label(next.from),
            to: this.label(next.to),
            reason: next.reason,
            window: next.window,
            until: next.until,
            now: this.now(),
          });
    const args = resumeArgs(this.parsed, id, prompt, {
      model: live?.model ?? null,
      effort: live?.effort ?? null,
      permissionMode: this.permissionMode,
    });
    if (next.reason !== "stay") {
      recordEvent(
        this.paths,
        {
          type: "hop",
          session: id,
          from: next.from,
          to: next.to,
          reason: next.reason,
          wrapper: this.wrapper,
        },
        this.now(),
      );
      this.resumedByBaton = true;
      this.okSinceResume = false;
    } else
      recordEvent(
        this.paths,
        { type: "stay", session: id, account: next.to, wrapper: this.wrapper },
        this.now(),
      );
    this.say(`baton: resuming ${id} on ${this.label(next.to)}`);
    return {
      account: next.to,
      from: next.from,
      args,
      cwd,
      reason: next.reason,
    };
  }
}
