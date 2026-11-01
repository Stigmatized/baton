import { pollLine, pollWords } from "./format.js";
import { loadMenuData } from "./menu/data.js";
import { s, spread, wrapLine } from "./menu/lines.js";
import { initialState } from "./menu/state.js";
import { span, when } from "./menu/text.js";
import { markIcon } from "./menu/tree.js";
import { reasonWords } from "./menu/views/common.js";
import { accountBody, menuTime } from "./menu/views/account.js";
import { overviewBody } from "./menu/views/overview.js";
import { statsBody } from "./menu/views/stats.js";
import {
  banner,
  entry,
  fact,
  heading,
  marks,
  next,
  outcome,
  paragraph,
  room,
  tildify,
} from "./term.js";

// What the plain commands print, as lines of spans (term.js draws them). The
// status, usage and stats screens are the menu's own panes (the same view
// models and builders), so a command and the menu always agree; the others
// are built from the same pieces.

const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

// ---- The menu's panes ----------------------------------------------------------

// The menu's state for the command line: its data, the sign-in of each
// account as far as the usage poll knows it (asking Claude Code for it is
// baton doctor's job).
function menuState(paths, term, data = loadMenuData(paths)) {
  const auth = {};
  for (const [id, entry] of Object.entries(data.poll?.accounts ?? {}))
    if (entry?.status === "ok") auth[id] = { loggedIn: true };
    else if (entry?.status === "signed-out") auth[id] = { loggedIn: false };
  return {
    ...initialState({
      size: { cols: term.cols, rows: 40 },
      now: data.now,
      color: term.styled,
      glyphs: term.glyphs,
      data,
    }),
    auth,
  };
}

export function statusScreen(term, paths) {
  const state = menuState(paths, term);
  const width = room(term);
  if (!state.data.states.length) return emptyScreen(term);
  // The accounts whose usage poll has something to say.
  const trouble = state.data.states.filter((a) => {
    const poll = state.data.poll?.accounts?.[a.id];
    return poll?.status && poll.status !== "ok";
  });
  return [
    ...banner(term),
    ...paragraph(pollLine(state.data), width),
    [],
    ...overviewBody(state, width),
    ...(trouble.length
      ? [
          [],
          heading("USAGE POLL", width, term),
          ...trouble.flatMap((a) =>
            wrapLine(
              [
                s(a.name, "bold"),
                s("  "),
                s(
                  pollWords(
                    state.data.poll.accounts[a.id],
                    state.now,
                    menuTime,
                  ),
                  "muted",
                ),
              ],
              width,
              2,
            ),
          ),
        ]
      : []),
    [],
    [
      s("baton usage", "accent"),
      s(" shows every window and where it came from", "muted"),
    ],
  ];
}

export function usageScreen(term, paths, { account = null } = {}) {
  const state = menuState(paths, term);
  const width = room(term);
  const g = term.g;
  if (!state.data.states.length) return emptyScreen(term);
  const shown = state.data.states.filter((a) => !account || a.id === account);
  const lines = [...banner(term)];
  shown.forEach((a, i) => {
    if (i) lines.push([]);
    lines.push(
      spread(
        [s(a.name, "bold")],
        [
          s(
            a.blocked ? `${g.blocked} blocked` : "available",
            a.blocked ? "err" : "ok",
          ),
        ],
        width,
      ),
      [s(g.corners.h.repeat(width), "divider")],
      ...accountBody(state, a.id, width),
    );
  });
  lines.push([], ...paragraph(pollLine(state.data), width));
  return lines;
}

export function statsScreen(term, paths, stats) {
  const base = loadMenuData(paths);
  const state = menuState(paths, term, { ...base, stats });
  const width = room(term);
  return [
    ...banner(term),
    heading("STATS", width, term, `last ${stats.days.length} days`),
    [],
    ...statsBody(state, width),
  ];
}

// ---- install and uninstall -----------------------------------------------------

const ITEM_LABEL = {
  statusline: "Status line",
  hooks: "Hooks",
  hop: "/hop command",
};
const WORDS = {
  add: ["added", "will add"],
  update: ["updated", "will update"],
  remove: ["removed", "will remove"],
  same: ["in place", "in place"],
  absent: ["not installed", "not installed"],
  skip: ["left alone", "left alone"],
};

