import test from "node:test";
import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { isAbsolute, join } from "node:path";
import { main } from "../src/cli.js";
import { runDoctor } from "../src/doctor.js";
import { applyPlan, planInstall, planUninstall } from "../src/install.js";
import { forward } from "../src/paths.js";
import { launcherDef, registrationState } from "../src/primed.js";
import { CLI, Collect, tempHome, testEnv, write } from "./helpers.js";

// Never the node running the tests (the doctor test tells them apart).
const NODE = "C:/Program Files/node-under-test/node.exe";
const read = (f) => readFileSync(f, "utf8");
const json = (f) => JSON.parse(read(f));
// `primed` is never on PATH unless a test says so.
const noPath = () => null;

// A test home with PRIMED CLI's data folder (~/.primed-cli).
function primedHome(t) {
  const home = tempHome(t);
  const data = join(home.home, ".primed-cli");
  mkdirSync(data, { recursive: true });
  return { ...home, data, file: join(data, "launchers", "baton.json") };
}

const plan = (paths, opts = {}) =>
  planInstall({
    paths,
    nodePath: NODE,
    cliPath: CLI,
    env: {},
    findPrimed: noPath,
    ...opts,
  });

function install(paths, opts) {
  const p = plan(paths, opts);
  return { plan: p, applied: applyPlan(p, { paths }) };
}

function uninstall(paths, env = {}) {
  const p = planUninstall({ paths, env });
  return { plan: p, applied: applyPlan(p, { paths }) };
}

const primedItems = (p) => p.items.filter((i) => i.name === "primed");

async function baton(home, ...argv) {
  const stdout = new Collect();
  const code = await main(argv, {
    env: testEnv(home),
    stdout,
    stderr: new Collect(),
    findPrimed: noPath,
  });
  return { code, out: stdout.text };
}

// PRIMED CLI's launcher format, schema version 1: what is wrong with a file
// (nothing when it is valid).
function launcherProblems(def, fileName) {
  const problems = [];
  const strings = (v) =>
    Array.isArray(v) && v.every((a) => typeof a === "string");
  const unescaped = (text) => text.replace(/\{\{|\}\}/g, "");
  const placeholders = (text, allowed) => {
    const rest = unescaped(text);
    for (const m of rest.matchAll(/\{([^{}]*)\}/g))
      if (!allowed.includes(m[1])) problems.push(`placeholder {${m[1]}}`);
    if (/[{}]/.test(rest.replace(/\{[^{}]*\}/g, "")))
      problems.push(`a stray brace in ${text}`);
  };
  if (def.schemaVersion !== 1) problems.push("schemaVersion");
  if (
    !/^[a-z0-9][a-z0-9-]{0,31}$/.test(def.id) ||
    `${def.id}.json` !== fileName
  )
    problems.push("id");
  if (typeof def.name !== "string" || !/^[^\p{C}]{1,40}$/u.test(def.name))
    problems.push("name");
  if (
    def.description !== undefined &&
    (typeof def.description !== "string" ||
      !/^[^\r\n]{0,120}$/.test(def.description))
  )
    problems.push("description");
  if (typeof def.program !== "string" || !def.program) problems.push("program");
  for (const key of ["args", "resumeArgs", "continueArgs"])
    if (def[key] !== undefined && !strings(def[key])) problems.push(key);
  for (const a of [...(def.args ?? []), ...(def.continueArgs ?? [])])
    placeholders(a, ["path", "name"]);
  for (const a of def.resumeArgs ?? [])
    placeholders(a, ["path", "name", "conversation"]);
  if (
    def.resumeArgs &&
    !def.resumeArgs.some((a) => unescaped(a).includes("{conversation}"))
  )
    problems.push("resumeArgs without {conversation}");
  if ((def.resumeArgs || def.continueArgs) && def.conversations === undefined)
    problems.push("resumeArgs or continueArgs without conversations");
  if (def.conversations !== undefined && def.conversations !== "claude-code")
    problems.push("conversations");
  if (def.terminal !== undefined && typeof def.terminal !== "boolean")
    problems.push("terminal");
  if (
    def.source !== undefined &&
    (typeof def.source !== "string" || def.source.length > 80)
  )
    problems.push("source");
  return problems;
}

