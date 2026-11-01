import { fuzzyMatches } from "./fuzzy.js";
import { fitLine, lineWidth, restyle, s, wrapLine } from "./lines.js";
import { span, width } from "./text.js";
import { glyphsOf } from "./theme.js";
import { usageTone } from "./charts.js";
import { bodyHeight, isNarrow, sidebarCols } from "./layout.js";
import { accounts, liveSessions, recentSessions, signedOut } from "./state.js";

// The sidebar (after Pelican's): one list of everything there is to look
// at: Overview; the accounts in priority order, each with its mark, its
// compact 5-hour and weekly use, and a blocked or signed-out mark; the live
// lead sessions, then the recent ones folded under "+ n recent"; Policy;
// Stats. A row is { id, kind, depth, icon, name, nameStyle, tail (dropped
// first when room is short), parent, selectable }.
const heading = (id, text, count) => ({
  id,
  kind: "heading",
  depth: 0,
  icon: null,
  name: text,
  nameStyle: "muted bold",
  tail: count ? [s(String(count), "muted")] : [],
  selectable: false,
});
const gap = (id) => ({
  id,
  kind: "gap",
  depth: 0,
  name: "",
  tail: [],
  selectable: false,
});

export const markIcon = (mark, g) =>
  mark === "preferred"
    ? s(g.preferred, "baton bold")
    : mark === "last-resort"
      ? s(g.lastResort, "muted")
      : s(g.normal, "muted");

// An account's tail: "5h 42 · wk 63" when it fits, else the higher of the
// two with its window ("wk 63%"); a blocked account shows when it is back,
// a signed-out one "sign in".
function accountTail(state, a, g) {
  if (signedOut(state, a.id)) return { tail: [s("sign in", "warn")] };
  if (a.blocked)
    return {
      tail: [
        s(
          `${g.blocked} ${a.availableKnown ? span(a.availableAt - state.now) : "?"}`,
          "err",
        ),
      ],
    };
  const five = a.windows.five_hour;
  const week = a.windows.seven_day;
  const n = (w) => (w.used == null ? "-" : String(Math.round(w.used)));
  const tone = (w) => usageTone(w.used, w.threshold);
  const higher =
    (week.used ?? -1) > (five.used ?? -1) ? ["wk", week] : ["5h", five];
  return {
    tail: [
      s("5h ", "muted"),
      s(n(five), tone(five)),
      s(" · ", "muted"),
      s("wk ", "muted"),
      s(n(week), tone(week)),
    ],
    short: [
      s(`${higher[0]} `, "muted"),
      s(`${n(higher[1])}%`, tone(higher[1])),
    ],
  };
}

export const sessionIcon = (x, g) =>
  x.wrapperState === "waiting" || x.wrapperState === "countdown"
    ? s(g.diamond, "warn bold")
    : x.turnState === "running"
      ? s(g.spinner[0], "accent spin")
      : x.live
        ? s(g.dot, "ok")
        : s(g.ring, "muted");

const sessionRow = (x, g, depth = 0, parent) => ({
  id: `sess:${x.id}`,
  kind: "session",
  depth,
  icon: sessionIcon(x, g),
  name: x.name,
  nameStyle: x.live ? "bold" : "",
  tail: x.account ? [s(x.accountName ?? x.account, "muted")] : [],
  parent,
  selectable: true,
  session: x,
});

export function treeRows(state, { everything = false } = {}) {
  const g = glyphsOf(state);
  const query = everything ? "" : state.filter.trim();
  const match = (...names) => !query || fuzzyMatches(query, ...names);
  const sections = [];
  const data = state.data;
  if (match("Overview"))
    sections.push([
      {
        id: "overview",
        kind: "overview",
        depth: 0,
        // Sections (Overview, Policy, Stats) have no sign: every glyph in
        // the sidebar means one thing (the help lists them).
        icon: s(" "),
        name: "Overview",
        nameStyle: "brand bold",
        tail: [],
        selectable: true,
      },
    ]);
  const list = accounts(state).filter((a) => match(a.name, a.mark));
  if (list.length)
    sections.push([
      heading("h:accounts", "Accounts", list.length),
      ...list.map((a) => ({
        id: `acct:${a.id}`,
        kind: "account",
        depth: 0,
        icon: markIcon(a.mark, g),
        name: a.name,
        nameStyle: data?.next.account === a.id ? "bold" : "",
        ...((t) => ({ tail: t.tail, shortTail: t.short ?? null }))(
          accountTail(state, a, g),
        ),
        selectable: true,
        account: a,
      })),
    ]);
  const live = liveSessions(state).filter((x) =>
    match(x.name, x.accountName, x.id),
  );
  const recent = recentSessions(state).filter((x) =>
    match(x.name, x.accountName, x.id),
  );
  if (live.length || recent.length) {
    const open = everything || query || state.open.sessions;
    const rows = [
      heading("h:sessions", "Sessions", live.length),
      ...live.map((x) => sessionRow(x, g)),
    ];
    if (recent.length) {
      if (open)
        rows.push(...recent.map((x) => sessionRow(x, g, 1, "more:sessions")));
      rows.push({
        id: "more:sessions",
        kind: "more",
        depth: 0,
        icon: null,
        name: open
          ? `${g.less} hide ${recent.length} recent`
          : `${g.more} ${recent.length} recent`,
        nameStyle: "muted",
        tail: [],
        selectable: !query,
      });
    }
    sections.push(rows);
  }
  const tools = [];
  if (match("Policy", "settings"))
    tools.push({
      id: "policy",
      kind: "policy",
      depth: 0,
      icon: s(" "),
      name: "Policy",
      nameStyle: "bold",
      tail: data ? [s(data.policy.mode, "muted")] : [],
      selectable: true,
    });
  if (match("Stats", "statistics"))
    tools.push({
      id: "stats",
      kind: "stats",
      depth: 0,
      icon: s(" "),
      name: "Stats",
      nameStyle: "bold",
      tail: [],
      selectable: true,
    });
  if (tools.length) sections.push(tools);
  const rows = sections.flatMap((section, i) => [
    ...(i ? [gap(`gap:${i}`)] : []),
    ...section,
  ]);
  if (!rows.length)
    rows.push({
      ...gap("none"),
      kind: "none",
      name: "Nothing matches.",
      nameStyle: "muted",
      icon: null,
    });
  return rows;
}

