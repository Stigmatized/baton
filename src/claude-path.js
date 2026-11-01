import {
  accessSync,
  constants,
  existsSync,
  readFileSync,
  statSync,
} from "node:fs";
import {
  delimiter,
  dirname,
  extname,
  isAbsolute,
  join,
  resolve,
} from "node:path";

// How to start the Claude Code CLI without a shell. On Windows a name on PATH
// resolves in PATHEXT order per folder (the WinGet and native installs put a
// real claude.exe there); an npm .cmd shim cannot be spawned without a shell,
// so its target is read from the shim and run directly (node + cli.js, or the
// package's claude.exe). Elsewhere the first executable `claude` on PATH.

export class ClaudeNotFound extends Error {}

const isFile = (p) => {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
};

export function findOnPath(
  name,
  { env = process.env, platform = process.platform } = {},
) {
  const dirs = (env.PATH ?? env.Path ?? "")
    .split(platform === "win32" ? ";" : delimiter)
    .map((d) => d.replace(/^"|"$/g, ""))
    .filter(Boolean);
  if (platform === "win32") {
    const exts = extname(name)
      ? [""]
      : (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD")
          .split(";")
          .filter(Boolean)
          .map((e) => e.toLowerCase());
    for (const dir of dirs)
      for (const ext of exts) {
        const candidate = join(dir, name + ext);
        if (isFile(candidate)) return candidate;
      }
    return null;
  }
  for (const dir of dirs) {
    const candidate = join(dir, name);
    try {
      accessSync(candidate, constants.X_OK);
      if (isFile(candidate)) return candidate;
    } catch {
      // not here
    }
  }
  return null;
}

// The target an npm cmd shim runs: "%dp0%\node_modules\...\cli.js" or ...\claude.exe.
export function shimTarget(shimPath) {
  let text = "";
  try {
    text = readFileSync(shimPath, "utf8");
  } catch {
    return null;
  }
  const dir = dirname(shimPath);
  const found = [
    ...text.matchAll(/"?%~?dp0%?\\?([^"%\r\n]+?\.(?:js|cjs|mjs|exe))"?/gi),
  ]
    .map((m) => resolve(dir, m[1]))
    .filter(existsSync);
  const exe = found.find((p) => /\.exe$/i.test(p));
  if (exe) return exe;
  const script = found.find((p) => /\.[cm]?js$/i.test(p));
  if (script) return script;
  for (const guess of [
    join(
      dir,
      "node_modules",
      "@anthropic-ai",
      "claude-code",
      "bin",
      "claude.exe",
    ),
    join(dir, "node_modules", "@anthropic-ai", "claude-code", "cli.js"),
  ])
    if (existsSync(guess)) return guess;
  return null;
}

const launch = (path, nodePath) =>
  /\.[cm]?js$/i.test(path)
    ? { command: nodePath, prefix: [path], path }
    : { command: path, prefix: [], path };

// { command, prefix, path }: spawn(command, [...prefix, ...args]).
export function resolveClaude({
  configured = null,
  env = process.env,
  platform = process.platform,
  nodePath = process.execPath,
  home = null,
} = {}) {
  const explicit = configured || env.BATON_CLAUDE || null;
  if (explicit) {
    const path = isAbsolute(explicit)
      ? explicit
      : findOnPath(explicit, { env, platform });
    if (!path || !existsSync(path))
      throw new ClaudeNotFound(`Claude Code not found at ${explicit}.`);
    if (platform === "win32" && /\.(cmd|bat)$/i.test(path)) {
      const target = shimTarget(path);
      if (!target)
        throw new ClaudeNotFound(
          `Cannot run the shell shim ${path} without a shell.`,
        );
      return launch(target, nodePath);
    }
    return launch(path, nodePath);
  }
  let path = findOnPath("claude", { env, platform });
  if (!path && home) {
    // The native installer's location, when a terminal did not get it on PATH.
    const native = join(
      home,
      ".local",
      "bin",
      platform === "win32" ? "claude.exe" : "claude",
    );
    if (isFile(native)) path = native;
  }
  if (!path) throw new ClaudeNotFound("Claude Code (claude) is not on PATH.");
  if (platform === "win32" && /\.(cmd|bat)$/i.test(path)) {
    const target = shimTarget(path);
    if (!target)
      throw new ClaudeNotFound(
        `Cannot run the shell shim ${path} without a shell.`,
      );
    return launch(target, nodePath);
  }
  return launch(path, nodePath);
}
