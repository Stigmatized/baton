import { fuzzyMatches } from "./fuzzy.js";
import { modalKeys, modalText } from "./modal.js";
import { printable } from "./keys.js";
import { expireToasts, toast } from "./state.js";
import { tooSmall } from "./layout.js";
import { hitTest } from "./mouse.js";
import {
  moveSelection,
  reselect,
  select,
  selectable,
  selectedRow,
  treeRows,
} from "./tree.js";
import { currentItem, paneBox, paneModel, scrollPane } from "./pane.js";
import { act, runAction, openActions } from "./actions.js";
import { closeForm, formKeys, startForm } from "./views/policy.js";
import { result } from "./views/common.js";

// Key handling as a reducer (after Pelican's): reduce(state, action) ->
// { state, effects }. Actions: { type: "key", key }, "text" (several
// characters at once), "paste", "tick", "resize", "data" (what was read from
// ~/.baton), "auth" (an account's sign-in), "applied" (an action's outcome),
// "busy". Effects are data the runtime carries out: reload, apply (a core
// function), signin, auth, redraw and quit.
//
// The sidebar keeps navigation focus. Enter opens the selection's visible
// action menu or the Policy editor; Esc leaves the editor.
const quit = { type: "quit" };
const reload = { type: "reload" };

export function reduce(state, action) {
  const now = action.now ?? state.now;
  if (now !== state.now) state = { ...state, now };
  switch (action.type) {
    case "splash-end":
      return result({ ...state, splash: false });
    case "mouse":
      return onMouse(state, action);
    case "key":
      return onKey(state, action.key);
    case "text":
    case "paste":
      return onText(state, action.text, action.type === "paste");
    case "tick":
      return result(expireToasts(state), [reload]);
    case "resize":
      return result(
        reselect({ ...state, size: { cols: action.cols, rows: action.rows } }),
        [{ type: "redraw" }],
      );
    case "data":
      return result(reselect({ ...state, data: action.data }));
    case "auth":
      return result({
        ...state,
        auth: { ...state.auth, [action.account]: action.status },
      });
    case "busy":
      return result({ ...state, busy: action.busy ?? null });
    case "applied":
      return result(toast(state, action.text, action.ok ? "ok" : "error"), [
        reload,
      ]);
    default:
      return result(state);
  }
}

function onText(state, text, pasted) {
  if (tooSmall(state)) return result(state);
  if (state.splash) return result({ ...state, splash: false });
  if (state.modal) {
    const typed = modalText(state, text);
    if (typed) return typed;
  }
  if (!state.modal && (state.filtering || state.focus === "search"))
    return setFilter(
      { ...state, filtering: true },
      state.filter + String(text).replace(/\s+/g, " "),
    );
  if (pasted) return result(state);
  let out = result(state);
  const effects = [];
  for (const ch of String(text)) {
    out = onKey(out.state, ch === "\r" || ch === "\n" ? "enter" : ch);
    effects.push(...out.effects);
  }
  return result(out.state, effects);
}

// When the selection moves, the policy form closes.
function settle(before, out) {
  if (out.state.selected === before.selected || !out.state.form) return out;
  return result(closeForm(out.state), out.effects);
}

function onKey(state, key) {
  if (key === null || key === undefined) return result(state);
  if (key === "ctrl+c") return result(state, [quit]);
  if (tooSmall(state)) return result(state, key === "q" ? [quit] : []);
  if (state.splash) return result({ ...state, splash: false });
  if (state.modal) return modalKeys(state, key);
  if (state.filtering) return settle(state, filterKeys(state, key));
  if (state.focus === "search" && printable(key) && !["/", "q"].includes(key))
    return setFilter({ ...state, filtering: true }, state.filter + key);
  if (!state.data) return result(state, key === "q" ? [quit] : []);
  const own =
    state.focus === "pane" ? paneKeys(state, key) : sideKeys(state, key);
  return settle(state, own ?? globalKeys(state, key));
}

function onMouse(state, event) {
  const target = hitTest(state, event);
  if (!target) return result(state);
  if (target.dismiss) return result({ ...state, splash: false });
  if (target.toast !== undefined)
    return result({
      ...state,
      toasts: state.toasts.filter((t) => t.id !== target.toast),
    });
  if (target.modalScroll !== undefined)
    return result({
      ...state,
      modal: { ...state.modal, scroll: target.modalScroll },
    });
  if (target.choice !== undefined)
    return onKey(
      { ...state, modal: { ...state.modal, index: target.choice } },
      "enter",
    );
  if (target.runAction) return runAction(state, target.runAction);
  if (target.threshold !== undefined) {
    const next = {
      ...state,
      modal: { ...state.modal, index: target.threshold },
    };
    return target.command ? onKey(next, target.command) : result(next);
  }
  if (target.select) {
    if (target.select === "add-account")
      return globalKeys(state, "add-account");
    let next = state;
    if (!selectable(treeRows(next)).some((row) => row.id === target.select))
      next = { ...next, filter: "", filtering: false };
    next = select(
      { ...closeForm(next), focus: "side", filtering: false },
      target.select,
    );
    if (target.select === "more:sessions") return sideKeys(next, "enter");
    if (target.open) next = focusPane(next);
    return result(next);
  }
  if (target.scroll) {
    if (target.side)
      return settle(
        state,
        result(
          moveSelection({ ...closeForm(state), focus: "side" }, target.scroll),
        ),
      );
    let next = state;
    for (let i = 0; i < Math.abs(target.scroll); i++)
      next = scrollFromSide(next, target.scroll > 0 ? "down" : "up");
    return result(next);
  }
  if (target.field !== undefined) {
    const next = focusPane(state);
    next.form = { ...next.form, index: target.field };
    if (target.command === "home-choice" || target.command === "end-choice") {
      next.form = {
        ...next.form,
        values: {
          ...next.form.values,
          mode: target.command === "home-choice" ? "smart" : "order",
        },
      };
      return result(next);
    }
    return target.command ? onKey(next, target.command) : result(next);
  }
  if (target.focus) return result(focusPane(state));
  if (["q", "/"].includes(target.command))
    return globalKeys(state, target.command);
  if (target.command) return onKey(state, target.command);
  return result(state);
}

