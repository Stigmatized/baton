import { mkdirSync, watch } from "node:fs";
import { createElement } from "react";
import { render } from "ink";
import {
  addAccount,
  moveAccount,
  removeAccount,
  renameAccount,
  setAccount,
  setPolicy,
} from "../accounts.js";
import { resolveClaude } from "../claude-path.js";
import { loadConfig, nameOf } from "../config.js";
import { authStatusAsync, profileEnv } from "../doctor.js";
import { hop } from "../hop.js";
import { Poller } from "../poller.js";
import { PollHost } from "../poll-host.js";
import { pollWords } from "../format.js";
import { linkProfile } from "../profile.js";
import { loadMenuData } from "./data.js";
import { reduce } from "./reducer.js";
import { initialState } from "./state.js";
import { pickGlyphs } from "./theme.js";
import { App } from "./ui/app.js";
import { TerminalInput } from "./input.js";
import { signIn } from "./login.js";
import { tooSmall } from "./layout.js";

// The menu: `baton view`, in a terminal. It reads ~/.baton with
// the same core functions as the CLI, acts through them (accounts.js, the
// policy settings, hop requests), and follows changes live (fs.watch on
// ~/.baton, with the tick every refreshMs as the fallback). State changes go
// through the reducer; Ink draws it on the alternate screen, rewriting only
// the lines that changed. A sign-in suspends the menu: Claude Code's own
// `claude auth login` gets the terminal, then the menu comes back.

const sizeOf = (output) => ({
  cols: output.columns || 80,
  rows: output.rows || 24,
});

// A refresh's outcomes as one toast.
export function refreshSummary(results, now = Date.now()) {
  if (results.length === 1) {
    const [r] = results;
    if (r.status === "ok") {
      const w = r.reading ?? {};
      const parts = [
        w.five_hour ? `5-hour ${Math.round(w.five_hour.used)}%` : null,
        w.seven_day ? `weekly ${Math.round(w.seven_day.used)}%` : null,
      ].filter(Boolean);
      return `${r.name}: ${parts.join(" · ") || "no meters reported"}.`;
    }
    if (r.status === "backoff")
      return `${r.name}: not asked; the usage endpoint asked to wait until ${new Date(r.until).toLocaleTimeString()}.`;
    return `${r.name}: ${pollWords(r, now)}.`;
  }
  const words = {
    ok: "polled",
    "signed-out": "signed out",
    "rate-limited": "rate limited",
    backoff: "waiting out a rate limit",
  };
  const counts = new Map();
  for (const r of results) {
    const w = words[r.status] ?? r.status;
    counts.set(w, (counts.get(w) ?? 0) + 1);
  }
  return `Usage: ${[...counts].map(([w, n]) => `${n} ${w}`).join(" · ") || "no accounts"}.`;
}

// The core operations behind the menu's actions.
export function operations(paths) {
  return {
    // Accounts by id (the menu's rows), new ones by name.
    mark: ({ id, mark }) => setAccount(paths, id, { mark }, { by: "id" }),
    move: ({ id, position }) => moveAccount(paths, id, position, { by: "id" }),
    thresholds: ({ id, fiveHour, weekly }) =>
      setAccount(paths, id, { fiveHour, weekly }, { by: "id" }),
    rename: ({ id, name }) => {
      renameAccount(paths, id, name, { by: "id" });
      return { then: { type: "refresh", account: id, quiet: true } };
    },
    add: ({ name }) => {
      const r = addAccount(paths, name);
      return { then: { type: "signin", account: r.account.id } };
    },
    remove: ({ id }) => removeAccount(paths, id, { by: "id" }),
    policy: ({ changes }) => setPolicy(paths, changes),
    hop: ({ session, to }) => {
      const r = hop(paths, { session, to: to ?? null, toBy: "id", by: "menu" });
      return {
        text: `${r.session.slice(0, 8)} moves from ${r.from} to ${r.to} ${r.between ? "now" : "when its turn ends"}.`,
      };
    },
  };
}

