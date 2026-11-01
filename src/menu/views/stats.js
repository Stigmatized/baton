import { lineWidth, s, wrapFacts } from "../lines.js";
import { usageTone } from "../charts.js";
import { glyphsOf } from "../theme.js";
import { dayLabel, shortDate } from "../text.js";
import { markIcon } from "../tree.js";
import { section } from "./common.js";

// The last 7 days: per account a graph of the 5-hour peak and the weekly use
// per day (a bar and the number in each day's column), hops, refusals and
// sessions per day, and the weekly allowance left unused when a window reset.

const COLUMN = 5;
const level = (g, v) =>
  v == null
    ? g.normal
    : g.ticks[
        Math.min(
          g.ticks.length - 1,
          Math.max(0, Math.round((v / 100) * (g.ticks.length - 1))),
        )
      ];

function dayCells(values, { g, tone, threshold, bars = true }) {
  return values.flatMap((v) => {
    const text = v == null ? "-" : String(Math.round(v));
    const style =
      tone ??
      (threshold == null ? (v ? "bold" : "muted") : usageTone(v, threshold));
    return bars
      ? [
          s(level(g, v), v == null ? "muted" : style),
          s(text.padStart(COLUMN - 2), v == null ? "muted" : style),
          s(" "),
        ]
      : [s(text.padStart(COLUMN - 1), v ? style : "muted"), s(" ")];
  });
}

export function statsBody(state, width) {
  const g = glyphsOf(state);
  const stats = state.data.stats;
  const labelWidth = Math.max(
    10,
    ...stats.accounts.map((a) => a.name.length + 6),
  );
  const head = [
    s(" ".repeat(labelWidth), ""),
    ...stats.days.flatMap((d) => [
      s(dayLabel(d).padStart(COLUMN - 1), "muted"),
      s(" "),
    ]),
  ];
  const tableWidth = lineWidth(head);
  const body = [
    // "last 7 days" is in the title row already.
    [
      s(
        `${shortDate(Date.parse(stats.since))} to ${shortDate(Date.parse(stats.until))}`,
        "muted",
      ),
    ],
    [],
  ];
  const fits = tableWidth <= width;
  // In a narrow pane the days run as sparklines under each other instead.
  if (fits) body.push(head);
  for (const a of stats.accounts) {
    const state2 = state.data.states.find((x) => x.id === a.id);
    const t5 = state2?.windows.five_hour.threshold;
    const tw = state2?.windows.seven_day.threshold;
    const five = a.daily.map((d) => d.fiveHourMax);
    const week = a.daily.map((d) => d.weeklyLast);
    if (fits) {
      body.push([
        markIcon(a.mark, g),
        s(" "),
        s(a.name, "bold"),
        s(" 5h".padEnd(labelWidth - a.name.length - 2), "muted"),
        ...dayCells(five, { g, threshold: t5 }),
      ]);
      body.push([
        s(`${" ".repeat(a.name.length + 2)} wk`.padEnd(labelWidth), "muted"),
        ...dayCells(week, { g, threshold: tw }),
      ]);
    } else {
      body.push([markIcon(a.mark, g), s(" "), s(a.name, "bold")]);
      body.push([
        s("  5h peak ", "muted"),
        ...five.map((v) =>
          s(level(g, v), v == null ? "muted" : usageTone(v, t5)),
        ),
      ]);
      body.push([
        s("  weekly  ", "muted"),
        ...week.map((v) =>
          s(level(g, v), v == null ? "muted" : usageTone(v, tw)),
        ),
      ]);
    }
  }
  body.push([]);
  const totals = stats.totals;
  const row = (label, values, tone) =>
    fits
      ? [
          s(label.padEnd(labelWidth), "muted"),
          ...dayCells(values, { g, tone, bars: false }),
        ]
      : [s(label.padEnd(10), "muted"), s(values.join(" "), tone)];
  body.push(
    row(
      "Hops",
      stats.days.map((d) => totals.hops[d]),
      "bold",
    ),
  );
  body.push(
    row(
      "Refusals",
      stats.days.map((d) => totals.refusals[d]),
      "warn",
    ),
  );
  body.push(
    row(
      "Sessions",
      stats.days.map((d) => totals.sessions[d]),
      "bold",
    ),
  );
  const reasons = Object.entries(stats.hopReasons);
  if (reasons.length)
    body.push(
      ...wrapFacts(
        reasons.map(([r, n]) => [s(`${n} `, "bold"), s(r, "muted")]),
        width,
        { lead: [s("Why       ", "muted")], indent: 10 },
      ),
    );
  body.push([], section("Weekly allowance lost at resets"));
  const lost = stats.accounts.flatMap((a) =>
    a.wasted.map((w) => ({ name: a.name, ...w })),
  );
  if (!lost.length)
    body.push([s("  no weekly reset in these 7 days", "muted")]);
  for (const w of lost)
    body.push(
      ...wrapFacts(
        [
          [s(shortDate(Date.parse(w.resetAt)), "muted")],
          [
            s(
              `${Math.round(w.unused)}% unused`,
              w.unused >= 10 ? "warn bold" : "bold",
            ),
          ],
          [s(`${Math.round(w.headroomLeft)}% under its threshold`, "muted")],
        ],
        width,
        { lead: [s(`  ${w.name}  `, "bold")], indent: 4 },
      ),
    );
  return body;
}

export const stats = {
  model(state, item, box) {
    return {
      title: [s("Stats", "bold")],
      right: [s("last 7 days", "muted")],
      body: statsBody(state, box.room.width),
    };
  },
};
