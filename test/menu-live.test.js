import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { readJsonLines, writeJsonAtomic } from "../src/fsutil.js";
import { runMenu } from "../src/menu/index.js";
import { profileDir } from "../src/paths.js";
import { NOW, buildHome } from "./menu-fixtures.js";
import { REPO, tempHome, testEnv, until } from "./helpers.js";
import { keys, RawInput, VirtualTerminal } from "./virtual-terminal.js";

// The menu in a (virtual) terminal: raw key bytes go in, Ink draws on a
// virtual screen, ~/.baton is a fixture home, and `claude` is a fake that
// answers auth status and runs a pretend sign-in.
const FAKE_LOGIN = join(REPO, "test", "fixtures", "fake-login.js");

function start(t, options = {}) {
  const { paths, root } = tempHome(t);
  buildHome(paths);
  // The fake's sign-ins: acct2 and acct3 signed in, acct4 not.
  for (const name of ["acct2", "acct3"])
    writeJsonAtomic(join(profileDir(paths, name), "fake-signed-in"), {});
  const log = join(root, "logins.jsonl");
  // The usage polls it asks for (the poller has its own tests).
  const refreshed = [];
  const input = new RawInput();
  const output = new VirtualTerminal(
    options.columns ?? 120,
    options.rows ?? 30,
  );
  const done = runMenu({
    poll: false,
    paths,
    env: testEnv(paths.home, { FAKE_LOGIN_LOG: log }),
    input,
    output,
    refreshMs: options.refreshMs ?? 60000,
    watchMs: 40,
    now: () => NOW,
    color: false,
    glyphs: "rich",
    splash: options.splash ?? false,
    mouse: options.mouse ?? true,
    launcher: {
      command: process.execPath,
      prefix: [FAKE_LOGIN],
      path: FAKE_LOGIN,
    },
    loginStdio: "ignore",
    refresh: async (account) => {
      refreshed.push(account);
      return { via: "here", results: [] };
    },
  });
  let finished = false;
  done.finally(() => (finished = true));
  t.after(async () => {
    if (!finished) input.write(keys.ctrlC);
    await done.catch(() => {});
  });
  const shows = (pattern, timeout = 8000) =>
    until(
      () =>
        typeof pattern === "string"
          ? output.text().includes(pattern)
          : pattern.test(output.text()),
      timeout,
    ).catch(() => {
      throw new Error(
        `The menu never showed ${pattern}. The screen:\n${output.text()}`,
      );
    });
  const type = async (...list) => {
    for (const bytes of list) {
      input.write(bytes);
      await new Promise((r) => setTimeout(r, bytes === keys.escape ? 120 : 25));
    }
  };
  return { paths, input, output, done, shows, type, log, refreshed };
}

test(
  "the splash waits for input, and mouse actions open directly",
  { timeout: 15000 },
  async (t) => {
    const menu = start(t, { splash: true });
    await menu.shows("Press any key to start");
    await new Promise((resolve) => setTimeout(resolve, 1100));
    assert.match(menu.output.text(), /Press any key to start/);
    await menu.type("\x1b[<0;8;8M");
    await menu.shows("NEXT ACCOUNT");
    assert.equal(menu.output.modes.get("1000"), true);
    const rows = menu.output.text().split("\n");
    const y = rows.findIndex(
      (line) =>
        line.indexOf("acct2") > 0 &&
        line.indexOf("acct2") < 38 &&
        line.includes("5h"),
    );
    await menu.type("\x1b[<0;8;" + (y + 1) + "M");
    await menu.shows(/#2 of 4/);
    assert.doesNotMatch(menu.output.text(), /Enter.*open/);
    assert.doesNotMatch(menu.output.text(), /Account relay/);
    await menu.type(keys.enter, "e");
    await menu.shows("Rename acct2");
    await menu.type(keys.escape, "q");
    assert.equal(await menu.done, 0);
    assert.equal(menu.output.modes.get("1000"), false);
  },
);

test(
  "mouse reporting can be disabled while keyboard navigation remains direct",
  { timeout: 15000 },
  async (t) => {
    const menu = start(t, { mouse: false });
    await menu.shows("NEXT ACCOUNT");
    assert.notEqual(menu.output.modes.get("1000"), true);
    await menu.type("\x1b[<0;8;13M");
    assert.match(menu.output.text(), /NEXT ACCOUNT/);
    await menu.type(keys.down, keys.down);
    await menu.shows(/#2 of 4/);
    await menu.type("q");
    assert.equal(await menu.done, 0);
  },
);

test(
  "usage updates live in the fixed workspace",
  { timeout: 15000 },
  async (t) => {
    const menu = start(t);
    await menu.shows("NEXT ACCOUNT");
    await menu.shows(/acct2 +5h 42 · wk 71/);
    writeJsonAtomic(join(menu.paths.usage, "acct2.json"), {
      account: "acct2",
      at: new Date(NOW).toISOString(),
      five_hour: {
        used: 77,
        resetsAt: new Date(NOW + 2 * 3600e3).toISOString(),
        readAt: new Date(NOW).toISOString(),
      },
      seven_day: {
        used: 64,
        resetsAt: new Date(NOW + 4 * 864e5).toISOString(),
        readAt: new Date(NOW).toISOString(),
      },
    });
    await menu.shows(/acct2 +5h 77 · wk 64/);
    await menu.type("q");
    assert.equal(await menu.done, 0);
    assert.equal(menu.output.modes.get("1049"), false);
    assert.equal(menu.output.modes.get("1000"), false);
    assert.equal(menu.output.modes.get("1006"), false);
    assert.ok(menu.output.chunks.join("").endsWith("\x1b[?7h"));
  },
);

test(
  "Claude sign-in gets a branded screen and returns to the same account",
  { timeout: 15000 },
  async (t) => {
    const menu = start(t);
    await menu.shows(/acct4 +sign in/);
    await menu.type(keys.down, keys.down, keys.down, keys.down);
    await menu.shows(/#4 of 4 · last-resort/);
    await menu.type(keys.enter, "s");
    await menu.shows("CONNECT ACCOUNT");
    await menu.shows("YOUR SIGN-IN LINK");
    await menu.shows("Open Claude sign-in");
    assert.equal(menu.output.modes.get("1000"), false);
    await until(() => readJsonLines(menu.log).length === 1, 8000);
    assert.deepEqual(readJsonLines(menu.log)[0], {
      args: "auth login",
      dir: profileDir(menu.paths, "acct4"),
    });
    await menu.shows("finished");
    assert.equal(menu.output.modes.get("1000"), true);
    await menu.shows(/acct4 +5h 5 · wk 18/);
    await until(() => menu.refreshed.includes("acct4"), 8000);
    assert.match(menu.output.text(), /signed in \(claude\.ai\)/);
    assert.doesNotMatch(menu.output.text(), /example\.invalid/);
    await menu.type(keys.up);
    await menu.shows(/#3 of 4 · normal/);
    await menu.type("q");
    assert.equal(await menu.done, 0);
  },
);

test(
  "a small terminal shows the branded error and resumes when resized",
  { timeout: 15000 },
  async (t) => {
    const menu = start(t, { refreshMs: 50 });
    await menu.shows("NEXT ACCOUNT");
    menu.output.resize(80, 24);
    await menu.shows("Baton needs 100 x 28");
    await menu.type(keys.down, keys.enter);
    assert.match(menu.output.text(), /Baton needs 100 x 28/);
    menu.output.resize(120, 30);
    await menu.shows("NEXT ACCOUNT");
    await menu.type("q");
    assert.equal(await menu.done, 0);
  },
);
