import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createStore, operations } from "../src/menu/index.js";
import { loadMenuData } from "../src/menu/data.js";
import { keyOf } from "../src/menu/keys.js";
import { logo } from "../src/menu/art.js";
import { legendLine } from "../src/menu/legend.js";
import { isNarrow } from "../src/menu/layout.js";
import { fitLine, plain, wrapLine } from "../src/menu/lines.js";
import { reduce } from "../src/menu/reducer.js";
import { lastToast } from "../src/menu/state.js";
import { width } from "../src/menu/text.js";
import { glyphSets, makeTheme, pickGlyphs } from "../src/menu/theme.js";
import { rowLines, treeRows } from "../src/menu/tree.js";
import { footerHints } from "../src/menu/ui/chrome.js";
import {
  NOW,
  S1,
  buildHome,
  frame,
  menuState,
  press,
  screens,
  sizes,
} from "./menu-fixtures.js";
import { tempHome } from "./helpers.js";

function home(t, options) {
  const { paths } = tempHome(t);
  buildHome(paths, options);
  return paths;
}
const screenState = (paths, size, screen) => {
  const spec = screens[screen];
  let state = menuState(paths, { size: sizes[size], keys: spec.keys });
  if (isNarrow(state) && state.focus !== "pane" && !spec.side)
    state = press(state, paths, "enter").state;
  return state;
};
const keysOf = (state) => footerHints(state).map(([k]) => k);
// Presses keys, returning the state and every effect.
function go(paths, state, ...keys) {
  const effects = [];
  for (const key of keys) {
    const out = press(state, paths, key);
    state = out.state;
    effects.push(...out.effects);
  }
  return {
    state,
    effects,
    applied: effects.filter((e) => e.type === "apply" || e.type === "signin"),
  };
}

test("every screen fills its supported terminal; smaller terminals show the branded size error", (t) => {
  const paths = home(t);
  for (const size of Object.values(sizes))
    for (const spec of Object.values(screens)) {
      const state = menuState(paths, { size, keys: spec.keys });
      const lines = frame(state);
      assert.equal(lines.length, size.rows - 1);
      assert.ok(lines.every((line) => width(line) <= size.cols));
      const text = lines.join("\n");
      if (size.cols < 100 || size.rows < 28)
        assert.match(text, /Baton needs 100 x 28/);
      else
        assert.ok(
          text.includes(logo[1].trim()) || state.modal,
          "the shared ASCII identity",
        );
    }
});

test("the overview is concise, while detail views retain the full information", (t) => {
  const paths = home(t);
  const at = (screen) => frame(screenState(paths, "120x30", screen)).join("\n");
  const overview = at("overview");
  assert.match(overview, /NEXT ACCOUNT[\s\S]*acct2/);
  assert.match(overview, /Account +5-hour +Weekly +Status/);
  assert.match(overview, /1 handoff +· +2 refusals/);
  assert.match(overview, /sports-odds[\s\S]*workflow running/);
  assert.match(at("account"), /signed in \(claude\.ai\)/);
  assert.match(at("account"), /loses 24% in 4d if unused/);
  assert.match(at("account-blocked"), /Blocked by the weekly limit until/);
  const session = at("session");
  assert.match(session, /Per turn +3% of 5h +· +0\.5% of weekly/);
  assert.match(session, /no planned hop while these run/);
  assert.match(at("policy"), /Plan factor .*1\.5x/);
  assert.match(at("thresholds"), /Thresholds of acct2/);
  assert.match(at("remove"), /Remove acct3 from Baton/);
  assert.match(at("rename"), /Rename acct2/);
});

test("contextual label bars explain symbols without a Help page", (t) => {
  const paths = home(t);
  const state = menuState(paths, { size: sizes["120x30"] });
  const g = glyphSets.rich;
  const rows = treeRows(state);
  for (const id of ["overview", "policy", "stats"])
    assert.equal(
      rows.find((r) => r.id === id).icon[0].trim(),
      "",
      `${id} has no sign`,
    );
  const signs = rows.filter((r) => r.kind === "session").map((r) => r.icon[0]);
  assert.deepEqual(
    signs,
    [g.spinner[0], g.diamond],
    "working; moving to another account",
  );
  for (const [kind, signs] of [
    [
      "overview",
      [
        [g.preferred, "Preferred"],
        [g.lastResort, "Last resort"],
        [g.normal, "Normal"],
      ],
    ],
    [
      "account",
      [
        [g.limit, "Threshold"],
        [g.baton, "Next account"],
        [g.blocked, "Blocked"],
      ],
    ],
    [
      "session",
      [
        [g.spinner[0], "Working"],
        [g.dot, "Idle"],
        [g.diamond, "Wait / move"],
        [g.ring, "Recent"],
      ],
    ],
  ]) {
    const bar = plain(legendLine(state, kind, 100));
    for (const [sign, label] of signs)
      assert.ok(bar.includes(sign + " " + label));
    assert.match(
      frame(screenState(paths, "120x30", kind)).at(-2),
      /Preferred|Threshold|Working/,
    );
  }
  assert.equal(go(paths, state, "?").state.modal, null);
});

