#!/usr/bin/env node
import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { pathsFor } from "./paths.js";

// baton: one command for the operator, the hooks and the status line.
// Commands live in one table: { group, usage, summary, options (node:util
// parseArgs options), raw (arguments passed on untouched), run(ctx) }; run
// returns { data, text, code } (data is printed for --json). The hook and
// status line paths load only what they need, to stay fast.

export const commands = new Map();
const command = (name, definition) =>
  commands.set(name, { options: {}, ...definition });
export class UsageError extends Error {}

const CLI_PATH = fileURLToPath(import.meta.url);

function readStdin(limit = 4 << 20) {
  if (process.stdin.isTTY) return "";
  try {
    const text = readFileSync(0, "utf8");
    return text.length > limit ? text.slice(0, limit) : text;
  } catch {
    return "";
  }
}

const parseJson = (text) => {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

function bool(value, flag) {
  if (value === undefined) return undefined;
  const word = String(value).toLowerCase();
  if (["true", "on", "yes", "1"].includes(word)) return true;
  if (["false", "off", "no", "0"].includes(word)) return false;
  throw new UsageError(`--${flag} takes true or false.`);
}

// A name as it would be typed in a shell (names may hold spaces and more).
export const quoted = (name) =>
  /^[A-Za-z0-9@._+:,=/-]+$/.test(String(name))
    ? String(name)
    : `"${String(name).replace(/["\\$`]/g, (c) => `\\${c}`)}"`;

// A screen of src/screens.js, built when it is printed (not for --json).
const screen =
  (name, ...args) =>
  async (term) =>
    (await import("./screens.js"))[name](term, ...args);

const percentOrDefault = (value, flag) => {
  if (value === undefined) return undefined;
  if (String(value).toLowerCase() === "default") return null;
  const n = Number(value);
  if (!Number.isFinite(n))
    throw new UsageError(`--${flag} takes a percentage or "default".`);
  return n;
};

// ---- Claude Code's callers: hooks and the status line ---------------------

command("hook", {
  group: "internal",
  usage: "baton hook <session-start|prompt|stop|stop-failure|session-end>",
  summary:
    "Record a Claude Code hook event (Claude Code runs this; reads the hook JSON on stdin).",
  async run({ positionals, env, paths }) {
    try {
      const { handleHook } = await import("./hooks.js");
      handleHook(positionals[0], parseJson(readStdin()), { env, paths });
    } catch {
      // A hook never fails the session.
    }
    return { code: 0, quiet: true };
  },
});

command("statusline", {
  group: "internal",
  usage: "baton statusline",
  summary:
    "Record rate_limits and print the status line (Claude Code runs this).",
  async run({ env, paths }) {
    const raw = readStdin();
    let result = { text: "" };
    const hooks = await import("./hooks.js");
    try {
      result = hooks.handleStatusLine(parseJson(raw), { env, paths });
    } catch {
      result = { text: "" };
    }
    if (result.previous) {
      const out = hooks.runPreviousStatusLine(result.previous, raw, { env });
      // Their line as it is, or with Baton's usage after it (policy
      // statusLineUsage).
      process.stdout.write(
        result.usage
          ? hooks.appendUsage(
              out.stdout,
              result.usage,
              Number(env.COLUMNS) || 0,
            )
          : out.stdout,
      );
      return { code: out.code, quiet: true };
    }
    if (result.text) process.stdout.write(result.text + "\n");
    return { code: 0, quiet: true };
  },
});

// ---- The lead session ------------------------------------------------------

const startCommand = {
  group: "session",
  usage: ["baton [claude arguments...]", "baton start [claude arguments...]"],
  summary:
    'Start Claude Code on the best account, with the terminal attached; hop the conversation when an account runs out. baton alone does it; baton start also takes a prompt first (baton start "fix the tests").',
  example: "baton --model opus --add-dir ../shared",
  raw: true,
  async run({ rest, env, paths }) {
    const { runLead } = await import("./lead.js");
    return { code: await runLead({ args: rest, paths, env }), quiet: true };
  },
};
command("start", startCommand);
command("claude", {
  ...startCommand,
  usage: "baton claude [claude arguments...]",
  summary: "Same as baton.",
  alias: true,
});

