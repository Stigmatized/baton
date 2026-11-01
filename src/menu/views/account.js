import { otherLimits, pollWords, readWords } from "../../format.js";
import { WINDOW_LABEL } from "../../policy.js";
import { s, wrapFacts, wrapLine } from "../lines.js";
import { spark } from "../charts.js";
import { glyphsOf } from "../theme.js";
import { dayLabel, plural, span, when } from "../text.js";
import { markIcon } from "../tree.js";
import { accountById, accounts, configOf, sessionsOn } from "../state.js";
import { field, windowLine } from "./common.js";

// One account: both bars with the threshold marks and the reset countdowns,
// blocked-by and availableAt, the weekly urgency in words, its mark, order
// and thresholds, its sign-in (method only), its sessions, 7 days of use
// per window and its hops.

export function urgencyWords(a, now) {
  const week = a.windows.seven_day;
  if (week.used == null || !week.resetsAt) return "no weekly reading yet";
  const left = Math.max(0, week.threshold - week.used);
  if (!left)
    return `weekly limit reached; resets in ${span(week.resetsAt - now)}`;
  return `loses ${Math.round(left)}% in ${span(week.resetsAt - now)} if unused`;
}

function signInWords(state, name) {
  const auth = state.auth[name];
  if (!auth) return [s("sign-in unknown", "muted")];
  if (auth.error) return [s("sign-in unknown", "muted")];
  return auth.loggedIn
    ? [
        s("signed in", "ok"),
        s(auth.authMethod ? ` (${auth.authMethod})` : "", "muted"),
      ]
    : [s("signed out", "warn bold")];
}

// Where each window's reading came from and how old it is, the plan's
// other limits (a model's own weekly one) and extra usage from the last
// poll, and the poller's last word on the account.
const POLL_TROUBLE = ["unavailable", "rate-limited", "timeout", "failed"];
export const menuTime = { time: when, span };
function usageLines(state, a, width) {
  const now = state.now;
  const reading = state.data.readings?.[a.id];
  const words = (w) =>
    w.readAt == null ? null : readWords(w.source, w.readAt, now, menuTime);
  const five = words(a.windows.five_hour);
  const week = words(a.windows.seven_day);
  const own = a.windows.seven_day.label
    ? [s(` (weekly: ${a.windows.seven_day.label}'s own limit)`, "info")]
    : [];
  const out = [];
  if (five || week)
    out.push(
      ...field(
        "Read",
        five && five === week
          ? [s(five), ...own]
          : [
              ...(five ? [s("5-hour ", "muted"), s(five)] : []),
              ...(five && week ? [s(" · ", "muted")] : []),
              ...(week ? [s("weekly ", "muted"), s(week)] : []),
              ...own,
            ],
        width,
        12,
      ),
    );
  otherLimits(reading, now).forEach((r, i) => {
    const name = `${r.label ?? r.kind}${r.group && r.group !== "session" ? ` ${r.group}` : ""}`;
    const resets = Date.parse(r.resetsAt ?? "");
    out.push(
      ...field(
        i ? "" : "Limits",
        [
          s(name, "bold"),
          s(
            ` ${Math.round(r.used)}%`,
            r.used >= a.windows.seven_day.threshold ? "err bold" : "",
          ),
          ...(Number.isFinite(resets)
            ? [
                s(
                  `  resets ${when(resets, now)} (${span(resets - now)})`,
                  "muted",
                ),
              ]
            : []),
        ],
        width,
        12,
      ),
    );
  });
  const extra = reading?.extraUsage;
  if (extra) {
    const money = (v) =>
      v == null
        ? null
        : `${(v / 100).toFixed(2)}${extra.currency ? ` ${extra.currency}` : ""}`;
    out.push(
      ...field(
        "Extra usage",
        [
          s(extra.enabled ? "on" : "off", extra.enabled ? "" : "muted"),
          ...(extra.usedCredits != null
            ? [s(`, ${money(extra.usedCredits)} used`)]
            : []),
          ...(extra.monthlyLimit != null
            ? [s(` of ${money(extra.monthlyLimit)} this month`, "muted")]
            : []),
        ],
        width,
        12,
      ),
    );
  }
  const poll = state.data.poll;
  if (poll) {
    const entry = poll.accounts[a.id];
    const said =
      poll.running?.account === a.id
        ? "polling now"
        : pollWords(entry, now, menuTime);
    out.push(
      ...field(
        "Usage poll",
        [s(said, POLL_TROUBLE.includes(entry?.status) ? "warn" : "muted")],
        width,
        12,
      ),
    );
  }
  return out;
}

