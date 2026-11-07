# Review: install, profiles, Ferry and doctor

A read-only review of the JS version at commit f676a1e. Paths are relative to the repository root.

### 1. Responsibilities

- **src/install.js**: plans and applies `baton install` and `baton uninstall`.
  - It edits `~/.claude/settings.json` (status line and 5 hooks), writes `~/.claude/commands/hop.md`, and writes the Ferry launcher.
  - It keeps backups and the record file `~/.baton/install.json`.
  - `installState` (install.js:503) tells doctor what is installed.
- **src/profile.js**: builds and inspects `~/.baton/accounts/<id>`.
  - It makes junctions or symlinks to `~/.claude` and asks copies.js to sync the copied files.
  - It seeds `<profile>/.claude.json` from `~/.claude.json` and carries folder trust from one account to another on a hop.
  - It removes Baton's links when an account is removed.
- **src/copies.js**: the two-way copy sync for `settings.json`, `CLAUDE.md` and `keybindings.json` when file symlinks are not allowed.
  - State lives in `copies.json` (sha256 hashes) and `conflicts.json`.
  - `copyState` is used by doctor.
- **src/ferry.js**: Ferry detection, the launcher format, whether a launcher is Baton's, and the registration state for doctor.
- **src/doctor.js**: `baton doctor`, plus `authStatus` / `authStatusAsync`, which the menu and poller also use.
- **src/diff.js**: a longest-common-subsequence line diff with 2 lines of context, for the `--dry-run` / `--diff` output.

Callers:
- `linkProfile` runs from: `account add` (accounts.js:95), `login` (cli.js:319), every lead launch and hop (lead.js:190 via `prepare`, lead.js:329), the menu sign-in (menu/index.js:358), and after install/uninstall (`refreshProfiles`, cli.js:563-572, cli.js:599).
- `carryTrust` runs at lead.js:325.
- On account removal, `unlinkProfile` and `forgetCopies` run (accounts.js:129-130).

### 2. Install/uninstall contract

**Hooks** (install.js:79-86, install.js:210-226)
- One handler for each of SessionStart, UserPromptSubmit, Stop, StopFailure and SessionEnd. The event map is hooks.js:53-59: `session-start`, `prompt`, `stop`, `stop-failure`, `session-end`.
- Each handler is in exec form:
  ```
  {"type":"command","command":"<forward(nodePath)>","args":["<forward(cliPath)>","hook","<name>"],"timeout":10}
  ```
- Each sits in its own group `{ "hooks": [handler] }`, with no matcher, appended at the end of the event's array.
- The node path is absolute, even when it contains spaces (exec form makes that safe).
- Unchanged detection (`sameBatonHooks`, install.js:170): exactly one Baton handler per event, compared with JSON.stringify (sensitive to key order), and no Baton handlers under any other event.
- On change, every Baton handler is removed first (`withoutBatonHooks`, install.js:141):
  - a group that mixes user and Baton handlers keeps only the user's handlers;
  - a group left empty is dropped;
  - an event left empty is dropped;
  - non-array or odd values are kept untouched.
- User hooks are never modified.

**How Baton's hook is recognised** (`isBatonHandler`, install.js:53-62):
- `type == "command"`, `args` is an array of at least 3;
- `args[1] == "hook"`;
- `args[0]` matches `/[\\/]src[\\/]cli\.js$/i`;
- `args[2] in HOOK_EVENTS`. This is a JS `in` test, so `"toString"` also matches. It is harmless.

**Status line** (install.js:228-249)
- The command is `${nodeCommand(node)} "${forward(cli)}" statusline` (install.js:76).
- `nodeCommand` replaces any node path that contains whitespace with plain `node` from PATH (install.js:71-74). The default Windows path `C:\Program Files\nodejs` has a space, so on most Windows machines the status line runs whatever `node` is on PATH.
- Recognition is the regex `/cli\.js"?\s+statusline\b/` (install.js:64-66).
- If the current status line is Baton's, only `command` is updated.
- Otherwise:
  - the current one (or null) becomes `previousStatusLine` in install.json;
  - the new status line is `{type:"command", command, ...}`, keeping `padding`, `refreshInterval` and `hideVimModeIndicator` from the user's;
  - a note is printed.
