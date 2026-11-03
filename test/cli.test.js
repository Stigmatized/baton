import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { main } from "../src/cli.js";
import { appendJsonLine } from "../src/fsutil.js";
import { profileDir } from "../src/paths.js";
import { historyFile } from "../src/usage.js";
import { CLI, Collect, tempHome, testEnv, write } from "./helpers.js";

// PRIMED CLI only when the test home has its data folder, never from PATH.
async function baton(home, ...argv) {
  const stdout = new Collect();
  const stderr = new Collect();
  const code = await main(argv, {
    env: testEnv(home),
    stdout,
    stderr,
    findPrimed: () => null,
  });
  return {
    code,
    out: stdout.text,
    err: stderr.text,
    json: () => JSON.parse(stdout.text),
  };
}

test("help lists the commands and each command's usage", async (t) => {
  const { home } = tempHome(t);
  const help = await baton(home, "help");
  assert.equal(help.code, 0);
  for (const name of [
    "start",
    "hop",
    "account",
    "login",
    "status",
    "stats",
    "policy",
    "install",
    "uninstall",
    "doctor",
    "view",
  ])
    assert.match(help.out, new RegExp(`\\n  ${name} `));
  // The other names for start and view are not listed.
  for (const name of ["claude", "menu"])
    assert.doesNotMatch(help.out, new RegExp(`\\n  ${name} `));
  assert.match(
    help.out,
    /baton starts Claude Code on the best account; baton view opens the menu/,
  );
  const start = (await baton(home, "help", "start")).out;
  assert.match(start, /^ *baton \[claude arguments\.\.\.\]$/m);
  assert.match(start, /^ *baton start \[claude arguments\.\.\.\]$/m);
  assert.match((await baton(home, "help", "menu")).out, /Same as baton view/);
  assert.match(
    (await baton(home, "help", "account")).out,
    /baton account add <name> \[--mark m\]/,
  );
  assert.match(
    (await baton(home, "status", "--help")).out,
    /baton status \[--json\]/,
  );
  assert.equal((await baton(home, "nonsense")).code, 2);
  assert.equal((await baton(home, "status", "--bogus")).code, 2);
});

