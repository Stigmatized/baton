import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { Writable, PassThrough } from "node:stream";
import { batonPaths } from "../src/paths.js";

// Test homes live in <repo>/.cache (gitignored), never in the real home.
export const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const CLI = join(REPO, "src", "cli.js");
export const FAKE_CLAUDE = join(REPO, "test", "fixtures", "fake-claude.js");
export const RAW_READER = join(REPO, "test", "fixtures", "raw-reader.js");

export function tempHome(t, { claude = true } = {}) {
  const root = join(REPO, ".cache", `test-${randomBytes(5).toString("hex")}`);
  const home = join(root, "home");
  if (!home.startsWith(join(REPO, ".cache") + sep))
    throw new Error("test home outside .cache");
  mkdirSync(home, { recursive: true });
  if (claude) mkdirSync(join(home, ".claude"), { recursive: true });
  t?.after?.(() => rmSync(root, { recursive: true, force: true }));
  return { root, home, paths: batonPaths(home) };
}

// A temporary home with these accounts added (config version 1, no
// profiles linked): what most tests start from.
export function accountsHome(
  t,
  names = ["acct1", "acct2", "acct3", "acct4"],
  options = {},
) {
  const home = tempHome(t, options);
  write(home.paths.config, {
    version: 1,
    accounts: names.map((name) =>
      typeof name === "string" ? { id: name, name, mark: "normal" } : name,
    ),
    policy: {},
  });
  return home;
}

export function write(file, content) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(
    file,
    typeof content === "string" ? content : JSON.stringify(content, null, 2),
  );
}

export const testEnv = (home, extra = {}) => {
  const env = {
    ...process.env,
    BATON_HOME: home,
    USERPROFILE: home,
    HOME: home,
    ...extra,
  };
  for (const key of Object.keys(env))
    if (
      key.toUpperCase() === "CLAUDE_CONFIG_DIR" &&
      !("CLAUDE_CONFIG_DIR" in extra)
    )
      delete env[key];
  // Not inside a Claude Code session or a lead wrapper, whatever runs the tests.
  delete env.BATON_WRAPPER;
  delete env.CLAUDE_CODE_SESSION_ID;
  return env;
};

export async function until(predicate, timeout = 15000, step = 20) {
  const start = Date.now();
  for (;;) {
    const value = await predicate();
    if (value) return value;
    if (Date.now() - start > timeout) throw new Error("Timed out waiting");
    await new Promise((r) => setTimeout(r, step));
  }
}

export class Collect extends Writable {
  constructor() {
    super();
    this.text = "";
  }
  _write(chunk, _enc, done) {
    this.text += chunk.toString();
    done();
  }
}

export const keyInput = () => {
  const input = new PassThrough();
  input.isTTY = false;
  return input;
};

export const H = 3600e3;
export const M = 60e3;
