// (From Pelican's tests.)
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { charWidth } from "../src/menu/text.js";

// A terminal for the menu tests: a stdout that keeps what was written and
// plays it on a screen of cells (the cursor moves, line and screen erases
// and text Ink sends; colours and modes are noted, not drawn), and a stdin
// in raw mode that keys are written to. Like xterm and Windows Terminal, it
// starts with the cursor under a shell prompt (cursorRow), and switching to
// the alternate screen clears it but leaves the cursor where it was.
export class VirtualTerminal extends EventEmitter {
  constructor(
    columns = 100,
    rows = 30,
    { cursorRow = Math.floor(rows / 2) } = {},
  ) {
    super();
    this.columns = columns;
    this.rows = rows;
    this.isTTY = true;
    this.chunks = [];
    this.modes = new Map();
    this.grid = this.blank();
    for (let y = 0; y < cursorRow; y++)
      this.grid[y].splice(0, 9, ..."PS E:\\> x");
    this.x = 0;
    this.y = Math.min(cursorRow, rows - 1);
  }
  blank() {
    return Array.from({ length: this.rows }, () =>
      new Array(this.columns).fill(" "),
    );
  }
  resize(columns, rows) {
    const old = this.grid;
    this.columns = columns;
    this.rows = rows;
    this.grid = Array.from({ length: rows }, (_, y) =>
      Array.from({ length: columns }, (_, x) => old[y]?.[x] ?? " "),
    );
    this.x = Math.min(this.x, columns - 1);
    this.y = Math.min(this.y, rows - 1);
    this.emit("resize");
  }
  write(data) {
    const text = String(data);
    this.chunks.push(text);
    this.play(text);
    return true;
  }
  // What the screen shows, a line per row, without trailing spaces.
  text() {
    return this.grid.map((row) => row.join("").trimEnd()).join("\n");
  }
  newline() {
    this.x = 0;
    if (this.y < this.rows - 1) this.y++;
    else {
      this.grid.shift();
      this.grid.push(new Array(this.columns).fill(" "));
    }
  }
  csi(params, final, mark) {
    const n = (i = 0, fallback = 1) =>
      Number(params[i]) || (params[i] === "0" ? 0 : fallback);
    const row = this.grid[this.y];
    switch (final) {
      case "A":
        this.y = Math.max(0, this.y - n());
        break;
      case "B":
        this.y = Math.min(this.rows - 1, this.y + n());
        break;
      case "C":
        this.x = Math.min(this.columns - 1, this.x + n());
        break;
      case "D":
        this.x = Math.max(0, this.x - n());
        break;
      case "E":
        this.y = Math.min(this.rows - 1, this.y + n());
        this.x = 0;
        break;
      case "F":
        this.y = Math.max(0, this.y - n());
        this.x = 0;
        break;
      case "G":
        this.x = Math.min(this.columns - 1, n() - 1);
        break;
      case "H":
      case "f":
        this.y = Math.min(this.rows - 1, n(0) - 1);
        this.x = Math.min(this.columns - 1, n(1) - 1);
        break;
      case "J": {
        const how = n(0, 0);
        if (how === 2 || how === 3) this.grid.forEach((r) => r.fill(" "));
        else {
          row.fill(" ", this.x);
          for (let y = this.y + 1; y < this.rows; y++) this.grid[y].fill(" ");
        }
        break;
      }
      case "K": {
        const how = n(0, 0);
        if (how === 2) row.fill(" ");
        else if (how === 1) row.fill(" ", 0, this.x + 1);
        else row.fill(" ", this.x);
        break;
      }
      case "h":
      case "l":
        if (mark === "?")
          for (const p of params) {
            if (p === "1049" && final === "h" && !this.primary) {
              // The alternate screen: blank, the cursor where it was.
              this.primary = { grid: this.grid, x: this.x, y: this.y };
              this.grid = this.blank();
            } else if (p === "1049" && final === "l" && this.primary) {
              ({ grid: this.grid, x: this.x, y: this.y } = this.primary);
              this.primary = null;
            }
            this.modes.set(p, final === "h");
          }
        break;
      default:
        // Colours (m) and anything else change no cell.
        break;
    }
  }
  play(text) {
    for (let i = 0; i < text.length;) {
      const ch = text[i];
      if (ch === "\x1b") {
        const next = text[i + 1];
        if (next === "[") {
          let j = i + 2;
          const mark = /[?>=<]/.test(text[j]) ? text[j++] : "";
          let body = "";
          while (j < text.length && !/[@-~]/.test(text[j])) body += text[j++];
          this.csi(body.split(";"), text[j], mark);
          i = j + 1;
        } else if (next === "]") {
          let j = i + 2;
          while (
            j < text.length &&
            text[j] !== "\x07" &&
            text.slice(j, j + 2) !== "\x1b\\"
          )
            j++;
          i = text[j] === "\x07" ? j + 1 : j + 2;
        } else i += 2;
        continue;
      }
      if (ch === "\r") this.x = 0;
      else if (ch === "\n") this.newline();
      else if (ch === "\b") this.x = Math.max(0, this.x - 1);
      else {
        const cp = text.codePointAt(i);
        const glyph = String.fromCodePoint(cp);
        const w = charWidth(glyph);
        if (w > 0 && this.x < this.columns) {
          this.grid[this.y][this.x] = glyph;
          if (w === 2 && this.x + 1 < this.columns)
            this.grid[this.y][this.x + 1] = "";
          // Line wrap is off: the last column takes every character.
          this.x = Math.min(this.columns - 1, this.x + w);
        }
        i += glyph.length;
        continue;
      }
      i++;
    }
  }
}

export class RawInput extends PassThrough {
  constructor() {
    super();
    this.isTTY = true;
    this.modes = [];
  }
  setRawMode(on) {
    this.modes.push(on);
    return this;
  }
  ref() {
    return this;
  }
  unref() {
    return this;
  }
}

// Bytes of the keys a terminal sends.
export const keys = {
  up: "\x1b[A",
  down: "\x1b[B",
  right: "\x1b[C",
  left: "\x1b[D",
  enter: "\r",
  escape: "\x1b",
  tab: "\t",
  shiftTab: "\x1b[Z",
  ctrlK: "\x0b",
  ctrlC: "\x03",
  backspace: "\x7f",
  end: "\x1b[F",
  home: "\x1b[H",
  paste: (text) => `\x1b[200~${text}\x1b[201~`,
};
