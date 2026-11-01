import { branding } from "./menu/art.js";
import { fitLine, lineWidth, s, wrapLine } from "./menu/lines.js";
import { glyphSets, makeTheme, pickGlyphs } from "./menu/theme-core.js";

// What the plain commands print (baton install, status, doctor, ...) is built
// like the menu's panes: lines of [text, style] spans (menu/lines.js) in the
// menu's palette and glyphs, measured in terminal cells and wrapped to the
// terminal. This file turns them into ANSI text for a stream, or into plain
// text when it is not a terminal (a pipe, a test, the /hop command's answer),
// NO_COLOR is set, or the terminal has no colour.

const NAMED = {
  black: 30,
  red: 31,
  green: 32,
  yellow: 33,
  blue: 34,
  magenta: 35,
  cyan: 36,
  white: 37,
  gray: 90,
  grey: 90,
  redBright: 91,
  greenBright: 92,
  yellowBright: 93,
  blueBright: 94,
  magentaBright: 95,
  cyanBright: 96,
  whiteBright: 97,
};
const BASIC = [
  [0, 0, 0],
  [205, 49, 49],
  [13, 188, 121],
  [229, 229, 16],
  [36, 114, 200],
  [188, 63, 188],
  [17, 168, 205],
  [229, 229, 229],
  [102, 102, 102],
  [241, 76, 76],
  [35, 209, 139],
  [245, 245, 67],
  [59, 142, 234],
  [214, 112, 214],
  [41, 184, 219],
  [255, 255, 255],
];

const rgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));

function colorCodes(color, background, depth) {
  const base = background ? 10 : 0;
  if (color in NAMED) return [NAMED[color] + base];
  const [r, g, b] = rgb(color);
  if (depth >= 24) return [background ? 48 : 38, 2, r, g, b];
  if (depth >= 8) {
    const gray = Math.abs(r - g) < 8 && Math.abs(g - b) < 8;
    const level = (v) => Math.round((v / 255) * 5);
    const index = gray
      ? 232 + Math.min(23, Math.round(((r - 8) / 247) * 24))
      : 16 + 36 * level(r) + 6 * level(g) + level(b);
    return [background ? 48 : 38, 5, index];
  }
  let best = 0;
  let distance = Infinity;
  BASIC.forEach(([cr, cg, cb], i) => {
    const d = (cr - r) ** 2 + (cg - g) ** 2 + (cb - b) ** 2;
    if (d < distance) [best, distance] = [i, d];
  });
  return [(best < 8 ? 30 + best : 82 + best) + base];
}

function escape(props, depth) {
  const codes = [];
  if (props.bold) codes.push(1);
  if (props.dimColor) codes.push(2);
  if (props.italic) codes.push(3);
  if (props.underline) codes.push(4);
  if (props.inverse) codes.push(7);
  if (props.color) codes.push(...colorCodes(props.color, false, depth));
  if (props.backgroundColor)
    codes.push(...colorCodes(props.backgroundColor, true, depth));
  return codes.length ? `\x1b[${codes.join(";")}m` : "";
}

// The terminal a command writes to: whether it styles, how wide it is, which
// glyph set it can show. A stream that is not a terminal gets plain text (set
// FORCE_COLOR to style it anyway); NO_COLOR drops every style.
export function terminalFor(stream, env = process.env) {
  const tty = Boolean(stream?.isTTY);
  const forced = env.FORCE_COLOR && env.FORCE_COLOR !== "0";
  let depth = 1;
  if (tty && typeof stream.getColorDepth === "function")
    depth = stream.getColorDepth(env);
  else if (forced && !env.NO_COLOR) depth = 8;
  return makeTerminal({
    tty,
    depth,
    glyphs: pickGlyphs(env),
    // Layout width: the terminal's, kept readable on a wide one.
    cols: Math.max(60, Math.min(stream?.columns || 100, 110)),
  });
}

export function makeTerminal({ tty, depth, glyphs, cols }) {
  return {
    tty,
    depth,
    styled: depth >= 4,
    glyphs,
    theme: makeTheme({ color: depth >= 4, glyphs }),
    g: glyphSets[glyphs],
    cols,
  };
}

// The colour depth to assume for output that goes through a pipe to a program
// that draws it (the status line Claude Code shows): from the environment it
// inherits, since the pipe says nothing. NO_COLOR: none.
export function inheritedDepth(env = process.env) {
  if (env.NO_COLOR) return 1;
  if (/truecolor|24bit/i.test(env.COLORTERM ?? "")) return 24;
  if (env.WT_SESSION || env.TERM_PROGRAM) return 24;
  if (/256color/i.test(env.TERM ?? "")) return 8;
  return 4;
}

