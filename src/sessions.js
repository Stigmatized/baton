import {
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
  mkdirSync,
} from "node:fs";
import { join } from "node:path";
import { ID_RE } from "./paths.js";
import {
  appendJsonLine,
  iso,
  isAlive,
  ms,
  readJson,
  readJsonLines,
  writeJsonAtomic,
} from "./fsutil.js";

// Per-session state, written by the hooks, the status line, `baton hop` and
// the lead wrapper. Every file has one kind of writer, so a plain atomic
// replace is enough:
//
// sessions/<id>/start.json   SessionStart: { at, source, account, cwd, transcriptPath, model, wrapper }
// sessions/<id>/turn.json    UserPromptSubmit / Stop / StopFailure:
//                            { at, state: running|idle, event, account, permissionMode,
//                              error, window, until, message, backgroundTasks }
// sessions/<id>/live.json    status line: { at, account, model, effort, cwd, reading }
// sessions/<id>/compact.json SessionStart source=compact: { at }
// sessions/<id>/end.json     SessionEnd: { at, reason }
// sessions/<id>/hop.json     baton hop / the /hop command: { at, to, by }
// sessions/<id>/lock.json    the lead wrapper holding the session: { pid, wrapper, at, account }
// sessions/<id>/turns.jsonl  one line per turn end with the session's reading (cost estimates)
// wrappers/<wrapper>.json    a running lead wrapper: { pid, wrapper, account, session, startedAt, cwd, state }
// wrappers/<wrapper>.session.json   SessionStart in a process the wrapper started: { session, at, source }

export const validId = (id) => typeof id === "string" && ID_RE.test(id);

export function sessionDir(paths, id) {
  if (!validId(id)) throw new Error(`Not a session id: ${id}`);
  return join(paths.sessions, id);
}

const file = (paths, id, name) => join(sessionDir(paths, id), name);

export const readSessionFile = (paths, id, name) =>
  validId(id) ? readJson(file(paths, id, name)) : null;

export function writeSessionFile(paths, id, name, value) {
  writeJsonAtomic(file(paths, id, name), value);
}

export function appendTurnSample(paths, id, sample) {
  appendJsonLine(file(paths, id, "turns.jsonl"), sample);
}

export const readTurnSamples = (paths, id) =>
  validId(id) ? readJsonLines(file(paths, id, "turns.jsonl")) : [];

export function requestHop(
  paths,
  id,
  { to = null, by = "cli", at = Date.now() } = {},
) {
  writeSessionFile(paths, id, "hop.json", { at: iso(at), to, by });
}

// The per-session lock: one conversation runs in one process at a time.
// Exclusive create; a lock whose process is gone is taken over.
export function acquireLock(paths, id, owner) {
  const target = file(paths, id, "lock.json");
  mkdirSync(sessionDir(paths, id), { recursive: true });
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      writeFileSync(target, JSON.stringify(owner) + "\n", { flag: "wx" });
      return { ok: true };
    } catch (error) {
      if (error.code !== "EEXIST") return { ok: false, error: error.message };
      const holder = readJson(target);
      if (holder && holder.wrapper === owner.wrapper) return { ok: true };
      if (holder && isAlive(holder.pid)) return { ok: false, holder };
      rmSync(target, { force: true });
    }
  }
  return { ok: false, error: "could not take the lock" };
}

export function releaseLock(paths, id, wrapper) {
  if (!validId(id)) return;
  const target = file(paths, id, "lock.json");
  const holder = readJson(target);
  if (holder?.wrapper === wrapper) rmSync(target, { force: true });
}

export function lockHolder(paths, id) {
  const holder = readSessionFile(paths, id, "lock.json");
  return holder && isAlive(holder.pid) ? holder : null;
}

// The lead wrappers' registry.
export const wrapperFile = (paths, wrapper) =>
  join(paths.wrappers, `${wrapper}.json`);
export const wrapperSessionFile = (paths, wrapper) =>
  join(paths.wrappers, `${wrapper}.session.json`);

export function listWrappers(paths) {
  let names = [];
  try {
    names = readdirSync(paths.wrappers);
  } catch {
    return [];
  }
  const out = [];
  for (const name of names) {
    if (!name.endsWith(".json") || name.endsWith(".session.json")) continue;
    const value = readJson(join(paths.wrappers, name));
    if (value && isAlive(value.pid)) out.push(value);
  }
  return out;
}

export function removeWrapper(paths, wrapper) {
  rmSync(wrapperFile(paths, wrapper), { force: true });
  rmSync(wrapperSessionFile(paths, wrapper), { force: true });
}

// Sessions seen recently (by any hook or the status line) that have not
// ended: { id, account, at, wrapper, cwd }.
export function recentSessions(
  paths,
  { now = Date.now(), withinMs = 6 * 3600e3 } = {},
) {
  let ids = [];
  try {
    ids = readdirSync(paths.sessions);
  } catch {
    return [];
  }
  const out = [];
  for (const id of ids) {
    if (!validId(id)) continue;
    let mtime = 0;
    try {
      mtime = statSync(join(paths.sessions, id)).mtimeMs;
    } catch {
      continue;
    }
    // Every write is a rename into the folder, so its time is the last activity.
    if (now - mtime > withinMs) continue;
    const live = readSessionFile(paths, id, "live.json");
    const turn = readSessionFile(paths, id, "turn.json");
    const start = readSessionFile(paths, id, "start.json");
    const end = readSessionFile(paths, id, "end.json");
    const at = Math.max(
      ms(live?.at) ?? 0,
      ms(turn?.at) ?? 0,
      ms(start?.at) ?? 0,
      mtime,
    );
    if (now - at > withinMs) continue;
    if (end && (ms(end.at) ?? 0) >= at - 1000) continue;
    out.push({
      id,
      account: live?.account ?? turn?.account ?? start?.account ?? null,
      at,
      wrapper: start?.wrapper ?? null,
      cwd: live?.cwd ?? start?.cwd ?? null,
      state: turn?.state ?? null,
    });
  }
  return out.sort((a, b) => b.at - a.at);
}

// Forgets sessions not seen for `days` (their folders hold only Baton's own
// small files). The history keeps their events.
export function pruneSessions(paths, { now = Date.now(), days = 30 } = {}) {
  let ids = [];
  try {
    ids = readdirSync(paths.sessions);
  } catch {
    return 0;
  }
  let removed = 0;
  for (const id of ids) {
    if (!validId(id)) continue;
    const dir = join(paths.sessions, id);
    try {
      if (now - statSync(dir).mtimeMs < days * 864e5) continue;
      if (lockHolder(paths, id)) continue;
      rmSync(dir, { recursive: true, force: true });
      removed++;
    } catch {
      // in use or gone
    }
  }
  return removed;
}