test("without PRIMED CLI the plan says so in one line and nothing is written for it", async (t) => {
  const { home, paths } = tempHome(t);
  const p = plan(paths);
  assert.deepEqual(primedItems(p), [{ name: "primed", action: "missing" }]);
  assert.ok(p.files.every((f) => !f.path.includes(".primed-cli")));
  applyPlan(p, { paths });
  assert.ok(!existsSync(join(home, ".primed-cli")));
  assert.equal(json(paths.install).launcher, undefined);
  // A PRIMED_CLI_HOME that does not exist is not PRIMED CLI either.
  assert.deepEqual(
    primedItems(plan(paths, { env: { PRIMED_CLI_HOME: join(home, "no") } })),
    [{ name: "primed", action: "missing" }],
  );
  const dry = await baton(home, "install", "--dry-run");
  assert.match(
    dry.out,
    /\n *\S PRIMED CLI not found; run baton install again after installing it\n/,
  );
  // Uninstall has nothing to say about it.
  assert.deepEqual(primedItems(uninstall(paths).plan), []);
});

test("dry run: Baton's registration is planned and nothing is written", async (t) => {
  const { home, paths, file } = primedHome(t);
  const p = plan(paths);
  assert.deepEqual(primedItems(p), [
    { name: "primed", action: "add", path: file },
  ]);
  const planned = p.files.find((f) => f.path === file);
  assert.equal(planned.before, null);
  assert.deepEqual(JSON.parse(planned.after), launcherDef(NODE, CLI));
  const dry = await baton(home, "install", "--dry-run");
  assert.equal(dry.code, 0);
  assert.match(
    dry.out,
    /PRIMED CLI +will register +~\/\.primed-cli\/launchers\/baton\.json/,
  );
  assert.match(dry.out, /create +~\/\.primed-cli\/launchers\/baton\.json/);
  assert.match(
    (await baton(home, "install", "--dry-run", "--diff")).out,
    /\+ +"source": "baton install"/,
  );
  assert.ok(!existsSync(join(home, ".primed-cli", "launchers")));
  assert.ok(!existsSync(paths.install));
});

test("install writes the launcher file in PRIMED CLI's format: node and Baton's cli.js, exec form", (t) => {
  const { paths, file } = primedHome(t);
  const { applied } = install(paths);
  assert.equal(applied.changed, true);
  const def = json(file);
  assert.deepEqual(def, {
    schemaVersion: 1,
    id: "baton",
    name: "Baton",
    description: "Claude Code on your accounts, one after another",
    program: NODE,
    args: [forward(CLI)],
    resumeArgs: ["--resume", "{conversation}"],
    continueArgs: ["--continue"],
    conversations: "claude-code",
    terminal: true,
    source: "baton install",
  });
  assert.deepEqual(launcherProblems(def, "baton.json"), []);
  assert.equal(json(paths.install).launcher, file);
  // By default, the node running Baton.
  const own = JSON.parse(
    planInstall({
      paths,
      cliPath: CLI,
      env: {},
      findPrimed: noPath,
    }).files.find((f) => f.path === file).after,
  );
  assert.equal(own.program, forward(process.execPath));
  assert.ok(isAbsolute(own.program) && isAbsolute(own.args[0]));
});

test("a cli.js path with braces stays literal for PRIMED CLI", () => {
  const def = launcherDef(NODE, "C:/tools/{baton}/src/cli.js");
  assert.equal(def.args[0], "C:/tools/{{baton}}/src/cli.js");
  assert.deepEqual(launcherProblems(def, "baton.json"), []);
});

test("PRIMED_CLI_HOME, or `primed` on PATH, finds PRIMED CLI; launchers/ is created", (t) => {
  const { home, root, paths } = tempHome(t);
  const data = join(root, "primed-data");
  mkdirSync(data);
  install(paths, { env: { PRIMED_CLI_HOME: data } });
  assert.ok(existsSync(join(data, "launchers", "baton.json")));
  assert.ok(!existsSync(join(home, ".primed-cli")));

  // On PATH only: ~/.primed-cli, made with its launchers/ folder.
  const other = tempHome(t);
  install(other.paths, {
    findPrimed: () => join(other.root, "bin", "primed.exe"),
  });
  assert.ok(
    existsSync(join(other.home, ".primed-cli", "launchers", "baton.json")),
  );

  // The PATH lookup itself, from the environment it is given.
  const third = tempHome(t);
  const bin = join(third.root, "bin");
  const program = join(
    bin,
    process.platform === "win32" ? "primed.exe" : "primed",
  );
  write(program, "");
  chmodSync(program, 0o755);
  const found = planInstall({
    paths: third.paths,
    nodePath: NODE,
    cliPath: CLI,
    env: { PATH: bin, PATHEXT: ".EXE" },
  });
  assert.equal(primedItems(found)[0].action, "add");
  const empty = planInstall({
    paths: third.paths,
    nodePath: NODE,
    cliPath: CLI,
    env: { PATH: join(third.root, "empty"), PATHEXT: ".EXE" },
  });
  assert.equal(primedItems(empty)[0].action, "missing");
});

