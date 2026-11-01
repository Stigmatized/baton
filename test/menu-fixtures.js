import { join } from "node:path";
import { createElement as h } from "react";
import { render } from "ink-testing-library";
import { appendJsonLine, writeJsonAtomic } from "../src/fsutil.js";
import { profileDir } from "../src/paths.js";
import { historyFile, recordRejection } from "../src/usage.js";
import { loadMenuData } from "../src/menu/data.js";
import { reduce } from "../src/menu/reducer.js";
import { initialState } from "../src/menu/state.js";
import { Screen } from "../src/menu/ui/app.js";
import { write } from "./helpers.js";

// A realistic ~/.baton for the menu's frames, written with Baton's own
// formats: four accounts (acct2 preferred, acct4 last resort, acct3 blocked
// by its weekly limit until a reset in 2 days, acct1 blocked by its 5-hour
// limit until a reset in 40 minutes), two live lead sessions (one in the
// middle of a workflow, one counting down to a hop), recent ones, a week of
// readings, hops and refusals, and the usage poller (this process holding
// the poll lease, the last poll 12 minutes ago: acct2 with a model's own weekly limit and
// extra usage, acct3 waiting out the usage endpoint's rate limit, acct4
// signed out).
// allBlocked: acct2 and acct4 blocked too.
export const NOW = Date.parse("2026-10-25T10:00:00Z");
const M = 60e3;
const H = 60 * M;
const D = 24 * H;
const iso = (t) => new Date(t).toISOString();
export const S1 = "6f0b2d4e-1c3a-4b5d-8e9f-0a1b2c3d4e5f";
export const S2 = "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d";
const S3 = "1b2c3d4e-5f6a-4b7c-8d9e-0f1a2b3c4d5e";
const S4 = "2c3d4e5f-6a7b-4c8d-9e0f-1a2b3c4d5e6f";

const window = (used, resetsIn, readAgo = 2 * M, source = "statusline") => ({
  used,
  resetsAt: iso(NOW + resetsIn),
  readAt: iso(NOW - readAgo),
  source,
});
const polled = (used, resetsIn, readAgo = 12 * M) =>
  window(used, resetsIn, readAgo, "poll");

