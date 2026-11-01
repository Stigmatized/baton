// Reading and rebuilding Claude Code's command line (2.1.302's `claude
// --help`). Baton needs to know which conversation a launch opens, whether the
// launch is an interactive session at all, and what to pass again when it
// resumes the conversation under another account: `claude --resume <id>`
// restores the conversation, its model and (from a terminal) its permission
// mode, but not --mcp-config, --settings, --plugin-dir, --fallback-model or
// --add-dir, so everything but the session selection and the first prompt is
// passed again, with the session's live model, effort and permission mode
// where Baton saw them change.

const BOOLEAN = [
  "--allow-dangerously-skip-permissions",
  "--ax-screen-reader",
  "--bg",
  "--background",
  "--bare",
  "--brief",
  "--chrome",
  "-c",
  "--continue",
  "--dangerously-skip-permissions",
  "--desktop",
  "--disable-slash-commands",
  "--exclude-dynamic-system-prompt-sections",
  "--fork-session",
  "--forward-subagent-text",
  "-h",
  "--help",
  "--ide",
  "--include-hook-events",
  "--include-partial-messages",
  "--no-chrome",
  "--no-session-persistence",
  "-p",
  "--print",
  "--replay-user-messages",
  "--restricted",
  "--safe-mode",
  "--strict-mcp-config",
  "--tmux",
  "--verbose",
  "-v",
  "--version",
];
const VALUE = [
  "--agent",
  "--agents",
  "--append-system-prompt",
  "--append-system-prompt-file",
  "--autocompact",
  "--debug-file",
  "--effort",
  "--environment",
  "--fallback-model",
  "--input-format",
  "--json-schema",
  "--max-budget-usd",
  "--max-turns",
  "--model",
  "-n",
  "--name",
  "--output-format",
  "--permission-mode",
  "--permission-prompt-tool",
  "--permission-prompts",
  "--plugin-dir",
  "--plugin-url",
  "--remote-control-session-name-prefix",
  "--session-id",
  "--setting-sources",
  "--settings",
  "--system-prompt",
  "--system-prompt-file",
  "--system-prompt-snapshot",
];
const OPTIONAL = [
  "--cloud",
  "-d",
  "--debug",
  "--from-pr",
  "--prompt-suggestions",
  "--remote-control",
  "-r",
  "--resume",
  "--teleport",
  "-w",
  "--worktree",
];
const VARIADIC = [
  "--add-dir",
  "--allowedTools",
  "--allowed-tools",
  "--betas",
  "--disallowedTools",
  "--disallowed-tools",
  "--file",
  "--mcp-config",
  "--tools",
];
const SUBCOMMANDS = [
  "agents",
  "attach",
  "auth",
  "auto-mode",
  "doctor",
  "gateway",
  "help",
  "import",
  "install",
  "kill",
  "logs",
  "mcp",
  "plugin",
  "plugins",
  "purge",
  "respawn",
  "rm",
  "setup-token",
  "stop",
  "ultrareview",
  "update",
  "upgrade",
];
const ALIASES = {
  "-c": "--continue",
  "-d": "--debug",
  "-h": "--help",
  "-n": "--name",
  "-p": "--print",
  "-r": "--resume",
  "-v": "--version",
  "-w": "--worktree",
  "--background": "--bg",
  "--allowed-tools": "--allowedTools",
  "--disallowed-tools": "--disallowedTools",
};
const kind = (flag) =>
  BOOLEAN.includes(flag)
    ? "boolean"
    : VALUE.includes(flag)
      ? "value"
      : OPTIONAL.includes(flag)
        ? "optional"
        : VARIADIC.includes(flag)
          ? "variadic"
          : "unknown";

const isFlag = (token) =>
  typeof token === "string" && token.startsWith("-") && token !== "-";

