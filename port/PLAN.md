# Baton Rust port: plan

Status: every decision here was adopted with the user on 2026-11-07. A new decision is discussed with the user first.
Based on four read-only reviews of the JS version at commit `f676a1e`, kept in [`review/`](review/):

| Review | Covers |
| --- | --- |
| [data.md](review/data.md) | `~/.baton` formats, config, policy, usage accounting, stats, sessions |
| [runtime.md](review/runtime.md) | the `baton` wrapper loop, hooks, status line, claude args, usage probe and polling, process handling |
| [install.md](review/install.md) | `baton install`, profiles, two-way copies, Ferry, doctor |
| [ui.md](review/ui.md) | commands and their JSON, printed screens, the menu, terminals per OS |

The reviews hold the exact contract the port must match: file formats, claude flags, hook inputs, every constant.
This plan only lists the decisions and the order of work.

## Ground rules

- Rust replaces JS completely. The JS code stays on this branch until Rust does everything it does, then goes in one
  commit.
- Windows, macOS and Linux are all first-class. CI runs the full test suite on all three.
- Existing users keep their data: the Rust version imports everything the JS version wrote under `~/.baton`, and
  recognises and upgrades every entry the JS `baton install` put in `~/.claude`.
- Every behaviour change gets a line in [NOTES.md](NOTES.md) saying what changed and why.
- During development, Rust runs only against a temporary `BATON_HOME`, never the real home folder. Testing the import
  means copying real `~/.baton` data into that temporary home first.
- The finished branch goes to ntanis as a draft pull request.

## Architecture

- One binary, `baton`. No Node, no runtime to install.
- Cargo workspace at the repo root:
  - `crates/baton`: the binary and its library.
  - `crates/fake-claude`: a test-only stand-in for `claude` (replaces `test/fixtures/fake-*.js`).
  - `xtask`: developer commands, starting with `cargo xtask shots`.
- No async runtime. Threads plus channels: one thread waits on the `claude` child, one runs the poll host, the TUI has
  an input thread and a data-loader thread.
- Crates: `clap`, `serde`/`serde_json` (`preserve_order`), `thiserror`, `rusqlite` (`bundled`), `fs4`, `tempfile`,
  `chrono`, `regex`, `uuid`, `crossbeam-channel`, `ratatui` + `crossterm`, `unicode-width` + `unicode-segmentation`
  + `unicode-normalization`, `notify`, `junction`, `dunce`, `same-file`, `sha2`, `similar` (diffs), `diffy`
  (three-way merge), `which`, `signal-hook`, `sysinfo`, `windows-sys` (Windows), `rustix` (Unix). Tests and tooling:
  `insta`, `portable-pty`, `vt100`, `resvg`.
- Modules:

| Module | Contents |
| --- | --- |
| `paths`, `names`, `time` | home and paths, account names and ids, the single time-format module |
| `config` | `config.json`: typed, strict, unknown fields kept |
| `store` | SQLite connection, schema, migrations, the JS import |
| `lock` | OS advisory locks: session, poll lease, wrapper liveness, config and sync |
| `usage`, `policy`, `stats` | readings, refusals, refusal inference, account selection, turn decisions; pure functions with an injected clock |
| `hooks`, `statusline` | the five hook events and the status line |
| `claude` | locating the executable, the argument parser, the usage probe |
| `runtime` | the wrapper state machine, ending `claude`, the countdown, `platform::{windows, unix}` |
| `poll` | the poller and the poll host |
| `profile`, `sync`, `install`, `ferry`, `doctor` | profiles and links, the settings sync engine, install/uninstall, Ferry launcher, checks |
| `views` | view models shared by printed screens and the TUI: `Vec<Line>` plus click targets |
| `cli`, `screens`, `tui` | clap commands and outputs, printed screens, the ratatui app |

## Storage

**S1. SQLite for live state and history; files for what people read or edit.**

| Data | Where | Why |
| --- | --- | --- |
| usage readings, refusals, per-model meters | SQLite | Status lines and the poller rewrite these at the same time today and lose updates. |
| history (readings, sessions, hops, refusals) | SQLite | Stats becomes queries; retention becomes a `DELETE`. |
| sessions, turn samples, hop requests | SQLite | Hot hook and wrapper traffic; replaces folder-mtime guessing with a `last_seen` column. |
| wrappers registry, poll state, poll requests | SQLite | Shared read-modify-write. |
| `config.json` | file | Documented and edited by hand. Edits take the config lock (S2); every save keeps `config.json.bak`. |
| `install.json`, `conflicts.json`, `sync/base/`, `backups/`, `logs/` | files | Rare writes, records people inspect. `sync/base/` replaces the JS `copies.json`. |
| `accounts/<id>/` | folders | They are Claude Code profiles. |

