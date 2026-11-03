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
import { launcherDef, registrationState } from "../src/ferry.js";
import { CLI, Collect, tempHome, testEnv, write } from "./helpers.js";

// Never the node running the tests (the doctor test tells them apart).
const NODE = "C:/Program Files/node-under-test/node.exe";
const read = (f) => readFileSync(f, "utf8");
const json = (f) => JSON.parse(read(f));
// `ferry` is never on PATH unless a test says so.
const noPath = () => null;

// A test home with Ferry's data folder (~/.ferry).
function ferryHome(t) {
  const home = tempHome(t);
  const data = join(home.home, ".ferry");
  mkdirSync(data, { recursive: true });
  return { ...home, data, file: join(data, "launchers", "baton.json") };
}

const plan = (paths, opts = {}) =>
  planInstall({
    paths,
    nodePath: NODE,
    cliPath: CLI,
    env: {},
    findFerry: noPath,
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

const ferryItems = (p) => p.items.filter((i) => i.name === "ferry");

async function baton(home, ...argv) {
  const stdout = new Collect();
  const code = await main(argv, {
    env: testEnv(home),
    stdout,
    stderr: new Collect(),
    findFerry: noPath,
  });
  return { code, out: stdout.text };
}

// Ferry's launcher format, schema version 1: what is wrong with a file
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

test("without Ferry the plan says so in one line and nothing is written for it", async (t) => {
  const { home, paths } = tempHome(t);
  const p = plan(paths);
  assert.deepEqual(ferryItems(p), [{ name: "ferry", action: "missing" }]);
  assert.ok(p.files.every((f) => !f.path.includes(".ferry")));
  applyPlan(p, { paths });
  assert.ok(!existsSync(join(home, ".ferry")));
  assert.equal(json(paths.install).launcher, undefined);
  // A FERRY_HOME that does not exist is not Ferry either.
  assert.deepEqual(
    ferryItems(plan(paths, { env: { FERRY_HOME: join(home, "no") } })),
    [{ name: "ferry", action: "missing" }],
  );
  const dry = await baton(home, "install", "--dry-run");
  assert.match(
    dry.out,
    /\n *\S Ferry not found; run baton install again after installing it\n/,
  );
  // Uninstall has nothing to say about it.
  assert.deepEqual(ferryItems(uninstall(paths).plan), []);
});

test("dry run: Baton's registration is planned and nothing is written", async (t) => {
  const { home, paths, file } = ferryHome(t);
  const p = plan(paths);
  assert.deepEqual(ferryItems(p), [
    { name: "ferry", action: "add", path: file },
  ]);
  const planned = p.files.find((f) => f.path === file);
  assert.equal(planned.before, null);
  assert.deepEqual(JSON.parse(planned.after), launcherDef(NODE, CLI));
  const dry = await baton(home, "install", "--dry-run");
  assert.equal(dry.code, 0);
  assert.match(
    dry.out,
    /Ferry +will register +~\/\.ferry\/launchers\/baton\.json/,
  );
  assert.match(dry.out, /create +~\/\.ferry\/launchers\/baton\.json/);
  assert.match(
    (await baton(home, "install", "--dry-run", "--diff")).out,
    /\+ +"source": "baton install"/,
  );
  assert.ok(!existsSync(join(home, ".ferry", "launchers")));
  assert.ok(!existsSync(paths.install));
});

test("install writes the launcher file in Ferry's format: node and Baton's cli.js, exec form", (t) => {
  const { paths, file } = ferryHome(t);
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
      findFerry: noPath,
    }).files.find((f) => f.path === file).after,
  );
  assert.equal(own.program, forward(process.execPath));
  assert.ok(isAbsolute(own.program) && isAbsolute(own.args[0]));
});

test("a cli.js path with braces stays literal for Ferry", () => {
  const def = launcherDef(NODE, "C:/tools/{baton}/src/cli.js");
  assert.equal(def.args[0], "C:/tools/{{baton}}/src/cli.js");
  assert.deepEqual(launcherProblems(def, "baton.json"), []);
});

test("FERRY_HOME, or `ferry` on PATH, finds Ferry; launchers/ is created", (t) => {
  const { home, root, paths } = tempHome(t);
  const data = join(root, "ferry-data");
  mkdirSync(data);
  install(paths, { env: { FERRY_HOME: data } });
  assert.ok(existsSync(join(data, "launchers", "baton.json")));
  assert.ok(!existsSync(join(home, ".ferry")));

  // On PATH only: ~/.ferry, made with its launchers/ folder.
  const other = tempHome(t);
  install(other.paths, {
    findFerry: () => join(other.root, "bin", "ferry.exe"),
  });
  assert.ok(existsSync(join(other.home, ".ferry", "launchers", "baton.json")));

  // The PATH lookup itself, from the environment it is given.
  const third = tempHome(t);
  const bin = join(third.root, "bin");
  const program = join(
    bin,
    process.platform === "win32" ? "ferry.exe" : "ferry",
  );
  write(program, "");
  chmodSync(program, 0o755);
  const found = planInstall({
    paths: third.paths,
    nodePath: NODE,
    cliPath: CLI,
    env: { PATH: bin, PATHEXT: ".EXE" },
  });
  assert.equal(ferryItems(found)[0].action, "add");
  const empty = planInstall({
    paths: third.paths,
    nodePath: NODE,
    cliPath: CLI,
    env: { PATH: join(third.root, "empty"), PATHEXT: ".EXE" },
  });
  assert.equal(ferryItems(empty)[0].action, "missing");
});