command("hop", {
  group: "session",
  usage: "baton hop [session] [--to account]",
  summary:
    "Move a conversation running under baton to another account at the end of its turn.",
  options: {
    to: { type: "string" },
    session: { type: "string" },
    "from-command": { type: "boolean" },
  },
  async run({ values, positionals, env, paths }) {
    const { hop, HopError } = await import("./hop.js");
    const fromCommand = !!values["from-command"];
    try {
      const r = hop(paths, {
        session: values.session ?? positionals[0],
        to: values.to || null,
        env,
        by: fromCommand ? "command" : "cli",
      });
      const when = r.between
        ? "now (it is between turns)"
        : "when this turn ends";
      // The /hop command's answer goes to the model, and a script reads the
      // same: plain words; a terminal gets the screen.
      const words = `Baton: conversation ${r.session} moves from ${r.from} to ${r.to} ${when}.`;
      return {
        data: r,
        text: words,
        ...(fromCommand
          ? {}
          : { pipe: words, screen: screen("hopScreen", r, when) }),
      };
    } catch (error) {
      if (!(error instanceof HopError)) throw error;
      // The /hop command shows Baton's answer to the model; it is not a failure there.
      return {
        data: { error: error.message },
        text: `Baton: ${error.message}`,
        ...(fromCommand ? {} : { screen: screen("failScreen", error.message) }),
        code: fromCommand ? 0 : 1,
      };
    }
  },
});

// ---- Accounts --------------------------------------------------------------

command("account", {
  group: "accounts",
  usage: [
    "baton account list",
    "baton account add <name> [--mark m] [--last-resort] [--position n]",
    "baton account rename <name> <new name>",
    "baton account remove <name>",
    "baton account order <name...>",
    "baton account move <name> <position>",
    "baton account set <name> [--mark preferred|normal|last-resort] [--last-resort true|false] [--five-hour n|default] [--weekly n|default]",
  ],
  summary: "Manage the accounts: names, order, marks and thresholds.",
  options: {
    mark: { type: "string" },
    "last-resort": { type: "string" },
    position: { type: "string" },
    "five-hour": { type: "string" },
    weekly: { type: "string" },
  },
  // `--last-resort` alone means true on add.
  prepare(argv) {
    return argv.map((a, i) =>
      a === "--last-resort" &&
      (argv[i + 1] === undefined || argv[i + 1].startsWith("-"))
        ? "--last-resort=true"
        : a,
    );
  },
  async run({ values, positionals, paths }) {
    const accounts = await import("./accounts.js");
    const { loadConfig } = await import("./config.js");
    const [sub, ...names] = positionals;
    // A new or renamed account is polled by the baton instance that polls,
    // if one runs.
    const poll = async (id, reason) => {
      const { requestPoll } = await import("./poll-host.js");
      requestPoll(paths, id, reason);
    };
    try {
      switch (sub) {
        case undefined:
        case "list": {
          const config = loadConfig(paths);
          return {
            data: config.accounts,
            screen: screen("accountsScreen", config),
          };
        }
        case "add": {
          if (!names[0]) throw new UsageError("baton account add <name>");
          const lastResort = bool(values["last-resort"], "last-resort");
          const r = accounts.addAccount(paths, names[0], {
            mark: lastResort ? "last-resort" : (values.mark ?? null),
            position: values.position ?? null,
          });
          await poll(r.account.id, "added");
          return {
            data: r,
            screen: screen(
              "accountAdded",
              r,
              paths,
              `baton login ${quoted(r.account.name)}`,
            ),
          };
        }
        case "rename": {
          if (names.length !== 2)
            throw new UsageError("baton account rename <name> <new name>");
          const r = accounts.renameAccount(paths, names[0], names[1]);
          await poll(r.id, "renamed");
          return { data: r, screen: screen("accountRenamed", r) };
        }
        case "remove": {
          if (!names[0]) throw new UsageError("baton account remove <name>");
          const r = accounts.removeAccount(paths, names[0]);
          return { data: r, screen: screen("accountRemoved", r, paths) };
        }
        case "order": {
          if (!names.length)
            throw new UsageError("baton account order <name...>");
          const r = accounts.orderAccounts(paths, names);
          return { data: r, screen: screen("accountOrder", r) };
        }
        case "move": {
          if (names.length !== 2)
            throw new UsageError("baton account move <name> <position>");
          const r = accounts.moveAccount(paths, names[0], names[1]);
          return { data: r, screen: screen("accountOrder", r) };
        }
        case "set": {
          if (!names[0]) throw new UsageError("baton account set <name> ...");
          const r = accounts.setAccount(paths, names[0], {
            mark: values.mark,
            lastResort: bool(values["last-resort"], "last-resort"),
            fiveHour: percentOrDefault(values["five-hour"], "five-hour"),
            weekly: percentOrDefault(values.weekly, "weekly"),
          });
          return { data: r, screen: screen("accountSet", r.account) };
        }
        default:
          throw new UsageError(`Unknown: baton account ${sub}`);
      }
    } catch (error) {
      if (error instanceof accounts.AccountError)
        throw new UsageError(error.message);
      throw error;
    }
  },
});