// parseClaudeArgs(args) -> { options: [{ flag, name, values, raw }], positionals,
//   subcommand, session: { mode: new|resume|continue|picker|fork, id }, interactive }
export function parseClaudeArgs(args) {
  const options = [];
  const positionals = [];
  let subcommand = null;
  for (let i = 0; i < args.length; i++) {
    const token = args[i];
    if (token === "--") {
      positionals.push(...args.slice(i + 1));
      break;
    }
    if (!isFlag(token)) {
      if (
        !options.length &&
        !positionals.length &&
        SUBCOMMANDS.includes(token)
      ) {
        subcommand = token;
        positionals.push(...args.slice(i + 1));
        break;
      }
      positionals.push(token);
      continue;
    }
    const eq = token.startsWith("--") ? token.indexOf("=") : -1;
    const flag = eq > 0 ? token.slice(0, eq) : token;
    const name = ALIASES[flag] ?? flag;
    const raw = [token];
    const values = [];
    const k = kind(flag);
    if (eq > 0) values.push(token.slice(eq + 1));
    else if (k === "value") {
      if (i + 1 < args.length) {
        values.push(args[++i]);
        raw.push(args[i]);
      }
    } else if (k === "optional") {
      if (i + 1 < args.length && !isFlag(args[i + 1])) {
        values.push(args[++i]);
        raw.push(args[i]);
      }
    } else if (k === "variadic") {
      while (i + 1 < args.length && !isFlag(args[i + 1])) {
        values.push(args[++i]);
        raw.push(args[i]);
      }
    }
    options.push({ flag, name, values, raw });
  }
  const has = (n) => options.some((o) => o.name === n);
  const value = (n) => options.findLast((o) => o.name === n)?.values[0];
  let session = { mode: "new", id: value("--session-id") ?? null };
  if (has("--resume")) {
    const target = value("--resume");
    session = target
      ? { mode: "resume", id: target }
      : { mode: "picker", id: null };
  } else if (has("--continue")) session = { mode: "continue", id: null };
  if (has("--fork-session") && session.mode !== "new")
    session = { mode: "fork", id: null };
  const passthrough =
    !!subcommand ||
    [
      "--print",
      "--help",
      "--version",
      "--bg",
      "--desktop",
      "--cloud",
      "--teleport",
      "--from-pr",
    ].some(has);
  return {
    options,
    positionals,
    subcommand,
    session,
    interactive: !passthrough,
  };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isSessionId = (id) => typeof id === "string" && UUID.test(id);

// Options that pick or create the conversation, or only apply to the first
// launch: not passed again on a resume.
const DROP_ON_RESUME = [
  "--continue",
  "--resume",
  "--session-id",
  "--fork-session",
  "--from-pr",
  "--worktree",
  "--tmux",
  "--name",
  "--teleport",
];

// The command line that resumes `sessionId`, keeping the original options.
// live: { model, effort, permissionMode } as last seen for the session.
//  - --model / --effort keep their flag but take the live value;
//  - a live permission mode replaces --permission-mode; bypassPermissions
//    (which a terminal resume does not restore) is passed again explicitly,
//    and --dangerously-skip-permissions is turned into
//    --allow-dangerously-skip-permissions when the session left bypass mode.
export function resumeArgs(parsed, sessionId, prompt = null, live = {}) {
  const out = [];
  const mode = live.permissionMode
    ? live.permissionMode === "default"
      ? "manual"
      : live.permissionMode
    : null;
  let allowBypass = false;
  for (const option of parsed.options) {
    if (DROP_ON_RESUME.includes(option.name)) continue;
    if (option.name === "--model" && live.model) {
      out.push("--model", live.model);
      continue;
    }
    if (option.name === "--effort" && live.effort) {
      out.push("--effort", live.effort);
      continue;
    }
    if (mode && option.name === "--permission-mode") continue;
    if (mode && option.name === "--dangerously-skip-permissions") {
      if (mode !== "bypassPermissions") allowBypass = true;
      else out.push(...option.raw);
      continue;
    }
    if (option.name === "--allow-dangerously-skip-permissions")
      allowBypass = false;
    out.push(...option.raw);
  }
  if (allowBypass && !out.includes("--allow-dangerously-skip-permissions"))
    out.push("--allow-dangerously-skip-permissions");
  if (live.effort && !parsed.options.some((o) => o.name === "--effort"))
    out.push("--effort", live.effort);
  if (mode) {
    const bypassForced = out.includes("--dangerously-skip-permissions");
    if (!(mode === "bypassPermissions" && bypassForced))
      out.push("--permission-mode", mode);
  }
  // --resume last before the prompt: it ends a preceding variadic option
  // (--add-dir a b) and the prompt then reads as the positional prompt.
  out.push("--resume", sessionId);
  if (prompt) out.push(prompt);
  return out;
}
