import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { iso, lowerPriority, ms } from "./fsutil.js";
import { profileDir, profileEnv } from "./paths.js";
import { forceKill, waitExit } from "./terminate.js";
import { isWeeklyMeter, parseTimeAfter } from "./usage.js";

// One account's plan usage, read the documented way without credentials: an
// Agent SDK session under the account's profile whose prompt is "/usage".
// Claude Code answers a /usage command locally with a synthetic assistant
// message; from Claude Code 2.1.273 (Agent SDK 0.3.273) that message carries
// usage_report, the structured twin of the text: rate_limits.limits[] (the
// usage endpoint's meters: kind, group, percent, resets_at, scope, severity,
// is_active) and extra_usage. rate_limits is null when the plan usage could
// not be fetched (the endpoint failing or rate limited, a token without the
// profile scope), and usage_report is absent outside claude.ai plans.
//
// The session is made to touch nothing: the installed claude
// (pathToClaudeCodeExecutable), no settings sources (so no hooks, no status
// line and no plugins: Baton's own hooks do not run), no tools, no MCP
// servers, one turn at most, no session persistence, in a folder of its
// own (~/.baton/probe) whose transcripts, should any appear, are deleted. It
// is ended after timeoutMs, its whole process tree with it.

export const PROBE_TIMEOUT_MS = 60e3;
const TIMEOUT = Symbol("timeout");
const STOPPED = Symbol("stopped");

// What a Claude Code that started Baton leaves in the environment, and
// credentials or endpoints from the environment that would answer for
// another account than the profile's sign-in (only the names are looked at).
const DROPPED =
  /^(CLAUDECODE|CLAUDE_CODE_ENTRYPOINT|CLAUDE_CODE_SESSION_ID|CLAUDE_CODE_SSE_PORT|BATON_WRAPPER|CLAUDE_CODE_OAUTH_TOKEN|ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN|ANTHROPIC_BASE_URL)$/i;
export function probeEnv(paths, id, env) {
  const out = profileEnv(paths, id, env);
  for (const key of Object.keys(out)) if (DROPPED.test(key)) delete out[key];
  return out;
}

export const probeDir = (paths) => join(paths.root, "probe");

// Claude Code keeps a folder's transcripts in <config>/projects/<the folder
// with every character but letters and digits as "-">; a long one is cut
// at 200 characters and given a hash.
export const projectDirName = (cwd) => cwd.replace(/[^a-zA-Z0-9]/g, "-");
export function removeProbeTranscripts(paths, id, cwd = probeDir(paths)) {
  const name = projectDirName(cwd);
  // Only ever the probe's own folder.
  if (!/-baton-probe$/i.test(name)) return [];
  const removed = [];
  // The profile's projects/ (a link into the shared base): only the
  // probe's own folder in it.
  const bases = [join(profileDir(paths, id), "projects")];
  for (const base of bases) {
    let entries = [];
    try {
      entries = readdirSync(base);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const lower = entry.toLowerCase();
      const ours =
        lower === name.toLowerCase() ||
        (name.length > 200 &&
          lower.startsWith(name.slice(0, 200).toLowerCase()));
      if (!ours) continue;
      const dir = join(base, entry);
      if (!existsSync(dir)) continue;
      rmSync(dir, { recursive: true, force: true });
      removed.push(dir);
    }
  }
  return removed;
}

