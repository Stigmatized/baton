import test from "node:test";
import assert from "node:assert/strict";
import { renderToString } from "ink";
import { createLoginOutput } from "../src/menu/login.js";
import { LoginScreen } from "../src/menu/ui/login.js";
import { h } from "../src/menu/ui/kit.js";
import { clean, width } from "../src/menu/text.js";
import { logo } from "../src/menu/art.js";

const url =
  "https://claude.ai/oauth/authorize?client_id=fixture&state=public&code=true";

test("sign-in extracts a public link across chunks and a prompt without exposing raw output", () => {
  const updates = [],
    parser = createLoginOutput((update) => updates.push(update));
  parser.push(Buffer.from("unrelated output\nhttps://claude.ai/oauth/auth"));
  assert.equal(updates.length, 0);
  parser.push(Buffer.from("orize?client_id=fixture&state=public&code=true\n"));
  assert.deepEqual(updates.at(-1), { url, codePrompt: false });
  parser.push(Buffer.from("Paste the verification code here: "));
  assert.deepEqual(updates.at(-1), { url, codePrompt: true });
  parser.end();
  assert.equal(updates.length, 2);
});

test("sign-in ignores tokens, callbacks, untrusted domains and terminal escapes", () => {
  const updates = [],
    parser = createLoginOutput((update) => updates.push(update));
  for (const invalid of [
    "https://claude.ai/oauth/authorize?access_token=private",
    "https://claude.ai/oauth/authorize?code=private",
    "https://claude.ai/oauth/callback?code=private",
    "https://claude.ai.example.com/oauth/authorize?client_id=fixture",
    "https://example.com/oauth/authorize?client_id=fixture",
    "https://someone:private@claude.ai/oauth/authorize",
    "https://claude.ai/oauth/authorize#private",
  ])
    parser.push(Buffer.from(invalid + "\n"));
  parser.push(Buffer.from("\x1b[2Jthis output must not be displayed\n"));
  parser.end();
  assert.deepEqual(updates, []);
});

test("the sign-in layout carries the ASCII identity and fits the supported terminal sizes", () => {
  for (const size of [
    { cols: 100, rows: 28 },
    { cols: 120, rows: 30 },
    { cols: 160, rows: 45 },
  ]) {
    const ansi = renderToString(
      h(LoginScreen, {
        state: { size, color: false, glyphs: "rich" },
        name: "work@example.com",
        url,
        codePrompt: true,
      }),
      { columns: size.cols },
    );
    const text = clean(ansi),
      lines = text.split("\n");
    assert.equal(lines.length, size.rows - 1);
    assert.ok(lines.every((line) => width(line) <= size.cols));
    for (const line of logo) assert.ok(text.includes(line.trim()));
    assert.match(text, /Connect account/);
    assert.match(text, /Open Claude sign-in/);
    assert.match(text, /VERIFICATION CODE/);
    assert.doesNotMatch(text, /client_id|state=public/);
  }
});
