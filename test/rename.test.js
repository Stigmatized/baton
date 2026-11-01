import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { main } from "../src/cli.js";
import { loadConfig } from "../src/config.js";
import { readJson, readJsonLines } from "../src/fsutil.js";
import { handleHook, handleStatusLine } from "../src/hooks.js";
import { Lead } from "../src/lead.js";
import { createStore } from "../src/menu/index.js";
import { plain } from "../src/menu/lines.js";
import { lastToast } from "../src/menu/state.js";
import { width } from "../src/menu/text.js";
import { idFromName } from "../src/names.js";
import { accountFromEnv, profileDir } from "../src/paths.js";
import { endClaude } from "../src/terminate.js";
import { NOW, buildHome, frame, menuState, sizes } from "./menu-fixtures.js";
import {
  Collect,
  FAKE_CLAUDE,
  keyInput,
  tempHome,
  testEnv,
  until,
  write,
} from "./helpers.js";

async function baton(home, ...argv) {
  const stdout = new Collect();
  const stderr = new Collect();
  const code = await main(argv, { env: testEnv(home), stdout, stderr });
  return {
    code,
    out: stdout.text,
    err: stderr.text,
    json: () => JSON.parse(stdout.text),
  };
}
const SID = "6f0b2d4e-1c3a-4b5d-8e9f-0a1b2c3d4e5f";
const EMAIL = "jane.work+baton@example.com";

test("rename from the command line: the name changes, the id, folder, files and history stay", async (t) => {
  const { home, paths } = tempHome(t);
  await baton(home, "account", "add", "acct1");
  await baton(home, "account", "add", "acct2");
  const id = loadConfig(paths).accounts[1].id;
  assert.equal(id, "acct2");
  handleStatusLine(
    {
      session_id: SID,
      rate_limits: {
        five_hour: {
          used_percentage: 33,
          resets_at: Math.floor(Date.now() / 1000) + 3600,
        },
      },
    },
    { env: { CLAUDE_CONFIG_DIR: profileDir(paths, id) }, paths },
  );
  const r = await baton(home, "account", "rename", "acct2", "work");
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /Renamed acct2 to work/);
  const config = loadConfig(paths);
  assert.deepEqual(
    config.accounts.map((a) => [a.id, a.name]),
    [
      ["acct1", "acct1"],
      ["acct2", "work"],
    ],
  );
  assert.ok(
    existsSync(profileDir(paths, "acct2")),
    "the profile folder did not move",
  );
  assert.ok(!existsSync(join(paths.accounts, "work")));
  const status = (await baton(home, "status", "--json")).json();
  assert.deepEqual(
    status.accounts.map((a) => [a.id, a.name]),
    [
      ["acct1", "acct1"],
      ["acct2", "work"],
    ],
  );
  assert.equal(
    status.accounts[1].five_hour.used,
    33,
    "the reading is still the account's",
  );
  assert.match(
    (await baton(home, "account", "list")).out,
    /2 +\S +work +normal +folder acct2/,
  );
  // The new name works everywhere; the id still finds it.
  assert.equal(
    (await baton(home, "account", "set", "work", "--mark", "preferred")).code,
    0,
  );
  assert.equal(
    (await baton(home, "account", "set", "acct2", "--mark", "normal")).code,
    0,
    "the id still finds it",
  );
  assert.equal(loadConfig(paths).accounts[1].mark, "normal");
  // A new account may take the old name; it gets an id of its own.
  assert.equal((await baton(home, "account", "add", "acct2")).code, 0);
  const third = loadConfig(paths).accounts[2];
  assert.deepEqual([third.id, third.name], ["acct2-2", "acct2"]);
  assert.ok(existsSync(profileDir(paths, "acct2-2")));
  // Now "acct2" is a name: it means the new account.
  await baton(home, "account", "set", "acct2", "--mark", "last-resort");
  assert.deepEqual(
    loadConfig(paths).accounts.map((a) => a.mark),
    ["normal", "normal", "last-resort"],
  );
});

