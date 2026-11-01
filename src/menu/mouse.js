import {
  bodyHeight,
  frameCols,
  paneHeaderRows,
  sideBrandRows,
  sideFooterRows,
  tooSmall,
} from "./layout.js";
import { currentItem, paneBox, paneModel, paneWindow } from "./pane.js";
import { sideLines, sideSpan, sideTop, sideWidth, treeRows } from "./tree.js";
import { glyphsOf, makeTheme } from "./theme.js";
import { modalLayout, toastLayouts } from "./ui/overlays.js";
import { footerModel } from "./ui/chrome.js";
import { fields } from "./views/policy.js";
import { width } from "./text.js";

const at = (targets, x, y) =>
  targets.find((t) => y === t.y && x >= t.x && x < t.x + t.width);
export function hitTest(state, event) {
  const { x, y, button, kind } = event;
  if (
    tooSmall(state) ||
    x < 0 ||
    y < 0 ||
    x >= frameCols(state) ||
    y >= state.size.rows - 1
  )
    return null;
  if (state.splash) return kind === "press" ? { dismiss: true } : null;
  if (kind !== "press" && kind !== "wheel") return null;
  if (state.modal) {
    const layout = modalLayout(
      state,
      makeTheme({ color: state.color, glyphs: state.glyphs }),
    );
    if (kind === "wheel")
      return {
        modalScroll: Math.max(
          0,
          Math.min(layout.max, layout.offset + event.delta),
        ),
      };
    return kind === "press" && button === 0
      ? (at(layout.targets, x, y) ?? null)
      : null;
  }
  if (!state.data || (kind === "press" && button !== 0)) return null;
  if (kind === "press") {
    const toast = toastLayouts(
      state,
      makeTheme({ color: state.color, glyphs: state.glyphs }),
    ).find(
      (t) =>
        x >= t.left &&
        x < t.left + t.width &&
        y >= t.top &&
        y < t.top + t.lines.length,
    );
    if (toast) return { toast: toast.id };
    if (y === state.size.rows - 2)
      return at(footerModel(state, glyphsOf(state)).targets, x, y) ?? null;
  }
  const side = sideWidth(state),
    inSide = x < side;
  if (kind === "wheel") return { scroll: event.delta, side: inSide };
  if (inSide) {
    if (y === sideBrandRows - 2) return { command: "/" };
    if (y === bodyHeight(state) - 2) return { command: "add-account" };
    const cells = side - 3,
      rows = treeRows(state);
    const view = sideLines(state, cells, {
      focused: state.focus === "side" && !state.filtering,
      g: glyphsOf(state),
      rows,
      span: sideSpan(state, cells, rows),
    });
    const room = Math.max(
      1,
      bodyHeight(state) - sideBrandRows - sideFooterRows,
    );
    const top = sideTop(view.lines.length, view.from, view.to, room);
    const index = y - sideBrandRows;
    if (index < 0 || index >= room || x < 1 || x >= side - 1) return null;
    const id = view.owners[top + index];
    return id ? { select: id } : null;
  }
  const box = paneBox(state),
    px = x - side - 3;
  if (px < 0 || px >= box.room.width) return null;
  const py = y - paneHeaderRows;
  if (py < 0 || py >= box.room.height) return null;
  const model = paneModel(state),
    w = paneWindow(state, model, box);
  const bodyY = py + w.top;
  const link = at(model.targets[bodyY] ?? [], px, bodyY);
  if (link) return link;
  if (currentItem(state).kind === "policy") {
    const index = bodyY;
    if (index >= 0 && index < fields.length) {
      const controlX = 2 + Math.max(...fields.map((f) => width(f.label))) + 2;
      const field = fields[index];
      const command =
        px < controlX || px > controlX + 18
          ? null
          : field.kind === "choice"
            ? px < controlX + 8
              ? "home-choice"
              : "end-choice"
            : px < controlX + 2
              ? "left"
              : "right";
      return { field: index, command };
    }
    if (index === fields.length + 1)
      return { field: fields.length, command: "enter" };
  }
  return null;
}
