import { readdir } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

// Syntax check of every JavaScript file (node --check).
for (const dir of [
  "src",
  "src/menu",
  "src/menu/ui",
  "src/menu/views",
  "scripts",
  "test",
  "test/fixtures",
]) {
  for (const file of await readdir(dir)) {
    if (!file.endsWith(".js")) continue;
    const result = spawnSync(process.execPath, ["--check", join(dir, file)], {
      stdio: "inherit",
    });
    if (result.status !== 0) process.exit(result.status ?? 1);
  }
}
console.log("JavaScript syntax checks passed.");
