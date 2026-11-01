import { PassThrough } from "node:stream";
import { StringDecoder } from "node:string_decoder";

// (From Pelican's menu.) What reaches the menu from the terminal is keys,
// pastes, and sometimes the terminal's own replies: focus in and out, cursor
// position reports, device attributes and status, mode and window reports,
// mouse reports, and string replies (OSC, DCS, APC, PM, SOS) ended by BEL or
// ST. None of them is a key; the filter removes them before Ink reads the
// input.
const csiReply = new RegExp(
  [
    "\\x1b\\[[IO]",
    "\\x1b\\[\\d+;\\d+R",
    "\\x1b\\[[?>=][\\d;]*c",
    "\\x1b\\[\\d*n",
    "\\x1b\\[\\??[\\d;]+\\$y",
    "\\x1b\\[\\?\\d+u",
    "\\x1b\\[\\d+(?:;\\d+)*t",
    "\\x1b\\[<\\d+;\\d+;\\d+[Mm]",
  ].join("|"),
  "g",
);
const stringReply = /\x1b[\]P_^X][\s\S]*?(?:\x07|\x1b\\)/g;
const stringStart = /\x1b[\]P_^X]/;
const partialTail = /\x1b(?:\[[\x30-\x3f]*[\x20-\x2f]*)?$/;

export const holdMs = { escape: 25, string: 150 };

export function createReplyFilter(onMouse = () => {}) {
  let held = "";
  let pasting = false;
  return {
    push(chunk) {
      let text = (held + String(chunk ?? ""))
        .replace(stringReply, "")
        .replace(
          /\x1b\[(200~|201~|<(\d+);(\d+);(\d+)([Mm]))/g,
          (raw, report, code, col, row, end) => {
            if (report === "200~" || report === "201~") {
              pasting = report === "200~";
              return raw;
            }
            if (!pasting) {
              const bits = Number(code);
              onMouse({
                x: Number(col) - 1,
                y: Number(row) - 1,
                button: bits & 3,
                kind:
                  bits & 64
                    ? "wheel"
                    : end === "m"
                      ? "release"
                      : bits & 32
                        ? "move"
                        : "press",
                delta: bits & 64 ? (bits & 1 ? 3 : -3) : 0,
              });
            }
            return "";
          },
        )
        .replace(csiReply, "");
      held = "";
      const start = text.search(stringStart);
      if (start >= 0) {
        held = text.slice(start);
        text = text.slice(0, start);
      } else {
        const tail = partialTail.exec(text);
        if (tail) {
          held = tail[0];
          text = text.slice(0, tail.index);
        }
      }
      return text;
    },
    flush() {
      const out = stringStart.test(held.slice(0, 2)) ? held.slice(2) : held;
      held = "";
      return out;
    },
    get pending() {
      return held !== "";
    },
    get wait() {
      return stringStart.test(held.slice(0, 2)) ? holdMs.string : holdMs.escape;
    },
  };
}

// The terminal's input as Ink reads it, without the replies: a stream that
// passes raw mode and ref/unref on to the real one. close() lets go of it
// (the menu closes it while `claude auth login` has the terminal).
export class TerminalInput extends PassThrough {
  constructor(source, { onMouse } = {}) {
    super();
    this.source = source;
    this.isTTY = Boolean(source.isTTY);
    this.filter = createReplyFilter(onMouse);
    this.decoder = new StringDecoder("utf8");
    this.timer = null;
    this.onData = (data) =>
      this.take(typeof data === "string" ? data : this.decoder.write(data));
    source.on("data", this.onData);
    source.resume?.();
  }
  take(text) {
    clearTimeout(this.timer);
    this.timer = null;
    const keys = this.filter.push(text);
    if (keys) this.write(keys);
    if (this.filter.pending)
      this.timer = setTimeout(() => {
        this.timer = null;
        const rest = this.filter.flush();
        if (rest && !this.writableEnded) this.write(rest);
      }, this.filter.wait);
  }
  setRawMode(on) {
    this.source.setRawMode?.(on);
    return this;
  }
  ref() {
    this.source.ref?.();
    return this;
  }
  unref() {
    this.source.unref?.();
    return this;
  }
  close() {
    clearTimeout(this.timer);
    this.source.off?.("data", this.onData);
    this.source.pause?.();
    this.end();
  }
}
