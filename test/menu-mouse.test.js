import test from "node:test";
import assert from "node:assert/strict";
import { createReplyFilter } from "../src/menu/input.js";
import { reduce } from "../src/menu/reducer.js";
import { sideWidth } from "../src/menu/tree.js";
import { width } from "../src/menu/text.js";
import { logo, motto, slogan } from "../src/menu/art.js";
import { tempHome } from "./helpers.js";
import {
  buildHome,
  frame,
  menuState,
  press,
  screens,
} from "./menu-fixtures.js";

function setup(t, options) {
  const { paths } = tempHome(t);
  buildHome(paths);
  return { paths, state: menuState(paths, options) };
}
const mouse = (state, x, y, rest = {}) =>
  reduce(state, { type: "mouse", kind: "press", button: 0, x, y, ...rest });
function locate(state, text, { side = false, pane = false } = {}) {
  for (const [y, line] of frame(state).entries()) {
    let from = 0;
    while (from < line.length) {
      const index = line.indexOf(text, from);
      if (index < 0) break;
      const x = width(line.slice(0, index));
      if ((!side || x < sideWidth(state)) && (!pane || x >= sideWidth(state)))
        return { x, y };
      from = index + 1;
    }
  }
  assert.fail("Missing control: " + text + "\n" + frame(state).join("\n"));
}
function click(state, text, options) {
  const { x, y } = locate(state, text, options);
  return mouse(state, x, y);
}
function action(state, key) {
  return reduce(reduce(state, { type: "key", key: "enter" }).state, {
    type: "key",
    key,
  });
}

test("SGR reports survive split chunks and pasted reports never click", () => {
  const events = [],
    filter = createReplyFilter((event) => events.push(event));
  assert.equal(filter.push("\x1b[<0;"), "");
  assert.equal(filter.push("12;9M"), "");
  assert.deepEqual(events[0], {
    x: 11,
    y: 8,
    button: 0,
    kind: "press",
    delta: 0,
  });
  filter.push("\x1b[<65;20;12M");
  assert.equal(events[1].delta, 3);
  assert.equal(
    filter.push("\x1b[200~text\x1b[<0;2;3M\x1b[201~"),
    "\x1b[200~text\x1b[201~",
  );
  assert.equal(events.length, 2);
  assert.equal(filter.push("\x1b[?1;2c\x1b[3;4Rr"), "r");
});

