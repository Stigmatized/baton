import { s, wrapFacts, wrapLine } from "../lines.js";
import { glyphsOf } from "../theme.js";
import { hhmm, plural, span, when } from "../text.js";
import { recentSessions, sessionById } from "../state.js";
import { field, section } from "./common.js";

// A lead session: its account, project folder, start, its hops with their
// reasons, the cost of a turn and the burn rate, and whether subagents or a
// workflow run (no planned hop then).

const fixed = (n) => (n == null ? "?" : `${Math.round(n * 10) / 10}%`);

export function sessionBody(state, id, width) {
  const x = sessionById(state, id);
  if (!x) return [[s("This session is gone.", "muted")]];
  const g = glyphsOf(state);
  const now = state.now;
  const body = [];
  const where = x.live
    ? x.wrapperState === "waiting"
      ? [
          s(
            `waiting for ${x.targetName ?? "an account"}${x.until ? ` until ${when(x.until, now)}` : ""}`,
            "warn bold",
          ),
        ]
      : x.wrapperState === "countdown"
        ? [s(`moving to ${x.targetName}`, "warn bold")]
        : [s("live under baton", "ok")]
    : [s(x.ended ? "ended" : "not running under baton", "muted")];
  body.push(
    ...wrapFacts(
      [[s("on ", "muted"), s(x.accountName ?? "?", "accent bold")], where],
      width,
      // The name is the pane's title already.
      { indent: 2 },
    ),
  );
  body.push(...field("Folder", [s(x.cwd ?? "?")], width));
  body.push(...field("Session", [s(x.id, "muted")], width));
  if (x.startedAt)
    body.push(
      ...field(
        "Started",
        [
          s(when(x.startedAt, now)),
          s(` (${span(now - x.startedAt)} ago)`, "muted"),
        ],
        width,
      ),
    );
  if (x.model) body.push(...field("Model", [s(x.model)], width));
  const busy = x.backgroundTasks.filter((t) =>
    ["subagent", "workflow", "teammate"].includes(t.type),
  );
  const shells = x.backgroundTasks.filter((t) => t.type === "shell").length;
  const now2 =
    x.turnState === "running"
      ? [s(`${g.spinner[0]} `, "accent spin"), s("working", "accent")]
      : x.turnEvent === "stop-failure"
        ? [
            s(
              `turn ended on ${x.error ?? "an API error"}`,
              x.error === "rate_limit" ? "err" : "warn",
            ),
          ]
        : [s("between turns", "muted")];
  if (busy.length)
    now2.push(
      s(" · ", "muted"),
      s(
        busy.some((t) => t.type === "workflow") ? "workflow running" : "",
        "hot",
      ),
      s(
        busy.some((t) => t.type === "workflow") &&
          busy.some((t) => t.type !== "workflow")
          ? ", "
          : "",
        "muted",
      ),
      s(
        busy.filter((t) => t.type !== "workflow").length
          ? plural(busy.filter((t) => t.type !== "workflow").length, "subagent")
          : "",
        "hot",
      ),
    );
  if (shells) now2.push(s(` · ${plural(shells, "background shell")}`, "muted"));
  body.push(...field("Now", now2, width));
  if (busy.length)
    body.push(
      ...wrapLine(
        [
          s(
            "          no planned hop while these run; only a refusal moves it",
            "muted",
          ),
        ],
        width,
        10,
      ),
    );
  body.push(
    ...field(
      "Per turn",
      x.cost.five_hour == null
        ? [s("not enough turns measured yet", "muted")]
        : [
            s(`${fixed(x.cost.five_hour)} of 5h`, "bold"),
            s(" · ", "muted"),
            s(`${fixed(x.cost.seven_day)} of weekly`, "bold"),
            s(`  (${plural(x.turns, "turn")})`, "muted"),
          ],
      width,
    ),
  );
  body.push(
    ...field(
      "Burn",
      x.burn.five_hour == null
        ? [s("no recent readings", "muted")]
        : [
            s(`${fixed(x.burn.five_hour)}/h 5h`, "bold"),
            s(" · ", "muted"),
            s(`${fixed(x.burn.seven_day)}/h weekly`, "bold"),
          ],
      width,
    ),
  );
  body.push(
    [],
    section("Hops", x.hops.length ? "" : "none in the last 7 days"),
  );
  for (const h of x.hops)
    body.push(
      ...wrapLine(
        [
          s(`  ${hhmm(Date.parse(h.at))} `, "muted"),
          s(h.from ?? "?", ""),
          s(` ${g.right} `, "muted"),
          s(h.to ?? "?", "bold"),
          s(`  ${h.reason}`, h.reason === "refusal" ? "warn" : "muted"),
        ],
        width,
        8,
      ),
    );
  return body;
}

export const session = {
  model(state, item, box) {
    const x = sessionById(state, item.id);
    return {
      title: [s(x?.name ?? "Session", "bold")],
      right: x ? [s(x.live ? "live" : "recent", x.live ? "ok" : "muted")] : [],
      body: sessionBody(state, item.id, box.room.width),
    };
  },
};

export const sessions = {
  model(state, item, box) {
    const width = box.room.width;
    const list = recentSessions(state);
    const body = [
      section(
        "Recent sessions",
        `${list.length} in the last 7 days, newest first`,
      ),
      [],
    ];
    for (const x of list)
      body.push(
        ...wrapFacts(
          [
            [s(x.accountName ?? "?", "accent")],
            [s(x.lastAt ? `${span(state.now - x.lastAt)} ago` : "", "muted")],
            [s(plural(x.hops.length, "hop"), "muted")],
          ],
          width,
          {
            lead: [s(x.name, "bold"), s("  ")],
            indent: 2,
          },
        ),
      );
    return { title: [s("Recent sessions", "bold")], right: [], body };
  },
};