- `previousStatusLine` survives a re-install because it is read from the existing record (install.js:229).
- Chaining happens at runtime: `handleStatusLine` reads `install.json.previousStatusLine.command` (hooks.js:241-242). cli.js:99-112 runs it through `statusLineShell` with the same stdin and a 15 s timeout (hooks.js:472-519). The shell is Git Bash on Windows when it can be found, otherwise PowerShell; elsewhere it is `/bin/sh -c`. The user's output is printed as is, or with Baton's usage appended when the policy `statusLineUsage` is on.

**commands/hop.md** (install.js:88-102). The text is:
```
---
description: Move this conversation to another account at the end of this turn (installed by Baton)
argument-hint: "[account]"
allowed-tools: Bash(node:*)
disable-model-invocation: true
---
!`node "<forward(cli)>" hop --session "${CLAUDE_SESSION_ID}" --from-command --to='$ARGUMENTS'`

Baton was asked to move this conversation ... (one-line instruction)
```
- It is Baton's if it contains the marker `(installed by Baton)` (install.js:46).
- If an existing hop.md lacks the marker, it is skipped with a note and never removed (install.js:266-270, install.js:378).
- It uses `node` from PATH, not the absolute node path that the hooks use.

**Format preservation** (install.js:104-120)
- Indent is detected from the first `\n<ws>"`; the default is 2.
- CRLF vs LF is detected, and so is the trailing newline.
- Rendering is `JSON.stringify(v, null, indent)`. Key order is kept, except that JS moves integer-like keys to the front.
- Invalid JSON, or a top-level value that is not an object, raises InstallError and nothing is written (install.js:124-137). A UTF-8 BOM also fails here.

**install.json record** (install.js:320-329, install.js:463-466)
```
{version:1, cli, node, settingsPath, commandPath, previousStatusLine, hooks:[event names], launcher?, installedAt, backup}
```
- `planIsNoop` compares records ignoring `installedAt` and `backup` (install.js:423-432).
- `uninstall` deletes the record last (install.js:495-498).

**applyPlan order** (install.js:450-500)
1. Back up every file whose `before` is not null into `~/.baton/backups/<ISO with : and . replaced by ->/`. Names: `settings.json`, `hop.md`, `ferry-baton.json`, `ferry-baton-2.json`.
2. Write the record (install only), before any file, so `previousStatusLine` is never lost.
3. Write each file atomically. A symlinked target is resolved with `realpathSync` first (install.js:473-478).
- A Ferry write that fails becomes a note, and the item is marked `failed`. Any other failure throws InstallError.
- The atomic write is temp file plus rename with 6 retries on EPERM/EACCES/EBUSY (fsutil.js:38-62). There is no fsync and file modes are not preserved.

**Dry run and diff**
- `planScreen` (screens.js:197-329) prints:
  - one line per item: hooks / statusline / hop / ferry with action add, update, same, skip, missing, remove, absent or failed;
  - the notes;
  - a FILES list: `create|change|remove <path> +N -M`;
  - with `--diff`, every diff line.
- diff.js prints lines as `"+ x"`, `"- x"`, `"  x"`, with 2 lines of context and `"  ..."` between hunks. CRLF is normalised and the trailing empty line is dropped.
- `--json` returns `{dryRun, files:[{path,diff}], notes, changed?, backup?}` (cli.js:601-607).

**Uninstall** (install.js:333-421)
- Removes Baton handlers by `isBatonHandler` and drops `hooks` entirely if it ends up empty. An original `"hooks": {}` is therefore not restored.
- If the status line is Baton's, puts back `record.previousStatusLine` or deletes the key. If the user changed it since install, it is left, with a note.
- Removes hop.md only if it carries the marker.
- Removes the Ferry launcher at both the current `FERRY_HOME` location and `record.launcher`, but only while `id == "baton"` and `source == "baton install"`.