test("an account's tail: both windows when they fit, else the higher one with its window", () => {
  const g = glyphSets.rich;
  const row = {
    id: "acct:x",
    kind: "account",
    depth: 0,
    icon: [g.normal, ""],
    name: "a-long-account-name",
    nameStyle: "",
    selectable: true,
  };
  const tail = [
    ["5h ", ""],
    ["42", ""],
    [" \u00b7 ", ""],
    ["wk ", ""],
    ["63", ""],
  ];
  const short = [
    ["wk ", ""],
    ["63%", ""],
  ];
  const wide = rowLines({ ...row, tail, shortTail: short }, 40, { g }).map(
    plain,
  );
  assert.match(wide[0], /a-long-account-name +5h 42 \u00b7 wk 63/);
  const narrow = rowLines({ ...row, tail, shortTail: short }, 32, { g }).map(
    plain,
  );
  assert.match(narrow[0], /a-long-account-name +wk 63%/);
  const tiny = rowLines({ ...row, tail, shortTail: short }, 26, { g }).map(
    plain,
  );
  assert.match(
    tiny[0],
    /a-long-account-name *$/,
    "the tail goes, the name stays whole",
  );
});

test("the workspace has a fixed rail and a branded minimum-size error", (t) => {
  const paths = home(t);
  const state = menuState(paths, { size: { cols: 120, rows: 30 } });
  assert.equal(isNarrow(state), false);
  const text = frame(state).join("\n");
  assert.match(text, /Accounts[\s\S]*NEXT ACCOUNT|NEXT ACCOUNT[\s\S]*Accounts/);
  const small = menuState(paths, { size: { cols: 80, rows: 24 } });
  assert.match(frame(small).join("\n"), /Current size: 80 x 24/);
  assert.deepEqual(go(paths, small, "q").effects, [{ type: "quit" }]);
});

test("accounts show immediately without an Enter step; only Policy opens an editor", (t) => {
  const paths = home(t),
    state = menuState(paths);
  const account = go(paths, state, "down", "down").state;
  assert.equal(account.selected, "acct:acct2");
  for (const key of ["enter", "right", "tab", "shift+tab"])
    assert.equal(go(paths, account, key).state.focus, "side");
  assert.ok(
    keysOf(account).includes("enter") && !keysOf(account).includes("Tab"),
  );
  const policy = go(paths, state, "end", "up").state;
  for (const key of ["enter"]) assert.ok(go(paths, policy, key).state.form);
  assert.equal(go(paths, policy, "enter", "escape").state.focus, "side");
  let stats = go(paths, state, "end").state;
  stats = {
    ...stats,
    data: {
      ...stats.data,
      stats: {
        ...stats.data.stats,
        accounts: [...stats.data.stats.accounts, ...stats.data.stats.accounts],
      },
    },
  };
  const scrolled = go(paths, stats, "pagedown").state;
  assert.ok(scrolled.views.stats.top > 0);
  assert.equal(scrolled.selected, "stats");
});

