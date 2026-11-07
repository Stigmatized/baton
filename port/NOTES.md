# Baton Rust port: notes

One line per behaviour change from the JS version: what changed and why. Filled in as changes are adopted; see
[PLAN.md](PLAN.md) for the proposals.

## Storage

- Usage readings, refusals, history, sessions, wrappers and poll state live in one SQLite database,
  `~/.baton/baton.db`, instead of loose JSON files: several processes write them at once, and transactions stop the
  lost updates the files allowed.
- `config.json` stays a file people can edit; edits now take a lock and each save keeps `config.json.bak`, so two
  changes at once no longer lose one of them.
- The session lock, the poll lease and wrapper liveness use OS file locks instead of lock files and pid checks: the OS
  releases them when a process dies, which ends the stale-lock races and the Windows pid-reuse problem.
- History, sessions, logs and backups are pruned by four new policy settings (`historyDays` 180, `sessionDays` 30,
  `logDays` 14, `backupsKept` 50): the JS version only pruned sessions and let everything else grow forever.
- New `baton export` writes the history as JSONL in the JS file format, so it stays readable outside Baton.
- The switch from the JS version happens in `baton install`, which imports the JS data into SQLite and moves the old
  folders to `~/.baton/legacy-js/` for rollback.

## Settings sync

- Copied settings files merge per key (JSON) or per line (`CLAUDE.md`) against the last synced version, and the
  newest change wins a real conflict: the JS version let `~/.claude` win whenever both sides changed, even when the
  changes touched different settings, so a change made under an account was often lost to a backup.
- The user-level keys of `.claude.json` (theme, editor mode, user-scope MCP servers, per-project trust and allowed
  tools) sync both ways between all accounts and `~/.claude`: the JS version only copied them from `~/.claude` into
  the accounts, so a change made under one account stayed there.
- Syncing runs immediately, on Claude Code's `ConfigChange` hook and on file watchers inside running Baton processes,
  not only at launch: changes reach the other accounts' running sessions within seconds.
- Prompt history (`history.jsonl`) is shared across accounts on every OS, merged as a de-duplicated union in time
  order: the JS version could only share it through a symlink, so on Windows without Developer Mode ↑ after a hop
  showed the new account's old prompts instead of the conversation's.
- Baton takes Claude Code's own `.claude.json.lock` before writing an account's `.claude.json`, and re-checks every
  file just before replacing it: the JS version could overwrite a save Claude Code made at the same moment.

## Behaviour

- An account already over its threshold is left at the next turn end when another account is open, even before a
  cost estimate exists and inside the minimum stay: the JS version kept using it until Claude Code refused a turn.
- A per-model weekly refusal (Opus, Sonnet…) applies only to that model's limit and is cleared only by a reading of
  that limit: the all-models reading used to cancel it, which caused refuse, re-pick, refuse loops.
- A status line reading no longer makes a newer poll reading look stale: the status line can repeat old numbers, and
  the JS version let them overwrite fresher data.
- A session's turn cost and burn rate exclude usage other sessions on the same account added during the turn: two
  sessions on one account each counted the other's usage as their own and hopped too early.
- A hop resumes in the session's project folder, not the folder it ended up in: `--resume` finds transcripts by
  project folder, so resuming elsewhere could miss the conversation.
- Unknown `claude` flags followed by a value are passed through on resume, with a log line: the JS version treated
  them as switches and dropped their values on every hop.

## Runtime and platforms

- On Windows, Baton ends `claude` by writing Ctrl+C into the console itself: the JS version started PowerShell and
  compiled C# for every attempt, which took seconds, failed on locked-down machines and looked suspicious to
  antivirus.
- `claude`'s process tree runs in a job object (Windows) or process group (Unix), and the usage probe and sign-in
  checks can never outlive Baton: the JS version could orphan MCP servers and shells.
- Terminal modes are saved before every `claude` launch and restored after every exit, and leftover keystrokes are
  flushed before the countdown and the relaunch: the JS version only reset the terminal after a forced kill.
- Killing the wrapper or closing its window ends `claude` and releases the lock and lease: the JS version left them
  behind.
- Hooks and the status line call the `baton` found on PATH: a versioned install folder (Homebrew, Scoop, winget)
  would break them on every upgrade.
- Every OS checks whether file symlinks work and falls back to the sync engine, and `~/.baton`, profiles and backups
  are private to the user: the JS version assumed symlinks always work outside Windows and created folders readable
  by others.
- `claude` is also looked up in `~/.claude/local`, `/opt/homebrew/bin` and `/usr/local/bin`: launches from Ferry or a
  macOS app often have no shell PATH.

## Interface

- The menu works down to 80×24, with the sidebar collapsing below 100 columns: the JS minimum of 100×28 is larger
  than the default macOS and Linux terminal window.
- Printed screens use the terminal's own text colour, and warnings have their own colour: fixed light greys were
  nearly invisible on light themes, and warnings looked like accents.
- One time format everywhere, and no locale-dependent text in JSON: the JS version mixed two formats, sometimes on one
  screen.
- "Mark" is the word for preferred / normal / last resort everywhere: the menu called it "mode", the policy's name.
- The command line rejects extra arguments, and with `--json` errors are JSON too: extra arguments were silently
  ignored and errors were always plain text.
- Sign-in always shows the full URL as text as well as a link: terminals without link support left no way to get it.
- Number fields accept typed digits, `?` shows the keys, and `r`, `/`, `q` and `Ctrl+L` work everywhere: reaching a
  value took hundreds of arrow presses, and the README's `r` did nothing.
- The policy form's "default" removes the override: it used to pin today's default value.
- The splash shows on first run only (`BATON_SPLASH=on` shows it every time): it asked for a key on every launch.
- The menu polls usage and re-checks sign-ins regardless of the splash or the window size: polling waited for the
  splash to be dismissed.

## Bug fixes

- A `config.json` that cannot be read or parsed stops the command with an error: the JS version treated it as an empty
  config, and the next account or policy change saved that, deleting every account.
- Seeding an account's `.claude.json` from `~/.claude.json` never downgrades: trust stays granted, allowed tools
  merge, and MCP servers added under the account stay. The JS version let the main config win on every launch, which
  could undo folder trust, including the trust just carried over on a hop.
- Hooks and the status line are accepted only from the wrapper's own `claude` process tree: in the JS version a
  `claude` started inside a Baton session could redirect the wrapper to its own conversation.
- One conversation can only be driven by one wrapper: the OS session lock replaces the lock file whose stale-lock race
  and pid reuse let two wrappers hold it.
- Account ids that are Windows device names (`con`, `nul`, `aux`, `com1`…) get a suffix, and ids compare ignoring
  case: those names produced folders Windows cannot create, and case-only differences split one account in two.
- `/hop` works for account names containing `'`, and its allowed tools are limited to `baton hop`: the JS command
  broke on quotes and allowed any `node` command during that turn.
