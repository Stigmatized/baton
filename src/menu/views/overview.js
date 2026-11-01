import { fitLine, s, spread, wrapLine } from "../lines.js";
import { accounts, liveSessions, nameOf, signedOut } from "../state.js";
import { sessionIcon } from "../tree.js";
import { plural, span, when } from "../text.js";
import { glyphsOf } from "../theme.js";
import { reasonWords, sectionRule } from "./common.js";

export function pollWhen(state) {
  const poll = state.data?.poll;
  if (!poll?.holder)
    return [s("Usage updates while Baton is running", "muted")];
  if (poll.running) return [s("Refreshing usage", "accent")];
  if (!poll.nextAt) return [s("Refresh on request", "muted")];
  return [
    s(
      "Usage updates every " +
        state.data.policy.usagePollMinutes +
        "m  ·  next " +
        when(poll.nextAt, state.now),
      "muted",
    ),
  ];
}
function linked(line, id, width) {
  return Object.assign(line, { targets: [{ x: 0, width, select: id }] });
}
function meter(window, g) {
  const used = window.used;
  const fill = used == null ? 0 : Math.min(3, Math.round((used / 100) * 3));
  const tone = used >= window.threshold ? "err" : "accent";
  return [
    s(g.full.repeat(fill), tone),
    s(g.empty.repeat(3 - fill), "muted"),
    s(
      (used == null ? " -" : Math.round(used) + "%").padStart(5),
      used >= window.threshold ? "err" : "text",
    ),
  ];
}
export function overviewBody(state, width) {
  const data = state.data,
    list = accounts(state),
    g = glyphsOf(state);
  if (!data) return [[s("Loading accounts...", "muted")]];
  if (!list.length)
    return [
      [s("Your next conversation starts here.", "bold")],
      [],
      ...wrapLine(
        [
          s(
            "Add your first account, then sign in with Claude Code. Baton keeps the conversation moving between the accounts you add.",
            "muted",
          ),
        ],
        width,
      ),
      [],
      linked([s("+ Add an account", "accent bold")], "add-account", width),
    ];
  const live = liveSessions(state);
  const ready = list.filter(
    (a) => !a.blocked && !signedOut(state, a.id),
  ).length;
  const body = [
    [
      s(ready + " ready", ready ? "ok" : "warn"),
      s(
        "   /   " +
          plural(list.length, "account") +
          "   /   " +
          plural(live.length, "live session"),
        "muted",
      ),
    ],
    [],
    sectionRule("NEXT ACCOUNT", width, g),
  ];
  if (data.next.account) {
    body.push(
      linked(
        [s(nameOf(state, data.next.account), "bold")],
        "acct:" + data.next.account,
        width,
      ),
      ...wrapLine(
        [s(reasonWords[data.next.reason] ?? data.next.reason, "muted")],
        width,
      ),
    );
  } else {
    body.push([s("All accounts are at their limit", "warn")]);
    if (data.next.earliest)
      body.push(
        linked(
          [
            s(
              nameOf(state, data.next.earliest) +
                (data.next.availableKnown
                  ? " returns in " + span(data.next.availableAt - state.now)
                  : " · reset time unknown"),
              "muted",
            ),
          ],
          "acct:" + data.next.earliest,
          width,
        ),
      );
  }
  const nameWidth = Math.max(14, Math.min(30, width - 34));
  body.push([], sectionRule("ACCOUNTS", width, g), [
    s("Account".padEnd(nameWidth + 2), "muted"),
    s("5-hour".padEnd(10), "muted"),
    s("Weekly".padEnd(10), "muted"),
    s("Status", "muted"),
  ]);
  for (const a of list) {
    const names = wrapLine(
      [s(a.name, a.id === data.next.account ? "bold" : "text")],
      nameWidth,
    );
    const status = signedOut(state, a.id)
      ? "Sign in"
      : a.blocked
        ? a.availableKnown
          ? "Back in " + span(a.availableAt - state.now)
          : "At limit"
        : "Ready";
    names.forEach((name, i) =>
      body.push(
        linked(
          [
            ...fitLine(name, nameWidth),
            s("  "),
            ...(i
              ? []
              : [
                  ...meter(a.windows.five_hour, g),
                  s("  "),
                  ...meter(a.windows.seven_day, g),
                  s("  "),
                  s(
                    status,
                    signedOut(state, a.id)
                      ? "accent"
                      : a.blocked
                        ? "muted"
                        : "ok",
                  ),
                ]),
          ],
          "acct:" + a.id,
          width,
        ),
      ),
    );
  }
  body.push([], sectionRule("LIVE SESSIONS", width, g));
  if (!live.length)
    body.push([s("No sessions running. Start one with baton.", "muted")]);
  for (const session of live) {
    const status =
      session.wrapperState === "countdown"
        ? "Moving to " + session.targetName
        : session.wrapperState === "waiting"
          ? "Waiting"
          : session.turnState === "running"
            ? "Working"
            : "Idle";
    const line = spread(
      [sessionIcon(session, g), s(" "), s(session.name, "bold")],
      [s(session.accountName ?? "", "muted")],
      width,
    );
    body.push(linked(line, "sess:" + session.id, width));
    const workflow = session.backgroundTasks.some(
      (task) => task.type === "workflow",
    );
    body.push(
      linked(
        [s("  " + status + (workflow ? " · workflow running" : ""), "muted")],
        "sess:" + session.id,
        width,
      ),
    );
  }
  const today = data.stats.days.at(-1);
  const hops = data.stats.totals.hops[today] ?? 0,
    refusals = data.stats.totals.refusals[today] ?? 0;
  body.push([], sectionRule("TODAY", width, g), [
    s(
      hops +
        (hops === 1 ? " handoff" : " handoffs") +
        "  ·  " +
        refusals +
        " refusals",
      "muted",
    ),
  ]);
  if (data.conflicts.length)
    body.push(
      [],
      [
        s(
          data.conflicts.length + " shared-file conflicts · baton conflicts",
          "warn",
        ),
      ],
    );
  return body;
}
export const overview = {
  model(state, item, box) {
    return {
      title: [s("Overview", "bold")],
      right: pollWhen(state),
      body: overviewBody(state, box.room.width),
    };
  },
};