export function createStore({
  paths,
  env = process.env,
  size = { cols: 120, rows: 30 },
  now = Date.now,
  color = true,
  glyphs = "rich",
  load = loadMenuData,
  ops = operations(paths),
  authOf = null,
  signin = async () => 1,
  refresh = null,
  onQuit = () => {},
  onRedraw = () => {},
  splash = false,
}) {
  let state = initialState({ size, now: now(), color, glyphs, splash });
  let closed = false;
  const listeners = new Set();
  function dispatch(action) {
    if (closed) return;
    const out = reduce(state, { now: now(), ...action });
    if (out.state !== state) {
      state = out.state;
      for (const listener of listeners) listener();
    }
    for (const effect of out.effects) perform(effect);
  }
  function reloadNow() {
    try {
      dispatch({ type: "data", data: load(paths, { now: now() }) });
    } catch (error) {
      dispatch({
        type: "applied",
        ok: false,
        text: `Could not read ~/.baton: ${error.message}`,
      });
    }
  }
  async function auth(names) {
    if (!authOf) return;
    await Promise.all(
      names.map(async (name) => {
        const status = await authOf(name);
        dispatch({ type: "auth", account: name, status });
      }),
    );
  }
  function perform(effect) {
    switch (effect.type) {
      case "quit":
        return onQuit();
      case "redraw":
        return onRedraw();
      case "reload":
        return reloadNow();
      case "auth":
        return void auth(
          effect.accounts ?? loadConfig(paths).accounts.map((a) => a.id),
        );
      case "apply": {
        let text = effect.done ?? "Done.";
        let ok = true;
        let then = effect.then ?? null;
        try {
          const out = ops[effect.op](effect.args ?? {});
          if (out?.text) text = out.text;
          if (out?.then) then = out.then;
        } catch (error) {
          ok = false;
          text = error.message;
        }
        dispatch({ type: "applied", ok, text });
        if (ok && then) perform(then);
        return undefined;
      }
      // The usage poller: one account (its id) or all, in this process.
      // quiet: after a rename or a sign-in.
      case "refresh":
        return void (async () => {
          if (!refresh) return;
          const config = loadConfig(paths);
          const who = effect.account
            ? `${nameOf(config, effect.account)}'s`
            : "every account's";
          if (!effect.quiet)
            dispatch({
              type: "applied",
              ok: true,
              text: `Asking ${who} usage.`,
            });
          try {
            const out = await refresh(effect.account ?? null);
            if (effect.quiet) dispatch({ type: "tick" });
            else
              dispatch({
                type: "applied",
                ok: true,
                text: refreshSummary(
                  Array.isArray(out) ? out : (out?.results ?? []),
                ),
              });
          } catch (error) {
            if (effect.quiet) dispatch({ type: "tick" });
            else
              dispatch({
                type: "applied",
                ok: false,
                text: `Could not ask ${who} usage: ${error.message}`,
              });
          }
        })();
      case "signin":
        return void (async () => {
          const name = nameOf(loadConfig(paths), effect.account);
          dispatch({ type: "busy", busy: `signing in ${name}` });
          let code = 1;
          try {
            code = await signin(effect.account);
          } catch {
            code = 1;
          }
          dispatch({ type: "busy", busy: null });
          dispatch({
            type: "applied",
            ok: code === 0,
            text:
              code === 0
                ? `${name}: Claude Code's sign-in finished.`
                : `${name}: the sign-in did not finish (code ${code}).`,
          });
          await auth([effect.account]);
          if (code === 0)
            perform({ type: "refresh", account: effect.account, quiet: true });
        })();
      default:
        return undefined;
    }
  }
  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    dispatch,
    perform,
    close() {
      closed = true;
      listeners.clear();
    },
  };
}

const wrapOff = "\x1b[?7l";
const wrapOn = "\x1b[?7h";
const mouseOn = "\x1b[?1000h\x1b[?1006h";
const mouseOff = "\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l";
const signals = { SIGTERM: 143, SIGHUP: 129, SIGBREAK: 149 };

