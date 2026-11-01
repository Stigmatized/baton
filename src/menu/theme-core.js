// The palette, glyph sets and style words of the menu, without React: the
// plain commands and the status line draw with them too (theme.js adds the
// Ink context).

// The menu's look (after Pelican's): one palette of roles in the terminal's
// own ANSI colours (it follows a light or dark scheme; NO_COLOR keeps bold
// and inverse and drops every colour), and two glyph sets: "rich" for
// terminals with modern fonts (Windows Terminal, VS Code, mintty, macOS and
// Linux terminals), "plain" for the classic Windows console host.
// BATON_GLYPHS=rich|plain overrides the guess.
export const roles = {
  accent: "#d7ac78",
  brand: "#e4bc89",
  baton: "#d7ac78",
  ok: "#92ae99",
  warn: "#d7ac78",
  err: "#cf8b82",
  info: "#b2b7bf",
  muted: "#7e858e",
  divider: "#343a43",
  hot: "#b2b7bf",
  surface: "#181b20",
  background: "#121519",
  text: "#d6d8dc",
};
const colours = new Set([
  "black",
  "red",
  "green",
  "yellow",
  "blue",
  "magenta",
  "cyan",
  "white",
  "gray",
  "grey",
  "redBright",
  "greenBright",
  "yellowBright",
  "blueBright",
  "magentaBright",
  "cyanBright",
  "whiteBright",
]);

export const glyphSets = {
  rich: {
    spinner: ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"],
    ticks: ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"],
    bars: ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"],
    full: "━",
    empty: "─",
    limit: "┃",
    dot: "●",
    ring: "○",
    diamond: "◆",
    check: "✓",
    cross: "✗",
    blocked: "⊘",
    preferred: "★",
    normal: "·",
    lastResort: "▿",
    baton: "╺━╸",
    link: "━",
    bullet: "•",
    arrow: "›",
    up: "↑",
    down: "↓",
    left: "←",
    right: "→",
    enter: "⏎",
    sep: "·",
    open: "▾",
    closed: "▸",
    more: "+",
    less: "-",
    border: "round",
    corners: { tl: "╭", tr: "╮", bl: "╰", br: "╯", h: "─", v: "│" },
  },
  plain: {
    spinner: ["|", "/", "-", "\\"],
    ticks: ["_", ".", ":", "-", "=", "+", "*", "#"],
    bars: ["▄", "█"],
    full: "█",
    empty: "░",
    limit: "|",
    dot: "*",
    ring: "o",
    diamond: "?",
    check: "+",
    cross: "x",
    blocked: "x",
    preferred: "*",
    normal: ".",
    lastResort: "v",
    baton: "=#=",
    link: "-",
    bullet: "*",
    arrow: ">",
    up: "↑",
    down: "↓",
    left: "←",
    right: "→",
    enter: "Enter",
    sep: "·",
    open: "v",
    closed: ">",
    more: "+",
    less: "-",
    border: "single",
    corners: { tl: "┌", tr: "┐", bl: "└", br: "┘", h: "─", v: "│" },
  },
};

export function pickGlyphs(env = process.env, platform = process.platform) {
  const forced = String(env.BATON_GLYPHS ?? "").toLowerCase();
  if (forced === "rich" || forced === "plain") return forced;
  if (platform !== "win32") return "rich";
  if (
    env.WT_SESSION ||
    env.TERM_PROGRAM ||
    env.ConEmuANSI === "ON" ||
    /xterm|mintty|alacritty|wezterm|kitty/i.test(env.TERM ?? "")
  )
    return "rich";
  return "plain";
}

function textProps(style, color) {
  const props = {};
  let tone = null;
  let dim = false;
  for (const word of String(style ?? "").split(" ")) {
    if (!word) continue;
    if (word === "bold") props.bold = true;
    else if (word === "italic") props.italic = true;
    else if (word === "underline") props.underline = true;
    else if (word === "inverse") props.inverse = true;
    else if (word === "label") {
      if (color) props.backgroundColor = "#20252c";
      else props.italic = true;
      tone = roles.muted;
    } else if (word === "dim") dim = true;
    else if (word === "selected") {
      // A solid accent bar, bright bold text (black, bold, reads as grey
      // in terminals that show bold as bright); NO_COLOR: inverse and bold.
      if (color) {
        props.color = "#f0d5b3";
        props.backgroundColor = "#35302a";
      } else props.inverse = true;
      props.bold = true;
      tone = "selected";
    } else if (word.startsWith("on-") && word.slice(3) in roles) {
      if (color) {
        props.backgroundColor = roles[word.slice(3)];
        props.color = word === "on-err" ? "whiteBright" : "black";
      } else props.inverse = true;
      tone = "selected";
    } else if (word in roles) tone = tone === "selected" ? tone : roles[word];
    else if (colours.has(word) || /^#[\da-f]{6}$/i.test(word))
      tone = tone === "selected" ? tone : word;
  }
  if (color && tone && tone !== "selected") props.color = tone;
  // A selected part is never dim (NO_COLOR: inverse and bold only).
  if (dim && tone !== "selected") {
    if (color && !props.color) props.color = roles.muted;
    else if (!props.backgroundColor) props.dimColor = true;
  }
  return props;
}

export function makeTheme({ color = true, glyphs = "rich" } = {}) {
  const g = glyphSets[glyphs] ?? glyphSets.rich;
  const cache = new Map();
  return {
    color,
    glyphs,
    g,
    props(style = "") {
      let p = cache.get(style);
      if (!p) cache.set(style, (p = textProps(style, color)));
      return p;
    },
    tone: (role) => (color ? (roles[role] ?? role) : undefined),
  };
}
