import { lineWidth, s, wrapFacts, wrapLine } from "../lines.js";
import { usageBar } from "../charts.js";
import { pct, span, when } from "../text.js";

// Pieces the panes share.
export const result = (state, effects = []) => ({ state, effects });
export const section = (title, extra = "") => [
  s(title, "bold"),
  ...(extra ? [s(`  ${extra}`, "muted")] : []),
];
export const sectionRule = (title, width, g) => [
  s(title, "muted bold"),
  s(
    "  " + g.corners.h.repeat(Math.max(0, width - lineWidth([s(title)]) - 2)),
    "divider",
  ),
];

// "label  value" rows with the labels in a column; a long value wraps under
// itself.
export function field(label, value, width, labelWidth = 10) {
  const head = [s(label.padEnd(labelWidth), "muted")];
  return wrapLine([...head, ...value], width, labelWidth);
}

// The words for where new work goes, from the policy's reason.
export const reasonWords = {
  preferred: "preferred, with 5-hour room",
  urgency: "the most weekly allowance to lose before its reset",
  "low-reserve": "the most 5-hour room left",
  "last-resort": "every other account is blocked",
  order: "first open account in order",
};

// One window of an account as a line: label, bar with the threshold mark,
// used %, and its reset when there is room (dropped first, never cut).
export function windowLine(label, w, width, g, now, { labelWidth = 4 } = {}) {
  const head = [s(label.padEnd(labelWidth), "muted")];
  const value =
    w.used == null
      ? [s(w.reset ? "reset" : "not measured", "muted")]
      : [
          s(
            ` ${pct(w.used)}`.padStart(5),
            w.used >= w.threshold ? "err bold" : "bold",
          ),
        ];
  const resets =
    w.used != null && w.resetsAt
      ? [
          s(`  resets ${when(w.resetsAt, now)}`, "muted"),
          s(` (${span(w.resetsAt - now)})`, "muted"),
        ]
      : [];
  // Every bar of a pane the same width (room kept for the longest reset
  // text); a narrow pane drops the resets instead of shrinking the bar.
  const fixed = labelWidth + 5 + 1;
  const withReset = width - fixed - 27;
  const barWidth = Math.max(
    8,
    Math.min(40, withReset >= 12 ? withReset : width - fixed),
  );
  const bar = usageBar(w.used, w.threshold, barWidth, { g });
  const line = [...head, ...bar, s(" "), ...value];
  if (lineWidth(line) + lineWidth(resets) <= width) line.push(...resets);
  return line;
}

export { wrapFacts };