test("names are labels: emails, spaces, any script, up to 120 characters; never control characters or a name taken in another case", async (t) => {
  const { home, paths } = tempHome(t);
  await baton(home, "account", "add", "acct1");
  await baton(home, "account", "add", "acct2");
  const long = "λ".repeat(120);
  for (const good of [
    EMAIL,
    "My Work Account",
    "Ελληνικά δοκιμή",
    "仕事",
    "a/b\\c:d",
    "-x",
    long,
  ]) {
    const r = await baton(home, "account", "rename", "--", "acct2", good);
    assert.equal(r.code, 0, `${good}: ${r.err}`);
    assert.equal(loadConfig(paths).accounts[1].name, good);
    // Back by the id, whatever the name was.
    assert.equal(
      (await baton(home, "account", "rename", "acct2", "acct2")).code,
      0,
    );
  }
  for (const bad of [
    "ACCT1",
    "acct1",
    " Acct1 ",
    "",
    "   ",
    "a\nb",
    "a\tb",
    "a\u0007b",
    "a\u202Eb",
    "λ".repeat(121),
  ]) {
    const r = await baton(home, "account", "rename", "acct2", bad);
    assert.equal(r.code, 2, JSON.stringify(bad));
  }
  assert.match(
    (await baton(home, "account", "rename", "acct2", "ACCT1")).err,
    /acct1 is the name of another account/,
  );
  assert.match(
    (await baton(home, "account", "rename", "acct2", "a\nb")).err,
    /cannot hold control characters or line breaks/,
  );
  assert.match(
    (await baton(home, "account", "rename", "acct2", "λ".repeat(121))).err,
    /at most 120 characters/,
  );
  // Surrounding spaces are trimmed; its own name in another case is fine.
  assert.equal(
    (await baton(home, "account", "rename", "acct2", "  Acct2  ")).code,
    0,
  );
  assert.equal(loadConfig(paths).accounts[1].name, "Acct2");
  assert.equal((await baton(home, "account", "rename", "nobody", "x")).code, 2);
  assert.equal((await baton(home, "account", "rename", "acct2")).code, 2);
});

test("the CLI finds an account by its name (spaces, an email, any case) or by its id; files use the id", async (t) => {
  const { home, paths } = tempHome(t);
  const added = await baton(home, "account", "add", "My Work Account");
  assert.equal(added.code, 0, added.err);
  assert.match(added.out, /baton login "My Work Account"/);
  const [a] = loadConfig(paths).accounts;
  assert.deepEqual([a.id, a.name], ["my-work-account", "My Work Account"]);
  assert.ok(existsSync(profileDir(paths, "my-work-account")));
  await baton(home, "account", "add", EMAIL);
  const b = loadConfig(paths).accounts[1];
  assert.equal(b.id, "jane-work-baton-example-com");
  assert.equal(b.id, idFromName(EMAIL));
  assert.ok(existsSync(profileDir(paths, b.id)));
  assert.equal(
    (await baton(home, "account", "set", "my work account", "--weekly", "80"))
      .code,
    0,
  );
  assert.equal(loadConfig(paths).accounts[0].weekly, 80);
  assert.equal(
    (
      await baton(
        home,
        "account",
        "set",
        EMAIL.toUpperCase(),
        "--mark",
        "preferred",
      )
    ).code,
    0,
  );
  assert.equal(
    (await baton(home, "account", "set", b.id, "--mark", "last-resort")).code,
    0,
  );
  assert.equal(loadConfig(paths).accounts[1].mark, "last-resort");
  assert.match(
    (await baton(home, "account", "list")).out,
    /2 +\S +jane\.work\+baton@example\.com +last resort +folder jane-work-baton-example-com/,
  );
  // Ids from names that leave nothing usable, and clashes.
  assert.equal(idFromName("仕事"), "account");
  await baton(home, "account", "add", "仕事");
  await baton(home, "account", "add", "Ελληνικά");
  assert.deepEqual(
    loadConfig(paths)
      .accounts.slice(2)
      .map((x) => [x.id, x.name]),
    [
      ["account", "仕事"],
      ["account-2", "Ελληνικά"],
    ],
  );
  // The hooks resolve the folder (the id), never the name.
  handleHook(
    "prompt",
    { session_id: SID },
    { env: { CLAUDE_CONFIG_DIR: profileDir(paths, b.id) }, paths },
  );
  assert.equal(readJson(join(paths.sessions, SID, "turn.json")).account, b.id);
  assert.equal(
    accountFromEnv({ CLAUDE_CONFIG_DIR: profileDir(paths, b.id) }, paths),
    b.id,
  );
});

