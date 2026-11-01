import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { main } from "../src/cli.js";
import { readConflicts, syncCopies } from "../src/copies.js";
import { runDoctor } from "../src/doctor.js";
import { profileDir } from "../src/paths.js";
import { inspectProfile, linkProfile } from "../src/profile.js";
import { Collect, tempHome, testEnv, write } from "./helpers.js";

// Profiles in copy mode (no file links): settings.json is a copy in each.
function setup(t) {
  const ctx = tempHome(t);
  const { paths } = ctx;
  write(join(paths.claudeDir, "settings.json"), { theme: "dark" });
  write(join(paths.claudeDir, "CLAUDE.md"), "# one\n");
  for (const name of ["acct2", "acct3"])
    linkProfile(paths, name, { fileLinks: false });
  return ctx;
}
const settingsOf = (paths, name) =>
  JSON.parse(
    readFileSync(
      name === "~/.claude"
        ? join(paths.claudeDir, "settings.json")
        : join(profileDir(paths, name), "settings.json"),
      "utf8",
    ),
  );
const entry = (report, account, name = "settings.json") =>
  report.find((r) => r.account === account && r.name === name);

test("a change made in a profile is copied back to ~/.claude (with a backup) and on to the other profiles", (t) => {
  const { paths } = setup(t);
  // /config under acct2 rewrites that profile's settings.json.
  write(join(profileDir(paths, "acct2"), "settings.json"), {
    theme: "light",
    model: "opus",
  });
  assert.equal(
    inspectProfile(paths, "acct2").find((i) => i.name === "settings.json")
      .status,
    "copy-changed",
  );
  const report = syncCopies(paths, ["acct2", "acct3"]);
  const back = entry(report, "acct2");
  assert.equal(back.action, "copied-back");
  assert.deepEqual(settingsOf(paths, "~/.claude"), {
    theme: "light",
    model: "opus",
  });
  assert.deepEqual(settingsOf(paths, "acct3"), {
    theme: "light",
    model: "opus",
  });
  assert.equal(entry(report, "acct3").action, "refreshed");
  const saved = back.detail.match(/is in (.+)$/)[1];
  assert.deepEqual(
    JSON.parse(readFileSync(saved, "utf8")),
    { theme: "dark" },
    "~/.claude's previous version is kept",
  );
  assert.deepEqual(readConflicts(paths), []);
  // Stable afterwards.
  assert.ok(
    syncCopies(paths, ["acct2", "acct3"]).every((r) =>
      ["ok", "no-source"].includes(r.action),
    ),
  );
});

test("a change in ~/.claude alone refreshes the profiles", (t) => {
  const { paths } = setup(t);
  write(join(paths.claudeDir, "settings.json"), { theme: "light" });
  const report = linkProfile(paths, "acct2", { fileLinks: false });
  assert.equal(
    report.find((r) => r.name === "settings.json").action,
    "refreshed",
  );
  assert.deepEqual(settingsOf(paths, "acct2"), { theme: "light" });
  assert.deepEqual(
    settingsOf(paths, "acct3"),
    { theme: "light" },
    "every profile at once",
  );
});

test("both changed: ~/.claude's version is kept, the profile's is backed up and the conflict recorded", (t) => {
  const { paths, home } = setup(t);
  write(join(paths.claudeDir, "settings.json"), { theme: "one" });
  write(join(profileDir(paths, "acct2"), "settings.json"), { theme: "two" });
  const report = syncCopies(paths, ["acct2", "acct3"]);
  const c = entry(report, "acct2");
  assert.equal(c.action, "conflict");
  assert.deepEqual(settingsOf(paths, "~/.claude"), { theme: "one" });
  assert.deepEqual(settingsOf(paths, "acct2"), { theme: "one" });
  const [conflict] = readConflicts(paths);
  assert.deepEqual(
    [conflict.account, conflict.item, conflict.kept],
    ["acct2", "settings.json", "~/.claude"],
  );
  assert.deepEqual(JSON.parse(readFileSync(conflict.backup, "utf8")), {
    theme: "two",
  });
  const doctor = runDoctor({ paths, env: testEnv(home), auth: false });
  const check = doctor.checks.find((x) => x.name === "copy conflicts");
  assert.equal(check.ok, false);
  assert.match(check.detail, /settings\.json changed in acct2/);
});

function await_main(argv, home, out) {
  return main(argv, { env: testEnv(home), stdout: out, stderr: new Collect() });
}

test("two profiles changed the same file: the first in order is copied back, the other is a conflict", async (t) => {
  const { paths, home } = setup(t);
  write(join(profileDir(paths, "acct2"), "settings.json"), { theme: "two" });
  write(join(profileDir(paths, "acct3"), "settings.json"), { theme: "three" });
  const report = syncCopies(paths, ["acct2", "acct3"]);
  assert.equal(entry(report, "acct2").action, "copied-back");
  assert.equal(entry(report, "acct3").action, "conflict");
  assert.deepEqual(settingsOf(paths, "~/.claude"), { theme: "two" });
  assert.deepEqual(settingsOf(paths, "acct3"), { theme: "two" });
  assert.equal(readConflicts(paths)[0].kept, "acct2");
  const out = new Collect();
  assert.equal(await await_main(["conflicts"], home, out), 0);
  assert.match(out.text, /settings\.json in acct3/);
  assert.match(out.text, /Kept +acct2's version/);
  await await_main(["conflicts", "--clear"], home, new Collect());
  assert.deepEqual(readConflicts(paths), []);
});

test("an old copy without a record is replaced by ~/.claude's and kept as a backup; removed accounts are forgotten", async (t) => {
  const { paths, home } = tempHome(t);
  write(join(paths.claudeDir, "settings.json"), { theme: "dark" });
  write(join(profileDir(paths, "acct9"), "settings.json"), { theme: "old" });
  const report = linkProfile(paths, "acct9", { fileLinks: false });
  assert.equal(
    report.find((r) => r.name === "settings.json").action,
    "refreshed",
  );
  assert.deepEqual(settingsOf(paths, "acct9"), { theme: "dark" });
  assert.ok(existsSync(paths.backups));
  const out = new Collect();
  await await_main(["account", "add", "acct3"], home, out);
  await await_main(["account", "add", "acct4"], home, out);
  assert.equal(await await_main(["account", "remove", "acct4"], home, out), 0);
  const record = JSON.parse(
    readFileSync(join(paths.root, "copies.json"), "utf8"),
  );
  assert.equal(record.profiles.acct4, undefined);
});

test(
  "doctor explains that Developer Mode turns the copies into real links",
  { skip: process.platform !== "win32" && "Windows only" },
  (t) => {
    const { paths, home } = tempHome(t);
    const doctor = runDoctor({ paths, env: testEnv(home), auth: false });
    const links = doctor.checks.find((c) => c.name === "file links");
    if (links.detail.startsWith("allowed")) return;
    assert.match(
      links.detail,
      /Developer Mode .* makes them real links and shares history\.jsonl/,
    );
  },
);