command("login", {
  group: "accounts",
  usage: "baton login <account>",
  summary:
    "Sign an account in: runs `claude auth login` under its profile with the terminal attached.",
  async run({ positionals, env, paths }) {
    const name = positionals[0];
    if (!name) throw new UsageError("baton login <account>");
    const { loadConfig, findAccount } = await import("./config.js");
    const config = loadConfig(paths);
    const account = findAccount(config, name);
    if (!account)
      throw new UsageError(
        `No account named ${name}; add it with baton account add ${quoted(name)}.`,
      );
    const { linkProfile } = await import("./profile.js");
    const { resolveClaude } = await import("./claude-path.js");
    const { profileEnv } = await import("./doctor.js");
    const { signIn } = await import("./menu/login.js");
    linkProfile(paths, account.id);
    const launcher = resolveClaude({
      configured: loadConfig(paths).claudePath,
      env,
      home: paths.home,
    });
    const code = await signIn({
      launcher,
      env: profileEnv(paths, account.id, env),
      name: account.name,
      color: !env.NO_COLOR,
    });
    if (code === 0) {
      const { requestPoll } = await import("./poll-host.js");
      requestPoll(paths, account.id, "signed in");
    }
    return { code, quiet: true };
  },
});

// ---- Usage and policy ------------------------------------------------------

const viewCommand = {
  group: "usage",
  usage: "baton view",
  summary: "The menu: accounts, sessions, policy and stats, live.",
  async run({ env, paths }) {
    if (!process.stdout.isTTY || !process.stdin.isTTY)
      throw new UsageError("The menu needs a terminal; try baton status.");
    const { runMenu } = await import("./menu/index.js");
    return {
      code: await runMenu({ paths, env, handleSignals: true }),
      quiet: true,
    };
  },
};
command("view", viewCommand);
command("menu", {
  ...viewCommand,
  usage: "baton menu",
  summary: "Same as baton view.",
  alias: true,
});

command("usage", {
  group: "usage",
  usage: "baton usage [--refresh] [account] [--json]",
  summary:
    "Every account's plan usage, where each reading came from and how old it is, and the usage poll; --refresh asks Claude Code for it now (one account or all).",
  options: { refresh: { type: "boolean" } },
  async run({ values, positionals, env, paths }) {
    const { loadConfig, findAccount } = await import("./config.js");
    const format = await import("./format.js");
    const config = loadConfig(paths);
    let id = null;
    if (positionals[0]) {
      const account = findAccount(config, positionals[0]);
      if (!account) throw new UsageError(`No account named ${positionals[0]}.`);
      id = account.id;
    }
    if (values.refresh) {
      // In this process, which exits when it is done.
      const { Poller } = await import("./poller.js");
      const results = await new Poller({ paths, env }).refresh({
        account: id,
        reason: "cli",
      });
      return {
        data: { results },
        screen: screen("refreshScreen", { results }, Date.now()),
      };
    }
    const { loadSnapshot } = await import("./state.js");
    const snapshot = loadSnapshot(paths, { poll: true });
    const view = format.statusView(snapshot);
    return {
      data: {
        accounts: view.accounts.filter((a) => !id || a.id === id),
        poll: view.poll,
      },
      screen: screen("usageScreen", paths, { account: id }),
    };
  },
});

