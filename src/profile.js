import {
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  rmdirSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { join, resolve } from "node:path";
import { globalConfigFile, profileDir, samePath } from "./paths.js";
import { readJson, writeJsonAtomic } from "./fsutil.js";
import { copyState, syncCopies } from "./copies.js";

// Every profile shares everything but the sign-in with the shared base (~/.claude):
// directories by junction (Windows) or symbolic link, files by symbolic link
// when the OS allows it (on Windows: Developer Mode), else by a copy that is
// refreshed at every launch. The per-profile global config (.claude.json) is
// never linked: it holds the signed-in account's identity, so Baton seeds only
// the keys that make a profile start like plain claude (onboarding done, the
// same trusted folders and MCP servers). Credentials are never touched: they
// are neither in the shared list nor read, and a link to one is removed.

export const SHARED = [
  // What every conversation needs, then what Claude Code 2.1.302 keeps per conversation
  // or per user next to it (file-history: /rewind checkpoints per session;
  // plans: plan-mode files the transcript points at; tasks, todos; rules and
  // output-styles: user memory and styles).
  { name: "projects", dir: true },
  { name: "settings.json" },
  { name: "CLAUDE.md" },
  { name: "skills", dir: true },
  { name: "agents", dir: true },
  { name: "commands", dir: true },
  { name: "plugins", dir: true },
  { name: "keybindings.json" },
  { name: "file-history", dir: true },
  { name: "plans", dir: true },
  { name: "tasks", dir: true },
  { name: "todos", dir: true },
  { name: "rules", dir: true },
  { name: "output-styles", dir: true },
  // The prompt history is appended by every running process: shared only by
  // a real link, never by a copy.
  { name: "history.jsonl", linkOnly: true },
];

// Never shared, never linked: credentials, per-process and per-install state
// and secrets (sessions/ and daemon/ hold keys, ssh/ holds SSH keys).
export const NEVER = [
  ".credentials.json",
  ".claude.json",
  "backups",
  "cache",
  "daemon",
  "debug",
  "feedback",
  "ide",
  "jobs",
  "mcp-needs-auth-cache.json",
  "paste-cache",
  "image-cache",
  "scheduled-tasks",
  "session-env",
  "sessions",
  "shell-snapshots",
  "ssh",
  "stats-cache.json",
  "statsig",
  "telemetry",
];

// .claude.json keys copied from ~/.claude.json (allowlist; everything else, the
// account identity first, stays per profile).
export const SEED_KEYS = [
  "hasCompletedOnboarding",
  "lastOnboardingVersion",
  "lastReleaseNotesSeen",
  "theme",
  "mcpServers",
  "hasSeenTasksHint",
  "hasSeenAutoDefaultNotice",
  "hasSeenAutoModeOutsideReadPrompt",
  "hasOpenedAgentsView",
  "bypassPermissionsModeAccepted",
  "hasAcknowledgedCostThreshold",
  "editorMode",
  "autoCompactEnabled",
  "verbose",
  "preferredNotifChannel",
  "shiftEnterKeyBindingInstalled",
  "optionAsMetaKeyInstalled",
  "autoUpdates",
  "installMethod",
  "diffTool",
  "githubRepoPaths",
  "officialMarketplaceAutoInstallAttempted",
  "officialMarketplaceAutoInstalled",
];
export const SEED_PROJECT_KEYS = [
  "hasTrustDialogAccepted",
  "hasCompletedProjectOnboarding",
  "projectOnboardingSeenCount",
  "allowedTools",
  "mcpServers",
  "enabledMcpjsonServers",
  "disabledMcpjsonServers",
  "mcpContextUris",
  "hasClaudeMdExternalIncludesApproved",
  "hasClaudeMdExternalIncludesWarningShown",
];

const lstat = (p) => {
  try {
    return lstatSync(p);
  } catch {
    return null;
  }
};

export function removeLink(path) {
  try {
    unlinkSync(path);
  } catch (error) {
    if (!["EPERM", "EISDIR"].includes(error.code)) throw error;
    rmdirSync(path); // a junction
  }
}

const stat = (p) => {
  try {
    return statSync(p);
  } catch {
    return null;
  }
};

const linkTarget = (path) => {
  try {
    return resolve(readlinkSync(path));
  } catch {
    return null;
  }
};

// Whether this process may create file symbolic links (Windows: Developer
// Mode or the privilege), by trying in a temporary folder.
let symlinkCache = null;
export function canSymlinkFiles(tmpDir, platform = process.platform) {
  if (platform !== "win32") return true;
  if (symlinkCache !== null) return symlinkCache;
  mkdirSync(tmpDir, { recursive: true });
  const id = randomBytes(4).toString("hex");
  const target = join(tmpDir, `symlink-test-${id}.txt`);
  const link = join(tmpDir, `symlink-test-${id}.lnk`);
  try {
    writeFileSync(target, "");
    symlinkSync(target, link, "file");
    symlinkCache = true;
  } catch {
    symlinkCache = false;
  } finally {
    rmSync(link, { force: true });
    rmSync(target, { force: true });
  }
  return symlinkCache;
}
export const resetSymlinkCache = () => {
  symlinkCache = null;
};

const sameBytes = (a, b) => {
  try {
    return readFileSync(a).equals(readFileSync(b));
  } catch {
    return false;
  }
};

// Links (or refreshes) one profile. Returns one entry per item:
// { name, action, detail } with action linked | ok | copied | refreshed |
// relinked | no-source | conflict | skipped | removed-unsafe-link.
export function linkProfile(
  paths,
  name,
  { fileLinks = null, platform = process.platform, peers = [] } = {},
) {
  const profile = profileDir(paths, name);
  mkdirSync(profile, { recursive: true });
  const files = fileLinks ?? canSymlinkFiles(paths.tmp, platform);
  const report = [];
  let copies = false;
  for (const item of SHARED) {
    const src = join(paths.claudeDir, item.name);
    const dst = join(profile, item.name);
    const srcStat = stat(src);
    const dstStat = lstat(dst);
    const isLink = dstStat?.isSymbolicLink() ?? false;
    const pointsHome =
      isLink && linkTarget(dst) && samePath(linkTarget(dst), src, platform);
    if (!srcStat) {
      if (isLink && pointsHome) removeLink(dst);
      report.push({ name: item.name, action: "no-source" });
      continue;
    }
    const wantDir = !!item.dir;
    if (wantDir !== srcStat.isDirectory()) {
      report.push({
        name: item.name,
        action: "skipped",
        detail: "type differs in ~/.claude",
      });
      continue;
    }
    if (isLink && pointsHome) {
      report.push({ name: item.name, action: "ok" });
      continue;
    }
    if (isLink) {
      // A link elsewhere: re-point it only if it is a dangling or old Baton link.
      const target = linkTarget(dst);
      if (target && lstat(target)) {
        report.push({
          name: item.name,
          action: "conflict",
          detail: `links to ${target}`,
        });
        continue;
      }
      removeLink(dst);
    }
    if (wantDir) {
      if (dstStat && !isLink) {
        report.push({
          name: item.name,
          action: "conflict",
          detail: "a folder of its own exists in the profile",
        });
        continue;
      }
      symlinkSync(src, dst, platform === "win32" ? "junction" : "dir");
      report.push({ name: item.name, action: isLink ? "relinked" : "linked" });
      continue;
    }
    if (files) {
      if (dstStat && !isLink) {
        if (!sameBytes(src, dst)) {
          report.push({
            name: item.name,
            action: "conflict",
            detail: "a file of its own exists in the profile",
          });
          continue;
        }
        unlinkSync(dst);
      }
      symlinkSync(src, dst, "file");
      report.push({ name: item.name, action: isLink ? "relinked" : "linked" });
      continue;
    }
    if (item.linkOnly) {
      report.push({
        name: item.name,
        action: "skipped",
        detail: "file links are not allowed here",
      });
      continue;
    }
    // A copy: synchronised both ways below, for every profile at once.
    copies = true;
  }
  if (copies)
    for (const entry of syncCopies(paths, [name, ...peers]))
      if (entry.account === name && entry.action !== "no-source")
        report.push({
          name: entry.name,
          action: entry.action,
          ...(entry.detail ? { detail: entry.detail } : {}),
        });
  // Defensive: nothing of the NEVER list may be a link into ~/.claude.
  for (const item of NEVER) {
    const dst = join(profile, item);
    if (lstat(dst)?.isSymbolicLink()) {
      removeLink(dst);
      report.push({ name: item, action: "removed-unsafe-link" });
    }
  }
  report.push(...seedGlobalConfigFile(paths, name));
  return report;
}

// The status of one profile's links, without changing anything. A file that
// only a real link may share (history.jsonl) is "not-shared", not "missing",
// where file links are not allowed: there it is left out on purpose and
// nothing launching Baton could change that.
export function inspectProfile(
  paths,
  name,
  { platform = process.platform, fileLinks = null } = {},
) {
  const profile = profileDir(paths, name);
  const out = [];
  let canLink = fileLinks;
  const filesLink = () => (canLink ??= canSymlinkFiles(paths.tmp, platform));
  for (const item of SHARED) {
    const src = join(paths.claudeDir, item.name);
    const dst = join(profile, item.name);
    const srcStat = stat(src);
    const dstStat = lstat(dst);
    if (!srcStat) {
      out.push({ name: item.name, status: "no-source" });
      continue;
    }
    if (!dstStat) {
      out.push({
        name: item.name,
        status: item.linkOnly && !filesLink() ? "not-shared" : "missing",
      });
      continue;
    }
    if (dstStat.isSymbolicLink()) {
      const target = linkTarget(dst);
      out.push({
        name: item.name,
        status:
          target && samePath(target, src, platform) ? "linked" : "wrong-link",
        detail: target,
      });
      continue;
    }
    if (item.dir) out.push({ name: item.name, status: "conflict" });
    else if (item.linkOnly) out.push({ name: item.name, status: "own" });
    else
      out.push({ name: item.name, status: copyState(paths, name, item.name) });
  }
  for (const item of NEVER) {
    if (lstat(join(profile, item))?.isSymbolicLink())
      out.push({ name: item, status: "unsafe-link" });
  }
  return out;
}

const normalizeProjectKey = (key) =>
  key.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();

// The seed: allowlisted keys from ~/.claude.json merged into the
// profile's own (pure). Account-identity keys are never taken from the
// source; the profile's own values for them are kept.
export function seedGlobalConfig(source, target) {
  const out = { ...(target ?? {}) };
  if (!source || typeof source !== "object") return out;
  for (const key of SEED_KEYS) if (key in source) out[key] = source[key];
  if (source.projects && typeof source.projects === "object") {
    const projects = { ...(out.projects ?? {}) };
    for (const [path, entry] of Object.entries(source.projects)) {
      if (!entry || typeof entry !== "object") continue;
      const picked = {};
      for (const key of SEED_PROJECT_KEYS)
        if (key in entry) picked[key] = entry[key];
      if (!Object.keys(picked).length) continue;
      projects[path] = { ...(projects[path] ?? {}), ...picked };
    }
    out.projects = projects;
  }
  return out;
}

export function seedGlobalConfigFile(paths, name) {
  const targetFile = globalConfigFile(paths, name);
  const source = readJson(paths.claudeJson);
  if (!source) return [{ name: ".claude.json", action: "no-source" }];
  const before = readJson(targetFile);
  const after = seedGlobalConfig(source, before);
  if (before && JSON.stringify(before) === JSON.stringify(after))
    return [{ name: ".claude.json", action: "ok", detail: "seeded" }];
  writeJsonAtomic(targetFile, after);
  return [{ name: ".claude.json", action: before ? "refreshed" : "seeded" }];
}

// Carries a folder's trust (and its other seeded project keys) from the
// profile a session ran on to the one it moves to, so the resumed session
// starts without the trust dialog (which would also keep the hooks off).
// ~/.claude.json is never written.
export function carryTrust(paths, from, to, cwd) {
  if (!cwd || from === to) return false;
  const source = readJson(globalConfigFile(paths, from));
  const targetFile = globalConfigFile(paths, to);
  const target = readJson(targetFile) ?? {};
  const want = normalizeProjectKey(cwd);
  let changed = false;
  const projects = { ...(target.projects ?? {}) };
  for (const [key, entry] of Object.entries(source?.projects ?? {})) {
    if (normalizeProjectKey(key) !== want || !entry?.hasTrustDialogAccepted)
      continue;
    const picked = {};
    for (const k of SEED_PROJECT_KEYS) if (k in entry) picked[k] = entry[k];
    const merged = { ...(projects[key] ?? {}), ...picked };
    if (JSON.stringify(merged) !== JSON.stringify(projects[key])) {
      projects[key] = merged;
      changed = true;
    }
  }
  if (changed) writeJsonAtomic(targetFile, { ...target, projects });
  return changed;
}

// Removes Baton's links from a profile (the folder itself, with its own
// sign-in, stays).
export function unlinkProfile(
  paths,
  name,
  { platform = process.platform } = {},
) {
  const profile = profileDir(paths, name);
  const removed = [];
  for (const item of SHARED) {
    const dst = join(profile, item.name);
    if (!lstat(dst)?.isSymbolicLink()) continue;
    const target = linkTarget(dst);
    if (
      target &&
      samePath(target, join(paths.claudeDir, item.name), platform)
    ) {
      removeLink(dst);
      removed.push(item.name);
    }
  }
  return removed;
}
