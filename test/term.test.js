import test from "node:test";
import assert from "node:assert/strict";
import { main } from "../src/cli.js";
import { s } from "../src/menu/lines.js";
import {
  errorText,
  notice,
  render,
  terminalFor,
  tildify,
} from "../src/term.js";
import { Collect, tempHome, testEnv } from "./helpers.js";

// A stream that says it is a terminal of `depth` colours.
class Tty extends Collect {
  constructor(depth, columns = 100) {
    super();
    this.isTTY = true;
    this.columns = columns;
    this.getColorDepth = () => depth;
  }
}

const strip = (text) => text.replace(/\x1b\[[0-9;]*m/g, "");

test("a pipe gets plain text; a terminal gets the menu's palette at its depth", () => {
  const line = [[s("Ready", "ok bold"), s(" now", "muted")]];
  const pipe = terminalFor(new Collect(), {});
  assert.equal(pipe.styled, false);
  assert.equal(render(line, pipe), "Ready now");

  const truecolor = terminalFor(new Tty(24), {});
  // ok is #92ae99, bold first; muted is #7e858e.
  assert.equal(
    render(line, truecolor),
    "\x1b[1;38;2;146;174;153mReady\x1b[0m\x1b[38;2;126;133;142m now\x1b[0m",
  );
  assert.match(render(line, terminalFor(new Tty(8), {})), /\x1b\[1;38;5;\d+m/);
  assert.match(render(line, terminalFor(new Tty(4), {})), /\x1b\[1;(3|9)\dm/);
  // NO_COLOR (Node reports depth 1) and a dumb terminal: no escapes at all.
  assert.equal(render(line, terminalFor(new Tty(1), {})), "Ready now");
});

test("FORCE_COLOR styles a pipe, NO_COLOR does not", () => {
  assert.equal(terminalFor(new Collect(), { FORCE_COLOR: "1" }).styled, true);
  assert.equal(
    terminalFor(new Collect(), { FORCE_COLOR: "1", NO_COLOR: "1" }).styled,
    false,
  );
  assert.equal(terminalFor(new Collect(), { FORCE_COLOR: "0" }).styled, false);
});

test("neighbouring spans of one style share one escape; plain lines lose trailing blanks", () => {
  const term = terminalFor(new Tty(24), {});
  const out = render(
    [[s("a ", "bold"), s("b", "bold"), s(" c", "muted")]],
    term,
  );
  assert.equal(out.match(/\x1b\[1m/g).length, 1);
  assert.equal(strip(out), "a b c");
  assert.equal(
    render([[s("text   ")]], terminalFor(new Collect(), {})),
    "text",
  );
});

test("the layout is as wide as the terminal, within reason", () => {
  assert.equal(terminalFor(new Tty(24, 200), {}).cols, 110);
  assert.equal(terminalFor(new Tty(24, 40), {}).cols, 60);
  assert.equal(terminalFor(new Collect(), {}).cols, 100);
});

test("notices from a baton session: the mark in front, the key hints after the first dot", () => {
  const line =
    "baton: acct1 reached its 5-hour limit; moving this conversation to acct2 in 8 s · Enter: now · any other key: stay on acct1 · Ctrl+C: quit";
  const plain = terminalFor(new Collect(), {});
  assert.equal(notice(line, plain), line, "not a terminal: unchanged");
  const term = terminalFor(new Tty(24), {});
  const styled = notice(line, term);
  assert.match(styled, /\x1b\[/);
  assert.equal(
    strip(styled),
    line.replace("baton: ", `${term.g.baton} `),
    "the same words, the mark in place of the name",
  );
  assert.equal(notice("something else", term), "something else");
});

test("errors: baton: message when plain, a cross when styled", () => {
  assert.equal(
    errorText("No account named x.", terminalFor(new Collect(), {})),
    "baton: No account named x.",
  );
  assert.equal(
    strip(errorText("No account named x.", terminalFor(new Tty(24), {}))),
    `${terminalFor(new Tty(24), {}).g.cross} No account named x.`,
  );
});

test("paths show the home folder as ~", () => {
  assert.equal(
    tildify("C:\\Users\\a\\.claude\\x.json", "C:\\Users\\a"),
    "~/.claude/x.json",
  );
  assert.equal(tildify("C:\\Users\\a", "C:\\Users\\a"), "~");
  assert.equal(tildify("D:\\other\\x", "C:\\Users\\a"), "D:/other/x");
  assert.equal(tildify("C:\\Users\\ab\\x", "C:\\Users\\a"), "C:/Users/ab/x");
});

test("in a terminal, install shows the mark, the pieces and the next step; the same words piped, without escapes", async (t) => {
  const { home } = tempHome(t);
  const env = { ...testEnv(home), BATON_GLYPHS: "rich" };
  const findFerry = () => null;

  const tty = new Tty(24);
  assert.equal(
    await main(["install", "--dry-run"], { env, stdout: tty, findFerry }),
    0,
  );
  const shown = strip(tty.text);
  assert.match(shown, /\/_____\/_\/ {2}\|_\/_\//, "the wordmark");
  assert.match(shown, /Keep the conversation moving\./);
  assert.match(shown, /INSTALL +─+ +dry run/);
  assert.match(shown, /› Status line +will add +baton statusline/);
  assert.match(shown, /› Hooks +will add +SessionStart · UserPromptSubmit/);
  assert.match(
    shown,
    /› \/hop command +will add +~\/\.claude\/commands\/hop\.md/,
  );
  assert.match(
    shown,
    /○ Ferry not found; run baton install again after installing it/,
  );
  assert.match(tty.text, /\x1b\[/);

  const pipe = new Collect();
  assert.equal(
    await main(["install", "--dry-run"], { env, stdout: pipe, findFerry }),
    0,
  );
  assert.doesNotMatch(pipe.text, /\x1b/);
  assert.doesNotMatch(
    pipe.text,
    /Keep the conversation moving/,
    "no wordmark in a pipe",
  );
  assert.match(pipe.text, /INSTALL +─+ +dry run/);
});

test("in a terminal, a failure goes to stderr with a cross and exit code 2", async (t) => {
  const { home } = tempHome(t);
  const err = new Tty(24);
  const code = await main(["account", "remove", "nobody"], {
    env: testEnv(home),
    stdout: new Collect(),
    stderr: err,
  });
  assert.equal(code, 2);
  assert.match(strip(err.text), /^✗ No account named nobody/);
});

test("--json is data, never styled, even in a terminal", async (t) => {
  const { home } = tempHome(t);
  const tty = new Tty(24);
  assert.equal(
    await main(["account", "list", "--json"], {
      env: testEnv(home),
      stdout: tty,
    }),
    0,
  );
  assert.deepEqual(JSON.parse(tty.text), []);
});
