import test from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  statSync,
  symlinkSync,
} from "node:fs";
import { join, resolve } from "node:path";
import {
  canSymlinkFiles,
  carryTrust,
  inspectProfile,
  linkProfile,
  resetSymlinkCache,
  seedGlobalConfig,
  unlinkProfile,
} from "../src/profile.js";
import { profileDir } from "../src/paths.js";
import { tempHome, write } from "./helpers.js";

const SENTINEL = "credential-sentinel-" + Math.random().toString(36).slice(2);

function sharedBase(paths) {
  write(join(paths.claudeDir, "projects", "E--work", "s1.jsonl"), "{}\n");
  mkdirSync(join(paths.claudeDir, "skills", "mine"), { recursive: true });
  mkdirSync(join(paths.claudeDir, "plugins"), { recursive: true });
  mkdirSync(join(paths.claudeDir, "file-history"), { recursive: true });
  mkdirSync(join(paths.claudeDir, "sessions"), { recursive: true });
  write(join(paths.claudeDir, "settings.json"), { theme: "dark" });
  write(join(paths.claudeDir, "CLAUDE.md"), "# rules\n");
  write(join(paths.claudeDir, "history.jsonl"), "{}\n");
  write(join(paths.claudeDir, ".credentials.json"), { token: SENTINEL });
  write(paths.claudeJson, {
    hasCompletedOnboarding: true,
    lastOnboardingVersion: "2.1.302",
    oauthAccount: {
      emailAddress: "operator@example.invalid",
      accountUuid: SENTINEL,
    },
    userID: SENTINEL,
    machineID: SENTINEL,
    primaryApiKey: SENTINEL,
    customApiKeyResponses: { approved: [SENTINEL] },
    cachedUsageUtilization: { x: 1 },
    mcpServers: { tools: { command: "node", args: ["server.js"] } },
    projects: {
      "E:/work": {
        hasTrustDialogAccepted: true,
        allowedTools: ["Bash"],
        lastCost: 9,
        lastSessionId: SENTINEL,
        mcpServers: { local: { command: "x" } },
      },
      "E:/untrusted": { lastCost: 1 },
    },
  });
}

const isLinkTo = (path, target) =>
  lstatSync(path).isSymbolicLink() &&
  resolve(readlinkSync(path)).toLowerCase() === resolve(target).toLowerCase();

function noSentinel(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isSymbolicLink()) continue; // links point into ~/.claude, checked by name
    if (entry.isDirectory()) noSentinel(p);
    else
      assert.ok(
        !readFileSync(p, "utf8").includes(SENTINEL),
        `${p} holds credential or identity data`,
      );
  }
}

test("a profile links the shared base's folders and copies its files when file links are not allowed", (t) => {
  const { paths } = tempHome(t);
  sharedBase(paths);
  const report = linkProfile(paths, "acct2", { fileLinks: false });
  const profile = profileDir(paths, "acct2");
  const by = Object.fromEntries(report.map((r) => [r.name, r.action]));
  for (const dir of ["projects", "skills", "plugins", "file-history"]) {
    assert.equal(by[dir], "linked");
    assert.ok(isLinkTo(join(profile, dir), join(paths.claudeDir, dir)), dir);
  }
  assert.equal(by["settings.json"], "copied");
  assert.equal(by["CLAUDE.md"], "copied");
  assert.equal(by["history.jsonl"], "skipped");
  assert.equal(by.agents, "no-source");
  assert.ok(!lstatSync(join(profile, "settings.json")).isSymbolicLink());
  // The shared transcripts are the same files.
  write(join(profile, "projects", "E--work", "s2.jsonl"), "{}\n");
  assert.ok(
    existsSync(join(paths.claudeDir, "projects", "E--work", "s2.jsonl")),
  );
  // Never the credentials, never per-process folders.
  assert.ok(!existsSync(join(profile, ".credentials.json")));
  assert.ok(!existsSync(join(profile, "sessions")));
  noSentinel(profile);
  noSentinel(paths.root);
});