test("install again changes nothing; Baton moving updates the file after a backup", (t) => {
  const { paths, file } = ferryHome(t);
  install(paths);
  const text = read(file);
  const again = install(paths);
  assert.equal(again.applied.changed, false);
  assert.equal(again.plan.files.length, 0);
  assert.deepEqual(ferryItems(again.plan), [
    { name: "ferry", action: "same", path: file },
  ]);
  assert.equal(read(file), text);
  const moved = join(CLI, "..", "..", "..", "baton-moved", "src", "cli.js");
  const after = install(paths, { cliPath: moved });
  assert.equal(ferryItems(after.plan)[0].action, "update");
  assert.equal(read(join(after.applied.backup, "ferry-baton.json")), text);
  assert.equal(json(file).args[0], forward(moved));
});

test("a baton.json that is not Baton's is backed up, then replaced", (t) => {
  const { paths, file } = ferryHome(t);
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
  assert.equal(read(join(applied.backup, "ferry-baton.json")), before);
  assert.equal(json(file).source, "baton install");
});

test("uninstall removes Baton's launcher only, after a backup; the other launchers stay", (t) => {
  const { paths, data, file } = ferryHome(t);
  const theirs = join(data, "launchers", "tool.json");
  write(theirs, { schemaVersion: 1, id: "tool", name: "Tool", program: "t" });
  install(paths);
  const text = read(file);
  const { plan: p, applied } = uninstall(paths);
  assert.deepEqual(ferryItems(p), [
    { name: "ferry", action: "remove", path: file },
  ]);
  assert.ok(!existsSync(file));
  assert.ok(existsSync(theirs));
  assert.equal(read(join(applied.backup, "ferry-baton.json")), text);
  const again = uninstall(paths);
  assert.equal(again.applied.changed, false);
  assert.deepEqual(ferryItems(again.plan), [
    { name: "ferry", action: "absent" },
  ]);
});

test("uninstall leaves a baton.json whose id or source is not Baton's", (t) => {
  const { paths, file } = ferryHome(t);
  install(paths);
  for (const change of [{ source: "by hand" }, { id: "other" }]) {
    const mine = { ...launcherDef(NODE, CLI), ...change };
    write(file, mine);
    const { plan: p } = uninstall(paths);
    assert.deepEqual(ferryItems(p), [
      { name: "ferry", action: "skip", path: file },
    ]);
    assert.ok(p.notes.some((n) => n.includes("not Baton's")));
    assert.deepEqual(json(file), mine);
  }
});

test("uninstall finds the launcher where install wrote it after FERRY_HOME changed", (t) => {
  const { root, paths } = tempHome(t);
  const data = join(root, "ferry-data");
  mkdirSync(data);
  install(paths, { env: { FERRY_HOME: data } });
  const file = join(data, "launchers", "baton.json");
  assert.ok(existsSync(file));
  const { plan: p } = uninstall(paths, {});
  assert.deepEqual(ferryItems(p), [
    { name: "ferry", action: "remove", path: file },
  ]);
  assert.ok(!existsSync(file));
});

test("install and uninstall from the command line register and remove Baton", async (t) => {
  const { home, file } = ferryHome(t);
  const done = await baton(home, "install");
  assert.match(
    done.out,
    /Ferry +registered +~\/\.ferry\/launchers\/baton\.json/,
  );
  assert.equal(json(file).args[0], forward(CLI));
  assert.match(
    (await baton(home, "install")).out,
    /Ferry +in place +~\/\.ferry\/launchers\/baton\.json/,
  );
  const removed = await baton(home, "uninstall");
  assert.match(
    removed.out,
    /Ferry +removed +~\/\.ferry\/launchers\/baton\.json/,
  );
  assert.ok(!existsSync(file));
});

test("a launcher that cannot be written is a note: the rest is installed and the status line survives", async (t) => {
  const { home, paths, data } = ferryHome(t);
  write(join(home, ".claude", "settings.json"), {
    statusLine: { command: "my-own-status" },
  });
  // Ferry's launchers/ is a file: Baton cannot write its launcher there.
  write(join(data, "launchers"), "not a folder");
  const stdout = new Collect();
  const stderr = new Collect();
  const code = await main(["install"], {
    env: testEnv(home),
    stdout,
    stderr,
    findFerry: noPath,
  });
  assert.equal(code, 0, stderr.text);
  assert.match(stdout.text, /Ferry +failed/);
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
  assert.match(again.out, /Ferry +registered/);
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
    findFerry: noPath,
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
  "Ferry's folders that install creates are private, and so is the launcher",
  { skip: process.platform === "win32" && "unix permissions" },
  (t) => {
    const { home, root, paths } = tempHome(t);
    install(paths, { findFerry: () => join(root, "bin", "ferry") });
    const mode = (p) => statSync(p).mode & 0o777;
    const data = join(home, ".ferry");
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
      findFerry: noPath,
    }).checks.find((c) => c.name === "Ferry");
  assert.deepEqual(check(), {
    name: "Ferry",
    ok: null,
    detail: "not installed",
  });

  const data = join(home, ".ferry");
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
      findFerry: noPath,
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