function itemDetail(item, mode, home) {
  if (item.action === "absent") return "";
  switch (item.name) {
    case "statusline":
      if (mode === "uninstall")
        return item.action === "remove"
          ? item.restored
            ? "your previous status line is back"
            : "removed from settings.json"
          : "";
      return "baton statusline";
    case "hooks":
      return item.events.join(" · ");
    default:
      return tildify(item.path, home);
  }
}

// The pieces in the order they are listed.
const ITEM_ORDER = ["statusline", "hooks", "hop"];

function countDiff(diff) {
  let added = 0;
  let removed = 0;
  for (const line of diff)
    if (line.startsWith("+ ")) added++;
    else if (line.startsWith("- ")) removed++;
  return { added, removed };
}

// The plan and what came of it. `diff` shows every changed line.
export function planScreen(
  term,
  { mode, plan, dryRun, applied, diff, paths, hasAccounts },
) {
  const width = room(term);
  const g = term.g;
  const m = marks(g);
  const verb = mode === "install" ? "Installed" : "Uninstalled";
  const lines = [
    ...banner(term, { full: mode === "install" }),
    heading(mode.toUpperCase(), width, term, dryRun ? "dry run" : ""),
    [],
  ];
  const labelWidth = 14;
  const wordWidth = 14;
  const items = [...plan.items].sort(
    (a, b) => ITEM_ORDER.indexOf(a.name) - ITEM_ORDER.indexOf(b.name),
  );
  for (const item of items) {
    const changing = ["add", "update", "remove"].includes(item.action);
    const mark = !changing
      ? item.action === "same"
        ? m.same
        : m.skip
      : dryRun
        ? [s(g.arrow, "accent bold")]
        : m.done;
    const word = WORDS[item.action][dryRun ? 1 : 0];
    const tone = changing ? (dryRun ? "accent bold" : "ok bold") : "muted";
    lines.push(
      ...wrapLine(
        [
          ...mark,
          s(" "),
          s(ITEM_LABEL[item.name].padEnd(labelWidth), "text bold"),
          s(word.padEnd(wordWidth), tone),
          s(itemDetail(item, mode, paths.home), "muted"),
        ],
        width,
        2 + labelWidth + wordWidth,
      ),
    );
  }
  for (const note of plan.notes)
    lines.push([], ...wrapLine([...m.warn, s(" "), s(note, "warn")], width, 2));
  if (plan.files.length) {
    lines.push([], heading("FILES", width, term), []);
    for (const f of plan.files) {
      const { added, removed } = countDiff(f.diff);
      const what =
        f.after === null ? "remove" : f.before === null ? "create" : "change";
      lines.push(
        spread(
          [s(what.padEnd(8), "muted"), s(tildify(f.path, paths.home), "text")],
          [
            ...(added ? [s(`+${added}`, "ok bold")] : []),
            ...(added && removed ? [s(" ")] : []),
            ...(removed ? [s(`${g.less}${removed}`, "err bold")] : []),
          ],
          width,
        ),
      );
      if (diff)
        for (const line of f.diff) {
          const kind = line[0];
          lines.push(
            ...wrapLine(
              [
                s(
                  "    " + line,
                  kind === "+" ? "ok" : kind === "-" ? "err" : "muted",
                ),
              ],
              width,
              6,
            ),
          );
        }
    }
    if (!diff)
      lines.push(
        [],
        [
          s("Add ", "muted"),
          s("--diff", "accent"),
          s(" to see every changed line.", "muted"),
        ],
      );
  }
  lines.push([]);
  if (dryRun) {
    lines.push(
      outcome(term, "Dry run: nothing was written.", "info"),
      [],
      ...fact("Apply", [s(`baton ${mode}`, "accent bold")], width),
    );
  } else if (applied.changed) {
    lines.push(outcome(term, verb), []);
    if (applied.backup)
      lines.push(
        ...fact("Backup", [s(tildify(applied.backup, paths.home))], width),
      );
    if (mode === "install") {
      lines.push(...fact("Undo", [s("baton uninstall")], width));
      lines.push(
        ...next(
          hasAccounts
            ? "baton"
            : "baton account add <name>, then baton login <name>",
          width,
        ),
      );
    } else lines.push(...fact("Again", [s("baton install")], width));
  } else
    lines.push(
      outcome(
        term,
        mode === "install"
          ? "Already installed. Nothing to change."
          : "Not installed. Nothing to change.",
        mode === "install" ? "same" : "skip",
      ),
    );
  return lines;
}