command("status", {
  group: "usage",
  usage: "baton status [--json]",
  summary:
    "Accounts in order, their 5-hour and weekly use, blocks and resets, sessions, where new work goes, and the usage poll.",
  async run({ paths }) {
    const { loadSnapshot } = await import("./state.js");
    const format = await import("./format.js");
    const snapshot = loadSnapshot(paths, { sessions: true, poll: true });
    return {
      data: format.statusView(snapshot),
      screen: screen("statusScreen", paths),
    };
  },
});

command("pick", {
  group: "usage",
  usage: "baton pick [--json]",
  summary: "The account new work would go to now.",
  async run({ paths }) {
    const { loadSnapshot } = await import("./state.js");
    const { pickStart } = await import("./policy.js");
    const s = loadSnapshot(paths);
    if (!s.states.length) {
      const { NO_ACCOUNTS } = await import("./format.js");
      return {
        data: { account: null, accounts: 0 },
        pipe: NO_ACCOUNTS,
        screen: screen("emptyScreen"),
        code: 3,
      };
    }
    const p = pickStart(s.states, s.policy);
    const data = {
      account: p.account,
      reason: p.reason,
      allBlocked: p.allBlocked,
      earliest: p.earliest ?? null,
      availableAt:
        p.availableKnown && p.availableAt
          ? new Date(p.availableAt).toISOString()
          : null,
    };
    const label = (id) => s.states.find((x) => x.id === id)?.name ?? id;
    return {
      data,
      // Piped, the bare name: `account=$(baton pick)`.
      pipe:
        p.account ??
        `none (all blocked; first back: ${p.earliest ?? "unknown"})`,
      screen: screen("pickScreen", {
        name: p.account ? label(p.account) : null,
        reason: p.reason,
        earliest: p.earliest ? label(p.earliest) : null,
        at: p.availableKnown ? p.availableAt : null,
      }),
      code: p.account ? 0 : 3,
    };
  },
});

command("stats", {
  group: "usage",
  usage: "baton stats [--days n] [--json]",
  summary:
    "Usage per account over the last days, hops and refusals per day, weekly allowance left unused at resets, sessions.",
  options: { days: { type: "string" } },
  async run({ values, paths }) {
    const days = values.days === undefined ? 7 : Number(values.days);
    if (!Number.isInteger(days) || days < 1 || days > 90)
      throw new UsageError("--days takes 1 to 90.");
    const { loadConfig, effectivePolicy } = await import("./config.js");
    const { computeStats } = await import("./stats.js");
    const config = loadConfig(paths);
    const stats = computeStats({
      paths,
      config,
      policy: effectivePolicy(config),
      days,
    });
    return { data: stats, screen: screen("statsScreen", paths, stats) };
  },
});

const POLICY_FLAGS = {
  mode: "mode",
  "five-hour": "fiveHour",
  weekly: "weekly",
  "start-reserve": "startReserve",
  "plan-factor": "planFactor",
  "cost-samples": "costSamples",
  "min-stay": "minStayMinutes",
  "wait-in-place": "waitInPlaceMinutes",
  "wait-in-place-max": "waitInPlaceMaxHours",
  "rebalance-horizon": "rebalanceHorizonMinutes",
  "rebalance-margin": "rebalanceMargin",
  "burn-window": "burnWindowMinutes",
  "unknown-rejection": "unknownRejectionHours",
  countdown: "countdownSeconds",
  "max-reblocks": "maxReblocks",
  "reblock-backoff": "reblockBackoffMinutes",
  "settle-ms": "settleMs",
  "compaction-rebalance": "compactionRebalance",
  "status-line-usage": "statusLineUsage",
  "usage-poll": "usagePollMinutes",
};

command("policy", {
  group: "usage",
  usage: `baton policy [--json] [${Object.keys(POLICY_FLAGS)
    .map((f) => `--${f} <value|default>`)
    .join(" ")}]`,
  summary:
    "Show or change the policy settings (smart or order mode, thresholds, reserves, timings).",
  options: Object.fromEntries(
    Object.keys(POLICY_FLAGS).map((f) => [f, { type: "string" }]),
  ),
  async run({ values, paths }) {
    const { setPolicy } = await import("./accounts.js");
    const { loadConfig, effectivePolicy, POLICY_DEFAULTS } =
      await import("./config.js");
    const changes = {};
    for (const [flag, key] of Object.entries(POLICY_FLAGS))
      if (values[flag] !== undefined)
        changes[key] =
          String(values[flag]).toLowerCase() === "default"
            ? null
            : values[flag];
    if (Object.keys(changes).length) {
      const { AccountError } = await import("./accounts.js");
      try {
        setPolicy(paths, changes);
      } catch (error) {
        if (error instanceof AccountError) throw new UsageError(error.message);
        throw error;
      }
    }
    const config = loadConfig(paths);
    const policy = effectivePolicy(config);
    const rows = Object.entries(POLICY_FLAGS).map(([flag, key]) => ({
      flag,
      value: policy[key],
      custom:
        key in config.policy && config.policy[key] !== POLICY_DEFAULTS[key],
    }));
    return {
      data: policy,
      screen: screen("policyScreen", {
        rows,
        mode: policy.mode,
        saved: Object.keys(changes).length,
      }),
    };
  },
});