test("linking again changes nothing; a changed source file is refreshed at the next launch", (t) => {
  const { paths } = tempHome(t);
  sharedBase(paths);
  linkProfile(paths, "acct2", { fileLinks: false });
  const again = linkProfile(paths, "acct2", { fileLinks: false });
  assert.ok(
    again.every((r) => ["ok", "no-source", "skipped"].includes(r.action)),
    JSON.stringify(again),
  );
  write(join(paths.claudeDir, "settings.json"), { theme: "light" });
  const refreshed = linkProfile(paths, "acct2", { fileLinks: false });
  assert.equal(
    refreshed.find((r) => r.name === "settings.json").action,
    "refreshed",
  );
  assert.deepEqual(
    JSON.parse(
      readFileSync(join(profileDir(paths, "acct2"), "settings.json"), "utf8"),
    ),
    { theme: "light" },
  );
  // The prompt history is left out on purpose where file links are not
  // allowed: that is "not shared", never "missing".
  assert.deepEqual(
    inspectProfile(paths, "acct2", { fileLinks: false }).filter(
      (i) => !["linked", "copy-fresh", "no-source"].includes(i.status),
    ),
    [{ name: "history.jsonl", status: "not-shared" }],
  );
});

test("history.jsonl: left out on purpose where file links are not allowed; a missing link is a real problem where they are", (t) => {
  const { paths } = tempHome(t);
  sharedBase(paths);
  linkProfile(paths, "acct2", { fileLinks: false });
  const status = (options) =>
    inspectProfile(paths, "acct2", options).find(
      (i) => i.name === "history.jsonl",
    ).status;
  assert.equal(status({ fileLinks: false }), "not-shared");
  // With file links the link should be there, and a baton session makes it.
  assert.equal(status({ fileLinks: true }), "missing");
  // A profile whose Claude Code made a history of its own keeps it.
  write(join(profileDir(paths, "acct2"), "history.jsonl"), "{}\n");
  assert.equal(status({ fileLinks: false }), "own");
  assert.equal(status({ fileLinks: true }), "own");
});

test("file symbolic links are used where the OS allows them", (t) => {
  const { paths } = tempHome(t);
  if (!canSymlinkFiles(paths.tmp)) {
    t.skip(
      "file symbolic links are not allowed here (Windows without Developer Mode)",
    );
    return;
  }
  sharedBase(paths);
  const report = linkProfile(paths, "acct2", { fileLinks: true });
  assert.equal(report.find((r) => r.name === "settings.json").action, "linked");
  assert.equal(report.find((r) => r.name === "history.jsonl").action, "linked");
  assert.ok(
    isLinkTo(
      join(profileDir(paths, "acct2"), "settings.json"),
      join(paths.claudeDir, "settings.json"),
    ),
  );
});

test("the symbolic link probe answers and leaves nothing behind", (t) => {
  const { paths } = tempHome(t);
  resetSymlinkCache();
  assert.equal(typeof canSymlinkFiles(paths.tmp), "boolean");
  // Where file links are always allowed (not Windows) the probe never makes
  // its folder at all.
  assert.deepEqual(existsSync(paths.tmp) ? readdirSync(paths.tmp) : [], []);
});

test("a profile's own folder is a conflict and is left alone; unsafe links are removed", (t) => {
  const { paths } = tempHome(t);
  sharedBase(paths);
  const profile = profileDir(paths, "acct2");
  write(join(profile, "skills", "own", "SKILL.md"), "mine");
  symlinkSync(
    join(paths.claudeDir, "sessions"),
    join(profile, "sessions"),
    process.platform === "win32" ? "junction" : "dir",
  );
  const report = linkProfile(paths, "acct2", { fileLinks: false });
  assert.equal(report.find((r) => r.name === "skills").action, "conflict");
  assert.ok(existsSync(join(profile, "skills", "own", "SKILL.md")));
  assert.equal(
    report.find((r) => r.name === "sessions").action,
    "removed-unsafe-link",
  );
  assert.ok(!existsSync(join(profile, "sessions")));
  assert.ok(
    existsSync(join(paths.claudeDir, "sessions")),
    "the target is untouched",
  );
});

test("a link whose source disappeared is removed; unlinking removes only Baton's links", (t) => {
  const { paths } = tempHome(t);
  sharedBase(paths);
  mkdirSync(join(paths.claudeDir, "agents"));
  linkProfile(paths, "acct2", { fileLinks: false });
  const profile = profileDir(paths, "acct2");
  assert.ok(lstatSync(join(profile, "agents")).isSymbolicLink());
  const removed = unlinkProfile(paths, "acct2");
  assert.ok(removed.includes("projects") && removed.includes("agents"));
  assert.ok(!existsSync(join(profile, "projects")));
  assert.ok(
    statSync(join(paths.claudeDir, "projects", "E--work", "s1.jsonl")).isFile(),
    "~/.claude keeps its data",
  );
  assert.ok(existsSync(join(profile, "settings.json")), "copies stay");
});