**Everything that embeds node or cli.js**
- hook `command` (node) and `args[0]` (cli.js);
- the status line command (`node`-or-path plus the quoted cli.js);
- hop.md (`node "<cli>"` and `Bash(node:*)`);
- the Ferry `program` (node) and `args[0]` (cli.js, braces doubled);
- install.json `cli` and `node`;
- the doctor check `node >= 24` (doctor.js:122-123) and the "node/cli.js path changed" wording (doctor.js:100-106);
- `installState` existence checks on `handler.command` and `handler.args[0]` (install.js:518-519).

**How a Rust install must recognise JS-written entries**
- **Hooks**: treat a handler as Baton's if it matches either form.
  - Legacy: the rule above.
  - New: the stem of `command` is `baton` (case-insensitive on Windows), `args[0] == "hook"`, and `args[1]` is one of the five names.
  - Remove all matches before adding the new handler, so nothing is duplicated.
- **Status line**: Baton's if it matches the legacy `cli\.js"?\s+statusline\b`, preferably tightened to `src[\\/]cli\.js"?\s+statusline`, or the new `baton(\.exe)?"?\s+statusline\b`.
  - If the legacy line is not recognised, Rust will save Baton's own JS line as `previousStatusLine` and chain to it, and the JS line breaks once node or Baton is gone.
- **install.json**: read v1 with serde `#[serde(default)]` and keep `previousStatusLine` without change. Write v2: `{version:2, program, settingsPath, commandPath, previousStatusLine, hooks, launcher?, installedAt, backup}`, and accept the v1 `cli` and `node` fields.
- **hop.md**: the marker is enough; rewrite it.
- **Ferry**: id plus source is enough. Program and args will differ, so it is replaced, with a backup.

### 3. Profiles

**Layout of `~/.baton/accounts/<id>`** (profile.js:28-50). The id matches `ACCOUNT_ID_RE`, paths.js:14.

| Entry | How it is shared |
|---|---|
| `projects`, `skills`, `agents`, `commands`, `plugins`, `file-history`, `plans`, `tasks`, `todos`, `rules`, `output-styles` | Directory link: a junction on Windows (`symlinkSync(...,"junction")`), a `"dir"` symlink elsewhere (profile.js:245) |
| `settings.json`, `CLAUDE.md`, `keybindings.json` | A file symlink when allowed, otherwise a two-way copy |
| `history.jsonl` | `linkOnly`: a symlink or nothing; skipped where file links are not allowed (profile.js:265-271) |
| `.claude.json` | The profile's own file, seeded |
| `.credentials.json` and Claude Code's own per-profile folders | Created by Claude Code; never touched |

- The NEVER list (profile.js:54-75) covers `.credentials.json`, `.claude.json`, `backups`, `cache`, `daemon`, `debug`, `feedback`, `ide`, `jobs`, `mcp-needs-auth-cache.json`, `paste-cache`, `image-cache`, `scheduled-tasks`, `session-env`, `sessions`, `shell-snapshots`, `ssh`, `stats-cache.json`, `statsig`, `telemetry`. Any symlink with one of these names is removed, whatever it points to (profile.js:285-291).

**`linkProfile` rules for each entry** (profile.js:187-294)
- The source is missing: a Baton link is removed and the result is `no-source`.
- The type differs (folder vs file): `skipped`.
- A link already points home: `ok`.
- A link points at an existing target elsewhere: `conflict`. A dangling link is removed and re-pointed (`relinked`).
- A folder: a real folder in the profile is `conflict`; otherwise it is linked.
- A file with file links allowed: an existing regular file with identical bytes is replaced by a link; different bytes are `conflict`, and the file stays a copy that is never synced.
- Otherwise the file is copied and `syncCopies(paths, [name, ...peers])` runs. Callers never pass `peers`.

**Windows Developer Mode detection** (`canSymlinkFiles`, profile.js:153-171)
- On anything but win32 it returns `true` without testing.
- On Windows it tries `symlinkSync(target, link, "file")` in `~/.baton/tmp` and caches the answer for the life of the process.
- This probe covers Developer Mode and the admin privilege. Reading the registry would miss the privilege case.

