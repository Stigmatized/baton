import { WINDOW_LABEL } from "./policy.js";

// The words Baton uses: the first prompt of a resumed conversation and the
// one-line notices. Pure; times are formatted in local time.

export function clock(ms, now = Date.now()) {
  if (ms == null) return "an unknown time";
  const d = new Date(ms);
  const time = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const sameDay = new Date(now).toDateString() === d.toDateString();
  return sameDay
    ? time
    : `${d.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" })} ${time}`;
}

export function duration(msLeft) {
  if (msLeft == null) return "unknown";
  const s = Math.max(0, Math.round(msLeft / 1000));
  if (s < 60) return `${s} s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h} h ${m % 60} min`;
  return `${Math.floor(h / 24)} d ${h % 24} h`;
}

const limitName = (window) => `${WINDOW_LABEL[window] ?? "usage"} limit`;

// Why the conversation moved, in one clause.
export function hopReason({ reason, from, window, until, now }) {
  switch (reason) {
    case "refusal":
      return `${from} reached its ${limitName(window)}${until ? ` (resets ${clock(until, now)})` : ""}`;
    case "planned":
      return `${from} was about to reach its ${limitName(window)} (planned move between turns)`;
    case "compaction":
      return `the conversation was just compacted and ${from} is close to its limits (rebalance)`;
    case "manual":
      return "the operator asked for it";
    case "all-blocked-wait":
    case "available":
      return `every account was at its limit; Baton waited until one was available`;
    case "reblocked":
      return `the accounts kept refusing right after resuming; Baton backed off before trying again`;
    default:
      return "of a usage limit";
  }
}

export function continuePrompt({
  from,
  to,
  reason,
  window,
  until,
  now = Date.now(),
}) {
  return [
    `[Baton] This conversation was moved from account ${from} to account ${to} because ${hopReason({ reason, from, window, until, now })}.`,
    "Carry on exactly where you stopped.",
    "If a workflow run was interrupted, relaunch it the same way (with resumeFromRunId, or the same script) so its finished agents replay from their saved results instead of running again.",
    "Background agents and background shells that were running before the move have ended; restart the ones that are still needed.",
  ].join(" ");
}

// When the operator chose to stay on a limited account: the prompt meets the
// limit and Claude Code's own wait-at-limit takes over.
export function stayPrompt({ account, window, until, now = Date.now() }) {
  return [
    `[Baton] Account ${account} reached its ${limitName(window)}${until ? ` (resets ${clock(until, now)})` : ""}; the operator chose to stay on it instead of moving the conversation.`,
    "Carry on exactly where you stopped once the limit allows.",
  ].join(" ");
}

export function hopLine({ from, to, reason, window, until, now, seconds }) {
  const why = hopReason({ reason, from, window, until, now });
  const tail =
    seconds == null
      ? ""
      : ` in ${seconds} s · Enter: now · any other key: stay on ${from} · Ctrl+C: quit`;
  return `baton: ${why}; moving this conversation to ${to}${tail}`;
}

export function waitLine({ total, to, window, at, now, reason }) {
  const lead =
    reason === "reblocked"
      ? "baton: accounts refused again right after resuming; waiting before the next try"
      : `baton: all ${total} accounts at limit; ${to} is first back`;
  const what = window
    ? `, its ${WINDOW_LABEL[window]} window resets at ${clock(at, now)}`
    : ` at ${clock(at, now)}`;
  return `${lead}${what} (in ${duration(at - now)}); resuming there then · any key: stay here · Ctrl+C: quit`;
}
