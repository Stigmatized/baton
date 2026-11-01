import { lineWidth, s, wrapLine } from "./lines.js";
import { bodyHeight, frameCols, inner, isNarrow } from "./layout.js";
import { selectedRow, sideWidth } from "./tree.js";
import { kinds } from "./views/index.js";

// The right pane shows what the sidebar has selected (after Pelican's).
export function currentItem(state) {
  if (state.filter.trim() && !selectedRow(state))
    return { kind: "empty", id: "empty", key: "empty" };
  const id = state.selected;
  if (id.startsWith("acct:"))
    return { kind: "account", id, key: id, accountId: id.slice(5) };
  if (id.startsWith("sess:"))
    return { kind: "session", id, key: id, sessionId: id.slice(5) };
  if (id === "more:sessions") return { kind: "sessions", id, key: id };
  if (id === "policy") return { kind: "policy", id, key: id };
  if (id === "stats") return { kind: "stats", id, key: id };
  return { kind: "overview", id: "overview", key: "overview" };
}

// Whether the right pane is taller than its room (PgUp/PgDn scroll it).
export function paneOverflows(state, item = currentItem(state)) {
  if (!state.data || isNarrow(state)) return false;
  const box = paneBox(state);
  const w = paneWindow(state, paneModel(state, item, box), box);
  return w.total > w.room;
}

export function paneBox(state) {
  const cols = frameCols(state);
  const height = bodyHeight(state);
  const width = isNarrow(state) ? cols : Math.max(10, cols - sideWidth(state));
  const room = inner(width, height);
  return { width, height, room };
}

// A pane's content, from its kind: { title, right, body }. Nothing is cut: a
// line wider than the pane wraps.
export function paneModel(
  state,
  item = currentItem(state),
  box = paneBox(state),
) {
  const model = {
    title: [],
    right: [],
    body: [],
    ...(state.data
      ? kinds[item.kind]?.model(
          state,
          { ...item, id: item.sessionId ?? item.id },
          box,
        )
      : {}),
  };
  const width = box.room.width;
  if (lineWidth(model.title) > width) {
    model.body = [...wrapLine(model.title, width), [], ...model.body];
    model.title = [s(item.kind === "account" ? "Account" : "Session", "bold")];
  }
  model.targets = [];
  model.body = model.body.flatMap((line) => {
    const lines = lineWidth(line) > width ? wrapLine(line, width, 2) : [line];
    for (let i = 0; i < lines.length; i++) {
      const row = model.targets.length;
      model.targets.push(
        (line.targets ?? []).map((target) => ({ ...target, y: row })),
      );
    }
    return lines;
  });
  model.viewKey = item.key;
  return model;
}

export const scrollOf = (state, model) =>
  state.views[model.viewKey] ?? { top: 0 };
export function paneWindow(state, model, box) {
  const room = Math.max(1, box.room.height);
  const max = Math.max(0, model.body.length - room);
  const top = Math.max(0, Math.min(scrollOf(state, model).top, max));
  return {
    room,
    top,
    max,
    lines: model.body.slice(top, top + room),
    above: top,
    below: Math.max(0, model.body.length - top - room),
    total: model.body.length,
  };
}

const steps = { up: -1, down: 1 };
export function scrollPane(state, key, model, box) {
  const w = paneWindow(state, model, box);
  let top = null;
  if (key in steps) top = w.top + steps[key];
  else if (key === "pageup") top = w.top - Math.max(1, w.room - 1);
  else if (key === "pagedown") top = w.top + Math.max(1, w.room - 1);
  else if (key === "home") top = 0;
  else if (key === "end") top = w.max;
  if (top === null) return null;
  top = Math.max(0, Math.min(w.max, top));
  return { ...state, views: { ...state.views, [model.viewKey]: { top } } };
}

export const paneHeight = (state) => bodyHeight(state);