**Seeding `.claude.json`** (profile.js:79-115, profile.js:353-382)
- It runs at every `linkProfile`, so on every launch.
- `SEED_KEYS` are copied from `~/.claude.json` and overwrite the profile's values: `hasCompletedOnboarding`, `lastOnboardingVersion`, `lastReleaseNotesSeen`, `theme`, `mcpServers`, `hasSeenTasksHint`, `hasSeenAutoDefaultNotice`, `hasSeenAutoModeOutsideReadPrompt`, `hasOpenedAgentsView`, `bypassPermissionsModeAccepted`, `hasAcknowledgedCostThreshold`, `editorMode`, `autoCompactEnabled`, `verbose`, `preferredNotifChannel`, `shiftEnterKeyBindingInstalled`, `optionAsMetaKeyInstalled`, `autoUpdates`, `installMethod`, `diffTool`, `githubRepoPaths`, `officialMarketplaceAutoInstallAttempted`, `officialMarketplaceAutoInstalled`.
- For each project, `SEED_PROJECT_KEYS` are merged in with the source winning: `hasTrustDialogAccepted`, `hasCompletedProjectOnboarding`, `projectOnboardingSeenCount`, `allowedTools`, `mcpServers`, `enabledMcpjsonServers`, `disabledMcpjsonServers`, `mcpContextUris`, `hasClaudeMdExternalIncludesApproved`, `hasClaudeMdExternalIncludesWarningShown`. A project with none of these keys is skipped.
- Never copied, because anything outside the allowlist stays: `oauthAccount`, `userID`, `machineID`, `primaryApiKey`, `customApiKeyResponses`, `cachedUsageUtilization`, and per-project `lastCost`, `lastSessionId` and so on.
- The file is written only when the result differs.

**Carrying trust** (`carryTrust`, profile.js:388-409)
- Copies the allowlisted project keys from the source profile's `.claude.json` into the target profile's, but only for entries whose normalised key matches the cwd and which have `hasTrustDialogAccepted: true`.
- Key normalisation: backslash to slash, trailing slash dropped, lowercased, on every OS.
- The source profile's own key spelling is kept. `~/.claude.json` is never written.

**Copy sync** (copies.js:73-199). `copies.json` is:
```
{version:1, profiles:{<id>:{<item>:sha256}}, source:{<item>:sha256}}
```
For each item in `COPIED` (copies.js:26):
1. Profiles are `names` plus every profile already in the record, filtered by the id regex and the folder existing.
2. `sourceChanged` means the recorded source hash exists and differs from the current one.
3. A profile counts as "changed" if it has a record entry, is a regular file, and its hash differs from both its recorded hash and the current source hash.
4. Only profiles changed: the first changed profile (the launching account first, then record order) is copied back.
   - The source is backed up as `backups/<stamp>/copyback-<item>`, then written, following a symlink.
   - Every other changed profile with a different hash becomes a conflict: backup `conflict-<id>-<item>`, `kept: <winner id>`.
5. Both the source and profiles changed: each changed profile's file is backed up as `conflict-<id>-<item>` and the conflict records `kept: "~/.claude"`.
6. Every copy is then rewritten to the source's bytes. A differing copy with no record is first backed up as `replaced-<id>-<item>`. A profile whose file is a real link is dropped from the record.

`conflicts.json` is `{conflicts:[{at, account, item, backup, kept}]}`, capped at the last 50 entries. `kept` is `"~/.claude"` or an account id. `baton conflicts --clear` empties it.

`copyState` (copies.js:203-215) returns `no-source`, `missing`, `copy-fresh`, `copy-changed` or `copy-stale`.

### 4. Ferry

