import { s } from "./lines.js";
import { width as cells } from "./text.js";

// Graphs as spans (after Pelican's): sparklines, bar charts, and the usage
// bar with its threshold. g is the theme's glyph set.

function runs(chars) {
  const spans = [];
  let text = "";
  let style = null;
  for (const [ch, st] of chars) {
    if (st !== style && text) {
      spans.push(s(text, style));
      text = "";
    }
    style = st;
    text += ch;
  }
  if (text) spans.push(s(text, style));
  return spans;
}

// One cell per value (null = no reading: a dim dot), scaled to `max`.
export function spark(values = [], { g, style = "accent", max = 100 } = {}) {
  return runs(
    values.map((v) => {
      if (v == null) return [g.normal, "muted"];
      const level =
        v > 0
          ? Math.min(
              g.ticks.length - 1,
              Math.max(1, Math.round((v / max) * (g.ticks.length - 1))),
            )
          : 0;
      return [g.ticks[level], level ? style : "muted"];
    }),
  );
}

// A bar chart `height` rows tall, one column per value, the scale on the
// left: lines, the top row first.
export function chart(
  values = [],
  height,
  {
    g,
    style = "accent",
    label = (n) => String(Math.round(n)),
    columnWidth = 1,
  } = {},
) {
  const top = Math.max(0, ...values);
  const axis = Math.max(cells(label(top)), 1) + 1;
  const steps = g.bars.length;
  const units = height * steps;
  const levels = values.map((v) =>
    v > 0 && top > 0 ? Math.max(1, Math.round((v / top) * units)) : 0,
  );
  const lines = [];
  for (let row = height - 1; row >= 0; row--) {
    const tag = row === height - 1 ? label(top) : row === 0 ? "0" : "";
    const chars = levels.flatMap((n) => {
      const filled = n - row * steps;
      const cell =
        filled >= steps
          ? [g.bars[steps - 1], style]
          : filled > 0
            ? [g.bars[filled - 1], style]
            : [row === 0 ? g.ticks[0] : " ", "muted"];
      return Array.from({ length: columnWidth }, () => cell);
    });
    lines.push([
      s(tag.padStart(axis - 1), "muted"),
      s(" ", "muted"),
      ...runs(chars),
    ]);
  }
  return lines;
}

// How full a window is, in a colour: green with room, yellow within 15
// points of the threshold, red at or past it.
export const usageTone = (used, threshold) =>
  used == null
    ? "muted"
    : used >= threshold
      ? "err"
      : used >= threshold - 15
        ? "warn"
        : "ok";

// used % as a bar `width` cells wide with the threshold marked on it.
export function usageBar(used, threshold, width, { g }) {
  const w = Math.max(4, width);
  const at = Math.min(
    w - 1,
    Math.max(0, Math.round((threshold / 100) * w) - 1),
  );
  const filled =
    used == null ? 0 : Math.min(w, Math.round((Math.max(0, used) / 100) * w));
  const tone = usageTone(used, threshold);
  const chars = [];
  for (let i = 0; i < w; i++) {
    if (i === at)
      chars.push([
        g.limit,
        used != null && used >= threshold ? "err bold" : "warn",
      ]);
    else if (i < filled) chars.push([g.full, tone]);
    else chars.push([g.empty, "muted"]);
  }
  return runs(chars);
}