- One database, `~/.baton/baton.db`, WAL mode, `synchronous=NORMAL`, schema version in `PRAGMA user_version`.
- Busy timeouts:
  - the status line: 250 ms, then it drops its write (it runs again within seconds);
  - hooks: 2 s, well inside their 10 s hook timeout (a dropped refusal would leave Baton unaware of it);
  - the wrapper, the poller, commands and the menu: 5 s.
- `~/.baton` on a network filesystem or a OneDrive-redirected home uses journal mode `DELETE`; doctor reports it.
- The wrapper notices turn ends by checking `PRAGMA data_version` every 250 ms: one cheap query, no file reads, no
  second notification channel.
- `baton export [--since date] [--kind readings|events]` writes the history as JSONL in the same shape as the JS
  `history/*.jsonl` files.

**S2. OS advisory locks instead of lock files and pid checks.**
The session lock, the poll lease, wrapper liveness, edits to `config.json` and every run of the sync engine all use
`fs4` locks on files under `~/.baton/run/`. The OS releases them when a process dies, which removes the races and
the pid-reuse problems in the JS version.

**S3. Retention, as policy settings.** Each limit is a policy key, set with `baton policy --<flag>` or in the menu's
Policy view under a Storage group. Cleanup runs at wrapper start and at menu start. It only touches Baton's own
records under `~/.baton`; Claude Code's transcripts and memory in `~/.claude/projects` are never read for cleanup,
moved or deleted.

| Policy key | Flag | Default | Range | Removes |
| --- | --- | --- | --- | --- |
| `historyDays` | `--history-days` | 180 | 0–3650, 0 keeps forever | history rows older than this |
| `sessionDays` | `--session-days` | 30 | 1–365 | ended sessions and their turn samples |
| `logDays` | `--log-days` | 14 | 0–365, 0 keeps forever | wrapper logs |
| `backupsKept` | `--backups-kept` | 50 | 0–1000, 0 keeps all | the oldest folders under `backups/` |

**Import from JS.** It runs inside the Rust `baton install`, the same step that replaces the JS hooks and status line
in `~/.claude`, so nothing keeps writing the old files afterwards.
1. Before that install, every Rust command except `install`, `doctor`, `help` and `version` stops with: "This is the
   Rust version of Baton. Run `baton install` to switch from the JS version."
2. The import runs once, inside one transaction: `usage/`, `rejected/`, `history/`, `poll/state.json`, and session
   folders from the last `sessionDays`.
3. The imported folders move to `~/.baton/legacy-js/`, kept for rollback and deleted by hand.
4. If legacy folders reappear with newer files (a JS hook still installed somewhere), the next Rust install or wrapper
   start imports them again; doctor reports it.

## Settings sync

Goal: every account has the same settings. A change made under any account, or in `~/.claude`, reaches all the
others without the user doing anything.

**Facts it rests on** (checked in Claude Code 2.1.319 and its docs):
- File symlinks need Developer Mode or admin on Windows; this is off by default. Junctions and hard links need no
  privilege.
- Claude Code writes user `settings.json` through a symlink (`allowSymlink: true` for user settings), so symlinked
  settings keep working.
- Claude Code saves by writing a temp file and renaming it over the target, which breaks hard links. Hard links are
  not used.
- Claude Code watches `settings.json` (symlink targets included) and reloads it in running sessions.
- The `ConfigChange` hook fires with `source: "user_settings"` and `file_path` when an account's `settings.json`
  changes during a session.
- Claude Code locks `.claude.json` with a lock folder, `<file>.lock` (proper-lockfile protocol), while writing it.

**Two mechanisms:**
1. Links where the OS allows them: symlinks for `settings.json`, `keybindings.json`, `CLAUDE.md` and `history.jsonl`
   on macOS, Linux, and Windows with Developer Mode. Folders (`projects/`, `skills/`…) stay junctions or symlinks on
   every OS.
