import { fitLine, lineWidth, s } from "./lines.js";

export function buttons(entries, width) {
  const lines = [[]],
    targets = [];
  for (const entry of entries) {
    const shortcut = entry.key
      ? [
          s(
            " " + entry.key + " ",
            entry.selected ? "selected bold" : "accent bold",
          ),
        ]
      : [];
    const line = [
      s(" " + entry.label + " ", entry.selected ? "selected bold" : "muted"),
      ...shortcut,
    ];
    const size = lineWidth(line);
    let row = lines.length - 1,
      x = lineWidth(lines[row]);
    if (x && x + size > width) {
      lines.push([]);
      row++;
      x = 0;
    }
    lines[row].push(...line, s("  "));
    targets.push({ x, y: row, width: Math.min(size, width - x), ...entry });
  }
  return { lines: lines.map((line) => fitLine(line, width)), targets };
}