export function runMenu({
  paths,
  env = process.env,
  input = process.stdin,
  output = process.stdout,
  refreshMs = 2000,
  watchMs = 120,
  now = Date.now,
  color = !env.NO_COLOR,
  glyphs = pickGlyphs(env),
  launcher = null,
  loginStdio = "inherit",
  handleSignals = false,
  ink = {},
  splash = env.BATON_SPLASH !== "off",
  mouse = env.BATON_MOUSE !== "off",
  // The menu is a baton instance: while it runs it takes its turn at the
  // usage poll (poll-host.js); poll: false (tests) leaves it out.
  poll = true,
  refresh = null,
}) {
  let host = null;
  const usage = () =>
    host?.poller ??
    new Poller({ paths, env, ...(launcher ? { launcher } : {}) });
  refresh ??= (account) => usage().refresh({ account, reason: "menu" });
  return new Promise((resolve, reject) => {
    const tty = Boolean(output.isTTY);
    let closed = false;
    let timer = null;
    let instance = null;
    let watcher = null;
    let debounce = null;
    const onMouse = (event) => {
      if (mouse && tty && !closed) {
        try {
          store.dispatch({ type: "mouse", ...event });
        } catch (error) {
          finish(error);
        }
      }
    };
    let keys = new TerminalInput(input, { onMouse });
    const cleanups = [];
    const claude = () =>
      launcher ??
      resolveClaude({
        configured: loadConfig(paths).claudePath,
        env,
        home: paths.home,
      });
    const restoreWrap = () => {
      if (!tty) return;
      try {
        output.write(mouseOff + wrapOn);
      } catch {
        // the terminal may be gone
      }
    };
    const draw = () => {
      if (tty) output.write(wrapOff);
      instance = render(createElement(App, { store }), {
        stdout: output,
        stdin: keys,
        exitOnCtrlC: false,
        patchConsole: false,
        alternateScreen: true,
        incrementalRendering: true,
        interactive: tty,
        maxFps: 30,
        ...ink,
      });
      if (tty && mouse) output.write(mouseOn);
    };
    function finish(error) {
      if (closed) return;
      closed = true;
      // The poll goes with the menu: its lease, and a read in progress.
      const stopping = host ? host.stop() : Promise.resolve();
      clearInterval(timer);
      clearTimeout(debounce);
      watcher?.close();
      for (const cleanup of cleanups) cleanup();
      store.close();
      try {
        instance?.unmount();
      } catch {
        // unmounting a broken tree
      }
      keys.close();
      restoreWrap();
      stopping
        .catch(() => {})
        .finally(() => (error ? reject(error) : resolve(0)));
    }
    // Claude Code's own sign-in with the terminal: the menu steps aside
    // (the main screen back, raw mode off, its input let go) and returns.
    async function signin(account) {
      try {
        linkProfile(paths, account);
      } catch {
        // doctor reports it
      }
      const l = claude();
      instance?.unmount();
      keys.close();
      restoreWrap();
      try {
        return await signIn({
          launcher: l,
          env: profileEnv(paths, account, env),
          name: nameOf(loadConfig(paths), account),
          output,
          stdio: loginStdio,
          color,
          glyphs,
        });
      } finally {
        if (!closed) {
          keys = new TerminalInput(input, { onMouse });
          draw();
          store.dispatch({ type: "resize", ...sizeOf(output) });
        }
      }
    }
    const authOf = async (name) => {
      try {
        return await authStatusAsync(claude(), profileEnv(paths, name, env));
      } catch (error) {
        return { ok: false, error: error.message };
      }
    };
    const store = createStore({
      paths,
      env,
      size: sizeOf(output),
      now,
      color,
      glyphs,
      splash: tty && splash,
      authOf,
      signin,
      refresh,
      onQuit: () => finish(),
      onRedraw: () => {
        instance?.clear();
        instance?.rerender(createElement(App, { store }));
      },
    });
    const guard =
      (fn) =>
      (...args) => {
        try {
          return fn(...args);
        } catch (error) {
          finish(error);
        }
      };
    try {
      draw();
      const resized = guard(() => {
        const size = sizeOf(output);
        const { cols, rows } = store.getState().size;
        if (size.cols !== cols || size.rows !== rows)
          store.dispatch({ type: "resize", ...size });
      });
      output.on?.("resize", resized);
      cleanups.push(() => output.off?.("resize", resized));
      if (handleSignals) {
        process.on("exit", restoreWrap);
        cleanups.push(() => process.off("exit", restoreWrap));
        for (const [signal, code] of Object.entries(signals)) {
          const stop = () => {
            finish();
            process.exit(code);
          };
          process.on(signal, stop);
          cleanups.push(() => process.off(signal, stop));
        }
      }
      // Live: a change under ~/.baton reads it again at once; the tick also
      // moves the clock and the countdowns, and notices a new size.
      try {
        mkdirSync(paths.root, { recursive: true });
        watcher = watch(paths.root, { recursive: true }, () => {
          clearTimeout(debounce);
          debounce = setTimeout(
            guard(() => store.dispatch({ type: "tick" })),
            watchMs,
          );
        });
        watcher.on("error", () => {});
      } catch {
        watcher = null;
      }
      timer = setInterval(
        guard(() => {
          resized();
          store.dispatch({ type: "tick" });
        }),
        refreshMs,
      );
      store.dispatch({ type: "tick" });
      store.perform({ type: "auth" });
      const startPolling = () => {
        if (
          !poll ||
          host ||
          store.getState().splash ||
          tooSmall(store.getState())
        )
          return;
        let own = null;
        try {
          own = claude();
        } catch {
          own = null; // the poller finds claude itself, or records why not
        }
        host = new PollHost({ paths, kind: "menu", env, launcher: own });
        host.start();
      };
      cleanups.push(store.subscribe(startPolling));
      startPolling();
    } catch (error) {
      finish(error);
    }
  });
}
