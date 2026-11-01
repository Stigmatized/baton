import { basename } from "node:path";
import { readConflicts } from "../copies.js";
import { nameOf } from "../config.js";
import { ms } from "../fsutil.js";
import { burnRate, pickStart, turnCost } from "../policy.js";
import { readSessionFile, readTurnSamples } from "../sessions.js";
import { loadSnapshot } from "../state.js";
import { computeStats } from "../stats.js";

// Everything the menu shows, read from ~/.baton in one go (the same core
// functions as the CLI): the policy's snapshot with every account's state,
// where new work goes, the live lead sessions and recent ones with their
// cost estimates and hops, the last 7 days of statistics, the copy
// conflicts, and the usage poller (its state per account, which baton
// instance polls, the next poll). Sign-in status comes separately (it asks `claude auth status`).
export const recentLimit = 12;

function sessionInfo(paths, id, { now, policy, config, wrapper, hops }) {
  const start = readSessionFile(paths, id, "start.json");
  const live = readSessionFile(paths, id, "live.json");
  const turn = readSessionFile(paths, id, "turn.json");
  const end = readSessionFile(paths, id, "end.json");
  const samples = readTurnSamples(paths, id);
  const cwd = live?.cwd ?? start?.cwd ?? wrapper?.cwd ?? null;
  const lastAt =
    Math.max(
      ms(live?.at) ?? 0,
      ms(turn?.at) ?? 0,
      ms(start?.at) ?? 0,
      ms(end?.at) ?? 0,
    ) || null;
  return {
    id,
    live: !!wrapper,
    wrapperState: wrapper?.state ?? null,
    target: wrapper?.target ?? null,
    until: ms(wrapper?.until),
    account:
      wrapper?.account ??
      live?.account ??
      turn?.account ??
      start?.account ??
      null,
    cwd,
    name: (cwd && basename(cwd.replace(/[\\/]+$/, ""))) || id.slice(0, 8),
    startedAt: ms(wrapper?.startedAt) ?? ms(start?.at),
    lastAt,
    ended: !!end && (ms(end.at) ?? 0) >= (lastAt ?? 0),
    turnState: turn?.state ?? null,
    turnEvent: turn?.event ?? null,
    error: turn?.error ?? null,
    model: live?.model ?? start?.model ?? null,
    backgroundTasks: Array.isArray(turn?.backgroundTasks)
      ? turn.backgroundTasks
      : [],
    cost: turnCost(samples, policy),
    burn: burnRate(samples, policy, now),
    turns: samples.length,
    hops,
  };
}

// Sessions name their account by id; what shows is its current name.
const named = (config, x) => ({
  ...x,
  accountName: x.account ? nameOf(config, x.account) : null,
  targetName: x.target ? nameOf(config, x.target) : null,
});

export function loadMenuData(paths, { now = Date.now() } = {}) {
  const snapshot = loadSnapshot(paths, { now, sessions: true, poll: true });
  const { config, policy, states } = snapshot;
  const stats = computeStats({ paths, config, policy, now, days: 7 });
  const wrappers = new Map();
  for (const w of snapshot.wrappers) if (w.session) wrappers.set(w.session, w);
  const hopsOf = new Map(stats.sessions.map((x) => [x.id, x.hops]));
  const ids = [
    ...wrappers.keys(),
    ...snapshot.sessions.map((x) => x.id),
    ...stats.sessions.map((x) => x.id),
  ].filter((id, i, all) => all.indexOf(id) === i);
  const sessions = ids
    .map((id) =>
      sessionInfo(paths, id, {
        now,
        policy,
        config,
        wrapper: wrappers.get(id),
        hops: hopsOf.get(id) ?? [],
      }),
    )
    .map((x) => named(config, x))
    .sort(
      (a, b) =>
        Number(b.live) - Number(a.live) || (b.lastAt ?? 0) - (a.lastAt ?? 0),
    );
  const live = sessions.filter((x) => x.live);
  const recent = sessions.filter((x) => !x.live).slice(0, recentLimit);
  return {
    now,
    config,
    policy,
    states,
    next: pickStart(states, policy),
    readings: snapshot.readings,
    poll: snapshot.poll,
    sessions: [...live, ...recent],
    stats,
    conflicts: readConflicts(paths),
  };
}