- **Data folder**: `FERRY_HOME` if set (resolved), otherwise `<home>/.ferry` (ferry.js:28-29). Home follows `BATON_HOME`.
- **Detection**: Ferry counts as found if the data folder is a directory, or if `ferry` is on PATH (`findOnPath`, which honours PATHEXT on Windows and X_OK elsewhere; claude-path.js:33-64).
- **Launcher file**: `<data>/launchers/baton.json` (ferry.js:31). New folders are created 0700 and the file 0600 (ferry.js:36; this does nothing on Windows).
- **Content** (ferry.js:60-77): `JSON.stringify(def, null, 2) + "\n"`, with
  ```
  {schemaVersion:1, id:"baton", name:"Baton",
   description:"Claude Code on your accounts, one after another",
   program:forward(node), args:[cli with { } doubled],
   resumeArgs:["--resume","{conversation}"], continueArgs:["--continue"],
   conversations:"claude-code", terminal:true, source:"baton install"}
  ```
- **Ownership**: the file is Baton's when `id == "baton"` and `source == "baton install"` (ferry.js:91-92).
- **Registration states**: `absent`, `missing`, `current` (exact text match), `stale` (with `node` / `cli` flags; paths compared with `samePath`), `foreign` (ferry.js:97-124).
- The full schema rules are in test/ferry.test.js:69-119:
  - `id` matches `^[a-z0-9][a-z0-9-]{0,31}$` and equals the file name;
  - `name` is 1-40 characters with no control characters;
  - `description` is at most 120 characters with no newlines;
  - placeholders are `{path}` and `{name}`, plus `{conversation}`, which `resumeArgs` must contain;
  - `conversations` is required whenever `resumeArgs` or `continueArgs` is given.
- **For Rust**: `program` becomes the binary and `args` becomes `[]`. Keep `id` and `source` the same so existing files stay recognised.

### 5. Doctor checks (doctor.js:112-282)

1. **node**: version ≥ 24, showing `process.execPath`. Drop this in Rust.
2. **claude**: resolved through `resolveClaude`, then `--version` is run with `CLAUDE_CONFIG_DIR=~/.baton/tmp/claude-version`; passes if the exit status is 0.
3. **file links**: information only. Says allowed, or "Developer Mode off" with the explanation.
4. **copy conflicts**: fails when any exist; shows the last 5.
5. **status line shell**: Windows only, information only.
6. **usage poll**: information only; the lease holder and the last run.
7. **accounts**: fails when there are none.
8. For each account:
   - **profile**: the folder exists;
   - **links**: from `inspectProfile`; fails on `missing`, `wrong-link`, `conflict`, `copy-stale` or `unsafe-link` (`copy-changed` and `own` pass);
   - **sign-in**: `claude auth status --json` under the profile, keeping only `loggedIn` and `authMethod`; synchronous, 30 s timeout, one account after another.
9. **install**: `settings.json` is valid JSON.
10. **status line** is Baton's. The command path is not checked.
11. **hooks**: all 5 present, and the node and cli paths exist.
12. **/hop command**: the marker is present. Informational in wording, but `false` makes the overall `ok` fail.
13. **Ferry**: the registration state; `null` when Ferry is absent.

`ok` is true when no check is `false`. The exit code is 1 otherwise.

### 6. Weaknesses and improvement candidates

1. **Trust is clobbered by the seed. High confidence; the most serious finding.**
   - Seeding runs on every launch and copies project keys from `~/.claude.json` with the source winning (profile.js:362-366).
   - As far as I know (I did not check a live file), Claude Code writes default project entries with `hasTrustDialogAccepted:false`, `allowedTools:[]` and so on. Any folder opened once in plain `claude` without being trusted would then carry `false`, which overwrites a profile's `true` on every launch.
   - Worse, lead.js:325-329 runs `carryTrust` and then `prepare` → `seedGlobalConfigFile`, so the trust carried over on a hop is undone immediately. The result is the trust dialog, and the hooks staying off.
   - Fix: never downgrade booleans (true wins), take the union of arrays (`allowedTools`), take the max of counts, and only fill keys the profile is missing.
2. **Profile-level MCP and settings changes are lost. High confidence.**
   - `mcpServers` and `theme` are replaced wholesale from `~/.claude.json` on every launch (profile.js:356), so `claude mcp add -s user` run under a profile is silently reverted.
   - Fix: seed only missing keys, or merge `mcpServers` by name with the profile winning. At minimum, never remove entries.