const focusPane = (state) => {
  const item = currentItem(state);
  if (item.kind === "policy")
    return {
      ...state,
      focus: "pane",
      form: state.form ?? startForm(state.data.policy),
    };
  return { ...state, focus: "pane" };
};
// PgUp/PgDn from the sidebar scroll the right pane (the sidebar keeps the keys).
function scrollFromSide(state, key) {
  const item = currentItem(state);
  const box = paneBox(state);
  return scrollPane(state, key, paneModel(state, item, box), box) ?? state;
}

// Search and Add account stay pinned outside the scrolling list, but are
// part of its arrow navigation. Focusing either preserves the detail view.
function stepSidebar(state, step) {
  if (state.focus === "search")
    return step < 0
      ? state
      : moveSelection({ ...state, focus: "side" }, "first");
  if (state.focus === "add")
    return step > 0
      ? state
      : moveSelection({ ...state, focus: "side" }, "last");
  const rows = selectable(treeRows(state));
  const at = rows.findIndex((row) => row.id === state.selected);
  if (step < 0 && at <= 0) return { ...state, focus: "search" };
  if (step > 0 && at === rows.length - 1) return { ...state, focus: "add" };
  return moveSelection(state, step);
}

function sideKeys(state, key) {
  const row = selectedRow(state);
  switch (key) {
    case "up":
      return result(stepSidebar(state, -1));
    case "down":
      return result(stepSidebar(state, 1));
    case "pageup":
    case "pagedown":
      return result(scrollFromSide(state, key));
    case "home":
      return result(moveSelection({ ...state, focus: "side" }, "first"));
    case "end":
      return result(moveSelection({ ...state, focus: "side" }, "last"));
    case "enter":
      if (state.focus === "search") return globalKeys(state, "/");
      if (state.focus === "add") return globalKeys(state, "add-account");
      if (!row) return result(state);
      if (row.kind === "more" && key === "enter") {
        const open = !state.open.sessions;
        return result(
          reselect({ ...state, open: { ...state.open, sessions: open } }),
        );
      }
      if (["overview", "account", "session"].includes(currentItem(state).kind))
        return openActions(state, currentItem(state));
      // Only a pane with something to do takes the keys.
      return result(
        currentItem(state).kind === "policy" ? focusPane(state) : state,
      );
    case "escape":
      return result(state.filter ? clearFilter(state) : state);
    default:
      return null;
  }
}

function paneKeys(state, key) {
  const item = currentItem(state);
  if (item.kind === "policy" && state.form) {
    const used = formKeys(state, key);
    if (used) return used;
  }
  const box = paneBox(state);
  const model = paneModel(state, item, box);
  const scrolled = scrollPane(state, key, model, box);
  if (scrolled) return result(scrolled);
  if (key === "escape") return result({ ...closeForm(state), focus: "side" });
  return null;
}

function globalKeys(state, key) {
  switch (key) {
    case "add-account":
      return act(
        { ...closeForm(state), focus: "add" },
        { kind: "overview" },
        "a",
      );
    case "q":
      return result(state, [quit]);
    case "/":
      return result({ ...closeForm(state), filtering: true, focus: "search" });
    case "escape":
      return result(state.filter ? clearFilter(state) : state);
    default:
      return result(state);
  }
}

function setFilter(state, filter) {
  if (!filter)
    return result(
      reselect({ ...state, filter: "", filtering: false, focus: "search" }),
    );
  let next = { ...state, filter };
  const query = filter.trim();
  const rows = selectable(treeRows(next));
  const hit =
    (query && rows.find((r) => fuzzyMatches(query, r.name))) ?? rows[0];
  if (hit) next = select(next, hit.id);
  return result(next);
}
const clearFilter = (state) =>
  reselect({ ...state, filter: "", filtering: false, focus: "side" });
function filterKeys(state, key) {
  const filter = state.filter;
  if (key === "enter")
    return result({ ...state, filtering: false, focus: "side" });
  if (key === "escape") return result(clearFilter(state));
  if (key === "backspace")
    return setFilter(state, [...filter].slice(0, -1).join(""));
  if (key === "ctrl+u") return setFilter(state, "");
  if (printable(key)) return setFilter(state, filter + key);
  if (key === "down")
    return result({ ...state, filtering: false, focus: "side" });
  if (key === "up") return result(state);
  return result(state);
}