test("install again changes nothing; Baton moving updates the file after a backup", (t) => {
  const { paths, file } = primedHome(t);
  install(paths);
  const text = read(file);
  const again = install(paths);
  assert.equal(again.applied.changed, false);
  assert.equal(again.plan.files.length, 0);
  assert.deepEqual(primedItems(again.plan), [
    { name: "primed", action: "same", path: file },
  ]);
  assert.equal(read(file), text);
  const moved = join(CLI, "..", "..", "..", "baton-moved", "src", "cli.js");
  const after = install(paths, { cliPath: moved });
  assert.equal(primedItems(after.plan)[0].action, "update");
  assert.equal(read(join(after.applied.backup, "primed-cli-baton.json")), text);
  assert.equal(json(file).args[0], forward(moved));
});

test("a baton.json that is not Baton's is backed up, then replaced", (t) => {
  const { paths, file } = primedHome(t);
  write(file, {
    schemaVersion: 1,
    id: "baton",
    name: "Something else",
    program: "something",
    source: "by hand",
  });
  const before = read(file);
  const { plan: p, applied } = install(paths);
  assert.ok(p.notes.some((n) => n.includes("not Baton's")));
  assert.equal(read(join(applied.backup, "primed-cli-baton.json")), before);
  assert.equal(json(file).source, "baton install");
});

test("uninstall removes Baton's launcher only, after a backup; the other launchers stay", (t) => {
  const { paths, data, file } = primedHome(t);
  const theirs = join(data, "launchers", "tool.json");
  write(theirs, { schemaVersion: 1, id: "tool", name: "Tool", program: "t" });
  install(paths);
  const text = read(file);
  const { plan: p, applied } = uninstall(paths);
  assert.deepEqual(primedItems(p), [
    { name: "primed", action: "remove", path: file },
  ]);
  assert.ok(!existsSync(file));
  assert.ok(existsSync(theirs));
  assert.equal(read(join(applied.backup, "primed-cli-baton.json")), text);
  const again = uninstall(paths);
  assert.equal(again.applied.changed, false);
  assert.deepEqual(primedItems(again.plan), [
    { name: "primed", action: "absent" },
  ]);
});

test("uninstall leaves a baton.json whose id or source is not Baton's", (t) => {
  const { paths, file } = primedHome(t);
  install(paths);
  for (const change of [{ source: "by hand" }, { id: "other" }]) {
    const mine = { ...launcherDef(NODE, CLI), ...change };
    write(file, mine);
    const { plan: p } = uninstall(paths);
    assert.deepEqual(primedItems(p), [
      { name: "primed", action: "skip", path: file },
    ]);
    assert.ok(p.notes.some((n) => n.includes("not Baton's")));
    assert.deepEqual(json(file), mine);
  }
});

test("uninstall finds the launcher where install wrote it after PRIMED_CLI_HOME changed", (t) => {
  const { root, paths } = tempHome(t);
  const data = join(root, "primed-data");
  mkdirSync(data);
  install(paths, { env: { PRIMED_CLI_HOME: data } });
  const file = join(data, "launchers", "baton.json");
  assert.ok(existsSync(file));
  const { plan: p } = uninstall(paths, {});
  assert.deepEqual(primedItems(p), [
    { name: "primed", action: "remove", path: file },
  ]);
  assert.ok(!existsSync(file));
});

test("install and uninstall from the command line register and remove Baton", async (t) => {
  const { home, file } = primedHome(t);
  const done = await baton(home, "install");
  assert.match(
    done.out,
    /PRIMED CLI +registered +~\/\.primed-cli\/launchers\/baton\.json/,
  );
  assert.equal(json(file).args[0], forward(CLI));
  assert.match(
    (await baton(home, "install")).out,
    /PRIMED CLI +in place +~\/\.primed-cli\/launchers\/baton\.json/,
  );
  const removed = await baton(home, "uninstall");
  assert.match(
    removed.out,
    /PRIMED CLI +removed +~\/\.primed-cli\/launchers\/baton\.json/,
  );
  assert.ok(!existsSync(file));
});

