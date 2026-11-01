import { effectivePolicy, loadConfig } from "./config.js";
import { accountStates, pickStart } from "./policy.js";
import { pollHolder } from "./poll-host.js";
import { nextPollAt, readPollState } from "./poller.js";
import { listWrappers, recentSessions } from "./sessions.js";
import { loadReadings, loadRejections } from "./usage.js";

// A snapshot of everything Baton knows, read from disk in one go: what the
// CLI's status, the lead wrapper's decisions and the TUI work from. poll:
// also the usage poller's state, which baton instance polls and the next poll.
export function loadSnapshot(
  paths,
  { now = Date.now(), sessions = false, poll = false } = {},
) {
  const config = loadConfig(paths);
  const policy = effectivePolicy(config);
  const ids = config.accounts.map((a) => a.id);
  const readings = loadReadings(paths, ids);
  const rejections = loadRejections(paths, ids);
  const states = accountStates({
    accounts: config.accounts,
    readings,
    rejections,
    policy,
    now,
  });
  const snapshot = { now, paths, config, policy, readings, rejections, states };
  if (sessions) {
    snapshot.wrappers = listWrappers(paths);
    snapshot.sessions = recentSessions(paths, { now });
  }
  if (poll) {
    const state = readPollState(paths);
    const holder = pollHolder(paths, { now });
    snapshot.poll = {
      ...state,
      holder,
      nextAt: nextPollAt(state, policy, { running: !!holder, now }),
    };
  }
  return snapshot;
}

export const nextWork = (snapshot) =>
  pickStart(snapshot.states, snapshot.policy);
