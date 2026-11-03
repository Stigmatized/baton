import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { main } from "../src/cli.js";
import { readJson } from "../src/fsutil.js";
import { Lead } from "../src/lead.js";
import { profileDir, profileEnv } from "../src/paths.js";
import { Poller } from "../src/poller.js";
import { pickStart } from "../src/policy.js";
import { loadSnapshot } from "../src/state.js";
import {
  CLI,
  Collect,
  FAKE_CLAUDE,
  accountsHome,
  keyInput,
  tempHome,
  testEnv,
  write,
} from "./helpers.js";

// Baton never interacts with the default Claude Code account (operator
// decision, 2026-10-25): its accounts are only the ones the operator adds.

const SID = "6f0b2d4e-1c3a-4b5d-8e9f-0a1b2c3d4e5f";

async function baton(home, ...argv) {
  const stdout = new Collect();
  const stderr = new Collect();
  // PRIMED CLI on this machine's PATH would change what doctor says.
  const code = await main(argv, {
    env: testEnv(home),
    stdout,
    stderr,
    findPrimed: () => null,
  });
  return { code, out: stdout.text, err: stderr.text };
}

// Every file under a folder with a hash of its content.
function tree(dir) {
  if (!existsSync(dir)) return {};
  const out = {};
  for (const rel of readdirSync(dir, { recursive: true }).map(String)) {
    const file = join(dir, rel);
    if (statSync(file).isFile())
      out[rel] = createHash("sha256").update(readFileSync(file)).digest("hex");
  }
  return out;
}

test("plain claude firing the installed hooks and status line leaves no Baton state; the status line only runs the operator's own", (t) => {
  const { root, paths } = accountsHome(t, ["acct1"]);
  const run = (args, input, env) =>
    spawnSync(process.execPath, [CLI, ...args], {
      input: JSON.stringify(input),
      env: testEnv(paths.home, env),
      encoding: "utf8",
    });
  const before = tree(paths.root);
  const statusInput = {
    session_id: SID,
    model: { id: "m" },
    cwd: "E:/w",
    rate_limits: {
      five_hour: { used_percentage: 77, resets_at: 1792920000 },
      seven_day: { used_percentage: 33, resets_at: 1793520000 },
    },
  };
  // No CLAUDE_CONFIG_DIR; ~/.claude itself; another folder; a profile
  // folder of an account Baton does not have.
  for (const env of [
    {},
    { CLAUDE_CONFIG_DIR: paths.claudeDir },
    { CLAUDE_CONFIG_DIR: join(root, "elsewhere") },
    { CLAUDE_CONFIG_DIR: join(paths.accounts, "ghost") },
  ]) {
    for (const [event, extra] of [
      ["session-start", { source: "startup", cwd: "E:/w" }],
      ["prompt", { prompt: "hi", permission_mode: "default" }],
      ["stop", { background_tasks: [] }],
      [
        "stop-failure",
        {
          error: "rate_limit",
          last_assistant_message: "Session limit reached ∙ resets 3pm",
        },
      ],
      ["session-end", { reason: "exit" }],
    ]) {
      const r = run(["hook", event], { session_id: SID, ...extra }, env);
      assert.equal(r.status, 0, r.stderr);
      assert.equal(r.stdout, "");
    }
    const line = run(["statusline"], statusInput, env);
    assert.equal(line.status, 0, line.stderr);
    assert.equal(line.stdout, "", "nothing of Baton's in plain claude");
  }
  assert.deepEqual(tree(paths.root), before, "no Baton state at all");
  // With the operator's own status line, that one runs, with the same input.
  const script = join(root, "mine.mjs");
  write(
    script,
    'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write("mine:"+JSON.parse(s).session_id))',
  );
  write(paths.install, {
    previousStatusLine: { type: "command", command: `node "${script}"` },
  });
  const theirs = run(["statusline"], statusInput, {});
  assert.equal(theirs.stdout, `mine:${SID}`);
  assert.ok(!existsSync(paths.usage) && !existsSync(paths.sessions));
  // Under one of Baton's profiles the same input is recorded.
  run(["statusline"], statusInput, {
    CLAUDE_CONFIG_DIR: profileDir(paths, "acct1"),
  });
  assert.equal(readJson(join(paths.usage, "acct1.json")).five_hour.used, 77);
});