// ---- doctor ----------------------------------------------------------------------

export function doctorScreen(term, report) {
  const width = room(term);
  const m = marks(term.g);
  const nameWidth = Math.min(
    34,
    Math.max(...report.checks.map((c) => c.name.length)),
  );
  const failed = report.checks.filter((c) => c.ok === false).length;
  return [
    ...banner(term),
    heading("DOCTOR", width, term),
    [],
    ...report.checks.flatMap((c) =>
      entry(
        c.ok === true ? m.ok : c.ok === false ? m.fail : m.info,
        c.name,
        [s(c.detail, c.ok === false ? "text" : "muted")],
        width,
        nameWidth + 1,
      ),
    ),
    [],
    outcome(
      term,
      failed ? `${plural(failed, "check")} failed.` : "All checks passed.",
      failed ? "fail" : "done",
    ),
  ];
}

// ---- help ---------------------------------------------------------------------------

export function helpScreen(term, { groups, commands, name }) {
  const width = room(term);
  if (name) {
    const c = commands.get(name);
    if (!c)
      return [
        ...banner(term),
        outcome(term, `Unknown command ${name}.`, "fail"),
        [],
        ...fact("Try", [s("baton help", "accent bold")], width),
      ];
    const usage = [c.usage].flat();
    return [
      ...banner(term),
      heading("USAGE", width, term),
      [],
      ...usage.flatMap((u) => wrapLine([s(u, "accent")], width, 4)),
      [],
      ...paragraph(c.summary, width, "text"),
      ...(c.example
        ? [[], heading("EXAMPLE", width, term), [], [s(c.example, "accent")]]
        : []),
    ];
  }
  const names = [...commands.entries()].filter(([, c]) => !c.alias);
  const nameWidth = Math.max(11, ...names.map(([n]) => n.length)) + 1;
  const lines = [
    ...banner(term, { full: true }),
    ...wrapLine(
      [
        s("baton", "accent bold"),
        s(" starts Claude Code on the best account; ", "muted"),
        s("baton view", "accent bold"),
        s(" opens the menu.", "muted"),
      ],
      width,
    ),
  ];
  for (const [group, title] of Object.entries(groups)) {
    lines.push([], heading(title.toUpperCase(), width, term), []);
    for (const [n, c] of names)
      if (c.group === group)
        lines.push(
          ...wrapLine(
            [s(n.padEnd(nameWidth), "accent bold"), s(c.summary, "text")],
            width,
            nameWidth,
          ),
        );
  }
  lines.push(
    [],
    wrapLine(
      [
        s("baton help <command>", "accent"),
        s(" shows its options. ", "muted"),
        s("--json", "accent"),
        s(" prints data where it makes sense.", "muted"),
      ],
      width,
    )[0],
  );
  return lines;
}

// ---- accounts --------------------------------------------------------------------------

const markWord = (mark) => (mark === "last-resort" ? "last resort" : mark);

export function accountsScreen(term, config) {
  if (!config.accounts.length) return emptyScreen(term);
  const width = room(term);
  const nameWidth = Math.min(
    40,
    Math.max(...config.accounts.map((a) => a.name.length)),
  );
  return [
    ...banner(term),
    heading("ACCOUNTS", width, term, plural(config.accounts.length, "account")),
    [],
    ...config.accounts.flatMap((a, i) => {
      const t = [
        a.fiveHour != null ? `5-hour ${a.fiveHour}%` : null,
        a.weekly != null ? `weekly ${a.weekly}%` : null,
      ].filter(Boolean);
      return entry(
        [
          s(String(i + 1).padStart(2), "muted"),
          s("  "),
          markIcon(a.mark, term.g),
        ],
        a.name,
        [
          s(markWord(a.mark), a.mark === "preferred" ? "baton" : "muted"),
          ...(t.length ? [s("  " + t.join(" · "), "muted")] : []),
          ...(a.id !== a.name ? [s("  folder " + a.id, "muted")] : []),
        ],
        width,
        nameWidth + 2,
      );
    }),
  ];
}

