import { profileDir } from "./paths.js";

// What to say when the operator has not added an account yet.
export const NO_ACCOUNTS =
  "No accounts yet: add one with baton account add <name> (or a in the menu), then sign it in with baton login <name>.";
import { pickStart } from "./policy.js";
import { clock, duration } from "./prompts.js";
import { iso } from "./fsutil.js";

// Readable text (and the JSON shapes) for the CLI. The TUI will use the same
// view models (statusView, statsView).

const pct = (n) => (n == null ? "?" : `${Math.round(n * 10) / 10}%`);
// How times read: the CLI's clock and durations; the menu passes its own
// (24-hour times, "12m").
const TEXT_TIME = { time: clock, span: duration };
const ago = (t, now, fmt = TEXT_TIME) =>
  t == null
    ? "never"
    : now - t < 60e3
      ? "just now"
      : `${fmt.span(now - t)} ago`;

// Where a reading came from, and how old it is: "polled 12m ago" (the
// usage poller), "from session 2m ago" (a session's status line).
export function readWords(source, readAt, now, fmt = TEXT_TIME) {
  const at = typeof readAt === "string" ? Date.parse(readAt) : readAt;
  if (at == null || !Number.isFinite(at)) return "never read";
  if (source === "poll") return `polled ${ago(at, now, fmt)}`;
  if (source === "statusline") return `from session ${ago(at, now, fmt)}`;
  return `read ${ago(at, now, fmt)}`;
}

function windowView(w, now) {
  return {
    used: w.used,
    threshold: w.threshold,
    headroom: w.headroom,
    resetsAt: iso(w.resetsAt),
    readAt: iso(w.readAt),
    source: w.source ?? null,
    ...(w.label ? { limit: w.label } : {}),
    reset: w.reset,
    stale: w.stale,
    blocked: w.blocked,
    rejected: w.rejected,
    rejectedUntil: iso(w.rejectedUntil),
    text:
      w.used === null
        ? w.reset
          ? `reset${w.stale ? " (reading older than the window)" : ""}, last ${readWords(w.source, w.readAt, now)}`
          : "not measured yet"
        : `${pct(w.used)} of ${w.threshold}%` +
          (w.label ? ` (${w.label}'s own limit)` : "") +
          (w.resetsAt
            ? ` · resets ${clock(w.resetsAt, now)} (in ${duration(w.resetsAt - now)})`
            : "") +
          ` · ${readWords(w.source, w.readAt, now)}`,
  };
}

// The poller's last word on an account, in words.
export function pollWords(entry, now, fmt = TEXT_TIME) {
  if (!entry?.status) return "not polled yet";
  const at = Date.parse(entry.at);
  const when = ago(Number.isFinite(at) ? at : null, now, fmt);
  const until = Date.parse(entry.backoffUntil ?? "");
  const reason = entry.reason ? `: ${entry.reason}` : "";
  switch (entry.status) {
    case "ok":
      return `polled ${when}`;
    case "unavailable":
      return `usage unavailable${reason} (${when})`;
    case "rate-limited":
      return `usage endpoint rate limited (${when}); asks again ${Number.isFinite(until) ? `${fmt.time(until, now)} (in ${fmt.span(until - now)})` : "later"}`;
    case "signed-out":
      return "signed out: not polled";
    case "timeout":
      return `poll timed out (${when})`;
    default:
      return `poll ${entry.status}${reason} (${when})`;
  }
}

// The plan's meters beyond the two windows (a model's own weekly limit),
// from the last poll, that have not reset.
export function otherLimits(reading, now) {
  if (!Array.isArray(reading?.limits)) return [];
  return reading.limits.filter((r) => {
    if (r.kind === "session" || r.kind === "weekly_all") return false;
    const resets = Date.parse(r.resetsAt ?? "");
    return !Number.isFinite(resets) || resets > now;
  });
}
export const NO_POLLER =
  "no baton running: usage is checked while baton or baton view runs";
const KINDS = { menu: "the menu", start: "baton" };

// The usage poll in one line: which baton instance polls, the schedule, the
// next run.
export function pollLine(snapshot) {
  const { now, poll } = snapshot;
  if (!poll) return null;
  const every = snapshot.policy.usagePollMinutes;
  if (!poll.holder) return `Usage poll: ${NO_POLLER}.`;
  const next = poll.nextAt
    ? `next ${clock(poll.nextAt, now)} (in ${duration(poll.nextAt - now)})`
    : "only on request (usagePollMinutes 0)";
  const last = poll.lastRunAt
    ? `last ${clock(Date.parse(poll.lastRunAt), now)}`
    : "none yet";
  const running = poll.running
    ? ` · polling ${snapshot.states.find((s) => s.id === poll.running.account)?.name ?? poll.running.account} now`
    : "";
  const by = `by ${KINDS[poll.holder.kind] ?? poll.holder.kind} (pid ${poll.holder.pid})`;
  return `Usage poll: ${by}, ${every > 0 ? `every ${every} min, ` : ""}${next}; ${last}${running}`;
}

const sessionsOn = (snapshot, name) => {
  const out = [];
  const seen = new Set();
  for (const w of snapshot.wrappers ?? [])
    if (w.account === name && w.session) {
      out.push({ id: w.session, by: "baton", state: w.state, pid: w.pid });
      seen.add(w.session);
    }
  for (const s of snapshot.sessions ?? [])
    if (s.account === name && !seen.has(s.id))
      out.push({ id: s.id, by: "seen", state: s.state, at: iso(s.at) });
  return out;
};

export function statusView(snapshot) {
  const { now, states, policy } = snapshot;
  const next = pickStart(states, policy);
  const label = (id) => states.find((s) => s.id === id)?.name ?? id;
  return {
    now: iso(now),
    mode: policy.mode,
    accounts: states.map((s, i) => ({
      order: i + 1,
      id: s.id,
      name: s.name,
      mark: s.mark,
      profile: profileDir(snapshot.paths, s.id),
      five_hour: windowView(s.windows.five_hour, now),
      seven_day: windowView(s.windows.seven_day, now),
      blocked: s.blocked,
      blockedBy: s.blockedBy,
      availableAt: s.availableKnown ? iso(s.availableAt) : null,
      availableKnown: s.availableKnown,
      urgency: Math.round(s.urgency * 100) / 100,
      sessions: sessionsOn(snapshot, s.id),
      ...(snapshot.poll
        ? {
            poll: snapshot.poll.accounts[s.id] ?? null,
            limits: otherLimits(snapshot.readings?.[s.id], now),
            extraUsage: snapshot.readings?.[s.id]?.extraUsage ?? null,
          }
        : {}),
    })),
    ...(snapshot.poll
      ? {
          poll: {
            holder: snapshot.poll.holder,
            everyMinutes: policy.usagePollMinutes,
            lastRunAt: snapshot.poll.lastRunAt,
            nextAt: iso(snapshot.poll.nextAt),
            running: snapshot.poll.running,
          },
        }
      : {}),
    // Names for reading, ids alongside.
    next: next.account
      ? { account: label(next.account), id: next.account, reason: next.reason }
      : {
          account: null,
          allBlocked: true,
          earliest: next.earliest ? label(next.earliest) : null,
          earliestId: next.earliest,
          availableAt: next.availableKnown ? iso(next.availableAt) : null,
          availableKnown: next.availableKnown,
        },
  };
}
