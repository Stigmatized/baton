// The menu's frames on the fixtures of test/menu-fixtures.js, as
// ink-testing-library draws them without colours, for review:
//
//   node scripts/menu-frames.js [dir]     every screen at every size, and the
//                                         all-blocked Overview (default dir:
//                                         .cache/frames)
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { isNarrow } from "../src/menu/layout.js";
import { batonPaths } from "../src/paths.js";
import {
  buildHome,
  frame,
  menuState,
  press,
  screens,
  sizes,
} from "../test/menu-fixtures.js";

export function screenState(paths, size, screen) {
  const spec = screens[screen];
  let state = menuState(paths, { size: sizes[size], keys: spec.keys });
  if (isNarrow(state) && state.focus !== "pane" && !spec.side)
    state = press(state, paths, "enter").state;
  return state;
}

const dir = resolve(process.argv[2] ?? ".cache/frames");
mkdirSync(dir, { recursive: true });
const homes = resolve(".cache/frames-home");
rmSync(homes, { recursive: true, force: true });
const normal = batonPaths(join(homes, "normal"));
const blocked = batonPaths(join(homes, "blocked"));
buildHome(normal);
buildHome(blocked, { allBlocked: true });
let count = 0;
for (const size of Object.keys(sizes)) {
  for (const screen of Object.keys(screens)) {
    writeFileSync(
      join(dir, `${size}-${screen}.txt`),
      frame(screenState(normal, size, screen)).join("\n") + "\n",
    );
    count++;
  }
  writeFileSync(
    join(dir, `${size}-overview-all-blocked.txt`),
    frame(screenState(blocked, size, "overview")).join("\n") + "\n",
  );
  count++;
}
rmSync(homes, { recursive: true, force: true });
console.log(`Wrote ${count} frames to ${dir}.`);