// "linked 9 · copied 2": what adding an account did to its profile.
const linkSummary = (links) => {
  const counts = new Map();
  for (const r of links)
    if (r.action !== "no-source")
      counts.set(r.action, (counts.get(r.action) ?? 0) + 1);
  return [...counts].map(([action, n]) => `${action} ${n}`).join(" · ");
};

// The answer to an account command: a headline, facts, an optional next step.
function doneScreen(term, { title, facts = [], notes = [], next: step }) {
  const width = room(term);
  return [
    ...banner(term),
    outcome(term, title),
    ...(facts.length ? [[]] : []),
    ...facts.flatMap(([label, value]) => fact(label, [s(value)], width, 12)),
    ...notes.flatMap((note) => [[], ...paragraph(note, width)]),
    ...(step ? [[], ...next(step, width, 12)] : []),
  ];
}

export const accountAdded = (term, r, paths, login) =>
  doneScreen(term, {
    title: `Added ${r.account.name}`,
    facts: [
      ["Position", `#${r.position}`],
      ["Mark", markWord(r.account.mark)],
      ["Profile", tildify(r.profile, paths.home)],
      ...(linkSummary(r.links) ? [["Shared", linkSummary(r.links)]] : []),
    ],
    next: login,
  });

export const accountRenamed = (term, r) =>
  doneScreen(term, {
    title: `Renamed ${r.from} to ${r.to}`,
    notes: ["Its profile, sign-in, sessions and history stay as they are."],
  });

export const accountRemoved = (term, r, paths) =>
  doneScreen(term, {
    title: `Removed ${r.name} from Baton`,
    facts: [
      ["Unlinked", r.unlinked.length ? `${r.unlinked.length} shared` : "none"],
      ["Folder", tildify(r.profile, paths.home)],
    ],
    notes: [
      "Its folder still holds that account's sign-in; delete it yourself when you no longer need it.",
    ],
  });

export function accountOrder(term, r) {
  const width = room(term);
  return [
    ...banner(term),
    outcome(term, "Order updated"),
    [],
    ...r.order.flatMap((name, i) =>
      wrapLine(
        [s(String(i + 1).padStart(2), "muted"), s("  "), s(name, "bold")],
        width,
        4,
      ),
    ),
  ];
}

export const accountSet = (term, a) =>
  doneScreen(term, {
    title: `Updated ${a.name}`,
    facts: [
      ["Mark", markWord(a.mark)],
      ["5-hour", a.fiveHour == null ? "default" : `${a.fiveHour}%`],
      ["Weekly", a.weekly == null ? "default" : `${a.weekly}%`],
    ],
  });

// ---- no accounts, failures ---------------------------------------------------------------------

export function emptyScreen(term) {
  const width = room(term);
  return [
    ...banner(term),
    outcome(term, "No accounts yet.", "skip"),
    [],
    ...paragraph(
      "Add the Claude accounts Baton should use, then sign each one in with Claude Code.",
      width,
    ),
    [],
    ...fact("Add", [s("baton account add <name>", "accent bold")], width),
    ...fact("Sign in", [s("baton login <name>", "accent bold")], width),
  ];
}

export const failScreen = (term, message) => [
  ...banner(term),
  ...wrapLine(outcome(term, message, "fail"), room(term), 2),
];

// ---- usage --refresh, conflicts, policy --------------------------------------------------