test("accounts: add, order, marks, thresholds, remove", async (t) => {
  const { home, paths } = tempHome(t);
  write(join(paths.claudeDir, "settings.json"), {});
  assert.equal((await baton(home, "account", "add", "acct1")).code, 0);
  const added = await baton(home, "account", "add", "acct2");
  assert.equal(added.code, 0, added.err);
  assert.match(added.out, /Added acct2/);
  assert.match(added.out, /Position {4}#2/);
  assert.match(added.out, /Mark {8}normal/);
  assert.match(added.out, /baton login acct2/);
  assert.ok(existsSync(profileDir(paths, "acct2")));
  assert.equal(
    (await baton(home, "account", "add", "acct3", "--last-resort")).code,
    0,
  );
  assert.equal(
    (
      await baton(
        home,
        "account",
        "add",
        "acct4",
        "--position",
        "1",
        "--mark",
        "preferred",
      )
    ).code,
    0,
  );
  assert.equal((await baton(home, "account", "add", "acct2")).code, 2);
  // Names are labels (any printable text), never control characters.
  assert.equal((await baton(home, "account", "add", "bad\nname")).code, 2);
  assert.equal((await baton(home, "account", "add", "ACCT2")).code, 2);
  const list = (await baton(home, "account", "list", "--json")).json();
  assert.deepEqual(
    list.map((a) => [a.name, a.mark]),
    [
      ["acct4", "preferred"],
      ["acct1", "normal"],
      ["acct2", "normal"],
      ["acct3", "last-resort"],
    ],
  );
  // The new order, one numbered line per account.
  const order = (out) =>
    [...out.matchAll(/^\s+\d+\s+(.+)$/gm)].map((m) => m[1]);
  assert.deepEqual(
    order((await baton(home, "account", "order", "acct1", "acct2")).out),
    ["acct1", "acct2", "acct4", "acct3"],
  );
  assert.deepEqual(
    order((await baton(home, "account", "move", "acct3", "2")).out),
    ["acct1", "acct3", "acct2", "acct4"],
  );
  const set = await baton(
    home,
    "account",
    "set",
    "acct2",
    "--five-hour",
    "80",
    "--weekly",
    "90",
    "--mark",
    "preferred",
  );
  assert.match(set.out, /Updated acct2/);
  assert.match(set.out, /Mark {8}preferred/);
  assert.match(set.out, /5-hour {6}80%/);
  assert.match(set.out, /Weekly {6}90%/);
  const reset = (
    await baton(
      home,
      "account",
      "set",
      "acct2",
      "--five-hour",
      "default",
      "--last-resort",
      "true",
    )
  ).out;
  assert.match(reset, /Mark {8}last resort/);
  assert.match(reset, /5-hour {6}default/);
  assert.equal(
    (await baton(home, "account", "set", "acct2", "--weekly", "120")).code,
    2,
  );
  assert.equal(
    (await baton(home, "account", "set", "nobody", "--mark", "normal")).code,
    2,
  );
  const removed = await baton(home, "account", "remove", "acct2");
  assert.match(removed.out, /still holds that account's sign-in/);
  assert.ok(existsSync(profileDir(paths, "acct2")), "the folder stays");
  assert.ok(
    !existsSync(join(profileDir(paths, "acct2"), "settings.json")) ||
      !lstatSync(
        join(profileDir(paths, "acct2"), "settings.json"),
      ).isSymbolicLink(),
  );
  assert.equal((await baton(home, "account", "remove", "acct1")).code, 0);
  assert.equal((await baton(home, "account", "remove", "acct3")).code, 0);
  // The last account stays.
  const last = await baton(home, "account", "remove", "acct4");
  assert.equal(last.code, 2);
  assert.match(last.err, /acct4 is the only account and Baton needs one/);
  const config = JSON.parse(readFileSync(paths.config, "utf8"));
  assert.equal(config.version, 1);
  assert.deepEqual(
    config.accounts.map((a) => a.name),
    ["acct4"],
  );
});

test("status: accounts with their windows, blocks, sessions and where new work goes", async (t) => {
  const { home, paths } = tempHome(t);
  await baton(home, "account", "add", "acct1");
  await baton(home, "account", "add", "acct2");
  await baton(home, "account", "add", "acct3");
  const now = Date.now();
  const r = (used, inMs) => ({
    used,
    resetsAt: new Date(now + inMs).toISOString(),
    readAt: new Date(now - 120e3).toISOString(),
  });
  write(join(paths.usage, "acct1.json"), {
    account: "acct1",
    five_hour: r(95, 42 * 60e3),
    seven_day: r(40, 3 * 864e5),
  });
  write(join(paths.usage, "acct2.json"), {
    account: "acct2",
    five_hour: r(20, 3600e3),
    seven_day: r(97, 864e5),
  });
  write(join(paths.usage, "acct3.json"), {
    account: "acct3",
    five_hour: r(10, 3600e3),
    seven_day: r(50, 864e5),
  });
  const text = (await baton(home, "status")).out;
  // One row per account: 5-hour and weekly use, then when it is back.
  assert.match(text, /^ *acct1 +\S+ +95% +\S+ +40% +Back in 42m$/m);
  assert.match(text, /^ *acct2 +\S+ +20% +\S+ +97% +Back in 1d$/m);
  assert.match(text, /^ *acct3 +\S+ +10% +\S+ +50% +Ready$/m);
  assert.match(text, /NEXT ACCOUNT[^\n]*\n *acct3\n/);
  assert.match(text, /Usage poll: no baton running/);
  // The accounts' windows, with where each reading came from.
  const usage = (await baton(home, "usage", "acct1")).out;
  assert.match(usage, /5-hour .* 95% +resets /);
  assert.match(usage, /blocked/);
  const view = (await baton(home, "status", "--json")).json();
  assert.deepEqual(
    view.accounts.map((a) => [a.name, a.blocked, a.blockedBy]),
    [
      ["acct1", true, ["five_hour"]],
      ["acct2", true, ["seven_day"]],
      ["acct3", false, []],
    ],
  );
  assert.equal(
    view.accounts[0].availableAt,
    new Date(now + 42 * 60e3).toISOString(),
  );
  assert.deepEqual(view.next, {
    account: "acct3",
    id: "acct3",
    reason: "urgency",
  });
  write(join(paths.usage, "acct3.json"), {
    account: "acct3",
    five_hour: r(99, 20 * 60e3),
    seven_day: r(50, 864e5),
  });
  const blocked = await baton(home, "status");
  assert.match(blocked.out, /All accounts are at their limit/);
  assert.match(blocked.out, /acct3 returns in (19|20)m/);
  const pick = await baton(home, "pick", "--json");
  assert.equal(pick.code, 3);
  assert.equal(pick.json().earliest, "acct3");
});

test("policy: show, change and reset settings", async (t) => {
  const { home } = tempHome(t);
  assert.match((await baton(home, "policy")).out, /mode {18}smart {2}default/);
  const changed = await baton(
    home,
    "policy",
    "--mode",
    "order",
    "--start-reserve",
    "30",
    "--min-stay",
    "45",
  );
  assert.equal(changed.code, 0, changed.err);
  const json = (await baton(home, "policy", "--json")).json();
  assert.deepEqual(
    [json.mode, json.startReserve, json.minStayMinutes, json.planFactor],
    ["order", 30, 45, 1.5],
  );
  assert.equal((await baton(home, "policy", "--mode", "chaos")).code, 2);
  assert.equal((await baton(home, "policy", "--start-reserve", "-5")).code, 2);
  await baton(home, "policy", "--mode", "default");
  assert.equal((await baton(home, "policy", "--json")).json().mode, "smart");
});

test("stats: usage per day, refusals, hops, sessions and weekly allowance left at a reset", async (t) => {
  const { home, paths } = tempHome(t);
  await baton(home, "account", "add", "acct1");
  await baton(home, "account", "add", "acct2");
  const now = Date.now();
  const at = (ago) => new Date(now - ago).toISOString();
  const reset = new Date(now - 864e5).toISOString();
  for (const [ago, used] of [
    [3 * 864e5, 70],
    [2 * 864e5, 80],
  ])
    appendJsonLine(historyFile(paths, "readings", now - ago), {
      at: at(ago),
      account: "acct1",
      window: "seven_day",
      used,
      resetsAt: reset,
    });
  // An hour ago, or at midnight when today is younger: on today's row.
  const today = Math.min(3600e3, now - new Date(now).setHours(0, 0, 0, 0));
  appendJsonLine(historyFile(paths, "readings", now - today), {
    at: at(today),
    account: "acct1",
    window: "five_hour",
    used: 55,
    resetsAt: at(-3600e3),
  });
  appendJsonLine(historyFile(paths, "events", now - 3600e3), {
    at: at(3600e3),
    type: "refusal",
    account: "acct1",
    window: "five_hour",
  });
  appendJsonLine(historyFile(paths, "events", now - 3500e3), {
    at: at(3500e3),
    type: "hop",
    session: "s",
    from: "acct1",
    to: "acct2",
    reason: "refusal",
  });
  appendJsonLine(historyFile(paths, "events", now - 7200e3), {
    at: at(7200e3),
    type: "session",
    account: "acct1",
    source: "startup",
  });
  const stats = (await baton(home, "stats", "--json")).json();
  const d = stats.accounts.find((a) => a.name === "acct1");
  assert.equal(d.refusals, 1);
  assert.equal(d.sessions, 1);
  assert.deepEqual(d.wasted, [
    { resetAt: reset, lastUsed: 80, headroomLeft: 15, unused: 20 },
  ]);
  assert.equal(d.daily.at(-1).fiveHourMax, 55);
  assert.deepEqual(stats.hopReasons, { refusal: 1 });
  const session = stats.sessions.find((s) => s.id === "s");
  assert.deepEqual(
    session.hops.map((h) => [h.from, h.to, h.reason]),
    [["acct1", "acct2", "refusal"]],
  );
  assert.deepEqual(session.costPerTurn, { five_hour: null, seven_day: null });
  assert.equal(
    stats.accounts
      .find((a) => a.name === "acct2")
      .daily.reduce((s, x) => s + x.hopsIn, 0),
    1,
  );
  const text = (await baton(home, "stats")).out;
  assert.match(text, /acct1 +\w{3} \d+ · 20% unused · 15% under its threshold/);
  assert.match(text, /Why +1 refusal/);
  assert.equal((await baton(home, "stats", "--days", "0")).code, 2);
});

test("install and uninstall from the command line, with a dry run first", async (t) => {
  const { home, paths } = tempHome(t);
  write(join(paths.claudeDir, "settings.json"), { theme: "dark" });
  await baton(home, "account", "add", "acct2");
  const dry = await baton(home, "install", "--dry-run");
  assert.match(dry.out, /will add +baton statusline/);
  assert.match(dry.out, /change +\S*settings\.json/);
  assert.match(dry.out, /Dry run: nothing was written/);
  assert.doesNotMatch(dry.out, /"hooks"/, "the diff is only shown on request");
  assert.match(
    (await baton(home, "install", "--dry-run", "--diff")).out,
    /\+ +"hooks": \{/,
  );
  assert.deepEqual(
    JSON.parse(readFileSync(join(paths.claudeDir, "settings.json"), "utf8")),
    { theme: "dark" },
  );
  const done = await baton(home, "install");
  assert.match(done.out, /Installed/);
  assert.match(done.out, /Backup +\S*backups/);
  assert.match(done.out, /Undo +baton uninstall/);
  assert.match((await baton(home, "install")).out, /Already installed/);
  // A profile in copy mode gets the new settings.json at once.
  const copy = JSON.parse(
    readFileSync(join(profileDir(paths, "acct2"), "settings.json"), "utf8"),
  );
  assert.ok(copy.statusLine.command.includes("statusline"));
  assert.match((await baton(home, "uninstall")).out, /Uninstalled/);
  assert.deepEqual(
    JSON.parse(readFileSync(join(paths.claudeDir, "settings.json"), "utf8")),
    { theme: "dark" },
  );
});

test("doctor reports claude, links, sign-in (method only) and the install", async (t) => {
  const { home, root, paths } = tempHome(t);
  // A stand-in claude: version and a signed-in auth status that also carries an email.
  const fake = join(root, "claude-stub.js");
  write(
    fake,
    'const a=process.argv.slice(2).join(" ");if(a==="--version")console.log("2.1.302 (Claude Code)");else if(a==="auth status --json"){console.log(JSON.stringify({loggedIn:!!process.env.CLAUDE_CONFIG_DIR,authMethod:process.env.CLAUDE_CONFIG_DIR?"claude.ai":"none",email:"someone@example.invalid"}));process.exit(process.env.CLAUDE_CONFIG_DIR?0:1)}',
  );
  write(paths.config, { version: 1, accounts: [], claudePath: fake });
  await baton(home, "account", "add", "acct2");
  const r = await baton(home, "doctor", "--json");
  const checks = Object.fromEntries(r.json().checks.map((c) => [c.name, c]));
  assert.equal(checks.claude.ok, true);
  assert.match(checks.claude.detail, /2\.1\.302/);
  assert.equal(checks["account acct2 sign-in"].detail, "signed in (claude.ai)");
  // Only Baton's own accounts, never the default Claude Code account.
  assert.equal(checks["account default sign-in"], undefined);
  assert.deepEqual(
    Object.keys(checks).filter((k) => k.endsWith("sign-in")),
    ["account acct2 sign-in"],
  );
  assert.equal(checks["status line"].ok, false);
  assert.equal(r.code, 1);
  assert.ok(!r.out.includes("example.invalid"), "no email is printed");
  assert.ok(!(await baton(home, "doctor")).out.includes("example.invalid"));
});

test("doctor does not flag a fresh account for history.jsonl, whether or not file links are allowed", async (t) => {
  const { home, root, paths } = tempHome(t);
  // The shared base has a prompt history, as soon as Claude Code has run.
  write(join(paths.claudeDir, "history.jsonl"), "{}\n");
  const fake = join(root, "claude-stub.js");
  write(fake, 'if(process.argv[2]==="--version")console.log("2.1.302");');
  write(paths.config, { version: 1, accounts: [], claudePath: fake });
  // Adding an account links its profile, as on a fresh install.
  assert.equal((await baton(home, "account", "add", "acct2")).code, 0);
  const report = (await baton(home, "doctor", "--json")).json();
  const links = report.checks.find((c) => c.name === "account acct2 links");
  assert.equal(links.ok, true, links.detail);
  assert.doesNotMatch(links.detail, /history\.jsonl missing/);
  // Where file links are off, the check says what was left out.
  if (
    !report.checks
      .find((c) => c.name === "file links")
      .detail.startsWith("allowed")
  )
    assert.match(links.detail, /history\.jsonl not shared/);
});

test("the bin runs as a process; `baton` alone starts a session, which asks for an account first", (t) => {
  const { home } = tempHome(t);
  const r = spawnSync(process.execPath, [CLI, "status"], {
    env: testEnv(home),
    encoding: "utf8",
  });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /No accounts yet/);
  assert.match(r.stdout, /baton account add <name>/);
  assert.doesNotMatch(r.stdout, /\x1b/, "piped output carries no escapes");
  const start = spawnSync(process.execPath, [CLI], {
    env: testEnv(home),
    encoding: "utf8",
  });
  assert.equal(start.status, 1, start.stderr);
  assert.match(start.stdout + start.stderr, /No accounts yet/);
  // The menu needs a terminal.
  const view = spawnSync(process.execPath, [CLI, "view"], {
    env: testEnv(home),
    encoding: "utf8",
  });
  assert.equal(view.status, 2);
  assert.match(view.stderr, /The menu needs a terminal; try baton status/);
  const v = spawnSync(process.execPath, [CLI, "--version"], {
    env: testEnv(home),
    encoding: "utf8",
  });
  assert.match(v.stdout, /^\d+\.\d+\.\d+/);
});