test("the selected sidebar row reads clearly: no dim or muted part, focused or not, at every size; a bright bold bar (NO_COLOR: inverse and bold)", (t) => {
  const paths = home(t);
  const g = glyphSets.rich;
  for (const size of Object.keys(sizes))
    for (const keys of [
      [],
      ["down"],
      ["down", "down"],
      ["down", "down", "down", "down"],
      ["down", "down", "down", "down", "down"],
      ["down", "down", "down", "down", "down", "down"],
      ["end", "up"],
      ["end"],
    ]) {
      const state = menuState(paths, { size: sizes[size], keys });
      const row = treeRows(state).find((r) => r.id === state.selected);
      for (const focused of [true, false])
        for (const cells of [18, 24, 40]) {
          const lines = rowLines(row, cells, { selected: true, focused, g });
          for (const line of lines)
            for (const [text, style] of line) {
              const words = String(style).split(" ");
              assert.ok(
                !words.includes("dim") && !words.includes("muted"),
                `${size} ${row.id} focused=${focused}: "${text}" is "${style}"`,
              );
              if (focused)
                assert.ok(
                  words.includes("selected") && words.includes("bold"),
                  `${size} ${row.id}: "${text}" is "${style}"`,
                );
            }
        }
    }
  const colour = makeTheme({ color: true }).props("selected bold");
  assert.deepEqual(
    [colour.color, colour.backgroundColor, colour.bold, colour.dimColor],
    ["#f0d5b3", "#35302a", true, undefined],
  );
  for (const style of ["selected", "selected bold", "selected dim muted"]) {
    const mono = makeTheme({ color: false }).props(style);
    assert.deepEqual(
      [mono.inverse, mono.bold, mono.dimColor, mono.color],
      [true, true, undefined, undefined],
      style,
    );
  }
});

test("the filter narrows the sidebar as you type; Esc clears it", (t) => {
  const paths = home(t);
  const { state } = go(paths, menuState(paths), "/", "a", "c", "c", "t", "3");
  assert.equal(state.filtering, true);
  assert.equal(state.selected, "acct:acct3");
  const sidebar = (lines) =>
    lines
      .slice(1, -1)
      .map((l) => l.slice(0, 27))
      .join("\n");
  const lines = frame(state);
  assert.match(sidebar(lines), /acct3/);
  assert.doesNotMatch(sidebar(lines), /acct2/);
  assert.match(lines.join("\n"), /\/ acct3/);
  const cleared = go(paths, state, "escape").state;
  assert.deepEqual([cleared.filter, cleared.filtering], ["", false]);
  assert.match(sidebar(frame(cleared)), /acct2/);
});

test("quit and undisclosed shortcuts", (t) => {
  const paths = home(t);
  assert.deepEqual(go(paths, menuState(paths), "q").effects, [
    { type: "quit" },
  ]);
  assert.deepEqual(go(paths, menuState(paths), "ctrl+c").effects, [
    { type: "quit" },
  ]);
  assert.deepEqual(go(paths, menuState(paths), "ctrl+l").effects, []);
});

test("arrows reach the pinned Search and Add account controls without changing the open view", (t) => {
  const paths = home(t);
  const initial = menuState(paths);
  const search = go(paths, initial, "up").state;
  assert.equal(search.focus, "search");
  assert.equal(search.selected, "overview");
  assert.match(frame(search).join("\n"), /› \/ Search/);
  const filtered = go(paths, search, "enter", "a", "c", "c", "t", "3").state;
  assert.equal(filtered.filtering, true);
  assert.equal(filtered.selected, "acct:acct3");
  const chosen = go(paths, filtered, "down").state;
  assert.equal(chosen.focus, "side");
  assert.equal(chosen.filtering, false);
  assert.equal(chosen.selected, "acct:acct3");
  const last = go(paths, initial, "end").state;
  const add = go(paths, last, "down").state;
  assert.equal(add.focus, "add");
  assert.equal(add.selected, "stats");
  assert.match(frame(add).join("\n"), /› \+ Add account/);
  const dialog = go(paths, add, "enter").state;
  assert.equal(dialog.modal.kind, "input");
  assert.equal(dialog.modal.submit, "add");
  assert.equal(go(paths, dialog, "escape", "up").state.focus, "side");
});

test("the footer offers Actions and undisclosed direct shortcuts do nothing", (t) => {
  const paths = home(t),
    account = menuState(paths, { keys: ["down", "down"] });
  const hints = keysOf(account);
  assert.ok(
    !hints.includes("Space") && !hints.includes("?") && hints.includes("q"),
  );
  assert.ok(
    !hints.includes("d") && !hints.includes("s") && hints.includes("enter"),
  );
  assert.equal(go(paths, account, " ").state.modal, null);
  for (const key of [
    "e",
    "r",
    "s",
    "d",
    "p",
    "l",
    "n",
    "a",
    "J",
    "K",
    "h",
    "H",
    "?",
    "tab",
    "ctrl+l",
    "j",
    "k",
    "g",
    "G",
    "shift+down",
  ]) {
    const ignored = go(paths, account, key);
    assert.equal(ignored.state, account, key);
    assert.deepEqual(ignored.effects, [], key);
  }
  assert.equal(go(paths, account, "enter", "e").state.modal.kind, "input");
  assert.equal(go(paths, account, "enter", "d").state.modal.kind, "confirm");
  const form = menuState(paths, { keys: ["end", "up", "enter"] });
  assert.equal(keysOf(form)[0], "updown");
});