export function refreshScreen(term, { results }, now) {
  const width = room(term);
  const m = marks(term.g);
  const pct = (n) => (n == null ? "?" : `${Math.round(n)}%`);
  const nameWidth = Math.min(
    40,
    Math.max(...results.map((r) => r.name.length)),
  );
  return [
    ...banner(term),
    heading("REFRESH", width, term),
    [],
    ...results.flatMap((r) => {
      if (r.status === "ok") {
        const w = r.reading ?? {};
        const parts = [
          w.five_hour ? `5-hour ${pct(w.five_hour.used)}` : null,
          w.seven_day ? `weekly ${pct(w.seven_day.used)}` : null,
        ].filter(Boolean);
        return entry(
          m.ok,
          r.name,
          [
            s(parts.join(" · ") || "no meters reported"),
            s("  polled now", "muted"),
          ],
          width,
          nameWidth,
        );
      }
      const until = Date.parse(r.until);
      const text =
        r.status === "backoff"
          ? `not asked: the usage endpoint was rate limited; asks again ${when(until, now)} (in ${span(until - now)})`
          : r.status === "unknown"
            ? "not one of Baton's accounts"
            : pollWords(r, now);
      return entry(
        r.status === "unknown" ? m.fail : m.skip,
        r.name,
        [s(text, "muted")],
        width,
        nameWidth,
      );
    }),
  ];
}

export function conflictsScreen(term, list, label, { cleared } = {}) {
  const width = room(term);
  if (cleared != null)
    return [
      ...banner(term),
      outcome(term, `Cleared ${plural(cleared, "conflict")}.`),
    ];
  if (!list.length)
    return [...banner(term), outcome(term, "No conflicts.", "same")];
  return [
    ...banner(term),
    heading("CONFLICTS", width, term, plural(list.length, "conflict")),
    [],
    ...list.flatMap((c, i) => [
      ...(i ? [[]] : []),
      ...wrapLine(
        [
          ...marks(term.g).warn,
          s(" "),
          s(`${c.item} in ${label(c.account)}`, "bold"),
          s("  " + c.at, "muted"),
        ],
        width,
        2,
      ),
      ...fact(
        "Kept",
        [
          s(
            `${c.kept === "~/.claude" ? "~/.claude" : label(c.kept)}'s version`,
          ),
        ],
        width,
        8,
      ).map((l) => [s("  "), ...l]),
      ...fact("Backup", [s(c.backup)], width, 8).map((l) => [s("  "), ...l]),
    ]),
    [],
    ...fact("Clear", [s("baton conflicts --clear", "accent")], width),
  ];
}

export function policyScreen(term, { rows, mode, saved }) {
  const width = room(term);
  const flagWidth = Math.max(...rows.map((r) => r.flag.length));
  const valueWidth = Math.max(...rows.map((r) => String(r.value).length));
  return [
    ...banner(term),
    ...(saved ? [outcome(term, `Saved ${plural(saved, "setting")}.`), []] : []),
    heading("POLICY", width, term, `${mode} mode`),
    [],
    ...rows.map((r) => [
      s(r.flag.padEnd(flagWidth + 2), "muted"),
      s(String(r.value).padEnd(valueWidth), r.custom ? "accent bold" : "bold"),
      s(r.custom ? "  changed" : "  default", "muted"),
    ]),
  ];
}

// ---- hop and pick ----------------------------------------------------------------------------

export function hopScreen(term, r, when) {
  const width = room(term);
  return [
    ...banner(term),
    outcome(term, "Hop queued"),
    [],
    ...fact("Session", [s(r.session)], width, 10),
    ...fact("From", [s(r.from)], width, 10),
    ...fact("To", [s(r.to, "accent bold")], width, 10),
    ...fact("When", [s(when)], width, 10),
  ];
}

export function pickScreen(term, { name, reason, earliest, at }) {
  const m = marks(term.g);
  const now = Date.now();
  const width = room(term);
  if (name)
    return [
      ...banner(term),
      ...wrapLine(
        [
          ...m.ok,
          s(" "),
          s(name, "bold"),
          s("  " + (reasonWords[reason] ?? reason), "muted"),
        ],
        width,
        2,
      ),
    ];
  return [
    ...banner(term),
    ...wrapLine(
      [
        s(term.g.blocked, "warn bold"),
        s(" "),
        s("Every account is at its limit", "bold"),
        ...(earliest
          ? [
              s(
                `  ${earliest} is first back${at ? ` at ${when(at, now)} (in ${span(at - now)})` : ""}`,
                "muted",
              ),
            ]
          : []),
      ],
      width,
      2,
    ),
  ];
}
