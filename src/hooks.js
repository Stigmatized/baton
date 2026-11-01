import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { delimiter, join, resolve } from "node:path";
import { accountFromEnv } from "./paths.js";
import { effectivePolicy, loadConfig, nameOf, thresholds } from "./config.js";
import { iso, ms, readJson, writeJsonAtomic } from "./fsutil.js";
import { usageTone } from "./menu/charts.js";
import { lineWidth, s } from "./menu/lines.js";
import { clean, width } from "./menu/text.js";
import { pickGlyphs } from "./menu/theme-core.js";
import { windowState } from "./policy.js";
import { inheritedDepth, makeTerminal, render } from "./term.js";
import {
  appendTurnSample,
  readSessionFile,
  validId,
  wrapperSessionFile,
  writeSessionFile,
} from "./sessions.js";
import {
  LIMIT_ERRORS,
  WINDOWS,
  inferRejection,
  readReading,
  readingFromStatusLine,
  recordEvent,
  recordReading,
  recordRejection,
} from "./usage.js";

// The hook handlers and the status line. Claude Code runs them on every
// session event, so they are small, synchronous, write atomically, print
// nothing (a SessionStart or UserPromptSubmit hook's stdout would reach the
// model) and never throw: bad input is ignored. Each one learns its account
// from CLAUDE_CONFIG_DIR (a profile of one of Baton's accounts) and, when the
// process was started by `baton`, the wrapper from BATON_WRAPPER. They
// live in the shared settings.json, so they also run in plain claude (no
// CLAUDE_CONFIG_DIR, or a folder that is not one of Baton's accounts'):
// there they do nothing at all, and the status line only runs the
// operator's own status line command, if any.

// The account of this process, or null when it is not one of Baton's.
export function batonAccount(env, paths) {
  const id = accountFromEnv(env, paths);
  if (!id) return null;
  try {
    return loadConfig(paths).accounts.some((a) => a.id === id) ? id : null;
  } catch {
    return null;
  }
}

export const HOOK_EVENTS = {
  "session-start": "SessionStart",
  prompt: "UserPromptSubmit",
  stop: "Stop",
  "stop-failure": "StopFailure",
  "session-end": "SessionEnd",
};

const clip = (text, n = 400) =>
  typeof text === "string" ? (text.length > n ? text.slice(0, n) : text) : null;

const taskSummary = (tasks) =>
  Array.isArray(tasks)
    ? tasks.slice(0, 50).map((t) => ({
        type: typeof t?.type === "string" ? t.type : null,
        status: typeof t?.status === "string" ? t.status : null,
        name: clip(t?.name ?? t?.agent_type ?? null, 80),
      }))
    : [];