test("backspacing an empty search restores the highlighted placeholder and typing resumes it", (t) => {
  const paths = home(t),
    initial = menuState(paths);
  const cleared = go(paths, initial, "/", "a", "backspace").state;
  assert.deepEqual(
    [cleared.filter, cleared.filtering, cleared.focus],
    ["", false, "search"],
  );
  assert.match(frame(cleared).join("\n"), /› \/ Search/);
  const typed = go(paths, cleared, "a", "c", "c", "t", "3").state;
  assert.equal(typed.filtering, true);
  assert.equal(typed.selected, "acct:acct3");
  const emptied = go(paths, typed, "ctrl+u").state;
  assert.equal(emptied.filtering, false);
  assert.match(frame(emptied).join("\n"), /› \/ Search/);
});

test("an unmatched search clears the detail pane and cannot act on the previous account", (t) => {
  const paths = home(t),
    account = menuState(paths, { keys: ["down", "down"] });
  const empty = go(paths, account, "/", {
    type: "text",
    text: "zzzz-no-matches",
  }).state;
  assert.match(frame(empty).join("\n"), /Nothing matches/);
  assert.ok(
    frame(empty)
      .slice(0, -1)
      .every((line) => !line.slice(46).trim()),
  );
  const inactive = go(paths, empty, "enter", "d", "s");
  assert.equal(inactive.state.modal, null);
  assert.equal(inactive.effects.length, 0);
  assert.ok(!keysOf(inactive.state).includes("enter"));
  const restored = go(paths, empty, "ctrl+u").state;
  assert.match(frame(restored).join("\n"), /#2 of 4/);
});

test("account actions open contextually and mode changes use the same account id", (t) => {
  const paths = home(t),
    initial = menuState(paths);
  assert.doesNotMatch(
    frame(initial).slice(0, -1).join("\n"),
    /Actions|Help|Refresh/,
  );
  const account = go(paths, initial, "down", "down").state;
  assert.doesNotMatch(
    frame(account).slice(0, -1).join("\n"),
    /Actions|Refresh/,
  );
  const menu = go(paths, account, "enter").state;
  assert.equal(menu.modal.kind, "actions");
  assert.match(frame(menu).join("\n"), /Change mode\s+m/);
  assert.equal(go(paths, menu, "m").state.modal.title, "Account mode");
  for (const label of [
    "Rename",
    "Change mode",
    "Delete account",
    "Sign in again",
  ])
    assert.match(frame(menu).join("\n"), new RegExp(label));
  assert.equal(go(paths, menu, "enter").state.modal.submit, "rename");
  const mode = go(paths, menu, "down", "enter").state;
  assert.equal(mode.modal.title, "Account mode");
  assert.deepEqual(go(paths, mode, "down", "enter").applied[0].args, {
    id: "acct2",
    mark: "normal",
  });
  assert.equal(go(paths, menu, "d").state.modal.kind, "confirm");
  assert.equal(go(paths, menu, "escape").state.modal, null);
  assert.deepEqual(go(paths, account, "enter", "r").effects, [
    { type: "refresh", account: "acct2" },
  ]);
});

test("account actions: marks, order, thresholds, sign in, add, remove", (t) => {
  const paths = home(t);
  const acct2 = menuState(paths, { keys: ["down", "down"] });
  const mode = go(paths, acct2, "enter", "down", "enter").state;
  assert.deepEqual(go(paths, mode, "3").applied[0].args, {
    id: "acct2",
    mark: "last-resort",
  });
  assert.deepEqual(go(paths, mode, "2").applied[0].args, {
    id: "acct2",
    mark: "normal",
  });
  assert.deepEqual(go(paths, acct2, "enter", "J").applied[0].args, {
    id: "acct2",
    position: 3,
  });
  assert.deepEqual(go(paths, acct2, "enter", "K").applied[0].args, {
    id: "acct2",
    position: 1,
  });
  assert.deepEqual(go(paths, acct2, "enter", "s").applied, [
    { type: "signin", account: "acct2" },
  ]);
  // Thresholds: a small form.
  const form = go(paths, acct2, "enter", "t").state;
  assert.equal(form.modal.kind, "thresholds");
  const edited = go(
    paths,
    form,
    "right",
    "right",
    "down",
    "left",
    "left",
    "left",
    "left",
    "left",
    "enter",
  );
  assert.deepEqual(edited.applied[0], {
    type: "apply",
    op: "thresholds",
    args: { id: "acct2", fiveHour: 92, weekly: 90 },
    done: "Saved the thresholds of acct2.",
  });
  assert.deepEqual(go(paths, form, "right", "d", "enter").applied[0].args, {
    id: "acct2",
    fiveHour: null,
    weekly: null,
  });
  assert.equal(go(paths, form, "escape").applied.length, 0);
  // Remove asks first.
  const acct3 = menuState(paths, { keys: ["down", "down", "down"] });
  const confirm = go(paths, acct3, "enter", "d").state;
  assert.equal(confirm.modal.kind, "confirm");
  assert.equal(go(paths, confirm, "n").applied.length, 0);
  assert.deepEqual(go(paths, confirm, "y").applied[0].args, { id: "acct3" });
  // Add: a name, then Claude Code's sign-in.
  const added = go(
    paths,
    acct2,
    "end",
    "down",
    "enter",
    { type: "text", text: "acct5" },
    "enter",
  );
  assert.deepEqual(added.applied[0], {
    type: "apply",
    op: "add",
    args: { name: "acct5" },
  });
  // Any name; never one taken in another case.
  const email = go(
    paths,
    acct2,
    "end",
    "down",
    "enter",
    { type: "text", text: "jane@example.com" },
    "enter",
  );
  assert.deepEqual(email.applied[0].args, { name: "jane@example.com" });
  const bad = go(
    paths,
    acct2,
    "end",
    "down",
    "enter",
    { type: "text", text: "ACCT3" },
    "enter",
  );
  assert.equal(bad.applied.length, 0);
  assert.match(lastToast(bad.state), /acct3 is the name of another account/);
});

test("session actions: hop at the end of the turn, or to a chosen account", (t) => {
  const paths = home(t);
  const s1 = menuState(paths, {
    keys: ["down", "down", "down", "down", "down"],
  });
  assert.equal(s1.selected, `sess:${S1}`);
  assert.deepEqual(go(paths, s1, "enter", "h").applied, [
    {
      type: "apply",
      op: "hop",
      args: { session: S1, to: null },
      done: undefined,
    },
  ]);
  const choice = go(paths, s1, "enter", "H").state;
  assert.deepEqual(
    choice.modal.options.map((o) => o.value),
    ["acct1", "acct3", "acct4"],
  );
  assert.deepEqual(go(paths, choice, "down", "down", "enter").applied[0].args, {
    session: S1,
    to: "acct4",
  });
  assert.deepEqual(go(paths, choice, "2").applied[0].args, {
    session: S1,
    to: "acct3",
  });
});

test("the policy form changes settings after a confirmation; Esc leaves them", (t) => {
  const paths = home(t);
  const form = menuState(paths, { keys: ["end", "up", "enter"] });
  assert.ok(form.form);
  const changed = go(
    paths,
    form,
    "down",
    "right",
    "down",
    "down",
    "down",
    "right",
    "end",
    "enter",
  );
  assert.equal(changed.state.modal.kind, "confirm");
  assert.deepEqual(changed.state.modal.lines, [
    "5-hour limit: 90% \u2192 91%",
    "Plan factor: 1.5x \u2192 1.6x",
  ]);
  assert.deepEqual(go(paths, changed.state, "y").applied[0].args, {
    changes: { fiveHour: 91, planFactor: 1.6 },
  });
  const toggled = go(paths, form, "end", "up", "up", "up", "left");
  assert.equal(toggled.state.form.values.compactionRebalance, false);
  // The last field, under the usage poll: Baton's usage after your own bar.
  const bar = go(paths, form, "end", "up", "right");
  assert.equal(bar.state.form.values.statusLineUsage, true);
  const mode = go(paths, form, "right").state.form.values.mode;
  assert.equal(mode, "order");
  const left = go(paths, form, "down", "right", "escape");
  assert.equal(left.state.form, null);
  assert.equal(left.applied.length, 0);
  assert.match(lastToast(left.state), /left unchanged/);
});

test("actions run through the core functions and the menu reads the result back", async (t) => {
  const paths = home(t);
  let quitted = false;
  const store = createStore({
    paths,
    size: sizes["120x30"],
    now: () => NOW,
    color: false,
    onQuit: () => (quitted = true),
  });
  store.dispatch({ type: "tick" });
  for (const key of ["down", "down", "enter", "down", "enter", "3"])
    store.dispatch({ type: "key", key });
  const config = () => JSON.parse(readFileSync(paths.config, "utf8"));
  assert.equal(
    config().accounts.find((a) => a.name === "acct2").mark,
    "last-resort",
  );
  assert.match(lastToast(store.getState()), /Updated the mode of acct2/);
  assert.equal(
    store.getState().data.states.find((a) => a.name === "acct2").mark,
    "last-resort",
  );
  store.dispatch({ type: "key", key: "enter" });
  store.dispatch({ type: "key", key: "J" });
  assert.deepEqual(
    config().accounts.map((a) => a.name),
    ["acct1", "acct3", "acct2", "acct4"],
  );
  assert.equal(
    store.getState().selected,
    "acct:acct2",
    "the selection follows the account",
  );
  store.dispatch({ type: "key", key: "enter" });
  store.dispatch({ type: "key", key: "t" });
  for (const key of ["right", "enter"]) store.dispatch({ type: "key", key });
  assert.equal(config().accounts.find((a) => a.name === "acct2").fiveHour, 91);
  // A hop request for a live session is refused when no lead holds it.
  store.dispatch({ type: "key", key: "end" });
  for (const key of ["up", "up", "up", "up", "enter", "h"])
    store.dispatch({ type: "key", key });
  assert.equal(store.getState().selected, `sess:${S1}`);
  assert.match(
    lastToast(store.getState()),
    /only work in sessions started with baton/,
  );
  store.dispatch({ type: "key", key: "q" });
  assert.equal(quitted, true);
  assert.equal(typeof operations(paths).policy, "function");
});

test("usage refresh reports the polling host's array of results", async (t) => {
  const paths = home(t);
  const store = createStore({
    paths,
    now: () => NOW,
    refresh: async () => [
      { name: "acct2", status: "ok", reading: { five_hour: { used: 42 } } },
    ],
  });
  t.after(() => store.close());
  store.dispatch({ type: "tick" });
  store.dispatch({ type: "key", key: "enter" });
  store.dispatch({ type: "key", key: "r" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(lastToast(store.getState()), "acct2: 5-hour 42%.");
});

test("keys, text and glyphs", () => {
  assert.equal(keyOf("", { upArrow: true, shift: true }), "shift+up");
  assert.equal(keyOf("", { tab: true, shift: true }), "shift+tab");
  assert.equal(keyOf("J", {}), "J");
  assert.deepEqual(keyOf("acct5", {}), { text: "acct5" });
  assert.equal(pickGlyphs({ BATON_GLYPHS: "plain" }, "linux"), "plain");
  assert.equal(pickGlyphs({}, "win32"), "plain");
  assert.equal(pickGlyphs({ WT_SESSION: "1" }, "win32"), "rich");
  // A line too wide is cut at the edge as a last resort, without an ellipsis;
  // wrapping keeps everything.
  assert.equal(plain(fitLine([["abcdefgh", ""]], 5)), "abcde");
  assert.deepEqual(wrapLine([["one two three", ""]], 7).map(plain), [
    "one two",
    "three",
  ]);
});

test("the plain glyphs draw every screen too", (t) => {
  const paths = home(t);
  for (const screen of ["overview", "account", "stats"]) {
    const lines = frame(
      menuState(paths, {
        size: sizes["120x30"],
        keys: screens[screen].keys,
        glyphs: "plain",
      }),
    );
    assert.equal(lines.length, 29);
    assert.ok(!lines.join("\n").includes("\u2026"));
  }
  assert.ok(loadMenuData(paths, { now: NOW }).sessions.length >= 2);
  // A rendered reducer state without data says it is reading.
  const empty = reduce(
    { ...menuState(paths), data: null },
    { type: "key", key: "down" },
  ).state;
  assert.match(frame(empty).join("\n"), /Loading your accounts/);
});
