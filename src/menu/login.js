import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { renderToString } from "ink";
import { clean } from "./text.js";
import { pickGlyphs } from "./theme.js";
import { sidebarCols, tooSmall } from "./layout.js";
import { h } from "./ui/kit.js";
import { LoginScreen } from "./ui/login.js";

// Only public authorization links belong in the UI. Never show arbitrary
// child output, credentials, callbacks or token-bearing URLs.
function authorizationUrl(text) {
  for (const candidate of text.matchAll(/https:\/\/[^\s<>"']+/g)) {
    try {
      const url = new URL(candidate[0]);
      if (
        !/(^|\.)(claude\.ai|claude\.com|anthropic\.com)$/.test(url.hostname) ||
        !/^\/(?:oauth\/)?authorize\/?$/.test(url.pathname) ||
        url.username ||
        url.password ||
        url.hash
      )
        continue;
      if (
        [...url.searchParams].some(
          ([key, value]) =>
            /token|secret|password/i.test(key) ||
            (key === "code" && !["true", "false"].includes(value)),
        )
      )
        continue;
      return url.href;
    } catch {
      // Ignore anything that is not a public authorization URL.
    }
  }
  return null;
}

export function createLoginOutput(onUpdate) {
  const decoder = new StringDecoder("utf8");
  let pending = "",
    url = null,
    codePrompt = false;
  function inspect(text) {
    const visible = clean(text);
    const found = authorizationUrl(visible);
    const prompt =
      /(?:paste|enter)[^\n]{0,80}(?:authorization|verification|code)|(?:authorization|verification) code/i.test(
        visible,
      );
    if ((!found || found === url) && (!prompt || codePrompt)) return;
    url = found ?? url;
    codePrompt ||= prompt;
    onUpdate({ url, codePrompt });
  }
  return {
    push(chunk) {
      pending += decoder.write(chunk);
      const lines = pending.split(/\r?\n/);
      pending = lines.pop().slice(-32768);
      for (const line of lines) inspect(line);
      // A prompt need not end with a newline. URLs wait for a full line.
      if (/(?:paste|enter)[^\n]{0,80}code/i.test(clean(pending)))
        inspect(pending.replace(/https:\/\/\S+/g, ""));
    },
    end() {
      inspect(pending + decoder.end());
      pending = "";
    },
  };
}

// Claude Code owns browser authentication and reads verification input
// directly from the terminal. Only its public link and prompt state reach
// the branded frame; no raw output or verification input is retained.
export async function signIn({
  launcher,
  env,
  name,
  output = process.stdout,
  stdio = "inherit",
  color = true,
  glyphs = pickGlyphs(env),
}) {
  const tty = Boolean(output.isTTY);
  let login = { url: null, codePrompt: false };
  const draw = () => {
    if (!tty) return;
    const state = {
      size: { cols: output.columns || 100, rows: output.rows || 28 },
      color,
      glyphs,
    };
    const frame = renderToString(h(LoginScreen, { state, name, ...login }), {
      columns: state.size.cols,
    });
    output.write("\x1b[?25l\x1b[H" + frame.replace(/\n/g, "\r\n"));
    if (login.codePrompt && !tooSmall(state))
      output.write(`\x1b[${state.size.rows - 3};${sidebarCols + 6}H\x1b[?25h`);
  };
  if (tty) {
    output.write("\x1b[?1049h\x1b[?7l\x1b[2J\x1b[H");
    output.on("resize", draw);
    draw();
  }
  const interrupted = () => {};
  process.on("SIGINT", interrupted);
  try {
    return await new Promise((done) => {
      const child = spawn(
        launcher.command,
        [...launcher.prefix, "auth", "login"],
        {
          env,
          stdio: tty
            ? [stdio === "ignore" ? "ignore" : "inherit", "pipe", "pipe"]
            : stdio,
          shell: false,
        },
      );
      const observe = (update) => {
        login = {
          url: update.url ?? login.url,
          codePrompt: login.codePrompt || update.codePrompt,
        };
        draw();
      };
      const stdout = tty ? createLoginOutput(observe) : null;
      const stderr = tty ? createLoginOutput(observe) : null;
      child.stdout?.on("data", (chunk) => stdout?.push(chunk));
      child.stderr?.on("data", (chunk) => stderr?.push(chunk));
      child.once("close", (code) => {
        stdout?.end();
        stderr?.end();
        done(code ?? 1);
      });
      child.once("error", () => done(1));
    });
  } finally {
    process.off("SIGINT", interrupted);
    if (tty) {
      output.off("resize", draw);
      output.write("\x1b[0m\x1b[?25h\x1b[?1049l\x1b[?7h");
    }
  }
}