test("/hop in a conversation not started with baton says it only works there", async (t) => {
  const { home } = accountsHome(t, ["acct1", "acct2"]);
  const r = await baton(home, "hop", SID, "--from-command");
  assert.equal(r.code, 0, "the /hop command shows the answer to the model");
  assert.match(
    r.out,
    /^Baton: \/hop and baton hop only work in sessions started with baton/,
  );
  assert.equal((await baton(home, "hop", SID)).code, 1);
});

test("with no accounts, baton asks for one and starts nothing; status and the account list say how", async (t) => {
  const { home, root, paths } = tempHome(t);
  const output = new Collect();
  let spawned = false;
  const lead = new Lead({
    poll: false,
    args: [],
    paths,
    env: testEnv(home, { FAKE_CLAUDE_DIR: root }),
    cwd: root,
    claude: {
      command: process.execPath,
      prefix: [FAKE_CLAUDE],
      path: FAKE_CLAUDE,
    },
    spawnClaude: () => {
      spawned = true;
      throw new Error("must not start claude");
    },
    input: keyInput(),
    output,
    stdio: "ignore",
  });
  assert.equal(await lead.run(), 1);
  assert.equal(spawned, false);
  assert.match(
    output.text,
    /No accounts yet: add one with baton account add <name> \(or a in the menu\), then sign it in with baton login <name>/,
  );
  for (const command of [["status"], ["account", "list"], ["usage"]]) {
    const r = await baton(home, ...command);
    assert.match(r.out, /No accounts yet/);
    assert.match(r.out, /baton account add <name>/);
  }
  const pick = await baton(home, "pick");
  assert.equal(pick.code, 3);
  assert.match(pick.out, /^No accounts yet/);
});

test("picking, launching, signing in and polling only ever use Baton's own profiles", async (t) => {
  const { home, root, paths } = accountsHome(t, ["acct1", "acct2"]);
  for (const id of ["acct1", "acct2"]) {
    assert.equal(
      profileEnv(paths, id, {}).CLAUDE_CONFIG_DIR,
      profileDir(paths, id),
    );
    assert.equal(
      profileEnv(paths, id, { CLAUDE_CONFIG_DIR: paths.claudeDir })
        .CLAUDE_CONFIG_DIR,
      profileDir(paths, id),
    );
  }
  const snapshot = loadSnapshot(paths);
  assert.deepEqual(
    snapshot.states.map((s) => s.id),
    ["acct1", "acct2"],
  );
  assert.ok(
    ["acct1", "acct2"].includes(
      pickStart(snapshot.states, snapshot.policy).account,
    ),
  );
  // The poller asks only the added accounts, each under its own profile.
  const asked = [];
  const poller = new Poller({
    paths,
    env: testEnv(home),
    launcher: {
      command: process.execPath,
      prefix: [FAKE_CLAUDE],
      path: FAKE_CLAUDE,
    },
    auth: async () => ({ ok: true, loggedIn: true }),
    probe: async ({ id, env }) => {
      asked.push([id, profileEnv(paths, id, env).CLAUDE_CONFIG_DIR]);
      return { status: "unavailable", reason: "test" };
    },
  });
  await poller.refresh();
  assert.deepEqual(asked, [
    ["acct1", profileDir(paths, "acct1")],
    ["acct2", profileDir(paths, "acct2")],
  ]);
  // doctor runs claude under the profiles (sign-in) and Baton's own folder
  // (version), never without a CLAUDE_CONFIG_DIR or with ~/.claude.
  const log = join(root, "claude-dirs.log");
  const stub = join(root, "claude-stub.cjs");
  write(
    stub,
    `require("fs").appendFileSync(${JSON.stringify(log)}, (process.env.CLAUDE_CONFIG_DIR || "(none)") + "\\n"); const a = process.argv.slice(2).join(" "); if (a === "--version") console.log("2.1.302 (Claude Code)"); else console.log(JSON.stringify({ loggedIn: true, authMethod: "claude.ai" }));`,
  );
  const config = JSON.parse(readFileSync(paths.config, "utf8"));
  write(paths.config, { ...config, claudePath: stub });
  await baton(home, "doctor");
  const dirs = readFileSync(log, "utf8").trim().split("\n");
  assert.equal(dirs.length, 3);
  assert.ok(!dirs.includes("(none)"));
  assert.ok(
    !dirs.some((d) => d.toLowerCase() === paths.claudeDir.toLowerCase()),
  );
  assert.ok(dirs.includes(profileDir(paths, "acct1")));
  assert.ok(dirs.includes(join(paths.tmp, "claude-version")));
});