// ---- Setup ----------------------------------------------------------------

async function refreshProfiles(paths) {
  const { loadConfig } = await import("./config.js");
  const { linkProfile } = await import("./profile.js");
  for (const account of loadConfig(paths).accounts)
    try {
      linkProfile(paths, account.id);
    } catch {
      // doctor reports it
    }
}

// baton install and baton uninstall: plan, show, and unless --dry-run, apply.
async function changeSettings(mode, { values, paths, env, findFerry }) {
  const install = await import("./install.js");
  const { loadConfig } = await import("./config.js");
  let plan;
  try {
    plan =
      mode === "install"
        ? install.planInstall({ paths, cliPath: CLI_PATH, env, findFerry })
        : install.planUninstall({ paths, env });
  } catch (error) {
    if (error instanceof install.InstallError)
      throw new UsageError(error.message);
    throw error;
  }
  const dryRun = !!values["dry-run"];
  let applied = null;
  if (!dryRun) {
    try {
      applied = install.applyPlan(plan, { paths });
    } catch (error) {
      if (error instanceof install.InstallError)
        throw new UsageError(error.message);
      throw error;
    }
    await refreshProfiles(paths);
  }
  return {
    data: {
      dryRun,
      files: plan.files.map((f) => ({ path: f.path, diff: f.diff })),
      notes: plan.notes,
      ...(applied ?? {}),
    },
    screen: screen("planScreen", {
      mode,
      plan,
      dryRun,
      applied,
      diff: !!values.diff,
      paths,
      hasAccounts: loadConfig(paths).accounts.length > 0,
    }),
  };
}

command("install", {
  group: "setup",
  usage: "baton install [--dry-run] [--diff]",
  summary:
    "Add Baton's status line, hooks and /hop command to ~/.claude, and register Baton with Ferry when it is installed (shows the changes, keeps a backup, idempotent); --diff lists every changed line.",
  options: { "dry-run": { type: "boolean" }, diff: { type: "boolean" } },
  run: (context) => changeSettings("install", context),
});

command("uninstall", {
  group: "setup",
  usage: "baton uninstall [--dry-run] [--diff]",
  summary:
    "Remove Baton's status line, hooks and /hop command from ~/.claude, restore the previous status line, and remove Baton's Ferry launcher; --diff lists every changed line.",
  options: { "dry-run": { type: "boolean" }, diff: { type: "boolean" } },
  run: (context) => changeSettings("uninstall", context),
});

command("doctor", {
  group: "setup",
  usage: "baton doctor [--json]",
  summary:
    "Check Claude Code, every profile's links and sign-in, the installed status line and hooks, and the Ferry registration.",
  async run({ env, paths, findFerry }) {
    const { runDoctor } = await import("./doctor.js");
    const report = runDoctor({ paths, env, cliPath: CLI_PATH, findFerry });
    return {
      data: report,
      screen: screen("doctorScreen", report),
      code: report.ok ? 0 : 1,
    };
  },
});

command("conflicts", {
  group: "setup",
  usage: "baton conflicts [--clear] [--json]",
  summary:
    "Shared files changed both in a profile and in ~/.claude (without file links), with the backups kept.",
  options: { clear: { type: "boolean" } },
  async run({ values, paths }) {
    const { readConflicts, clearConflicts } = await import("./copies.js");
    const list = readConflicts(paths);
    const { loadConfig, nameOf } = await import("./config.js");
    const config = loadConfig(paths);
    const label = (id) => nameOf(config, id);
    if (values.clear) {
      clearConflicts(paths);
      return {
        data: { cleared: list.length },
        screen: screen("conflictsScreen", list, label, {
          cleared: list.length,
        }),
      };
    }
    return { data: list, screen: screen("conflictsScreen", list, label) };
  },
});