export function buildHome(paths, { allBlocked = false } = {}) {
  write(paths.config, {
    version: 1,
    accounts: [
      { id: "acct1", name: "acct1", mark: "normal" },
      { id: "acct2", name: "acct2", mark: "preferred" },
      { id: "acct3", name: "acct3", mark: "normal" },
      { id: "acct4", name: "acct4", mark: "last-resort", weekly: 90 },
    ],
    policy: {},
  });
  const usage = {
    acct1: {
      five_hour: window(100, 40 * M),
      seven_day: window(71, 3 * D + 2 * H),
    },
    acct2: allBlocked
      ? { five_hour: window(100, 70 * M), seven_day: window(66, 4 * D) }
      : { five_hour: polled(42, 2 * H + 5 * M), seven_day: polled(63, 4 * D) },
    acct3: {
      five_hour: window(12, 3 * H),
      seven_day: polled(97, 2 * D, 42 * M),
    },
    acct4: allBlocked
      ? { five_hour: window(30, 4 * H), seven_day: window(92, 5 * D) }
      : {
          five_hour: window(5, 4 * H, 42 * M),
          seven_day: window(18, 6 * D, 42 * M),
        },
  };
  const meters = {
    acct2: {
      limits: [
        {
          kind: "session",
          group: "session",
          label: null,
          used: 42,
          resetsAt: iso(NOW + 2 * H + 5 * M),
          severity: "normal",
          active: true,
        },
        {
          kind: "weekly_all",
          group: "weekly",
          label: null,
          used: 63,
          resetsAt: iso(NOW + 4 * D),
          severity: "normal",
          active: false,
        },
        {
          kind: "weekly_scoped",
          group: "weekly",
          label: "Fable",
          used: 71,
          resetsAt: iso(NOW + 4 * D),
          severity: "warning",
          active: false,
        },
      ],
      limitsAt: iso(NOW - 12 * M),
      extraUsage: {
        enabled: true,
        monthlyLimit: 5000,
        usedCredits: 1250,
        utilization: 25,
        currency: "USD",
      },
    },
  };
  for (const [name, r] of Object.entries(usage))
    writeJsonAtomic(join(paths.usage, `${name}.json`), {
      account: name,
      at: iso(NOW - 2 * M),
      source: "statusline",
      ...r,
      ...(meters[name] ?? {}),
    });
  // The usage poller: this process holds a menu lease, with the last
  // poll 12 minutes ago.
  writeJsonAtomic(join(paths.root, "poll", "lease.json"), {
    pid: process.pid,
    instance: "fixture",
    kind: "menu",
    since: iso(NOW - 12 * M),
    heartbeatAt: iso(NOW),
  });
  const ok = {
    at: iso(NOW - 12 * M),
    status: "ok",
    reason: null,
    okAt: iso(NOW - 12 * M),
    backoffUntil: null,
    backoffMs: null,
    failures: 0,
  };
  writeJsonAtomic(join(paths.root, "poll", "state.json"), {
    lastRunAt: iso(NOW - 12 * M),
    running: null,
    accounts: {
      acct1: ok,
      acct2: ok,
      acct3: {
        at: iso(NOW - 12 * M),
        status: "rate-limited",
        reason: "Usage endpoint is rate limited. Please try again in a moment.",
        okAt: iso(NOW - 42 * M),
        backoffUntil: iso(NOW + 3 * M),
        backoffMs: 15 * M,
        failures: 2,
      },
      acct4: {
        ...ok,
        status: "signed-out",
        reason: "not signed in: baton login acct4",
        okAt: null,
      },
    },
  });
  recordRejection(paths, "acct1", {
    window: "five_hour",
    at: iso(NOW - 25 * M),
    until: iso(NOW + 40 * M),
    untilSource: "message",
    error: "rate_limit",
    session: S2,
  });
  if (allBlocked)
    recordRejection(paths, "acct2", {
      window: "five_hour",
      at: iso(NOW - 5 * M),
      until: iso(NOW + 70 * M),
      untilSource: "reading",
      error: "rate_limit",
      session: S1,
    });
  // A week of readings: a 5-hour peak and the weekly use each day.
  const days = [6, 5, 4, 3, 2, 1, 0];
  const peaks = {
    acct1: [55, 80, 97, 64, 88, 92, 100],
    acct2: [20, 45, 70, 30, 52, 61, 42],
    acct3: [90, 95, 99, 85, 92, 77, 12],
    acct4: [0, 0, 12, 0, 8, 0, 5],
  };
  const weekly = {
    acct1: [12, 25, 41, 49, 58, 66, 71],
    acct2: [10, 18, 31, 38, 47, 55, 63],
    acct3: [60, 72, 83, 9, 30, 70, 97],
    acct4: [0, 0, 5, 5, 11, 11, 18],
  };
  for (const [name, list] of Object.entries(peaks))
    days.forEach((ago, i) => {
      const at = NOW - ago * D - 3 * H;
      appendJsonLine(historyFile(paths, "readings", at), {
        at: iso(at),
        account: name,
        window: "five_hour",
        used: list[i],
        resetsAt: iso(at + 2 * H),
        session: S1,
        source: "statusline",
      });
      // acct3's weekly window reset 4 days ago with 83% used.
      const resetsAt =
        name === "acct3" && i < 3 ? iso(NOW - 4 * D + H) : iso(NOW + 2 * D);
      appendJsonLine(historyFile(paths, "readings", at), {
        at: iso(at),
        account: name,
        window: "seven_day",
        used: weekly[name][i],
        resetsAt,
        session: S1,
        source: "statusline",
      });
    });
  const event = (ago, e) =>
    appendJsonLine(historyFile(paths, "events", NOW - ago), {
      at: iso(NOW - ago),
      ...e,
    });
  event(5 * D, {
    type: "session",
    session: S4,
    account: "acct3",
    source: "startup",
  });
  event(4 * D + H, {
    type: "hop",
    session: S4,
    from: "acct3",
    to: "acct1",
    reason: "planned",
  });
  event(3 * D, {
    type: "refusal",
    account: "acct3",
    window: "seven_day",
    session: S4,
  });
  event(3 * D - M, {
    type: "hop",
    session: S4,
    from: "acct3",
    to: "acct1",
    reason: "refusal",
  });
  event(D + 2 * H, {
    type: "session",
    session: S3,
    account: "acct2",
    source: "startup",
  });
  event(D, {
    type: "hop",
    session: S3,
    from: "acct2",
    to: "acct4",
    reason: "compaction",
  });
  event(3 * H, {
    type: "session",
    session: S1,
    account: "acct1",
    source: "startup",
  });
  event(2 * H + 10 * M, {
    type: "session",
    session: S2,
    account: "acct1",
    source: "startup",
  });
  event(2 * H, {
    type: "refusal",
    account: "acct1",
    window: "five_hour",
    session: S1,
  });
  event(2 * H - M, {
    type: "hop",
    session: S1,
    from: "acct1",
    to: "acct2",
    reason: "refusal",
  });
  event(25 * M, {
    type: "refusal",
    account: "acct1",
    window: "five_hour",
    session: S2,
  });
  // Two live lead sessions (this process stands in for their wrappers).
  const live = (wrapper, id, account, cwd, state, extra = {}) => {
    writeJsonAtomic(join(paths.wrappers, `${wrapper}.json`), {
      pid: process.pid,
      wrapper,
      account,
      session: id,
      startedAt: iso(NOW - 3 * H),
      cwd,
      state,
      ...extra,
    });
    writeJsonAtomic(join(paths.sessions, id, "start.json"), {
      at: iso(NOW - 3 * H),
      source: "startup",
      account,
      cwd,
      model: "claude-opus-5-5",
      wrapper,
    });
    writeJsonAtomic(join(paths.sessions, id, "live.json"), {
      at: iso(NOW - M),
      account,
      model: "claude-opus-5-5",
      effort: "high",
      cwd,
      reading: null,
    });
  };
  live(
    "1001-aaaa",
    S1,
    "acct2",
    "E:\\GitHub\\ntanis-dev\\sports-odds",
    "running",
  );
  writeJsonAtomic(join(paths.sessions, S1, "turn.json"), {
    at: iso(NOW - 4 * M),
    state: "running",
    event: "prompt",
    account: "acct2",
    permissionMode: "auto",
    backgroundTasks: [
      { type: "workflow", status: "running", name: "monitor sweep" },
      { type: "subagent", status: "running", name: "Explore" },
      { type: "subagent", status: "running", name: "Explore" },
      { type: "shell", status: "running", name: null },
    ],
  });
  for (const [i, used] of [30, 33, 35, 38, 42].entries())
    appendJsonLine(join(paths.sessions, S1, "turns.jsonl"), {
      at: iso(NOW - (50 - i * 10) * M),
      account: "acct2",
      five_hour: { used, resetsAt: usage.acct2.five_hour.resetsAt },
      seven_day: {
        used: 60 + i * 0.5,
        resetsAt: usage.acct2.seven_day.resetsAt,
      },
    });
  live(
    "1002-bbbb",
    S2,
    "acct1",
    "E:\\GitHub\\ntanis-dev\\pelican",
    allBlocked ? "waiting" : "countdown",
    {
      target: allBlocked ? "acct1" : "acct2",
      ...(allBlocked ? { until: iso(NOW + 40 * M) } : {}),
    },
  );
  writeJsonAtomic(join(paths.sessions, S2, "turn.json"), {
    at: iso(NOW - 25 * M),
    state: "idle",
    event: "stop-failure",
    account: "acct1",
    error: "rate_limit",
    window: "five_hour",
  });
  // Recent, ended sessions.
  for (const [id, account, cwd, ago] of [
    [S3, "acct4", "E:\\GitHub\\ntanis-dev\\royal-flush", 20 * H],
    [S4, "acct1", "E:\\GitHub\\ntanis-dev\\baton", 3 * D],
  ]) {
    writeJsonAtomic(join(paths.sessions, id, "start.json"), {
      at: iso(NOW - ago - H),
      source: "startup",
      account,
      cwd,
    });
    writeJsonAtomic(join(paths.sessions, id, "end.json"), {
      at: iso(NOW - ago),
      reason: "prompt_input_exit",
      account,
    });
  }
  for (const name of ["acct2", "acct3", "acct4"])
    write(join(profileDir(paths, name), ".claude.json"), {});
}