// handleHook(event, input, { env, paths, now }) -> { recorded: [...] }
export function handleHook(
  event,
  input,
  { env = process.env, paths, now = Date.now() },
) {
  const recorded = [];
  if (!input || typeof input !== "object" || !(event in HOOK_EVENTS))
    return { recorded };
  const account = batonAccount(env, paths);
  const id = input.session_id;
  if (!account || !validId(id)) return { recorded };
  const at = iso(now);
  const wrapper = validId(env.BATON_WRAPPER) ? env.BATON_WRAPPER : null;
  const cwd = typeof input.cwd === "string" ? input.cwd : null;

  if (event === "session-start") {
    const source = typeof input.source === "string" ? input.source : null;
    writeSessionFile(paths, id, "start.json", {
      at,
      source,
      account,
      cwd,
      transcriptPath:
        typeof input.transcript_path === "string"
          ? input.transcript_path
          : null,
      model: typeof input.model === "string" ? input.model : null,
      wrapper,
    });
    recorded.push("start");
    if (wrapper) {
      writeJsonAtomic(wrapperSessionFile(paths, wrapper), {
        session: id,
        at,
        source,
        account,
      });
      recorded.push("wrapper");
    }
    if (source === "compact") {
      writeSessionFile(paths, id, "compact.json", { at });
      recorded.push("compact");
    }
    recordEvent(
      paths,
      { type: "session", session: id, account, source, wrapper },
      now,
    );
    return { recorded };
  }

  if (event === "prompt") {
    writeSessionFile(paths, id, "turn.json", {
      at,
      state: "running",
      event: "prompt",
      account,
      permissionMode:
        typeof input.permission_mode === "string"
          ? input.permission_mode
          : null,
    });
    recorded.push("turn");
    return { recorded };
  }

  if (event === "stop") {
    writeSessionFile(paths, id, "turn.json", {
      at,
      state: "idle",
      event: "stop",
      account,
      permissionMode:
        typeof input.permission_mode === "string"
          ? input.permission_mode
          : null,
      backgroundTasks: taskSummary(input.background_tasks),
    });
    recorded.push("turn");
    // The session's latest reading (from its status line) at this turn end.
    const live = readSessionFile(paths, id, "live.json");
    if (live?.reading && live.account === account) {
      appendTurnSample(paths, id, {
        at,
        account,
        five_hour: live.reading.five_hour ?? null,
        seven_day: live.reading.seven_day ?? null,
      });
      recorded.push("sample");
    }
    return { recorded };
  }

  if (event === "stop-failure") {
    const error = typeof input.error === "string" ? input.error : "unknown";
    const message = clip(input.last_assistant_message);
    const details = clip(
      typeof input.error_details === "string"
        ? input.error_details
        : input.error_details
          ? JSON.stringify(input.error_details)
          : null,
    );
    let rejection = null;
    if (LIMIT_ERRORS.includes(error)) {
      rejection = inferRejection({
        error,
        message,
        details,
        reading: readReading(paths, account),
        at: now,
      });
      // The refusal first, then the turn: the wrapper acts on the turn.
      recordRejection(paths, account, {
        ...rejection,
        at,
        error,
        session: id,
        message,
      });
      recordEvent(
        paths,
        {
          type: "refusal",
          session: id,
          account,
          error,
          window: rejection.window,
          until: rejection.until,
        },
        now,
      );
      recorded.push("rejection");
    }
    writeSessionFile(paths, id, "turn.json", {
      at,
      state: "idle",
      event: "stop-failure",
      account,
      error,
      window: rejection?.window ?? null,
      until: rejection?.until ?? null,
      message,
    });
    recorded.push("turn");
    return { recorded };
  }

  if (event === "session-end") {
    writeSessionFile(paths, id, "end.json", {
      at,
      reason: typeof input.reason === "string" ? input.reason : null,
      account,
    });
    recorded.push("end");
  }
  return { recorded };
}

// The status line: records the account's rate_limits and the session's live
// state, then returns what to print. Returns { text } (Baton's own line) or
// { previous } (the operator's own status line command to run instead).
export function handleStatusLine(
  input,
  { env = process.env, paths, now = Date.now() },
) {
  const account = batonAccount(env, paths);
  const install = readJson(paths.install);
  const previous = install?.previousStatusLine?.command ?? null;
  let reading = null;
  if (account && input && typeof input === "object") {
    const id = validId(input.session_id) ? input.session_id : null;
    const parsed = readingFromStatusLine(input);
    if (parsed) {
      const result = recordReading(paths, account, parsed, {
        at: now,
        session: id,
      });
      reading = result.reading ?? readReading(paths, account);
    } else reading = readReading(paths, account);
    if (id) {
      const live = {
        at: iso(now),
        account,
        model: typeof input.model?.id === "string" ? input.model.id : null,
        effort:
          typeof input.effort?.level === "string" ? input.effort.level : null,
        cwd:
          typeof input.workspace?.current_dir === "string"
            ? input.workspace.current_dir
            : typeof input.cwd === "string"
              ? input.cwd
              : null,
        reading: parsed ?? null,
      };
      const before = readSessionFile(paths, id, "live.json");
      const same =
        before &&
        before.account === live.account &&
        before.model === live.model &&
        before.effort === live.effort &&
        before.cwd === live.cwd &&
        JSON.stringify(before.reading) === JSON.stringify(live.reading) &&
        now - (ms(before.at) ?? 0) < 30e3;
      if (!same) writeSessionFile(paths, id, "live.json", live);
      const wrapper = validId(env.BATON_WRAPPER) ? env.BATON_WRAPPER : null;
      if (wrapper) {
        const mapped = readJson(wrapperSessionFile(paths, wrapper));
        if (mapped?.session !== id)
          writeJsonAtomic(wrapperSessionFile(paths, wrapper), {
            session: id,
            at: iso(now),
            source: "statusline",
            account,
          });
      }
    }
  }
  if (!account) return previous ? { previous } : { text: "" };
  const config = loadConfig(paths);
  // Baton's line for a given width (0: as wide as it likes).
  const line = (columns) =>
    ownStatusLine(
      // The account's current name (the files are keyed by its id).
      nameOf(config, account),
      reading,
      now,
      {
        columns,
        overall: overallUsage(paths, config, account, reading, now),
        limits: thresholds(
          config.accounts.find((a) => a.id === account),
          effectivePolicy(config),
        ),
        // The line goes through a pipe to Claude Code, which draws it in the
        // terminal this process inherited its environment from.
        term: makeTerminal({
          tty: false,
          depth: inheritedDepth(env),
          glyphs: pickGlyphs(env),
          cols: columns,
        }),
      },
    );
  // With the operator's own status line, Baton's line is added to the end of
  // theirs only when the policy says so (appendUsage).
  if (previous)
    return {
      previous,
      usage: effectivePolicy(config).statusLineUsage ? line : null,
    };
  return { text: line(Number(env.COLUMNS) || 0) };
}

