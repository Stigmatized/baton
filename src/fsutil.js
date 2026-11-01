import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { basename, dirname, join } from "node:path";
import { constants, setPriority } from "node:os";

// Small synchronous file helpers. State files are replaced atomically (a
// temporary file in the same folder, then a rename), so a reader never sees
// half a file; history files are append-only JSON lines.

const sleeper = new Int32Array(new SharedArrayBuffer(4));
export const sleepSync = (ms) => Atomics.wait(sleeper, 0, 0, ms);

export function readJson(file, fallback = null) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

export function readText(file, fallback = null) {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return fallback;
  }
}

export function writeFileAtomic(file, text) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = join(
    dirname(file),
    `.${basename(file)}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`,
  );
  writeFileSync(tmp, text);
  // Windows refuses a rename over a file another process has open without
  // delete sharing (a virus scanner, an editor); retry briefly.
  for (let attempt = 0; ; attempt++) {
    try {
      renameSync(tmp, file);
      return;
    } catch (error) {
      if (attempt >= 6 || !["EPERM", "EACCES", "EBUSY"].includes(error.code)) {
        rmSync(tmp, { force: true });
        throw error;
      }
      sleepSync(5 * (attempt + 1));
    }
  }
}

export const writeJsonAtomic = (file, value) =>
  writeFileAtomic(file, JSON.stringify(value, null, 2) + "\n");

export function appendJsonLine(file, value) {
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, JSON.stringify(value) + "\n");
}

export function readJsonLines(file) {
  const text = readText(file, "");
  const out = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      // A torn last line (a writer that died mid-append) is skipped.
    }
  }
  return out;
}

// A child at a low priority (Windows: below normal), so that work in the
// background never competes with the session in front of the operator.
export function lowerPriority(pid) {
  try {
    if (pid) setPriority(pid, constants.priority.PRIORITY_BELOW_NORMAL);
  } catch {
    // not allowed or already gone: it runs at its normal priority
  }
}

// Whether a process is alive (signal 0 only checks).
export function isAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

export const iso = (ms) => (ms == null ? null : new Date(ms).toISOString());
export function ms(value) {
  if (value == null || value === "") return null;
  const n = typeof value === "number" ? value : Date.parse(value);
  return Number.isFinite(n) ? n : null;
}
