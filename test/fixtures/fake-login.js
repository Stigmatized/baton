// A stand-in for `claude auth status --json` and `claude auth login` in the
// menu's tests: a profile counts as signed in once "login" ran under it (a
// marker file in its CLAUDE_CONFIG_DIR); plain claude (no CLAUDE_CONFIG_DIR)
// is always signed in.
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2).join(" ");
const dir = process.env.CLAUDE_CONFIG_DIR;
const marker = dir ? join(dir, "fake-signed-in") : null;
if (args === "auth status --json") {
  const loggedIn = !dir || existsSync(marker);
  process.stdout.write(
    JSON.stringify({
      loggedIn,
      authMethod: loggedIn ? "claude.ai" : "none",
      email: "someone@example.invalid",
    }),
  );
  process.exit(loggedIn ? 0 : 1);
}
if (args === "auth login") {
  if (dir) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(marker, "");
  }
  if (process.env.FAKE_LOGIN_LOG)
    appendFileSync(
      process.env.FAKE_LOGIN_LOG,
      JSON.stringify({ args, dir: dir ?? null }) + "\n",
    );
  process.stdout.write(
    "https://claude.ai/oauth/authorize?client_id=baton-fixture&state=public-fixture\n",
  );
  process.stdout.write("Paste the verification code here: ");
  // Long enough for the test to see the menu step aside.
  setTimeout(() => process.exit(0), 300);
} else process.exit(2);
