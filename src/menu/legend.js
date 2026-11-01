import { lineWidth, s } from "./lines.js";
import { glyphsOf } from "./theme.js";

// A quiet label bar beside the view that uses the symbols.
export function legendLine(state, kind, width) {
  const g = glyphsOf(state);
  const entries =
    kind === "account"
      ? [
          [g.limit, "Threshold"],
          [g.baton, "Next account"],
          [g.blocked, "Blocked"],
        ]
      : ["session", "sessions"].includes(kind)
        ? [
            [g.spinner[0], "Working"],
            [g.dot, "Idle"],
            [g.diamond, "Wait / move"],
            [g.ring, "Recent"],
          ]
        : ["overview", "stats"].includes(kind)
          ? [
              [g.preferred, "Preferred"],
              [g.lastResort, "Last resort"],
              [g.normal, "Normal"],
              [g.blocked, "Blocked"],
            ]
          : [];
  const line = [];
  for (const [sign, label] of entries) {
    const next = [
      ...(line.length ? [s(" ")] : []),
      s(" " + sign + " " + label + " ", "label"),
    ];
    if (lineWidth([...line, ...next]) <= width) line.push(...next);
  }
  return line;
}