2. A sync engine for everything else: file copies on Windows without Developer Mode, and the shared keys of
   `.claude.json` on every OS (it holds the account's identity, so it can never be a link).

**Merge rules:**

| Item | How it merges |
| --- | --- |
| `settings.json`, `keybindings.json` | Per key against a base snapshot of the last synced version: objects merge recursively, arrays and scalars are single values. |
| `CLAUDE.md` | Three-way line merge against the base snapshot, like git. |
| `.claude.json` | Only the shared keys: theme, editor mode, user-scope MCP servers, onboarding flags and the other `SEED_KEYS`; per project, trust, allowed tools, MCP choices and the other `SEED_PROJECT_KEYS`. Identity (`oauthAccount`, `userID`, keys) never syncs. |
| `history.jsonl` | Union of lines, de-duplicated on timestamp + session + text, in time order. |

- When the same key or the same lines changed differently on two sides, the newest change wins everywhere. The other
  value goes to `backups/` and is listed in `baton conflicts`, the menu and doctor.
- Exception in `.claude.json`: flags that only ever turn on (`hasTrustDialogAccepted`, `hasCompletedOnboarding`,
  `hasCompletedProjectOnboarding` and the other `has*` flags) keep `true`, counts keep the larger value, and
  `allowedTools` lists are merged. Claude Code writes untrusted defaults for folders it opens, and newest-wins would
  let such a default undo trust given under another account (B2).
- Base snapshots live in `~/.baton/sync/base/`. An item with no snapshot (first run, or just imported from JS) is
  seeded from `~/.claude`, and any differing account copy counts as a change made under that account.

**When it runs** (no background service):
- the `ConfigChange` hook, which `baton install` adds alongside the other hooks;
- file watchers inside every running Baton process (wrappers and the menu), which also catch edits from editors;
- every launch, hop and session start, to catch up on changes made while nothing ran.

**Safety:**
- The engine runs under Baton's sync lock (S2) and takes Claude Code's own `.claude.json.lock` before touching a
  `.claude.json`.
- Before replacing a file it re-reads the file's hash; if it changed during the merge, the merge starts over, so a
  concurrent Claude Code save is never lost.
- When file symlinks become available (Developer Mode turned on), the engine syncs the copies first, then replaces
  them with links.

## Changes from the JS version

The source review has the full reasoning for each one.

### Bugs in the JS version

The port fixes all of them. B1–B3 were reported to ntanis on 2026-11-07.

| # | Change | Source |
| --- | --- | --- |
| B1 | A failed or invalid read of `config.json` is an error, never an empty config. Today the next account change saves the empty config and deletes every account. Saves keep `config.json.bak`. | data §6.1 |
| B2 | `.claude.json` keys are merged by the sync engine, which never turns trust or onboarding flags off and never drops MCP servers added under an account (see the exception under [Settings sync](#settings-sync)). Today seeding runs on every launch with the main config winning, which can undo trust and drop MCP servers added under a profile; on a hop it undoes the trust just carried over. | install §6.1–2 |
| B3 | A `claude` started inside a Baton session cannot take over the wrapper: hooks and the status line are accepted only from the wrapper's own `claude` process tree. | runtime §6.1 |
| B4 | Two wrappers can no longer drive one conversation (session lock race, pid reuse). Fixed by S2. | data §6.3, runtime §6.2 |
| B5 | Account ids that are Windows device names (`con`, `nul`, `aux`, `com1`…) get a suffix; ids compare case-insensitively. | data §6.7–8 |
| B6 | `/hop` works with account names containing `'`, and its `allowed-tools` allows only `baton hop`. | install §6.11 |

### Behaviour

| # | Change | Source |
| --- | --- | --- |
| H1 | An account already over its threshold is left at the next turn end when another account is open, even with no cost estimate yet and inside the minimum stay. Today it is used until Claude Code refuses a turn. | data §6.2 |
| H2 | A per-model weekly refusal (Opus, Sonnet…) is scoped to that model's meter; the all-models reading no longer cancels it. | data §6.6 |
| H3 | A status line reading never makes a newer poll reading look stale. | data §6.5 |
| H4 | Turn cost and burn rate subtract the increases recorded by other sessions on the same account during the turn. | data §6.10 |
| H5 | Resume uses the session's project folder (`start.cwd` / `workspace.project_dir`), not its current folder. | runtime §6.11 |
| H6 | Unknown `claude` flags followed by a value are passed through on resume, with a log line. | runtime §6.12 |
| H7 | Replaced by [Settings sync](#settings-sync). | install §6.5–7 |

### Runtime and platforms

| # | Change | Source |
| --- | --- | --- |
| R1 | Windows: Ctrl+C is typed into the console in-process (`WriteConsoleInputW`), not through a PowerShell + C# helper per attempt. | runtime §6.3 |
| R2 | Process trees: job objects on Windows, process groups on Unix; the usage probe and auth checks can never outlive Baton. | runtime §6.6 |
| R3 | Terminal modes are saved before every `claude` launch and restored after every exit; leftover input is flushed before the countdown and the relaunch. | runtime §6.4–5 |
| R4 | SIGTERM, SIGHUP and closing the console window clean up the lock, the lease and `claude`. | runtime §6.7 |
| R5 | Hooks and the status line point at the `baton` found on PATH, not a versioned install folder. `baton install` stops if `baton` is not on PATH; doctor checks that it is the same file as the running binary; on Windows a path with spaces is written in its 8.3 short form. | install §6.10, §7 |
| R6 | Every OS probes whether file symlinks work and falls back to the sync engine; `~/.baton`, profiles and backups are private (0700/0600). | install §7 |
| R7 | `claude` lookup adds `~/.claude/local/claude`, `/opt/homebrew/bin` and `/usr/local/bin` for launches without a shell PATH. | runtime §8 |

### Interface

| # | Change | Source |
| --- | --- | --- |
| U1 | The menu works down to 80×24 (macOS and Linux default windows): the sidebar collapses below 100 columns. | ui §5.5 |
| U2 | Light terminals: printed screens use the terminal's own foreground for body text; warnings get their own colour. | ui §5.6 |
| U3 | One time format everywhere; JSON carries no locale-dependent text. | ui §5.1 |
| U4 | "Mark" everywhere (the menu says "mode", which is also the policy's name). | ui §5.8 |
| U5 | Strict command line (no ignored extra arguments); with `--json`, errors are JSON too. | ui §5.10 |
| U6 | Sign-in always shows the full URL as text as well as the link. | ui §5.7 |
| U7 | Number fields accept typed digits; `?` opens a key help overlay; `r`, `/`, `q`, `Ctrl+L` work everywhere. | ui §5.12–13, 21 |
| U8 | The policy form's "default" removes the override, as the command line does, instead of pinning today's value. | ui §5.9 |
| U9 | The splash shows on first run only (`BATON_SPLASH=on` shows it every time). | ui §5.17 |
| U10 | The menu polls usage and re-checks sign-ins regardless of the splash or window size. | ui §5.4 |

## Testing and review

- **Unit tests.** The JS suite is ported test by test. `crates/fake-claude` stands in for `claude`: it writes hook
  input, emits stream-json for the usage probe, exits on Ctrl+C or SIGTERM, and records the arguments it got.
- **Text snapshots.** Every view, modal and printed screen is drawn into a ratatui `TestBackend` buffer and stored
  with `insta`, at 80×24, 100×30, 120×30 and 160×45, with rich and plain glyphs, with and without colour. Every row
  is also asserted to fit its width. A changed screen fails the test and shows a text diff.
- **Images.** `cargo xtask shots` renders the same buffers to PNG (buffer → SVG → PNG with `resvg`; a bundled
  monospace font; every cell's colours and bold, inverse and underline). It needs no terminal or browser and gives
  the same output on every OS. Files go to `target/shots/<view>-<size>-<variant>.png`. CI uploads them on every run.
- **End to end.** A few tests run the real `baton view` in a pseudo-terminal (`portable-pty` + `vt100`) against a
  temporary `BATON_HOME`. They send keys, mouse clicks and resizes, change files, and check the screen and the
  terminal modes before and after. The screen grid can go through the PNG renderer.
- **Demo.** `cargo run --example menu-demo` opens the menu on fixture data with a fake sign-in.
- **Smoke tests with the real Claude Code.** At the end of milestones 3, 5, 6 and 8, the user runs the real `claude`
  under a temporary `BATON_HOME`: two accounts added and signed in there with `baton login` (the sign-ins stay in the
  temporary profiles), then real sessions covering hooks, the status line, `/hop`, a limit hop and `/usage` probing.
  This catches drift between `crates/fake-claude` and the real `claude`. Transcripts stay in the temporary home.
- **Real home.** Only at switch-over: a release build, `baton install --dry-run --diff` reviewed first.
- **Rule for every UI change:** update the snapshots, review their diff, and look at the changed PNGs before the
  change counts as done.

## Review process

Every code change is reviewed with the `sol-loop` skill (OpenAI's Sol through the codex-bridge plugin) before it is
committed. Commits that change only documents in `port/`, `CLAUDE.md` or `.claude/` are not.

**Slices.** Each milestone is split into slices: one coherent piece each, about 300–1,000 lines of non-test code.
Per slice:
1. Implement it; `cargo fmt --check`, `cargo clippy --all-targets -- -D warnings` and `cargo test` pass.
2. Run sol-loop with the base set to the last commit (`HEAD`), so Sol sees only this slice. Never let sol-loop
   default to `origin/main`: that is the whole port.
3. Fix or dispute the findings as the skill says. An item still disputed after two replies goes to the user.
4. Commit once Sol approves. The commit message ends with
   `Reviewed with sol-loop: <N> rounds with <model>. Sol verdict: approved` (or `user decided <ids>`).
5. Push the `rust` branch only after an approved slice, never during a loop.

**Five rounds** (the skill's extension) for slices touching the SQLite store, the JS import, locks, the settings sync
engine, and install/uninstall writes to `~/.claude`.

**UI slices** give Sol the text snapshot diffs as part of the change; the implementer reviews the PNGs from
`cargo xtask shots` before starting the loop.

**Milestone check.** After a milestone's last slice, one more sol-loop runs with the base at the milestone's first
commit. Its intent: compare the milestone with this plan and the contracts in `port/review/`, and look only for gaps
and for bugs across slice boundaries, not for line-level issues already reviewed.

## Things to verify against real Claude Code

Still open, confirmed before milestone 6 starts with one run on a signed-in account:
`claude -p "/usage" --output-format stream-json --verbose` emits `usage_report` on the assistant message, as the SDK
path does.

Verified in Claude Code 2.1.319 and its docs:
- On macOS each profile keeps its own sign-in: the Keychain item is named after the config folder (see
  [review/install.md](review/install.md), "Credentials on macOS").
- Claude Code writes `settings.json` through a symlink instead of replacing it (see [Settings sync](#settings-sync)).
- Claude Code starts every project entry in `.claude.json` from a default with `hasTrustDialogAccepted: false` and
  writes the whole entry, so any folder opened in plain `claude` carries an explicit `false` (the cause of B2).
- The `statusLine` setting takes only a `command` string (`type`, `command`, `padding`, `refreshInterval`,
  `hideVimModeIndicator`), no exec-form `args`, so R5's 8.3 short path on Windows is needed.

## Order of work

Each milestone ends with its tests passing on Windows, macOS and Linux.

1. **Foundation.** Workspace, CI matrix, `paths`, `names`, `time`, `config` (with B1, B5), `store` with the schema
   and the JS import, `lock`. The first slice adds the real-home guard: a `baton` built anywhere but the release
   workflow refuses to start unless `BATON_HOME` is set to a folder other than the real home (the release workflow
   sets a compile-time flag, read with `option_env!`, that lifts the guard). It runs before anything else in `main`,
   so tests, `cargo run` and every child process are covered; dogfooding on the real home uses a release build. The
   workspace starts with the checks every later slice relies on:
   - Edition 2024; the toolchain pinned in `rust-toolchain.toml`.
   - Root `Cargo.toml`: `[workspace.lints.rust] unsafe_code = "deny"`; `[workspace.lints.clippy]` sets `all`,
     `unwrap_used`, `expect_used`, `panic`, `todo`, `unimplemented`, `dbg_macro`, `allow_attributes`,
     `allow_attributes_without_reason` and `undocumented_unsafe_blocks` to `"deny"`. Every crate sets
     `[lints] workspace = true`.
   - `clippy.toml`: `allow-unwrap-in-tests = true`, `allow-expect-in-tests = true`.
   - CI on Windows, macOS and Linux runs `cargo fmt --check`, `cargo clippy --all-targets -- -D warnings` and
     `cargo test`.
2. **Policy.** `usage`, `policy`, `stats` as pure functions, with H1–H4. Port `policy.test.js` and `usage.test.js`.
3. **Hooks and status line.** The five events, the status line with chaining to the previous one, B3.
4. **Profiles and install.** Links, the settings sync engine (with B2), install/uninstall with recognition of the JS
   entries, B6, R5, R6, Ferry, doctor.
5. **Runtime.** `claude` lookup (R7), argument parser (H6), the wrapper loop, ending `claude` (R1–R4), countdown, the
   `hop` command, H5. After this milestone `baton` is usable day to day.
6. **Usage polling.** The probe (after the open item under "Things to verify"), the poller, the poll host on an OS
   lock.
7. **Commands.** Every command and its `--json` output, printed screens (U2–U5).
8. **Menu.** `cargo xtask shots` first, then the ratatui app with every view, modal, sign-in and mouse support (U1,
   U6–U10), each view landing with its snapshots and images.
9. **Switch-over.** README, NOTES.md complete, release builds for the three OSes, remove the JS code together with
   its `Edit` deny rules in `.claude/settings.json` and its mentions in `CLAUDE.md`, draft pull request to
   `ntanis-dev/baton`.