export function accountBody(state, id, width) {
  const a = accountById(state, id);
  if (!a) return [[s("This account is gone.", "muted")]];
  const g = glyphsOf(state);
  const now = state.now;
  const all = accounts(state);
  const config = configOf(state, id);
  const body = [];
  body.push(
    ...wrapFacts(
      [
        [s(`#${a.index + 1} of ${all.length}`, "muted")],
        [
          s(
            a.mark,
            a.mark === "preferred"
              ? "baton bold"
              : a.mark === "last-resort"
                ? "muted"
                : "",
          ),
        ],
        signInWords(state, id),
        ...(state.data.next.account === id
          ? [[s(`${g.baton} next work goes here`, "baton")]]
          : []),
      ],
      width,
      {
        // The name is the pane's title already.
        lead: [markIcon(a.mark, g), s(" ")],
        indent: 2,
      },
    ),
  );
  body.push(
    ...field(
      "Thresholds",
      [
        s(
          `5-hour ${a.windows.five_hour.threshold}%`,
          config?.fiveHour != null ? "bold" : "",
        ),
        s(" · ", "muted"),
        s(
          `weekly ${a.windows.seven_day.threshold}%`,
          config?.weekly != null ? "bold" : "",
        ),
        s(
          config?.fiveHour == null && config?.weekly == null
            ? "  (policy defaults)"
            : "",
          "muted",
        ),
      ],
      width,
      12,
    ),
  );
  body.push([]);
  body.push(
    windowLine("5-hour", a.windows.five_hour, width, g, now, { labelWidth: 8 }),
  );
  body.push(
    windowLine("weekly", a.windows.seven_day, width, g, now, { labelWidth: 8 }),
  );
  body.push(...usageLines(state, a, width));
  if (a.blocked) {
    const by = a.blockedBy.map((w) => WINDOW_LABEL[w]).join(" and the ");
    body.push(
      ...wrapLine(
        [
          s(`${g.blocked} `, "err bold"),
          s(`Blocked by the ${by} limit`, "err bold"),
          s(
            a.availableKnown
              ? ` until ${when(a.availableAt, now)} (in ${span(a.availableAt - now)})`
              : "; its reset time is unknown",
            "err",
          ),
        ],
        width,
        2,
      ),
    );
    const refused = ["five_hour", "seven_day"].filter(
      (w) => a.windows[w].rejected,
    );
    if (refused.length || a.unknownRejection)
      body.push(
        ...wrapLine(
          [s("  refused by Anthropic, not only over the threshold", "muted")],
          width,
          2,
        ),
      );
  } else body.push([s(`${g.check} `, "ok bold"), s("Available now", "ok")]);
  body.push(...field("Weekly", [s(urgencyWords(a, now))], width, 12));
  body.push([]);
  // 7 days per window.
  const stats = state.data.stats.accounts.find((x) => x.id === id);
  if (stats) {
    // A column per day ("Mon" over its bar) where there is room, else a cell.
    const wide = width >= 12 + stats.daily.length * 4;
    const cellsOf = (values, style) =>
      wide
        ? spark(values, { g, style }).flatMap(([text, st]) =>
            [...text].flatMap((ch) => [s(ch.repeat(3), st), s(" ")]),
          )
        : spark(values, { g, style });
    const days = wide
      ? stats.daily.map((d) => dayLabel(d.date)).join(" ")
      : stats.daily.map((d) => dayLabel(d.date)[0]).join("");
    body.push(...field("7 days", [s(days, "muted")], width, 12));
    body.push(
      ...field(
        "  5h peak",
        cellsOf(
          stats.daily.map((d) => d.fiveHourMax),
          "accent",
        ),
        width,
        12,
      ),
    );
    body.push(
      ...field(
        "  weekly",
        cellsOf(
          stats.daily.map((d) => d.weeklyLast),
          "info",
        ),
        width,
        12,
      ),
    );
    const hopsIn = stats.daily.reduce((n, d) => n + d.hopsIn, 0);
    const hopsOut = stats.daily.reduce((n, d) => n + d.hopsOut, 0);
    body.push(
      ...field(
        "Hops",
        [
          s(`${hopsIn} in`, hopsIn ? "bold" : "muted"),
          s(" · ", "muted"),
          s(`${hopsOut} out`, hopsOut ? "bold" : "muted"),
          s(" · ", "muted"),
          s(
            plural(stats.refusals, "refusal"),
            stats.refusals ? "warn" : "muted",
          ),
        ],
        width,
        12,
      ),
    );
  }
  const live = sessionsOn(state, id);
  body.push(
    ...field(
      "Sessions",
      live.length
        ? live.flatMap((x, i) => [
            ...(i ? [s(", ", "muted")] : []),
            s(x.name, "bold"),
          ])
        : [s("none running", "muted")],
      width,
      12,
    ),
  );
  return body;
}

export const account = {
  model(state, item, box) {
    const a = accountById(state, item.accountId);
    const g = glyphsOf(state);
    return {
      title: [s(a?.name ?? item.accountId, "bold")],
      right: a
        ? [
            s(
              a.blocked ? `${g.blocked} blocked` : "available",
              a.blocked ? "err" : "ok",
            ),
          ]
        : [],
      body: accountBody(state, item.accountId, box.room.width),
    };
  },
};