3. **Lost-update races on `.claude.json`. Medium confidence.**
   - `seedGlobalConfigFile` and `carryTrust` read, modify and write a profile's `.claude.json` that a live `claude` on the same account (another terminal) is rewriting all the time.
   - Fix: re-read and compare just before the rename, and honour Claude Code's lock file if it uses one (to be verified).
4. **Races in the copy sync. Medium-high confidence.**
   - (a) `syncCopies` rewrites every profile's copy (copies.js:166-193), including profiles with a live `claude`. A write by that `claude` between Baton's read and its rename is lost with no backup.
   - (b) There is no lock around `copies.json` and `conflicts.json`. Two `baton` processes launching at once can lose conflict entries, revert a just copied-back change in the profiles for a while, and keep hashes that do not match.
   - Fix: a cross-process lock (`fd-lock` / `fs4`) on `~/.baton/copies.lock` around sync and install, and a compare-and-swap check of the file's hash just before each rename.
5. **Conflicts are too coarse. High confidence.**
   - Any change to `~/.claude` (including Baton's own `install` writing hooks, followed by `refreshProfiles`) plus any profile change means the profile's edit goes to a backup.
   - Fix: keep base snapshots (`~/.baton/copies/base/<item>`) and do a key-level three-way merge for the JSON files. Fall back to today's rule for CLAUDE.md and on real conflicts. Migration: no base snapshot means today's behaviour.
6. **"Priority order" is not the config order.** The comment at copies.js:23 promises it, but the code orders the launching account first, then the record's insertion order (copies.js:78; profile.js:277 passes only `[name]`). Fix: pass the config order. High confidence.
7. **Moving from copies to links strands edits.** With file links allowed, a profile copy that differs is reported `conflict` and left as a copy forever (profile.js:250-257). It is never synced or copied back, and doctor shows `copy-changed`, which it treats as OK. The same happens if Claude Code ever saves `settings.json` by temp file and rename, which would replace the symlink with a regular file.
   - Fix: run the copy-sync logic first (copy back, or conflict plus backup), then link.
   - Confidence is high for the logic. Whether Claude Code renames over the file is unverified.
8. **Status line recognition is too broad.** The regex `cli\.js"?\s+statusline` (install.js:66) matches any tool's `cli.js statusline`. Such a line would be taken as Baton's, and the user's line overwritten without being saved as previous; it survives only in the backup. Medium confidence that it matters; low frequency.
9. **Chaining depends on `install.json`.** If it is lost or deleted, the user's status line silently stops running and uninstall cannot restore it (install.js:229, hooks.js:241).
   - Fix: also keep a copy of `previousStatusLine` in the backup set, and have doctor warn when Baton's line is installed but the record is missing.
10. **Node-only workarounds.** The status line and hop.md use `node` from PATH when the node path has spaces; hop.md always does (install.js:71-77, install.js:93-97). Doctor never checks that PATH node is ≥ 24.
    - Rust note: PowerShell cannot start a command with a quoted path (it needs `&`, which breaks bash), so a Rust binary under a path with spaces has the same problem.
    - Options:
      - (a) Check whether Claude Code's `statusLine` accepts exec-form `args`. If it does, use that.
      - (b) Write an 8.3 short path from `GetShortPathNameW` when the path has spaces.
      - (c) Fall back to bare `baton` on PATH, and have doctor verify it resolves to the same file.
11. **hop.md is too permissive and breaks on apostrophes.** `allowed-tools: Bash(node:*)` allows any node command during that turn. `--to='$ARGUMENTS'` breaks on account names containing `'`, and names may be any text. Fix: `Bash(<baton> hop:*)`, and accept the remaining words after `--` as the name. Medium.
12. **Settings writes can lose concurrent edits.** Plan, then apply, with no check that `settings.json` is unchanged; `/config` or `/hooks` running in the meantime is overwritten. The atomic write drops the file mode (0600 becomes 0644) and does not fsync. Fix: re-read before the rename, `tempfile` + `sync_all` + `persist`, and copy the permissions over.
13. **Robustness of settings parsing.** A non-array `hooks[event]` throws a TypeError with a stack trace in `sameBatonHooks` and `installState` (install.js:172, install.js:512). A BOM is rejected as invalid JSON. Comparing handlers with JSON.stringify is sensitive to key order and causes needless updates. Rust: serde `Value` equality (order-insensitive) plus BOM stripping. Low.
14. **Backups grow forever.** Every copy-back and conflict adds a folder under `backups/`. Two operations in the same millisecond share a folder. Fix: prune by age or count, and add a counter suffix. Low-medium.
15. **diff.js memory.** The LCS table is O(n·m): a 5k-line `settings.json` would use about 100 MB. Fix: the `similar` crate (Myers). Low.
16. **Seeding scope.** A project entry with `hasTrustDialogAccepted:false` is still copied (see 1). `normalizeProjectKey` lowercases on case-sensitive Linux too (profile.js:347). Low-medium.
17. **Windows edge cases.**
    - Junctions cannot point at UNC targets.
    - `samePath` uses `resolve` without `realpath`, so a junctioned or 8.3 `~/.claude` gives a `conflict` on every run.
    - Rust's `read_link` on a junction may return a `\\?\` path, so strip it with `dunce` before comparing, or JS-made junctions will look wrong.
    - Never `remove_dir_all` a profile before unlinking: an older tool that follows junctions would wipe `~/.claude/projects`.
    - The rename retries (about 105 ms in total) are short against antivirus locks.
    - Medium.
18. **Doctor gaps.**
    - The status line command's path is not checked for existence.
    - hop.md is not checked for being current.
    - In copy mode, nothing checks that the profiles' `settings.json` actually contains the hooks.
    - The seeded trust is not checked.
    - Sign-in checks run one after another, up to 30 s each; run them in parallel.
    - `copy-changed` counts as OK.
19. **SHARED and COPIED duplicate the file list** (profile.js:28, copies.js:26). Use one table.

### 7. macOS and Linux (the JS version was only tested on Windows)

**How profiles, links and copies look on each OS**

| | Windows | macOS | Linux |
|---|---|---|---|
| Folder links | Junctions | `dir` symlinks | `dir` symlinks |
| Shared files | Symlinks with Developer Mode, otherwise two-way copies | Always symlinks | Always symlinks |
| `history.jsonl` | Shared only with Developer Mode | Always shared | Always shared |
| Detection | Probe in `~/.baton/tmp` | None: `canSymlinkFiles` returns `true` without probing (profile.js:154) | Same |

- On macOS and Linux the copy sync and `conflicts.json` effectively never run.
- But a filesystem that refuses symlinks (exFAT/FAT, SMB mounts without unix extensions, some FUSE mounts) makes `symlinkSync` throw part-way through `linkProfile`. Rust should probe on every OS and fall back to copies.
- `~/.claude`, `~/.claude.json` and each profile's `.claude.json` are at the same paths on all three OSes. Claude Code does not use XDG folders. Ferry's data folder is `FERRY_HOME` or `~/.ferry` on every OS, per ferry.js:28. I did not check whether Ferry itself uses something else on macOS.

**Credentials on macOS (verified after the review)**
- The sign-in is kept in the macOS Keychain, and each `CLAUDE_CONFIG_DIR` gets its own Keychain item, so profiles hold separate sign-ins on macOS as on the other OSes.
- The item's service name is `Claude Code-credentials`, plus `-` and the first 8 hex digits of the SHA-256 of the config folder path when `CLAUDE_CONFIG_DIR` is set. Checked in the Claude Code 2.1.319 binary. The authentication docs say the same: "keys the macOS Keychain entry to that directory too, so a session with a different `CLAUDE_CONFIG_DIR` reads a different entry" (https://code.claude.com/docs/en/authentication).
- If the Keychain refuses the write (for example when it is locked in an SSH session), the sign-in goes to `<config dir>/.credentials.json` instead, which is still per profile.
- The exception is a Claude Console sign-in without an API key: it is stored outside the config folder and is shared. Baton tracks claude.ai plan windows, so those accounts are out of scope anyway.
- Because the item name hashes the folder path, moving or renaming a profile folder loses its sign-in. Baton's account ids never change, so this only matters if `BATON_HOME` moves.

**Case-insensitive filesystems**
- `samePath` is case-sensitive everywhere except win32 (paths.js:63-67). On default APFS this gives false `wrong-link` / `conflict` results.
- Rust: compare by `same-file`, or canonicalise both sides.
- `normalizeProjectKey`'s lowercasing is right on macOS and wrong on Linux.

**Permissions**
- Profiles are created with `mkdirSync` under the default umask, so 0755, yet they hold `.credentials.json`.
- Backups under `~/.baton/backups` copy `settings.json`, which may hold `env` secrets such as API keys.
- Rust: create `~/.baton`, the profiles and the backups as 0700, write files 0600, and keep the mode of `settings.json` when replacing it.

**Windows-only assumptions that leak into other OSes**
- `nodeCommand`'s fallback to plain `node` applies on every OS; for example `/Users/x/Library/Application Support/...` has a space. Under `/bin/sh` a quoted path works fine, so on macOS and Linux always write the quoted absolute path.
- `forward()` does nothing there.
- `removeLink`'s `rmdir` fallback only matters on Windows.
- Doctor's "file links" text talks about Developer Mode. The "status line shell" check is Windows-only, which is fine.

**Binary path stability on macOS and Linux**
- `current_exe()` returns the resolved path (via `/proc/self/exe` on Linux), for example Homebrew's versioned `Cellar/baton/x.y.z/bin/baton`. That path breaks the hooks on every upgrade.
- Prefer the `baton` found on PATH when it resolves to the same file; otherwise use a stable shim such as `~/.local/bin/baton`.
- On Windows, scoop and winget give versioned folders too, and a running `.exe` cannot be overwritten.

**Gatekeeper on macOS**
- An unsigned binary that was downloaded carries a quarantine flag and will be blocked when hooks run it.
- Ship through brew or cargo, or sign and notarise. Doctor should spot the quarantine flag.

**Ferry folder permissions** are only applied on unix; that is already correct.

### 8. Rust mapping

**Modules**
- `install` (plan, apply, legacy matchers)
- `settings_fmt` (indent, EOL and trailing-newline preservation, BOM)
- `profile` (layout table, link, inspect, seed, trust)
- `copies` (sync, three-way merge, lock)
- `ferry`
- `doctor`
- `diff`
- `fsx` (atomic write, links, lock, probe)
- `paths` (`same_path`, `dunce`)

**Key types**
- `SharedItem { name, kind: Dir | File | LinkOnlyFile }`
- `LinkAction`, `ItemStatus` enums
- `InstallRecord`: v1 and v2, serde defaults, `previous_status_line: Option<Value>`
- `Plan { files: Vec<PlannedFile>, items, notes, record }`
- `PlannedFile { path, before: Option<String>, after: Option<String>, diff, backup_name, soft_fail }`
- `CopiesRecord { version, profiles: BTreeMap<String, BTreeMap<String, String>>, source }`
- `Conflict { at, account, item, backup, kept }`
- `LauncherDef` (field order fixed, rendered pretty with 2 spaces plus `\n`)
- `Check { name, ok: Option<bool>, detail }`
- Keep `settings.json` and `.claude.json` as `serde_json::Value`, so unknown keys survive.

**Crates**
- `serde`, `serde_json` with `preserve_order`; `PrettyFormatter::with_indent` for the detected indent.
- `junction` (create and read Windows junctions); `std::os::{unix,windows}::fs::symlink*` for symlinks and the probe.
- `dunce` and `same-file` for path comparison.
- `tempfile` for atomic writes, plus a retry loop on Windows.
- `fd-lock` or `fs4` for the cross-process lock.
- `sha2` and `hex` for the hashes.
- `similar` for the diff.
- `which` for the PATH lookup.
- `time` or `jiff` for ISO timestamps.
- No `notify`: the README promises no background service. Sync at launch and hop, and cheaply in the SessionStart hook, which Rust makes affordable.