// The operator's own status line output with Baton's line added after it, on
// the same (last) line, as far as the terminal is wide: `usage(columns)` is
// Baton's line for the room that is left (it drops its parts to fit), or
// nothing when there is none. Their output is otherwise left as it is.
export function appendUsage(output, usage, columns = 0) {
  const text = String(output ?? "").replace(/\r\n/g, "\n");
  const lines = text.replace(/\n+$/, "").split("\n");
  const last = lines.length - 1;
  const ends = text.endsWith("\n") ? "\n" : "";
  const theirs = text.trim() ? lines[last] : "";
  const room = columns > 0 ? columns - width(clean(theirs)) - 2 : 0;
  if (columns > 0 && room < 1) return output;
  const ours = usage(room);
  if (!ours || (columns > 0 && width(clean(ours)) > room)) return output;
  // Their line may end in an open colour: close it before ours.
  const reset = ours.includes("\x1b") ? "\x1b[0m" : "";
  if (!theirs) return `${ours}\n`;
  lines[last] = `${theirs}${reset}  ${ours}`;
  return lines.join("\n") + ends;
}

// Every account together: how many there are, the mean 5-hour and the mean
// weekly use of those that have a reading (a window past its reset counts as
// 0 used), and per window one cell per account in order ({ used, limit,
// current }, used null when it was never measured). This session's account
// is read from `reading`, the one this very status line run was given, so
// the overall figure is only as old as the other accounts' stored readings.
export function overallUsage(paths, config, account, reading, now) {
  const policy = effectivePolicy(config);
  const readings = config.accounts.map((a) =>
    a.id === account ? reading : readReading(paths, a.id),
  );
  const overall = { count: config.accounts.length, cells: {} };
  for (const window of WINDOWS) {
    const cells = config.accounts.map((a, i) => {
      const limit = thresholds(a, policy)[window];
      const w = windowState({
        window,
        reading: readings[i]?.[window],
        rejection: null,
        threshold: limit,
        now,
        policy,
      });
      return { used: w.reset ? 0 : w.used, limit, current: a.id === account };
    });
    const known = cells.filter((c) => c.used !== null);
    overall[window] = known.length
      ? known.reduce((sum, c) => sum + c.used, 0) / known.length
      : null;
    overall.cells[window] = cells;
  }
  return overall;
}

const pct = (n) => `${Math.round(n)}%`;
const WINDOW_TAG = { five_hour: "5h", seven_day: "week" };
const DEFAULT_LIMITS = { five_hour: 90, seven_day: 95 };