test("a launcher that cannot be written is a note: the rest is installed and the status line survives", async (t) => {
  const { home, paths, data } = primedHome(t);
  write(join(home, ".claude", "settings.json"), {
    statusLine: { command: "my-own-status" },
  });
  // PRIMED CLI's launchers/ is a file: Baton cannot write its launcher there.
  write(join(data, "launchers"), "not a folder");
  const stdout = new Collect();
  const stderr = new Collect();
  const code = await main(["install"], {
    env: testEnv(home),
    stdout,
    stderr,
    findPrimed: noPath,
  });
  assert.equal(code, 0, stderr.text);
  assert.match(stdout.text, /PRIMED CLI +failed/);
  assert.match(stdout.text, /Could not write[\s\S]*baton\.json:/);
  assert.equal(stderr.text, "");
  const settings = json(join(home, ".claude", "settings.json"));
  assert.match(settings.statusLine.command, /statusline/);
  assert.deepEqual(json(paths.install).previousStatusLine, {
    command: "my-own-status",
  });
  // Fixed, it registers, and uninstall still puts the operator's status line back.
  rmSync(join(data, "launchers"));
  const again = await baton(home, "install");
  assert.match(again.out, /PRIMED CLI +registered/);
  assert.deepEqual(json(paths.install).previousStatusLine, {
    command: "my-own-status",
  });
  await baton(home, "uninstall");
  assert.deepEqual(json(join(home, ".claude", "settings.json")), {
    statusLine: { command: "my-own-status" },
  });
});

test("a file Baton cannot write stops install with a message, and the record keeps the status line", async (t) => {
  const { home, paths } = tempHome(t);
  write(join(home, ".claude", "settings.json"), {
    statusLine: { command: "my-own-status" },
  });
  // commands/ is a file: hop.md cannot be written, after settings.json was.
  write(join(home, ".claude", "commands"), "not a folder");
  const stderr = new Collect();
  const code = await main(["install"], {
    env: testEnv(home),
    stdout: new Collect(),
    stderr,
    findPrimed: noPath,
  });
  assert.equal(code, 2);
  assert.match(stderr.text, /Could not write[\s\S]*hop\.md:/);
  assert.doesNotMatch(stderr.text, /\n\s+at /);
  assert.deepEqual(json(paths.install).previousStatusLine, {
    command: "my-own-status",
  });
  rmSync(join(home, ".claude", "commands"));
  assert.equal((await baton(home, "install")).code, 0);
  await baton(home, "uninstall");
  assert.deepEqual(json(join(home, ".claude", "settings.json")), {
    statusLine: { command: "my-own-status" },
  });
});

test(
  "PRIMED CLI's folders that install creates are private, and so is the launcher",
  { skip: process.platform === "win32" && "unix permissions" },
  (t) => {
    const { home, root, paths } = tempHome(t);
    install(paths, { findPrimed: () => join(root, "bin", "primed") });
    const mode = (p) => statSync(p).mode & 0o777;
    const data = join(home, ".primed-cli");
    assert.equal(mode(data), 0o700);
    assert.equal(mode(join(data, "launchers")), 0o700);
    assert.equal(mode(join(data, "launchers", "baton.json")), 0o600);
  },
);

test("doctor: not installed (not a failure), not registered, current, stale, not Baton's", (t) => {
  const { home, root, paths } = tempHome(t);
  const stub = join(root, "claude-stub.js");
  write(stub, 'if(process.argv[2]==="--version")console.log("2.1.302");');
  write(paths.config, { version: 1, accounts: [], claudePath: stub });
  const check = () =>
    runDoctor({
      paths,
      env: testEnv(home),
      auth: false,
      cliPath: CLI,
      findPrimed: noPath,
    }).checks.find((c) => c.name === "PRIMED CLI");
  assert.deepEqual(check(), {
    name: "PRIMED CLI",
    ok: null,
    detail: "not installed",
  });

  const data = join(home, ".primed-cli");
  const file = join(data, "launchers", "baton.json");
  mkdirSync(data);
  assert.equal(check().ok, false);
  assert.equal(check().detail, "not registered: baton install");

  install(paths, { nodePath: process.execPath });
  assert.equal(check().ok, true);
  assert.equal(check().detail, `registered and current (${file})`);

  const moved = join(root, "elsewhere", "src", "cli.js");
  const stale = (opts, why) => {
    install(paths, opts);
    assert.equal(check().ok, false);
    assert.equal(
      check().detail,
      `registered but stale (${why}): run baton install again`,
    );
  };
  stale({ nodePath: process.execPath, cliPath: moved }, "cli.js path changed");
  stale({ nodePath: NODE }, "node path changed");
  stale({ nodePath: NODE, cliPath: moved }, "node and cli.js paths changed");
  write(file, {
    ...launcherDef(process.execPath, CLI),
    description: "older words",
  });
  assert.equal(
    check().detail,
    "registered but stale (contents changed): run baton install again",
  );
  assert.equal(
    registrationState({
      paths,
      env: {},
      findPrimed: noPath,
      cliPath: CLI,
    }).state,
    "stale",
  );

  write(file, { id: "baton", source: "by hand" });
  assert.equal(check().ok, false);
  assert.equal(
    check().detail,
    `${file} is not Baton's: baton install replaces it`,
  );
});