// Lines of spans to text, one line per row. Trailing blanks are trimmed.
export function render(lines, term) {
  return lines
    .map((line) => {
      let out = "";
      // Neighbouring spans of one style go out under one escape.
      const runs = [];
      for (const [text, style] of line)
        if (runs.at(-1)?.[1] === style) runs.at(-1)[0] += text;
        else runs.push([text, style]);
      for (const [text, style] of runs) {
        const open = term.styled
          ? escape(term.theme.props(style), term.depth)
          : "";
        out += open ? `${open}${text}\x1b[0m` : text;
      }
      return term.styled ? out : out.replace(/ +$/, "");
    })
    .join("\n");
}

// ---- Pieces the commands share ----------------------------------------------

export const INDENT = 2;
const pad = [s(" ".repeat(INDENT))];

// A document: every line indented, and in a terminal a blank line above and
// below.
export function document(lines, term) {
  const body = lines.map((line) => (line.length ? [...pad, ...line] : line));
  return term.tty ? [[], ...body, []] : body;
}

// An error for stderr: "✗ message" in a terminal, "baton: message" otherwise.
export function errorText(message, term) {
  if (!term.styled) return `baton: ${message}`;
  return render(
    [[s(term.g.cross, "err bold"), s(" "), s(message, "text")]],
    term,
  );
}

// The width of what a document's lines may use.
export const room = (term) => term.cols - INDENT * 2;

// The Baton mark: the wordmark and slogan, or the mark and name on one line.
export function banner(term, { full = false } = {}) {
  if (!term.tty) return [];
  if (full) return [...branding(""), []];
  return [[s(term.g.baton, "brand"), s(" BATON", "brand bold")], []];
}

// "TITLE ──────── note": a section heading with its rule, the menu's.
export function heading(title, width, term, note = "") {
  const tail = note ? [s(note, "muted")] : [];
  const rule = Math.max(
    0,
    width - lineWidth([s(title)]) - 2 - (note ? lineWidth(tail) + 2 : 0),
  );
  return [
    s(title, "muted bold"),
    s("  " + term.g.corners.h.repeat(rule), "divider"),
    ...(note ? [s("  "), ...tail] : []),
  ];
}

// "label   value" with the labels in a column and a long value wrapped under
// itself; `value` is spans.
export function fact(label, value, width, labelWidth = 10, style = "muted") {
  return wrapLine(
    [s(label.padEnd(labelWidth), style), ...value],
    width,
    labelWidth,
  );
}

// A list entry: a mark, a name column and what follows, wrapped under itself.
export function entry(mark, name, value, width, nameWidth) {
  const head = [...mark, s(" "), s(name.padEnd(nameWidth), "bold")];
  const lead = lineWidth(head) + 1;
  return wrapLine([...head, s(" "), ...value], width, lead);
}

// A paragraph of one style.
export const paragraph = (text, width, style = "muted") =>
  wrapLine([s(text, style)], width);

// Outcome marks, in the menu's glyphs.
export const marks = (g) => ({
  ok: [s(g.check, "ok bold")],
  done: [s(g.check, "ok bold")],
  same: [s(g.check, "muted")],
  fail: [s(g.cross, "err bold")],
  warn: [s("!", "warn bold")],
  info: [s(g.dot, "muted")],
  skip: [s(g.ring, "muted")],
});

// The one-line answer to a command that did something: "✓ Added acct2".
export const outcome = (term, text, kind = "done") => [
  ...marks(term.g)[kind],
  s(" "),
  s(text, kind === "fail" ? "err bold" : "bold"),
];

// A command's next step, in the accent colour.
export const next = (text, width, labelWidth = 10) =>
  fact("Next", [s(text, "accent bold")], width, labelWidth);

// Shown paths: the home folder as ~ and forward slashes.
export function tildify(path, home) {
  const norm = (p) => String(p).replace(/\\/g, "/");
  const a = norm(path);
  const h = norm(home).replace(/\/$/, "");
  return a.toLowerCase() === h.toLowerCase()
    ? "~"
    : a.toLowerCase().startsWith(h.toLowerCase() + "/")
      ? "~" + a.slice(h.length)
      : a;
}

// A notice between Claude Code's own output (a baton session): "baton: text" with
// the mark in front, the key hints after the first " · " dimmed.
export function notice(line, term) {
  if (!term.styled || !line.startsWith("baton: ")) return line;
  const [head, ...hints] = line.slice("baton: ".length).split(" · ");
  const body = [
    s(term.g.baton, "brand"),
    s(" "),
    s(head, "text"),
    ...hints.flatMap((hint) => [
      s(" · ", "divider"),
      ...hint
        .split(/(Enter|Ctrl\+C|any other key|any key)/)
        .map((part, i) => s(part, i % 2 ? "accent bold" : "muted")),
    ]),
  ];
  return render([body], term);
}

export { fitLine, s, wrapLine };