const oneLine = (text, max = 200) =>
  String(text ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
const str = (v, max = 64) =>
  typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null;
const num = (v) =>
  Number.isFinite(Number(v)) && v !== null ? Number(v) : null;

// A meter of the usage endpoint as Baton keeps it.
function meter(row) {
  if (!row || typeof row !== "object") return null;
  const used = Number(row.percent);
  if (row.percent === null || !Number.isFinite(used)) return null;
  return {
    kind: str(row.kind) ?? "unknown",
    group: str(row.group),
    label:
      str(row.scope?.model?.display_name) ??
      str(row.scope?.surface?.display_name),
    used,
    resetsAt: iso(ms(row.resets_at)),
    severity: str(row.severity, 32),
    active: row.is_active === true,
  };
}
const fullest = (rows) =>
  rows.reduce((a, b) => (!a || b.used > a.used ? b : a), null);

// usage_report (and the /usage text beside it) as an outcome:
//   { status: "ok", reading: { five_hour, seven_day }, limits, extraUsage }
//   { status: "rate-limited", until (epoch ms or null), reason }
//   { status: "unavailable", reason }
//   { status: "signed-out", reason }
// five_hour is the "session" meter, seven_day the all-models weekly one
// ("weekly_all"); every meter is kept in limits (a model's own weekly limit
// among them), where the policy finds the strictest weekly limit.
export function usageFromReport(report, { text = "", at = Date.now() } = {}) {
  const words = oneLine(text);
  const limits = report?.rate_limits?.limits;
  if (!Array.isArray(limits)) {
    if (/rate.?limited/i.test(text)) {
      const until = parseTimeAfter(text, "until", at);
      return {
        status: "rate-limited",
        until: until && until > at ? until : null,
        reason: words || "the usage endpoint is rate limited",
      };
    }
    if (/not logged in|please run \/login|\/login\b/i.test(text))
      return { status: "signed-out", reason: words || "not signed in" };
    return {
      status: "unavailable",
      reason:
        report === undefined
          ? words
            ? `no usage report (${words})`
            : "Claude Code sent no usage report (not a claude.ai plan, or too old)"
          : words || "the plan usage could not be fetched",
    };
  }
  const rows = limits.map(meter).filter(Boolean);
  const five =
    fullest(rows.filter((r) => r.kind === "session")) ??
    fullest(rows.filter((r) => r.group === "session" && !r.label));
  const week =
    fullest(rows.filter((r) => r.kind === "weekly_all")) ??
    fullest(rows.filter((r) => isWeeklyMeter(r) && !r.label));
  const reading = {};
  if (five) reading.five_hour = { used: five.used, resetsAt: five.resetsAt };
  if (week) reading.seven_day = { used: week.used, resetsAt: week.resetsAt };
  const extra = report.rate_limits.extra_usage;
  return {
    status: "ok",
    reading,
    limits: rows,
    extraUsage:
      extra && typeof extra === "object"
        ? {
            enabled: extra.is_enabled === true,
            monthlyLimit: num(extra.monthly_limit),
            usedCredits: num(extra.used_credits),
            utilization: num(extra.utilization),
            currency: str(extra.currency, 8),
          }
        : null,
  };
}

const textOf = (message) => {
  const content = message?.message?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((b) => b?.type === "text" && typeof b.text === "string")
    .map((b) => b.text)
    .join("\n");
};

let sdk = null;
const sdkQuery = async () => {
  sdk ??= await import("@anthropic-ai/claude-agent-sdk");
  return sdk.query;
};

// Reads one account's usage. Resolves with an outcome (never rejects):
// usageFromReport's, or { status: "timeout" | "failed", reason }.
export async function readPlanUsage({
  paths,
  id,
  env = process.env,
  claudePath,
  query = null,
  timeoutMs = PROBE_TIMEOUT_MS,
  now = Date.now,
  platform = process.platform,
  signal = null,
  low = false,
}) {
  const cwd = probeDir(paths);
  let child = null;
  let q = null;
  let report;
  let reply = null;
  let result = null;
  let failure = null;
  let timedOut = false;
  let stopped = false;
  let timer = null;
  const abort = new AbortController();
  const stderr = [];
  try {
    mkdirSync(cwd, { recursive: true });
    const run = query ?? (await sdkQuery());
    q = run({
      prompt: "/usage",
      options: {
        cwd,
        env: probeEnv(paths, id, env),
        pathToClaudeCodeExecutable: claudePath,
        persistSession: false,
        settingSources: [],
        strictMcpConfig: true,
        mcpServers: {},
        tools: [],
        maxTurns: 1,
        abortController: abort,
        // Spawned here so that a hang can end the whole tree.
        spawnClaudeCodeProcess: ({ command, args, cwd: dir, env: vars }) => {
          child = spawn(command === "node" ? process.execPath : command, args, {
            cwd: dir,
            env: vars,
            stdio: ["pipe", "pipe", "pipe"],
            windowsHide: true,
          });
          child.on("error", () => {});
          if (low) lowerPriority(child.pid);
          child.stderr.on("data", (chunk) => {
            stderr.push(String(chunk));
            if (stderr.length > 20) stderr.shift();
          });
          return child;
        },
      },
    });
    const deadline = new Promise((resolve) => {
      timer = setTimeout(() => resolve(TIMEOUT), timeoutMs);
      if (signal?.aborted) resolve(STOPPED);
      signal?.addEventListener("abort", () => resolve(STOPPED), {
        once: true,
      });
    });
    const messages = q[Symbol.asyncIterator]();
    for (;;) {
      const next = messages.next();
      next.catch(() => {});
      const step = await Promise.race([next, deadline]);
      if (step === TIMEOUT || step === STOPPED) {
        timedOut = step === TIMEOUT;
        stopped = step === STOPPED;
        break;
      }
      if (step.done) break;
      const m = step.value;
      if (m?.type === "assistant") {
        if (m.usage_report !== undefined && report === undefined) {
          report = m.usage_report;
          reply = textOf(m);
        } else if (reply === null) reply = textOf(m);
      } else if (m?.type === "result") {
        result = m;
        break;
      }
    }
  } catch (error) {
    failure = error;
  } finally {
    clearTimeout(timer);
    if (timedOut || stopped || failure) {
      abort.abort();
      if (child) forceKill(child, platform);
    }
    try {
      q?.close?.();
    } catch {
      // already closed
    }
    if (child && !(await waitExit(child, 5000))) {
      forceKill(child, platform);
      await waitExit(child, 5000);
    }
    try {
      removeProbeTranscripts(paths, id, cwd);
    } catch {
      // the next read tries again
    }
  }
  if (stopped) return { status: "stopped", reason: "stopped" };
  if (timedOut)
    return {
      status: "timeout",
      reason: `no answer in ${Math.round(timeoutMs / 1000)} s; claude was ended`,
    };
  if (failure && report === undefined)
    return {
      status: "failed",
      reason:
        oneLine(failure?.message ?? failure) ||
        oneLine(stderr.join("")) ||
        "claude failed",
    };
  const text =
    reply ?? (typeof result?.result === "string" ? result.result : "");
  if (report === undefined && result?.is_error && !text)
    return {
      status: "failed",
      reason: oneLine(result.subtype) || "claude failed",
    };
  return usageFromReport(report, { text, at: now() });
}
