import { Box } from "ink";
import { fitLine, restyle, s } from "../lines.js";
import { useTheme } from "../theme.js";
import { sideLines, sideSpan, sideTop, treeRows } from "../tree.js";
import { h, Lines } from "./kit.js";
import { sideBrandRows, sideFooterRows } from "../layout.js";
import { branding } from "../art.js";
import { fieldWindow } from "../modal.js";

export function Sidebar({ state, width, height }) {
  const theme = useTheme();
  const cells = width - 3;
  const rows = treeRows(state);
  const room = Math.max(1, height - sideBrandRows - sideFooterRows);
  const view = sideLines(state, cells, {
    focused: state.focus === "side" && !state.filtering,
    g: theme.g,
    rows,
    span: sideSpan(state, cells, rows),
  });
  const top = sideTop(view.lines.length, view.from, view.to, room);
  const field = fieldWindow(state.filter, [...state.filter].length, cells - 6);
  const search = state.filtering
    ? [
        s("  / ", "accent bold"),
        s(field.before),
        s(field.at, "inverse"),
        s(field.after),
      ]
    : [
        s(state.focus === "search" ? theme.g.arrow + " " : "  "),
        s("/ ", "accent bold"),
        s(state.filter || "Search", state.filter ? "text" : "muted"),
      ];
  const control = (line, active) =>
    active
      ? fitLine(restyle(line, "selected bold"), cells, "selected bold")
      : line;
  const add = [
    s(state.focus === "add" ? theme.g.arrow + " " : "  "),
    s("+ ", "accent bold"),
    s("Add account", "accent"),
  ];
  return h(
    Box,
    {
      width,
      height,
      flexShrink: 0,
      flexDirection: "column",
      paddingLeft: 1,
      paddingRight: 1,
      borderStyle: "single",
      borderLeft: false,
      borderTop: false,
      borderBottom: false,
      borderColor: theme.color ? "#2b3037" : undefined,
      backgroundColor: theme.tone("surface"),
    },
    h(Lines, {
      lines: [
        [],
        ...branding("  "),
        [],
        control(search, state.focus === "search" && !state.filtering),
        [],
      ],
      width: cells,
      height: sideBrandRows,
    }),
    h(Lines, {
      lines: view.lines.slice(top, top + room),
      width: cells,
      height: room,
    }),
    h(Lines, {
      lines: [
        [],
        control(add, state.focus === "add"),
        [
          ...(top ? [s("  " + theme.g.up + " more above", "muted")] : []),
          ...(top + room < view.lines.length
            ? [s((top ? "   " : "  ") + theme.g.down + " more below", "muted")]
            : []),
        ],
      ],
      width: cells,
      height: sideFooterRows,
    }),
  );
}
