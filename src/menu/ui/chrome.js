import { fitLine, lineWidth, s } from "../lines.js";
import { frameCols } from "../layout.js";
import { currentItem, paneOverflows } from "../pane.js";
import { sessionById } from "../state.js";

export const keyLabel = (key, g) =>
  ({
    updown: g.up + g.down,
    leftright: g.left + g.right,
    down: g.down,
    enter: g.enter,
  })[key] ?? key;
export function footerHints(state) {
  const kind = state.modal?.kind;
  if (kind === "choice" || kind === "actions")
    return [
      ["updown", "Choose", 1],
      ["enter", "Select", 1],
      ["Esc", "Close", 1],
    ];
  if (kind === "confirm")
    return [
      ["leftright", "Choose", 1],
      ["enter", "Select", 1],
      ["Esc", "Cancel", 1],
    ];
  if (kind === "input")
    return [
      ["Ctrl+U", "Clear", 1],
      ["enter", "Save", 1],
      ["Esc", "Cancel", 1],
    ];
  if (kind === "thresholds")
    return [
      ["updown", "Field", 1],
      ["leftright", "Adjust", 1],
      ["d", "Default", 1],
      ["enter", "Save", 1],
      ["Esc", "Cancel", 1],
    ];
  if (state.filtering)
    return [
      ["down", "Results", 1],
      ["enter", "Done", 1],
      ["Ctrl+U", "Clear", 1],
      ["Esc", "Cancel", 1],
    ];
  const item = currentItem(state);
  if (item.kind === "policy" && state.form)
    return [
      ["updown", "Field", 1],
      ["leftright", "Adjust", 1],
      ["Home/End", "Jump", 2],
      ["d", "Default", 1],
      ["enter", "Apply", 1],
      ["Esc", "Done", 1],
    ];
  return [
    ["updown", "Navigate", 1],
    ["Home/End", "Jump", 2],
    ...(state.focus === "search" || state.focus === "add"
      ? [["enter", "Activate", 1]]
      : item.kind === "policy"
        ? [["enter", "Edit", 1]]
        : item.kind === "sessions"
          ? [["enter", state.open.sessions ? "Collapse" : "Expand", 1]]
          : ["overview", "account"].includes(item.kind) ||
              (item.kind === "session" &&
                sessionById(state, item.sessionId)?.live)
            ? [["enter", "Actions", 1]]
            : []),
    ...(state.filter ? [["Esc", "Clear", 1]] : []),
    ...(paneOverflows(state) ? [["PgUp/Dn", "Scroll", 2]] : []),
    ["q", "Quit", 1],
  ];
}
export function footerModel(state, g) {
  const cols = frameCols(state);
  let shown = footerHints(state);
  const spans = (list) =>
    list.flatMap(([key, label], i) => [
      s(i ? "    " : "  "),
      s(keyLabel(key, g), "accent bold"),
      s(" " + label, "muted"),
    ]);
  while (shown.length > 1 && lineWidth(spans(shown)) > cols) {
    const weight = Math.max(...shown.map((h) => h[2]));
    const index = shown.findLastIndex((h) => h[2] === weight);
    shown = shown.filter((_, i) => i !== index);
  }
  let x = 0;
  const targets = shown.map(([key, label], i) => {
    x += i ? 4 : 2;
    const start = x,
      size = lineWidth([s(keyLabel(key, g) + " " + label)]);
    x += size;
    const command =
      {
        updown: "down",
        leftright: "right",
        enter: "enter",
        Esc: "escape",
        "Home/End": "end",
        "PgUp/Dn": "pagedown",
        "Ctrl+U": "ctrl+u",
      }[key] ?? key;
    return { x: start, y: state.size.rows - 2, width: size, command };
  });
  return { line: fitLine(spans(shown), cols), targets };
}
export const footerLine = (state, g) => footerModel(state, g).line;
