// Reads the console in raw mode (as Claude Code does) and logs every chunk
// it receives as JSON lines to argv[2]; exits after two Ctrl+C (code 0) or
// after argv[3] ms (code 2).
import { appendFileSync, openSync, writeFileSync } from "node:fs";
import tty from "node:tty";

const log = process.argv[2];
writeFileSync(log, "");
const write = (entry) => appendFileSync(log, JSON.stringify(entry) + "\n");
let input;
try {
  input = process.stdin.isTTY
    ? process.stdin
    : new tty.ReadStream(openSync("\\\\.\\CONIN$", "r+"));
  input.setRawMode(true);
} catch (error) {
  write({ error: error.code ?? error.message });
  process.exit(3);
}
write({ ready: true });
let ctrlC = 0;
input.on("data", (chunk) => {
  const text = chunk.toString("latin1");
  write({ data: text });
  for (const ch of text) if (ch === "\x03") ctrlC++;
  if (ctrlC >= 2) {
    input.setRawMode(false);
    process.exit(0);
  }
});
process.on("SIGINT", () => write({ signal: "SIGINT" }));
setTimeout(() => process.exit(2), Number(process.argv[3] ?? 10000));
