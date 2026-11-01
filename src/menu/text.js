// Text for the terminal (after Pelican's menu): cleaned of control
// sequences, measured in terminal cells (wide CJK and emoji take two,
// combining marks none) and wrapped to fit. Nothing is ever cut with an
// ellipsis: what does not fit wraps, or a view leaves a less important part
// out.
const escapes =
  /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)?|[@-Z\\-_])/g;
const controls = /[\x00-\x08\x0b-\x1f\x7f-\x9f]/g;
const zeroWidth = /^[\p{Mn}\p{Me}\p{Cf}]$/u;

export function clean(text) {
  return String(text ?? "")
    .replace(/\r\n?/g, "\n")
    .replace(escapes, "")
    .replace(/\t/g, "  ")
    .replace(controls, "");
}

function wide(cp) {
  return (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0xa4cf && cp !== 0x303f) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe4f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1f64f) ||
    (cp >= 0x1f680 && cp <= 0x1f6ff) ||
    (cp >= 0x1f900 && cp <= 0x1f9ff) ||
    (cp >= 0x1fa70 && cp <= 0x1faff) ||
    (cp >= 0x20000 && cp <= 0x3fffd)
  );
}
export function charWidth(ch) {
  const cp = ch.codePointAt(0);
  if (cp < 0x20 || (cp >= 0x7f && cp < 0xa0)) return 0;
  if (zeroWidth.test(ch)) return 0;
  return wide(cp) ? 2 : 1;
}
export function width(text) {
  let cells = 0;
  for (const ch of String(text)) cells += charWidth(ch);
  return cells;
}

// Word wrap to `cells`, keeping blank lines; a word longer than a line is
// broken. `indent` prefixes continuation lines.
export function wrap(text, cells, indent = "") {
  const out = [];
  const room = Math.max(1, cells);
  for (const paragraph of clean(text).split("\n")) {
    if (!paragraph.trim()) {
      out.push("");
      continue;
    }
    let line = "";
    let used = 0;
    let first = true;
    const prefix = () => (first ? "" : indent);
    const limit = () => Math.max(1, room - width(prefix()));
    const flush = () => {
      out.push(prefix() + line);
      first = false;
      line = "";
      used = 0;
    };
    for (const word of paragraph.trim().split(/ +/)) {
      const w = width(word);
      if (used && used + 1 + w > limit()) flush();
      if (w > limit()) {
        for (const ch of word) {
          const cw = charWidth(ch);
          if (used + cw > limit()) flush();
          line += ch;
          used += cw;
        }
        continue;
      }
      line += (used ? " " : "") + word;
      used += (used ? 1 : 0) + w;
    }
    if (line) flush();
  }
  return out;
}

// Amounts for the screen.
const pad2 = (n) => String(n).padStart(2, "0");
// A time span: 45s, 42m, 2h 5m, 3d 4h. Every component carries its unit.
export function span(ms) {
  if (ms == null || !Number.isFinite(ms)) return "?";
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return m % 60 ? `${h}h ${m % 60}m` : `${h}h`;
  const d = Math.floor(h / 24);
  return h % 24 ? `${d}d ${h % 24}h` : `${d}d`;
}
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = "Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec".split(" ");
// Local wall-clock time: 15:20, or "Sat 09:00" when not today, or "Oct 30"
// when more than a week away.
export function hhmm(ms) {
  const d = new Date(ms);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}
export function when(ms, now) {
  if (ms == null) return "?";
  const d = new Date(ms);
  const today = new Date(now);
  if (d.toDateString() === today.toDateString()) return hhmm(ms);
  if (Math.abs(ms - now) < 6.5 * 864e5)
    return `${DAYS[d.getDay()]} ${hhmm(ms)}`;
  return `${MONTHS[d.getMonth()]} ${d.getDate()}`;
}
export const dayLabel = (date) => {
  const [y, m, d] = String(date).split("-").map(Number);
  return DAYS[new Date(y, m - 1, d).getDay()];
};
export const shortDate = (ms) => {
  const d = new Date(ms);
  return `${MONTHS[d.getMonth()]} ${d.getDate()}`;
};
export const pct = (n) => (n == null ? "?" : `${Math.round(n)}%`);
export const plural = (n, word, many = `${word}s`) =>
  `${n} ${n === 1 ? word : many}`;