export const auth = {
  acct1: { ok: true, loggedIn: true, authMethod: "claude.ai" },
  acct2: { ok: true, loggedIn: true, authMethod: "claude.ai" },
  acct3: { ok: true, loggedIn: true, authMethod: "claude.ai" },
  acct4: { ok: true, loggedIn: false, authMethod: "none" },
};

// The menu's state on the fixture home, after `keys`.
export function menuState(
  paths,
  { size = { cols: 120, rows: 30 }, keys = [], glyphs = "rich" } = {},
) {
  let state = {
    ...initialState({ size, now: NOW, color: false, glyphs }),
    auth,
  };
  state = reduce(state, {
    type: "data",
    data: loadMenuData(paths, { now: NOW }),
    now: NOW,
  }).state;
  for (const key of keys) state = press(state, paths, key).state;
  return state;
}
export function press(state, paths, key) {
  const out = reduce(
    state,
    typeof key === "object"
      ? { ...key, now: NOW }
      : { type: "key", key, now: NOW },
  );
  return out.effects.some((e) => e.type === "reload")
    ? {
        state: reduce(out.state, {
          type: "data",
          data: loadMenuData(paths, { now: NOW }),
          now: NOW,
        }).state,
        effects: out.effects,
      }
    : out;
}

// ink-testing-library's terminal is 100 columns wide; each frame gets one of
// its own width (after Pelican's snapshot script).
let columns = 100;
let patched = false;
function patch() {
  if (patched) return;
  patched = true;
  const probe = render(h("ink-text", null));
  Object.defineProperty(Object.getPrototypeOf(probe.stdout), "columns", {
    configurable: true,
    get: () => columns,
  });
  probe.unmount();
}
const ansi = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
export function frame(state) {
  patch();
  columns = state.size.cols;
  const app = render(h(Screen, { state }));
  try {
    return app.lastFrame().replace(ansi, "").split("\n");
  } finally {
    app.unmount();
  }
}

export const sizes = {
  "80x24": { cols: 80, rows: 24 },
  "100x30": { cols: 100, rows: 30 },
  "120x30": { cols: 120, rows: 30 },
  "160x45": { cols: 160, rows: 45 },
};
// Each screen: the keys from a fresh menu (Overview selected). In a narrow
// window, where one pane shows at a time, the right pane's screens end with
// Enter.
export const screens = {
  overview: { keys: [] },
  account: { keys: ["down", "down"] },
  "account-blocked": { keys: ["down", "down", "down"] },
  session: { keys: ["down", "down", "down", "down", "down"] },
  policy: { keys: ["end", "up", "enter"] },
  stats: { keys: ["end"] },
  actions: { keys: ["down", "down", "enter"], side: true },
  filter: { keys: ["/", "a", "c", "c", "t", "3"], side: true },
  thresholds: { keys: ["down", "down", "enter", "t"], side: true },
  remove: { keys: ["down", "down", "down", "enter", "d"], side: true },
  "remove-account-1": { keys: ["down", "enter", "d"], side: true },
  rename: { keys: ["down", "down", "enter", "e"], side: true },
  "hop-to": {
    keys: ["down", "down", "down", "down", "down", "enter", "H"],
    side: true,
  },
};