command("version", {
  group: "setup",
  usage: "baton version",
  summary: "Print Baton's version.",
  async run() {
    const pkg = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    );
    return { data: { version: pkg.version }, text: pkg.version };
  },
});

command("help", {
  group: "setup",
  usage: "baton help [command]",
  summary: "Show the commands, or one command's usage.",
  async run({ positionals }) {
    return helpResult(positionals[0]);
  },
});

const GROUPS = {
  session: "Conversation",
  accounts: "Accounts",
  usage: "Usage and policy",
  setup: "Setup",
  internal: "Run by Claude Code",
};

const helpResult = (name) => ({
  screen: screen("helpScreen", { groups: GROUPS, commands, name }),
  code: name && !commands.has(name) ? 2 : 0,
});

// Prints a command's answer: --json its data; otherwise its screen drawn for
// the terminal (plain text when stdout is not one) or, where a command has
// one, the text meant for scripts (`pipe`).
async function present(result, { json, stdout, env }) {
  if (json) {
    stdout.write(JSON.stringify(result.data ?? null, null, 2) + "\n");
    return;
  }
  let text = result.text;
  if (result.screen || result.pipe !== undefined) {
    const { terminalFor, render, document } = await import("./term.js");
    const term = terminalFor(stdout, env);
    if (!term.tty && result.pipe !== undefined) text = result.pipe;
    else if (result.screen)
      text = render(document(await result.screen(term), term), term);
  }
  if (text) stdout.write(text + "\n");
}

// An error for stderr, in the menu's look when stderr is a terminal.
async function complain(message, { stderr, env }) {
  const { terminalFor, errorText } = await import("./term.js");
  stderr.write(errorText(message, terminalFor(stderr, env)) + "\n");
}

// main(argv, { env, stdout, stderr, findFerry }) -> exit code. findFerry()
// -> path | null replaces the PATH lookup of Ferry (the tests pass
// their own).
export async function main(
  argv = process.argv.slice(2),
  {
    env = process.env,
    stdout = process.stdout,
    stderr = process.stderr,
    findFerry,
  } = {},
) {
  const paths = pathsFor(env);
  let name = argv[0];
  let rest = argv.slice(1);
  // `baton` alone, or with claude arguments (`baton --model opus`), starts
  // a session.
  if (name === "-h" || name === "--help") name = "help";
  else if (name === "--version" || name === "-v") name = "version";
  else if (name === undefined || name.startsWith("-")) {
    rest = argv;
    name = "start";
  }
  const definition = commands.get(name);
  if (!definition) {
    await complain(`unknown command ${name}. Try baton help.`, { stderr, env });
    return 2;
  }
  try {
    let values = {};
    let positionals = [];
    if (!definition.raw) {
      const args = definition.prepare ? definition.prepare(rest) : rest;
      const parsed = parseArgs({
        args,
        options: {
          ...definition.options,
          json: { type: "boolean" },
          help: { type: "boolean", short: "h" },
        },
        allowPositionals: true,
        strict: true,
      });
      values = parsed.values;
      positionals = parsed.positionals;
      if (values.help) {
        await present(helpResult(name), { stdout, env });
        return 0;
      }
    }
    const result =
      (await definition.run({
        values,
        positionals,
        rest,
        env,
        paths,
        findFerry,
      })) ?? {};
    if (!result.quiet)
      await present(result, { json: values.json, stdout, env });
    return result.code ?? 0;
  } catch (error) {
    if (
      error instanceof UsageError ||
      error?.code === "ERR_PARSE_ARGS_UNKNOWN_OPTION" ||
      error?.code?.startsWith?.("ERR_PARSE_ARGS")
    ) {
      await complain(error.message, { stderr, env });
      return 2;
    }
    await complain(String(error?.stack ?? error), { stderr, env });
    return 1;
  }
}

const invoked = (() => {
  try {
    return realpathSync(process.argv[1]) === realpathSync(CLI_PATH);
  } catch {
    return false;
  }
})();
if (invoked) {
  const code = await main();
  process.exitCode = code;
}
