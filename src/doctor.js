import { execFile, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { lowerPriority } from "./fsutil.js";
import { resolveClaude } from "./claude-path.js";
import { loadConfig, nameOf } from "./config.js";
import { installState } from "./install.js";
import { profileDir, profileEnv } from "./paths.js";
import { registrationState } from "./primed.js";
import { canSymlinkFiles, inspectProfile } from "./profile.js";
import { statusLineShell } from "./hooks.js";
import { readConflicts } from "./copies.js";
import { readPollState } from "./poller.js";
import { KIND_WORDS, pollHolder } from "./poll-host.js";
import { NO_POLLER } from "./format.js";

// `baton doctor`: Claude Code on PATH and its version, every profile's links,
// which profiles are signed in (from `claude auth status --json`, of which
// only loggedIn and authMethod are kept: no email, no organization), whether
// the status line, hooks and /hop are installed, and Baton's registration with
// PRIMED CLI.

const parseAuth = (stdout) => {
  const data = JSON.parse(stdout);
  return {
    ok: true,
    loggedIn: data.loggedIn === true,
    authMethod: typeof data.authMethod === "string" ? data.authMethod : null,
  };
};

// The same without blocking (the menu, the poller): never rejects. low:
// at a low priority.
export function authStatusAsync(launcher, env, { low = false } = {}) {
  return new Promise((resolve) => {
    try {
      const child = execFile(
        launcher.command,
        [...launcher.prefix, "auth", "status", "--json"],
        { env, encoding: "utf8", timeout: 30e3, windowsHide: true },
        (error, stdout, stderr) => {
          try {
            resolve(parseAuth(stdout));
          } catch {
            resolve({
              ok: false,
              error: String(error?.message ?? stderr ?? "no output")
                .trim()
                .slice(0, 200),
            });
          }
        },
      );
      if (low) lowerPriority(child.pid);
    } catch (error) {
      resolve({ ok: false, error: error.message });
    }
  });
}

export function authStatus(launcher, env) {
  const result = spawnSync(
    launcher.command,
    [...launcher.prefix, "auth", "status", "--json"],
    {
      env,
      encoding: "utf8",
      timeout: 30e3,
      windowsHide: true,
    },
  );
  try {
    return parseAuth(result.stdout);
  } catch {
    return {
      ok: false,
      error: (result.error?.message ?? result.stderr ?? "no output")
        .toString()
        .trim()
        .slice(0, 200),
    };
  }
}

export { profileEnv };

// The registration, in doctor's words: ok is null when PRIMED CLI is not here.
function primedCheck(r) {
  switch (r.state) {
    case "absent":
      return [null, "not installed"];
    case "missing":
      return [false, "not registered: baton install"];
    case "current":
      return [true, `registered and current (${r.file})`];
    case "foreign":
      return [false, `${r.file} is not Baton's: baton install replaces it`];
    default: {
      const why =
        r.node && r.cli
          ? "node and cli.js paths changed"
          : r.node || r.cli
            ? `${r.node ? "node" : "cli.js"} path changed`
            : "contents changed";
      return [false, `registered but stale (${why}): run baton install again`];
    }
  }
}

// cliPath and findPrimed: for the PRIMED CLI registration (primed.js).
export function runDoctor({
  paths,
  env = process.env,
  platform = process.platform,
  auth = true,
  cliPath = fileURLToPath(new URL("./cli.js", import.meta.url)),
  findPrimed,
}) {
  const checks = [];
  const add = (name, ok, detail) => checks.push({ name, ok, detail });
  const major = Number(process.versions.node.split(".")[0]);
  add("node", major >= 24, `${process.version} (${process.execPath})`);
  const config = loadConfig(paths);
  let launcher = null;
  try {
    launcher = resolveClaude({
      configured: config.claudePath,
      env,
      platform,
      home: paths.home,
    });
    // Never without a profile: an empty folder of Baton's own.
    const versionEnv = { ...env };
    for (const key of Object.keys(versionEnv))
      if (key.toUpperCase() === "CLAUDE_CONFIG_DIR") delete versionEnv[key];
    versionEnv.CLAUDE_CONFIG_DIR = join(paths.tmp, "claude-version");
    const version = spawnSync(
      launcher.command,
      [...launcher.prefix, "--version"],
      {
        encoding: "utf8",
        timeout: 30e3,
        windowsHide: true,
        env: versionEnv,
      },
    );
    add(
      "claude",
      version.status === 0,
      `${launcher.path} ${String(version.stdout ?? "").trim() || "(no version output)"}`,
    );
  } catch (error) {
    add("claude", false, error.message);
  }
  const fileLinks = canSymlinkFiles(paths.tmp, platform);
  add(
    "file links",
    null,
    fileLinks
      ? "allowed (shared files are symbolic links)"
      : "not allowed (Developer Mode off): settings.json, CLAUDE.md and keybindings.json are two-way copies synchronised at every launch and history.jsonl is not shared; turning on Windows Developer Mode (Settings > System > For developers) makes them real links and shares history.jsonl",
  );
  const conflicts = readConflicts(paths);
  add(
    "copy conflicts",
    conflicts.length ? false : null,
    conflicts.length
      ? `${conflicts.length}: ` +
          conflicts
            .slice(-5)
            .map(
              (c) =>
                `${c.item} changed in ${nameOf(config, c.account)} and elsewhere (kept ${c.kept === "~/.claude" ? "~/.claude" : nameOf(config, c.kept)}'s; ${nameOf(config, c.account)}'s is in ${c.backup})`,
            )
            .join("; ") +
          " · baton conflicts --clear once handled"
      : "none",
  );
  if (platform === "win32") {
    const shell = statusLineShell(env, platform);
    add("status line shell", null, shell.command);
  }
  const holder = pollHolder(paths);
  const poll = readPollState(paths);
  add(
    "usage poll",
    null,
    holder
      ? `by ${KIND_WORDS[holder.kind] ?? "baton"} (pid ${holder.pid}); last poll ${poll.lastRunAt ?? "none yet"}`
      : NO_POLLER,
  );
  if (!config.accounts.length)
    add(
      "accounts",
      false,
      "none yet: baton account add <name>, then baton login <name>",
    );
  for (const account of config.accounts) {
    const label = `account ${account.name}`;
    if (!existsSync(profileDir(paths, account.id)))
      add(
        `${label} profile`,
        false,
        "missing: run baton account add again or baton login",
      );
    else {
      const items = inspectProfile(paths, account.id, { platform, fileLinks });
      const bad = items.filter((i) =>
        [
          "missing",
          "wrong-link",
          "conflict",
          "copy-stale",
          "unsafe-link",
        ].includes(i.status),
      );
      add(
        `${label} links`,
        bad.length === 0,
        bad.length
          ? bad.map((i) => `${i.name} ${i.status}`).join(", ") +
              " (the next baton session refreshes them; conflicts need a look)"
          : `${items.filter((i) => i.status === "linked").length} linked, ${items.filter((i) => i.status === "copy-fresh").length} copied` +
              // Left out on purpose (the file-links line above says why).
              items
                .filter((i) => i.status === "not-shared")
                .map((i) => `, ${i.name} not shared`)
                .join(""),
      );
    }
    if (auth && launcher) {
      const s = authStatus(launcher, profileEnv(paths, account.id, env));
      add(
        `${label} sign-in`,
        s.ok ? s.loggedIn : false,
        s.ok
          ? s.loggedIn
            ? `signed in (${s.authMethod})`
            : `not signed in: baton login ${account.name}`
          : `unknown: ${s.error}`,
      );
    }
  }
  const install = installState(paths);
  if (!install.ok) add("install", false, install.error);
  else {
    add(
      "status line",
      install.statusLine,
      install.statusLine ? "installed" : "not installed: baton install",
    );
    const hooks = Object.entries(install.hooks);
    const missing = hooks.filter(([, h]) => !h.installed).map(([e]) => e);
    const broken = hooks
      .filter(([, h]) => h.installed && (!h.cliExists || !h.nodeExists))
      .map(([e]) => e);
    add(
      "hooks",
      missing.length === 0 && broken.length === 0,
      missing.length
        ? `missing ${missing.join(", ")}: baton install`
        : broken.length
          ? `paths gone for ${broken.join(", ")}: baton install again`
          : hooks.map(([e]) => e).join(", "),
    );
    add(
      "/hop command",
      install.hopCommand,
      install.hopCommand
        ? "installed"
        : "not installed (baton hop still works)",
    );
  }
  add(
    "PRIMED CLI",
    ...primedCheck(
      registrationState({ paths, env, platform, findPrimed, cliPath }),
    ),
  );
  return { ok: checks.every((c) => c.ok !== false), checks };
}
