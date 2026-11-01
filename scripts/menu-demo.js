// A fully interactive fixture preview. All changes stay in a temporary home;
// no service, real Claude process, profile or credential is involved.
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { batonPaths, profileDir } from "../src/paths.js";
import { runMenu } from "../src/menu/index.js";
import { auth, buildHome, NOW } from "../test/menu-fixtures.js";
import { writeJsonAtomic } from "../src/fsutil.js";

const cache = resolve(".cache");
mkdirSync(cache, { recursive: true });
const home = mkdtempSync(join(cache, "menu-demo-"));
const paths = batonPaths(home);
buildHome(paths);
for (const [id, status] of Object.entries(auth)) {
  if (status.loggedIn)
    writeJsonAtomic(join(profileDir(paths, id), "fake-signed-in"), {});
}
const started = Date.now();
try {
  await runMenu({
    paths,
    poll: false,
    env: { ...process.env, FAKE_LOGIN_LOG: "" },
    now: () => NOW + Date.now() - started,
    launcher: {
      command: process.execPath,
      prefix: [resolve("test/fixtures/fake-login.js")],
    },
    loginStdio: "ignore",
    handleSignals: true,
    refresh: async (account) => ({
      results: [{ name: account ?? "Demo accounts", status: "ok" }],
    }),
  });
} finally {
  // The generated home is always inside this repository's .cache directory.
  if (!home.startsWith(join(cache, "menu-demo-")))
    throw new Error("Unexpected demo path");
  rmSync(home, { recursive: true, force: true });
}
