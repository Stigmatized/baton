import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { ACCOUNT_ID_RE, profileDir } from "./paths.js";

// What a conflict names when the shared base's version was kept.
export const BASE = "~/.claude";
import { iso, readJson, writeFileAtomic, writeJsonAtomic } from "./fsutil.js";

// Two-way copies of the shared files when the OS does not allow file links
// (Windows without Developer Mode): settings.json, CLAUDE.md and
// keybindings.json are copies in every profile. Baton remembers the hash of
// what it last copied into each profile (copies.json), so at every launch it
// can tell who changed what since:
//  - only ~/.claude changed: the profiles are refreshed from it;
//  - only a profile changed (e.g. /config under account 2 wrote its
//    settings.json): its version is copied back to ~/.claude (after a
//    timestamped backup of ~/.claude's) and from there to the other
//    profiles;
//  - both changed: ~/.claude's version is kept everywhere, the profile's is
//    saved as a backup, and the conflict is recorded (conflicts.json; doctor,
//    status and the menu show it).
// When two profiles changed the same file, the first in priority order is
// copied back and the others are conflicts.

export const COPIED = ["settings.json", "CLAUDE.md", "keybindings.json"];

export const copiesFile = (paths) => join(paths.root, "copies.json");
export const conflictsFile = (paths) => join(paths.root, "conflicts.json");

const hash = (buffer) => createHash("sha256").update(buffer).digest("hex");
const read = (file) => {
  try {
    return readFileSync(file);
  } catch {
    return null;
  }
};
const isCopy = (file) => {
  try {
    return !lstatSync(file).isSymbolicLink();
  } catch {
    return false;
  }
};

export function readConflicts(paths) {
  return readJson(conflictsFile(paths), { conflicts: [] }).conflicts ?? [];
}

export function clearConflicts(paths) {
  writeJsonAtomic(conflictsFile(paths), { conflicts: [] });
}

function addConflicts(paths, list) {
  if (!list.length) return;
  const all = [...readConflicts(paths), ...list].slice(-50);
  writeJsonAtomic(conflictsFile(paths), { conflicts: all });
}

// Forget a profile (baton account remove).
export function forgetCopies(paths, name) {
  const record = readJson(copiesFile(paths));
  if (!record?.profiles?.[name]) return;
  delete record.profiles[name];
  writeJsonAtomic(copiesFile(paths), record);
}

// syncCopies(paths, names) -> report entries { account, name, action,
// detail } with action copied | refreshed | ok | copied-back | conflict |
// no-source. `names` are the profiles to bring in line (in priority
// order); profiles Baton copied into before are included too.
export function syncCopies(paths, names, { now = Date.now() } = {}) {
  const record = readJson(copiesFile(paths)) ?? {};
  record.version = 1;
  record.profiles ??= {};
  record.source ??= {};
  const order = [...names, ...Object.keys(record.profiles)];
  const profiles = [...new Set(order)].filter(
    (n) => ACCOUNT_ID_RE.test(n) && existsSync(profileDir(paths, n)),
  );
  const stamp = iso(now).replace(/[:.]/g, "-");
  const backupDir = join(paths.backups, stamp);
  const report = [];
  const conflicts = [];
  const backup = (label, buffer) => {
    const file = join(backupDir, label);
    writeFileAtomic(file, buffer);
    return file;
  };
  for (const item of COPIED) {
    const src = join(paths.claudeDir, item);
    let srcBuffer = read(src);
    if (!srcBuffer) {
      for (const p of profiles)
        report.push({ account: p, name: item, action: "no-source" });
      continue;
    }
    let srcHash = hash(srcBuffer);
    const known = record.source[item] ?? null;
    const sourceChanged = known !== null && srcHash !== known;
    // Profiles whose copy changed since Baton last wrote it.
    const changed = [];
    for (const p of profiles) {
      const dst = join(profileDir(paths, p), item);
      const last = record.profiles[p]?.[item] ?? null;
      if (!last || !isCopy(dst)) continue;
      const buffer = read(dst);
      if (!buffer) continue;
      const h = hash(buffer);
      if (h !== last && h !== srcHash) changed.push({ p, buffer, h });
    }
    const handled = new Set();
    if (changed.length && !sourceChanged) {
      const [winner, ...rest] = changed;
      const saved = backup(`copyback-${item}`, srcBuffer);
      // Through a symbolic link in ~/.claude (dotfiles) to its target.
      writeFileAtomic(isCopy(src) ? src : realpathSync(src), winner.buffer);
      srcBuffer = winner.buffer;
      srcHash = winner.h;
      handled.add(winner.p);
      report.push({
        account: winner.p,
        name: item,
        action: "copied-back",
        detail: `~/.claude's previous ${item} is in ${saved}`,
      });
      for (const other of rest)
        if (other.h !== winner.h) {
          const saved2 = backup(`conflict-${other.p}-${item}`, other.buffer);
          conflicts.push({
            at: iso(now),
            account: other.p,
            item,
            backup: saved2,
            kept: winner.p,
          });
          report.push({
            account: other.p,
            name: item,
            action: "conflict",
            detail: `kept ${winner.p}'s change; this profile's is in ${saved2}`,
          });
          handled.add(other.p);
        }
    } else if (changed.length) {
      for (const c of changed) {
        const saved = backup(`conflict-${c.p}-${item}`, c.buffer);
        conflicts.push({
          at: iso(now),
          account: c.p,
          item,
          backup: saved,
          kept: BASE,
        });
        report.push({
          account: c.p,
          name: item,
          action: "conflict",
          detail: `changed in the profile and in ~/.claude: kept ~/.claude's; this profile's is in ${saved}`,
        });
        handled.add(c.p);
      }
    }
    // Every profile's copy as ~/.claude's file is now.
    for (const p of profiles) {
      const dst = join(profileDir(paths, p), item);
      record.profiles[p] ??= {};
      if (existsSync(dst) && !isCopy(dst)) {
        // A real link (made where file links are allowed): nothing to copy.
        delete record.profiles[p][item];
        continue;
      }
      const buffer = read(dst);
      if (buffer && hash(buffer) === srcHash) {
        record.profiles[p][item] = srcHash;
        if (!handled.has(p))
          report.push({ account: p, name: item, action: "ok", detail: "copy" });
        continue;
      }
      // A copy with no record that differs (made before Baton kept hashes):
      // ~/.claude's wins, the old copy is kept as a backup.
      if (buffer && !record.profiles[p][item] && !handled.has(p))
        backup(`replaced-${p}-${item}`, buffer);
      writeFileAtomic(dst, srcBuffer);
      record.profiles[p][item] = srcHash;
      if (!handled.has(p))
        report.push({
          account: p,
          name: item,
          action: buffer ? "refreshed" : "copied",
        });
    }
    record.source[item] = srcHash;
  }
  writeJsonAtomic(copiesFile(paths), record);
  addConflicts(paths, conflicts);
  return report;
}

// Whether a profile's copy was changed in the profile since Baton's last
// copy (it will be copied back at the next launch).
export function copyState(paths, name, item) {
  const record = readJson(copiesFile(paths));
  const last = record?.profiles?.[name]?.[item] ?? null;
  const dst = join(profileDir(paths, name), item);
  const src = join(paths.claudeDir, item);
  const a = read(src);
  const b = read(dst);
  if (!a) return "no-source";
  if (!b) return "missing";
  const hb = hash(b);
  if (hb === hash(a)) return "copy-fresh";
  return last && hb !== last ? "copy-changed" : "copy-stale";
}