// Baton's own status line (when the operator had none): the baton mark, the
// account and its two windows, then all the accounts together, one little bar
// each (taller the fuller, coloured by its threshold, this account's
// underlined) and their mean:
//   ╺━╸ acct2 · 5h 42% · week 63% │ 5h ▂▇▅▃ 31% · week ▃▅▇▅ 58%
// A narrow terminal drops the overall part first, then the windows. `term`
// decides the glyphs and colours (plain text when it is not styled).
export function ownStatusLine(
  account,
  reading,
  now,
  { columns = 0, overall = null, limits = DEFAULT_LIMITS, term } = {},
) {
  if (!account) return "";
  term ??= makeTerminal({
    tty: false,
    depth: 1,
    glyphs: "rich",
    cols: columns,
  });
  const dot = s(" · ", "muted");
  const figure = (window, used) => [
    s(`${WINDOW_TAG[window]} `, "muted"),
    s(pct(used), usageTone(used, limits[window] ?? DEFAULT_LIMITS[window])),
  ];
  const head = [s(term.g.baton, "brand bold"), s(" "), s(account, "bold")];
  const own = [];
  for (const window of WINDOWS) {
    const w = reading?.[window];
    const resets = ms(w?.resetsAt);
    if (!w || !Number.isFinite(w.used)) continue;
    own.push(
      dot,
      ...(resets !== null && resets <= now
        ? [s(`${WINDOW_TAG[window]} `, "muted"), s("reset", "ok")]
        : figure(window, w.used)),
    );
  }
  // One bar per account: its use as a height, unknown as a dot; this
  // account's, the live one, underlined.
  const ticks = term.g.ticks;
  const bars = (window) =>
    (overall.cells?.[window] ?? []).map(({ used, limit, current }) =>
      used === null
        ? s(term.g.normal, current ? "muted underline" : "muted")
        : s(
            ticks[
              Math.min(
                ticks.length - 1,
                Math.round((Math.max(0, used) / 100) * (ticks.length - 1)),
              )
            ],
            usageTone(used, limit) + (current ? " underline" : ""),
          ),
    );
  const together = [];
  // Only a window that another account has a reading for: otherwise the
  // overall figure would only repeat this account's own.
  const comparable = (window) =>
    overall.cells?.[window]
      ? overall.cells[window].some((c) => !c.current && c.used !== null)
      : true;
  const shown = WINDOWS.filter(
    (window) => overall?.[window] != null && comparable(window),
  );
  if (overall?.count > 1 && shown.length) {
    together.push(s(` ${term.g.limit} `, "muted"));
    shown.forEach((window, i) => {
      if (i) together.push(dot);
      const [tag, value] = figure(window, overall[window]);
      const cells = bars(window);
      together.push(tag, ...cells, ...(cells.length ? [s(" ")] : []), value);
    });
  }
  const fits = (line) => columns <= 0 || lineWidth(line) <= columns;
  const line =
    [head, [...head, ...own], [...head, ...own, ...together]]
      .reverse()
      .find(fits) ?? head;
  return render([line], term);
}

// The shell Claude Code itself runs a status line command in: Git Bash on
// Windows when it is installed (CLAUDE_CODE_GIT_BASH_PATH, or next to git on
// PATH, or the default install), else PowerShell; sh elsewhere.
export function statusLineShell(
  env = process.env,
  platform = process.platform,
) {
  if (platform !== "win32")
    return { command: "/bin/sh", args: (c) => ["-c", c] };
  const candidates = [];
  if (env.CLAUDE_CODE_GIT_BASH_PATH)
    candidates.push(env.CLAUDE_CODE_GIT_BASH_PATH);
  for (const dir of (env.PATH ?? env.Path ?? "")
    .split(delimiter)
    .filter(Boolean)) {
    const clean = dir.replace(/^"|"$/g, "");
    if (existsSync(join(clean, "git.exe")))
      candidates.push(
        resolve(clean, "..", "bin", "bash.exe"),
        resolve(clean, "..", "..", "bin", "bash.exe"),
      );
  }
  for (const root of [env.ProgramFiles, env["ProgramFiles(x86)"]].filter(
    Boolean,
  ))
    candidates.push(join(root, "Git", "bin", "bash.exe"));
  const bash = candidates.find((c) => existsSync(c));
  if (bash) return { command: bash, args: (c) => ["-c", c] };
  return {
    command: "powershell.exe",
    args: (c) => ["-NoProfile", "-NonInteractive", "-Command", c],
  };
}

// Runs the operator's previous status line command with the same stdin.
export function runPreviousStatusLine(
  command,
  stdinText,
  { env = process.env } = {},
) {
  const shell = statusLineShell(env);
  const result = spawnSync(shell.command, shell.args(command), {
    input: stdinText,
    encoding: "utf8",
    env,
    timeout: 15e3,
    windowsHide: true,
    maxBuffer: 1 << 20,
  });
  return { stdout: result.stdout ?? "", code: result.status ?? 1 };
}