const marker = 2;
const prefixWidth = (row) => marker + row.depth * 2 + (row.icon ? 2 : 0);
export const rowWidth = (row, tail = row.tail) =>
  prefixWidth(row) +
  width(row.name) +
  (tail.length ? 2 + lineWidth(tail) : 0) +
  1;

export function sideWidth(state) {
  return sidebarCols;
}

// A row as lines `cells` wide. The name is never cut: the tail goes first,
// then the name wraps under itself.
export function rowLines(
  row,
  cells,
  { selected = false, focused = false, g, span: room0 = cells },
) {
  if (row.kind === "gap") return [[]];
  const indent = " ".repeat(row.depth * 2);
  const mark = selected
    ? [s(`${g.arrow} `, focused ? "" : "accent bold")]
    : [s("  ")];
  const icon = row.icon ? [row.icon, s(" ")] : [];
  const nameStyle =
    selected && !focused ? `${row.nameStyle ?? ""} bold`.trim() : row.nameStyle;
  const name = [s(row.name, nameStyle)];
  const head = [...mark, s(indent), ...icon];
  const room = Math.min(cells, room0);
  let lines;
  // The full tail, else the short one, else none: the name is never cut.
  const tail = [row.tail, row.shortTail].find(
    (t) => t && rowWidth(row, t) <= room,
  );
  if (tail)
    lines = [
      [
        ...head,
        ...name,
        s(" ".repeat(room - rowWidth(row, tail) + (tail.length ? 2 : 0))),
        ...tail,
        s(" "),
      ],
    ];
  else if (prefixWidth(row) + width(row.name) + 1 <= cells)
    lines = [[...head, ...name]];
  else {
    const lead = prefixWidth(row);
    lines = wrapLine(name, Math.max(1, cells - 1 - lead)).map((line, i) =>
      i ? [s(" ".repeat(lead)), ...line] : [...head, ...line],
    );
  }
  // The selected row reads at a glance: focused, a solid accent bar with a
  // bright bold foreground for every part of it (no dim, muted or colour
  // of its own); unfocused, the › marker and its text at full strength.
  if (selected && focused)
    return lines.map((line) =>
      fitLine(restyle(line, "selected bold"), cells, "selected bold"),
    );
  if (selected) return lines.map((line) => fitLine(undimmed(line), cells));
  return lines.map((line) => fitLine(line, cells));
}

const faint = new Set(["dim", "muted"]);
export const undimmed = (line) =>
  line.map(([text, style]) => [
    text,
    String(style ?? "")
      .split(" ")
      .filter((w) => w && !faint.has(w))
      .join(" "),
  ]);

export const selectable = (rows) => rows.filter((r) => r.selectable);
export function selectedRow(state, rows = treeRows(state)) {
  return rows.find((r) => r.id === state.selected && r.selectable) ?? null;
}

// After the data or the filter changes the selection stays on its item while
// it is there; otherwise the row now at its place takes it.
export function reselect(state) {
  const rows = selectable(treeRows(state));
  if (!rows.length) return state;
  const at = rows.findIndex((r) => r.id === state.selected);
  if (at >= 0) return at === state.index ? state : { ...state, index: at };
  const index = Math.max(0, Math.min(state.index, rows.length - 1));
  return { ...state, selected: rows[index].id, index };
}

export function moveSelection(state, step) {
  const rows = selectable(treeRows(state));
  if (!rows.length) return state;
  const at = Math.max(
    0,
    rows.findIndex((r) => r.id === state.selected),
  );
  const index =
    step === "first"
      ? 0
      : step === "last"
        ? rows.length - 1
        : Math.max(0, Math.min(rows.length - 1, at + step));
  if (rows[index].id === state.selected && index === state.index) return state;
  return { ...state, selected: rows[index].id, index };
}
export const select = (state, id) => {
  const index = selectable(treeRows({ ...state, selected: id })).findIndex(
    (r) => r.id === id,
  );
  return { ...state, selected: id, index: Math.max(0, index) };
};

export function sideLines(
  state,
  cells,
  { focused, g, rows = treeRows(state), span: room = cells },
) {
  const lines = [];
  const owners = [];
  let from = 0;
  let to = 0;
  for (const row of rows) {
    const selected = row.selectable && row.id === state.selected;
    const own = rowLines(row, cells, { selected, focused, g, span: room });
    if (selected) {
      from = lines.length;
      to = from + own.length;
    }
    lines.push(...own);
    owners.push(...own.map(() => (row.selectable ? row.id : null)));
  }
  return { lines, owners, from, to };
}
export function sideTop(count, from, to, height) {
  if (count <= height) return 0;
  const room = Math.max(0, height - (to - from));
  const top = from - Math.floor(room / 2);
  return Math.max(0, Math.min(top, count - height));
}
export function sideSpan(state, cells, rows = treeRows(state)) {
  if (!isNarrow(state)) return cells;
  const widest = Math.max(0, ...rows.map((r) => rowWidth(r)));
  return Math.min(cells, Math.max(30, Math.min(48, widest)));
}
export const sidePage = (state) => Math.max(1, bodyHeight(state) - 4);