test("accounts display on click; there is no Enter navigation or resizable rail", (t) => {
  const { paths, state } = setup(t);
  const next = click(state, "acct2", { side: true }).state;
  assert.equal(next.selected, "acct:acct2");
  assert.equal(next.focus, "side");
  assert.match(frame(next).join("\n"), /#2 of 4/);
  assert.equal(press(next, paths, "enter").state.focus, "side");
  assert.equal(sideWidth(next), 46);
  const resized = reduce(next, { type: "resize", cols: 160, rows: 45 }).state;
  assert.equal(sideWidth(resized), 46);
  const arrow = press(resized, paths, "ctrl+right").state;
  assert.equal(sideWidth(arrow), 46);
  assert.doesNotMatch(
    frame(next).join("\n"),
    /Sidebar|Enter.*open|Account relay/,
  );
  assert.equal(
    click(resized, "Policy", { side: true }).state.selected,
    "policy",
  );
});

test("account menu commands preserve their dialogs and confirmation", (t) => {
  const { state } = setup(t);
  const account = click(state, "acct2", { side: true }).state;
  assert.doesNotMatch(
    frame(account).join("\n"),
    /Remove account|Rename account/,
  );
  const rename = action(account, "e").state;
  assert.equal(rename.modal.kind, "input");
  let edited = reduce(rename, { type: "key", key: "ctrl+u" }).state;
  edited = reduce(edited, { type: "text", text: "Work account" }).state;
  const saved = click(edited, "Rename");
  // The title is not a button.
  assert.equal(saved.effects.length, 0);
  const button = locate(edited, "Rename  Enter");
  const applied = mouse(edited, button.x, button.y);
  assert.deepEqual(applied.effects[0].args, {
    id: "acct2",
    name: "Work account",
  });
  const confirmation = action(account, "d").state;
  assert.equal(confirmation.modal.kind, "confirm");
  assert.equal(mouse(confirmation, 2, 2).state.modal.kind, "confirm");
  assert.equal(click(confirmation, "No  n").effects.length, 0);
  assert.deepEqual(click(confirmation, "Yes  y").effects[0].args, {
    id: "acct2",
  });
});

test("the footer actions menu contains refresh and the header stays clear", (t) => {
  const { state } = setup(t);
  const account = click(state, "acct2", { side: true }).state;
  assert.doesNotMatch(frame(account).slice(0, 3).join("\n"), /Refresh|Actions/);
  const actions = click(account, "Actions").state;
  assert.equal(actions.modal.kind, "actions");
  assert.deepEqual(click(actions, "Refresh usage").effects, [
    { type: "refresh", account: "acct2" },
  ]);
  assert.equal(click(actions, "Rename").state.modal.submit, "rename");
  const mode = click(actions, "Change mode").state;
  assert.equal(click(mode, "2 Normal").effects[0].args.mark, "normal");
  assert.equal(click(actions, "Delete account").state.modal.kind, "confirm");
});

test("Policy controls edit directly and Apply still confirms", (t) => {
  const { paths, state } = setup(t);
  const visible = press(press(state, paths, "end").state, paths, "up").state;
  let policy = click(visible, "Policy", { side: true }).state;
  const originalField = locate(policy, "5-hour limit", { pane: true });
  policy = click(policy, "order", { pane: true }).state;
  assert.deepEqual(
    locate(policy, "5-hour limit", { pane: true }),
    originalField,
  );
  assert.match(frame(policy)[2], /1 unsaved/);
  assert.equal(policy.form.values.mode, "order");
  const field = locate(policy, "5-hour limit", { pane: true });
  const line = frame(policy)[field.y];
  policy = mouse(
    policy,
    width(line.slice(0, line.lastIndexOf("→"))),
    field.y,
  ).state;
  assert.equal(policy.form.values.fiveHour, 91);
  assert.deepEqual(
    locate(policy, "5-hour limit", { pane: true }),
    originalField,
  );
  assert.match(frame(policy)[2], /2 unsaved/);
  const confirm = click(policy, "Apply 2 changes", { pane: true }).state;
  assert.equal(confirm.modal.kind, "confirm");
  assert.deepEqual(click(confirm, "Yes  y").effects[0].args.changes, {
    mode: "order",
    fiveHour: 91,
  });
});

test("dashboard entries select directly and the wheel scrolls the pointed pane", (t) => {
  const { paths, state } = setup(t);
  const account = click(state, "acct2", { pane: true }).state;
  assert.equal(account.selected, "acct:acct2");
  let stats = press(state, paths, "end").state;
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
  const scrolled = mouse(stats, sideWidth(stats) + 5, 12, {
    kind: "wheel",
    delta: 3,
  }).state;
  assert.equal(scrolled.views.stats.top, 3);
  const selection = mouse(state, 3, 12, { kind: "wheel", delta: 2 }).state;
  assert.equal(selection.selected, "acct:acct2");
});

test("thresholds, hop choices and Add account remain clickable", (t) => {
  const { paths, state } = setup(t);
  const account = click(state, "acct2", { side: true }).state;
  let thresholds = action(account, "t").state;
  const row = locate(thresholds, "› 5-hour");
  const line = frame(thresholds)[row.y];
  thresholds = mouse(
    thresholds,
    width(line.slice(0, line.indexOf("→"))),
    row.y,
  ).state;
  assert.equal(thresholds.modal.values.fiveHour, 91);
  assert.equal(click(thresholds, "Save  Enter").effects[0].args.fiveHour, 91);
  const session = menuState(paths, { keys: screens.session.keys });
  const choices = action(session, "H").state;
  assert.equal(click(choices, "1 acct1").effects[0].args.to, "acct1");
  assert.equal(
    click(state, "+ Add account", { side: true }).state.modal.kind,
    "input",
  );
});

test("the splash and minimum-size error use the same ASCII identity", (t) => {
  const { paths, state } = setup(t);
  const splash = { ...state, splash: true };
  const text = frame(splash).join("\n");
  const offsets = logo.map(
    (line) =>
      frame(splash)
        .find((row) => row.includes(line.trim()))
        .indexOf(line.trim()) - line.search(/\S/),
  );
  assert.equal(
    new Set(offsets).size,
    1,
    "ASCII rows retain their original alignment",
  );
  for (const line of logo) assert.ok(text.includes(line.trim()));
  assert.match(
    frame(state).join("\n"),
    /Your Claude accounts.[\s\S]*One continuous conversation./,
  );
  assert.match(text, /Press any key to start/);
  const caption = [slogan, ...motto];
  const splashRows = frame(splash);
  const captionAt = splashRows.findIndex((line) => line.includes(slogan));
  assert.deepEqual(
    splashRows.slice(captionAt, captionAt + 3).map((line) => line.trim()),
    caption,
  );
  assert.equal(
    new Set(caption.map((line, i) => splashRows[captionAt + i].indexOf(line)))
      .size,
    1,
  );
  const mainRows = frame(state).map((line) => line.slice(0, 45).trim());
  const mainAt = mainRows.indexOf(slogan);
  assert.deepEqual(mainRows.slice(mainAt, mainAt + 3), caption);
  assert.match(frame(state).join("\n"), /Keep the conversation moving\./);
  const dismissed = press(splash, paths, "a");
  assert.equal(dismissed.state.splash, false);
  assert.equal(dismissed.state.modal, null);
  const error = { ...splash, size: { cols: 80, rows: 24 } };
  assert.match(frame(error).join("\n"), /Baton needs 100 x 28/);
  assert.equal(press(error, paths, "enter").state.splash, true);
  assert.deepEqual(press(error, paths, "q").effects, [{ type: "quit" }]);
});

test("every supported view fits the fixed design", (t) => {
  const { paths, state } = setup(t);
  for (const size of [
    { cols: 100, rows: 28 },
    { cols: 120, rows: 30 },
    { cols: 160, rows: 45 },
  ])
    for (const spec of Object.values(screens)) {
      const lines = frame(menuState(paths, { size, keys: spec.keys }));
      assert.equal(lines.length, size.rows - 1);
      assert.ok(lines.every((line) => width(line) <= size.cols));
    }
});