test("an account the operator names default is an account like any other: its own profile, never ~/.claude", async (t) => {
  const { home, paths } = tempHome(t);
  assert.equal((await baton(home, "account", "add", "default")).code, 0);
  const [a] = loadConfig(paths).accounts;
  assert.deepEqual([a.id, a.name], ["default", "default"]);
  assert.equal(profileDir(paths, "default"), join(paths.accounts, "default"));
  assert.ok(existsSync(join(paths.accounts, "default")));
  const status = (await baton(home, "status", "--json")).json();
  assert.equal(status.accounts[0].profile, join(paths.accounts, "default"));
  // Plain claude (no CLAUDE_CONFIG_DIR) is not that account.
  assert.equal(accountFromEnv({}, paths), null);
  handleHook("prompt", { session_id: SID }, { env: {}, paths });
  assert.ok(!existsSync(join(paths.sessions, SID)));
  handleHook(
    "prompt",
    { session_id: SID },
    { env: { CLAUDE_CONFIG_DIR: join(paths.accounts, "default") }, paths },
  );
  assert.equal(
    readJson(join(paths.sessions, SID, "turn.json")).account,
    "default",
  );
  assert.equal(loadConfig(paths).version, 1);
});

test(
  "renamed to an email while a session runs: its hooks land on the same account and the hop speaks the new name",
  { timeout: 60000 },
  async (t) => {
    const { home, root, paths } = tempHome(t);
    const dir = join(root, "fake");
    mkdirSync(dir, { recursive: true });
    // Strict order with acct2 first: the session starts on acct2.
    write(paths.config, {
      version: 1,
      accounts: [
        { id: "acct2", name: "acct2" },
        { id: "acct1", name: "acct1" },
      ],
      policy: { mode: "order" },
    });
    write(join(dir, "scenario.json"), {
      session: SID,
      runs: [
        {
          steps: [
            { hook: "session-start" },
            { waitFile: "renamed" },
            {
              statusline: {
                five_hour: [100, 3 * 3600],
                seven_day: [30, 72 * 3600],
              },
            },
            { hook: "prompt" },
            { hook: "stop-failure", error: "rate_limit" },
            { wait: "end" },
          ],
        },
        { steps: [{ hook: "session-start" }, { exit: 0 }] },
      ],
    });
    const output = new Collect();
    const lead = new Lead({
      poll: false,
      args: [],
      paths,
      env: testEnv(home, { FAKE_CLAUDE_DIR: dir }),
      cwd: root,
      claude: {
        command: process.execPath,
        prefix: [FAKE_CLAUDE],
        path: FAKE_CLAUDE,
      },
      end: (child) => endClaude(child, { method: "kill" }),
      input: keyInput(),
      output,
      signals: new EventEmitter(),
      pollMs: 40,
      tickMs: 40,
      countdownSeconds: 0,
      settleMs: 50,
      stdio: "ignore",
    });
    const done = lead.run();
    await until(
      () =>
        existsSync(paths.wrappers) &&
        readdirSync(paths.wrappers).some((f) => f.endsWith(".session.json")),
    );
    assert.equal(
      (await baton(home, "account", "rename", "acct2", EMAIL)).code,
      0,
    );
    write(join(dir, "renamed"), "");
    assert.equal(await done, 0);
    // The status line under acct2's folder wrote acct2's reading; the refusal is acct2's.
    assert.equal(readJson(join(paths.usage, "acct2.json")).five_hour.used, 100);
    assert.ok(existsSync(join(paths.rejected, "acct2.five_hour.json")));
    // What the operator and Claude read uses the new name, as typed.
    assert.match(
      output.text,
      /jane\.work\+baton@example\.com reached its 5-hour limit .* moving this conversation to acct1/,
    );
    const invocations = readJsonLines(join(dir, "invocations.jsonl"));
    assert.equal(invocations[0].configDir, profileDir(paths, "acct2"));
    assert.equal(invocations[1].configDir, profileDir(paths, "acct1"));
    assert.match(
      invocations[1].argv.at(-1),
      /moved from account jane\.work\+baton@example\.com to account acct1/,
    );
    // Folders, the environment and the arguments carry ids only (the
    // continue prompt, text for the model, says the name).
    for (const inv of invocations)
      assert.ok(
        !JSON.stringify({ ...inv, argv: inv.argv.slice(0, -1) }).includes(
          EMAIL,
        ),
        "no name in arguments or folders",
      );
    const stats = (await baton(home, "stats", "--json")).json();
    assert.deepEqual(
      stats.hops.map((h) => [h.from, h.to, h.fromId]),
      [[EMAIL, "acct1", "acct2"]],
    );
  },
);

