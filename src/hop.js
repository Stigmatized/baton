import { findAccount, nameOf } from "./config.js";
import { readJson } from "./fsutil.js";
import { pickStart } from "./policy.js";
import {
  listWrappers,
  lockHolder,
  readSessionFile,
  requestHop,
  validId,
  wrapperFile,
  wrapperSessionFile,
} from "./sessions.js";
import { loadSnapshot } from "./state.js";

// `baton hop` and the /hop command: ask the lead wrapper running a session to
// move it at the end of the current turn (now, if it is between turns).
// The session comes from the argument, else the wrapper of the calling
// process (BATON_WRAPPER, set for everything claude runs), else Claude Code's
// CLAUDE_CODE_SESSION_ID, else the only session running under baton.

export class HopError extends Error {}

export function resolveSession(paths, { session, env = process.env }) {
  if (session) {
    if (!validId(session)) throw new HopError(`Not a session id: ${session}`);
    return session;
  }
  if (validId(env.BATON_WRAPPER)) {
    const mapped = readJson(wrapperSessionFile(paths, env.BATON_WRAPPER));
    if (validId(mapped?.session)) return mapped.session;
  }
  if (validId(env.CLAUDE_CODE_SESSION_ID)) return env.CLAUDE_CODE_SESSION_ID;
  const running = listWrappers(paths).filter((w) => w.session);
  if (running.length === 1) return running[0].session;
  if (!running.length)
    throw new HopError(
      "/hop and baton hop only work in sessions started with baton, and none is running.",
    );
  throw new HopError(
    `Several conversations run under baton; name one: ${running.map((w) => w.session).join(", ")}`,
  );
}

// to: an account's name (or id); with toBy: "id", its id (the menu). The
// request carries the id; the result names both accounts by their current
// names.
export function hop(
  paths,
  {
    session,
    to = null,
    toBy = "name",
    env = process.env,
    by = "cli",
    now = Date.now(),
  },
) {
  const id = resolveSession(paths, { session, env });
  const holder = lockHolder(paths, id);
  if (!holder)
    throw new HopError(
      `/hop and baton hop only work in sessions started with baton; this conversation (${id}) was not, so Baton leaves it alone.`,
    );
  const wrapper = readJson(wrapperFile(paths, holder.wrapper));
  const from = wrapper?.account ?? holder.account;
  const snapshot = loadSnapshot(paths, { now });
  const label = (x) => nameOf(snapshot.config, x);
  let target = null;
  if (to) {
    const account = findAccount(snapshot.config, to, { by: toBy });
    if (!account) throw new HopError(`No account named ${to}.`);
    target = account.id;
  }
  if (target && target === from)
    throw new HopError(`The conversation already runs on ${label(from)}.`);
  const predicted =
    target ??
    pickStart(snapshot.states, snapshot.policy, { exclude: [from] }).account;
  if (!predicted)
    throw new HopError(
      `Every other account is at its limit; ${id} stays on ${label(from)}.`,
    );
  requestHop(paths, id, { to: target, by, at: now });
  const turn = readSessionFile(paths, id, "turn.json");
  return {
    session: id,
    from: label(from),
    to: label(predicted),
    fromId: from,
    toId: predicted,
    explicit: !!target,
    between: turn?.state !== "running",
  };
}