test("the .claude.json seed copies only the allowlist and keeps the profile's own identity", () => {
  const source = {
    hasCompletedOnboarding: true,
    theme: "dark",
    oauthAccount: { emailAddress: "one@example.invalid" },
    userID: "u1",
    primaryApiKey: "k",
    cachedUsageUtilization: {},
    mcpServers: { m: { command: "x" } },
    projects: {
      "E:/w": { hasTrustDialogAccepted: true, lastCost: 3, lastSessionId: "s" },
    },
  };
  const target = {
    oauthAccount: { emailAddress: "two@example.invalid" },
    userID: "u2",
    numStartups: 4,
    projects: { "E:/w": { lastCost: 1 } },
  };
  const out = seedGlobalConfig(source, target);
  assert.deepEqual(out.oauthAccount, { emailAddress: "two@example.invalid" });
  assert.equal(out.userID, "u2");
  assert.equal(out.primaryApiKey, undefined);
  assert.equal(out.cachedUsageUtilization, undefined);
  assert.equal(out.hasCompletedOnboarding, true);
  assert.deepEqual(out.mcpServers, { m: { command: "x" } });
  assert.deepEqual(out.projects["E:/w"], {
    lastCost: 1,
    hasTrustDialogAccepted: true,
  });
  assert.equal(out.numStartups, 4);
  const fresh = seedGlobalConfig(source, null);
  assert.deepEqual(Object.keys(fresh).sort(), [
    "hasCompletedOnboarding",
    "mcpServers",
    "projects",
    "theme",
  ]);
});

test("the seed is written to the profile's .claude.json without identity fields", (t) => {
  const { paths } = tempHome(t);
  sharedBase(paths);
  const report = linkProfile(paths, "acct2", { fileLinks: false });
  assert.equal(report.find((r) => r.name === ".claude.json").action, "seeded");
  const seeded = JSON.parse(
    readFileSync(join(profileDir(paths, "acct2"), ".claude.json"), "utf8"),
  );
  assert.equal(seeded.hasCompletedOnboarding, true);
  assert.equal(seeded.oauthAccount, undefined);
  assert.deepEqual(seeded.projects["E:/work"], {
    hasTrustDialogAccepted: true,
    allowedTools: ["Bash"],
    mcpServers: { local: { command: "x" } },
  });
  assert.equal(seeded.projects["E:/untrusted"], undefined);
  assert.equal(
    linkProfile(paths, "acct2", { fileLinks: false }).find(
      (r) => r.name === ".claude.json",
    ).action,
    "ok",
  );
});

test("folder trust moves with a session to the next profile, never into ~/.claude.json", (t) => {
  const { paths } = tempHome(t);
  write(join(profileDir(paths, "a2"), ".claude.json"), {
    oauthAccount: { emailAddress: "a2" },
    projects: { "E:\\new": { hasTrustDialogAccepted: true, lastCost: 2 } },
  });
  write(join(profileDir(paths, "a3"), ".claude.json"), {
    oauthAccount: { emailAddress: "a3" },
  });
  write(paths.claudeJson, { projects: {} });
  assert.equal(carryTrust(paths, "a2", "a3", "E:/new"), true);
  const a3 = JSON.parse(
    readFileSync(join(profileDir(paths, "a3"), ".claude.json"), "utf8"),
  );
  assert.deepEqual(a3.projects["E:\\new"], { hasTrustDialogAccepted: true });
  assert.equal(a3.oauthAccount.emailAddress, "a3");
  assert.equal(carryTrust(paths, "a2", "a3", "E:/new"), false);
  // An account named "default" is a profile like any other.
  assert.equal(carryTrust(paths, "a2", "default", "E:/new"), true);
  assert.ok(
    JSON.parse(
      readFileSync(join(paths.accounts, "default", ".claude.json"), "utf8"),
    ).projects["E:\\new"].hasTrustDialogAccepted,
  );
  assert.deepEqual(JSON.parse(readFileSync(paths.claudeJson, "utf8")), {
    projects: {},
  });
});
