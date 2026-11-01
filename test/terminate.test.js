import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { join } from "node:path";
import { readJsonLines } from "../src/fsutil.js";
import {
  TERMINAL_RESET,
  endClaude,
  restoreTerminal,
  typeConsoleKeys,
  waitExit,
} from "../src/terminate.js";
import { Collect, RAW_READER, tempHome, until } from "./helpers.js";

const sleeper = (extra = "") =>
  spawn(process.execPath, ["-e", `${extra};setInterval(()=>{},1000)`], {
    stdio: "ignore",
  });

function consoleAvailable() {
  if (process.platform !== "win32") return false;
  try {
    closeSync(openSync("\\\\.\\CONIN$", "r+"));
    return true;
  } catch {
    return false;
  }
}

test("kill ends the process at once", async () => {
  const child = sleeper();
  const r = await endClaude(child, { method: "kill" });
  assert.deepEqual([r.method, r.forced], ["kill", true]);
  assert.notEqual(child.exitCode ?? child.signalCode, null);
});

test("keys that do not end claude fall back to ending its process tree, then restore the terminal", async () => {
  const child = sleeper();
  const typed = [];
  let restored = 0;
  const r = await endClaude(child, {
    method: "keys",
    typeKeys: async (pid, codes) => {
      typed.push(codes);
      return "ok";
    },
    rounds: 2,
    roundWaitMs: 100,
    restore: () => restored++,
  });
  assert.deepEqual(typed, [
    [3, 3],
    [3, 3],
  ]);
  assert.deepEqual([r.method, r.forced, restored], ["keys", true, 1]);
  assert.ok(await waitExit(child, 1000));
});

test("keys stop as soon as claude has exited", async () => {
  const child = sleeper();
  let rounds = 0;
  const r = await endClaude(child, {
    method: "keys",
    typeKeys: async () => {
      rounds++;
      child.kill();
      return "ok";
    },
    roundWaitMs: 2000,
  });
  assert.deepEqual([r.forced, r.rounds, rounds], [false, 1, 1]);
});

test(
  "SIGTERM lets claude shut down by itself",
  {
    skip:
      process.platform === "win32" && "no SIGTERM to one process on Windows",
  },
  async () => {
    const child = sleeper("process.on('SIGTERM',()=>process.exit(143))");
    await new Promise((r) => setTimeout(r, 200));
    const r = await endClaude(child, { method: "signal" });
    assert.deepEqual(
      [r.method, r.forced, child.exitCode],
      ["signal", false, 143],
    );
  },
);

test("restoring the terminal writes the reset sequence only to a terminal", () => {
  const out = new Collect();
  restoreTerminal({ output: out, input: {} });
  assert.equal(out.text, "");
  out.isTTY = true;
  restoreTerminal({ output: out, input: {} });
  assert.equal(out.text, TERMINAL_RESET);
});

test(
  "two Ctrl+C typed into the console arrive as keys at a raw-mode reader",
  { skip: !consoleAvailable() && "needs a Windows console" },
  async (t) => {
    const { root } = tempHome(t);
    const log = join(root, "reader.jsonl");
    const reader = spawn(process.execPath, [RAW_READER, log, "15000"], {
      stdio: "ignore",
    });
    const exited = new Promise((r) => reader.once("exit", r));
    const first = await until(() => readJsonLines(log)[0]);
    if (first.error) {
      reader.kill();
      t.skip(`the console cannot be read here (${first.error})`);
      return;
    }
    const started = Date.now();
    assert.equal(
      await typeConsoleKeys(process.pid, [3, 3], { delayMs: 200 }),
      "ok",
    );
    assert.equal(await exited, 0);
    t.diagnostic(`keys typed and read in ${Date.now() - started} ms`);
    const chunks = readJsonLines(log)
      .filter((e) => "data" in e)
      .map((e) => e.data);
    assert.deepEqual(chunks, ["\x03", "\x03"], "two separate key presses");
  },
);