test("rename in the menu: Enter then e opens the name field; Enter renames, Esc cancels; the row stays selected", async (t) => {
  const { paths } = tempHome(t);
  buildHome(paths);
  const store = createStore({
    paths,
    size: { cols: 120, rows: 30 },
    now: () => NOW,
    color: false,
  });
  store.dispatch({ type: "tick" });
  for (const key of ["down", "down", "enter", "e"])
    store.dispatch({ type: "key", key });
  let state = store.getState();
  assert.deepEqual(
    [state.modal.kind, state.modal.submit, state.modal.value],
    ["input", "rename", "acct2"],
  );
  store.dispatch({ type: "key", key: "escape" });
  assert.equal(store.getState().modal, null);
  store.dispatch({ type: "key", key: "enter" });
  store.dispatch({ type: "key", key: "e" });
  store.dispatch({ type: "key", key: "ctrl+u" });
  store.dispatch({ type: "text", text: "ACCT3" });
  store.dispatch({ type: "key", key: "enter" });
  assert.match(
    lastToast(store.getState()),
    /acct3 is the name of another account/,
  );
  assert.equal(store.getState().modal.kind, "input", "the field stays open");
  store.dispatch({ type: "key", key: "ctrl+u" });
  // The field never holds a control character.
  store.dispatch({ type: "text", text: "a\u0007b" });
  assert.equal(store.getState().modal.value, "ab");
  store.dispatch({ type: "key", key: "ctrl+u" });
  store.dispatch({ type: "text", text: EMAIL });
  store.dispatch({ type: "key", key: "enter" });
  state = store.getState();
  assert.equal(state.modal, null);
  assert.match(lastToast(state), /Renamed acct2 to jane\.work\+baton@/);
  assert.equal(
    loadConfig(paths).accounts.find((a) => a.id === "acct2").name,
    EMAIL,
  );
  assert.equal(state.selected, "acct:acct2");
  assert.equal(state.data.states.find((a) => a.id === "acct2").name, EMAIL);
  // The footer offers the contextual account menu.
  const { footerHints } = await import("../src/menu/ui/chrome.js");
  assert.ok(footerHints(state).some(([k]) => k === "enter"));
});

test("a long name such as an email wraps in the sidebar instead of being cut, and every frame keeps its width", (t) => {
  const { paths } = tempHome(t);
  buildHome(paths);
  const name = "alexandra.longlastname.work.account@company.example.org";
  const config = JSON.parse(readFileSync(paths.config, "utf8"));
  config.accounts[1].name = name;
  write(paths.config, config);
  for (const [size, keys] of [
    ["120x30", ["down", "down"]],
    ["100x30", ["down", "down"]],
    ["80x24", ["down", "down"]],
    ["80x24", []],
  ]) {
    const state = menuState(paths, { size: sizes[size], keys });
    const lines = frame(state);
    for (const line of lines)
      assert.ok(
        width(line) <= state.size.cols,
        `${size}: ${width(line)} > ${state.size.cols}: ${line}`,
      );
    const text = lines.join("\n");
    if (state.size.cols < 100) {
      assert.match(text, /Baton needs 100 x 28/);
      continue;
    }
    // Every part of the name is there, in order, across the wrapped lines.
    const squeezed = lines
      .map((line) => line.slice(0, 46))
      .join("")
      .replace(/[\s│╭╮╰╯─›★▿·]+/g, "");
    assert.ok(
      squeezed.includes(name.replace(/\s+/g, "")),
      `${size} shows the whole name`,
    );
  }
  assert.ok(plain([["x", ""]]) === "x");
});
