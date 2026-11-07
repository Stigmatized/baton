# Baton: Rust port

This branch, `rust`, ports Baton from JavaScript to Rust. The JS code in `src/`, `test/` and `scripts/` is the
reference implementation: read it to learn behaviour, never copy its structure, and do not run it.

## Where the decisions are

- [port/PLAN.md](port/PLAN.md): every adopted decision, the architecture, the milestones and the review process.
  Read the relevant section before starting work.
- [port/review/](port/review/): the exact JS behaviour to match (file formats, `claude` flags, hook inputs,
  constants): [data.md](port/review/data.md), [runtime.md](port/review/runtime.md),
  [install.md](port/review/install.md), [ui.md](port/review/ui.md).
- [port/NOTES.md](port/NOTES.md): one line per behaviour change from the JS version.
- Match `port/review/` exactly unless PLAN.md adopts a change; PLAN.md wins a disagreement. If the work needs a
  decision PLAN.md does not make, stop and ask the user.

## Commands

- Build: `cargo build`
- All tests: `cargo test`
- One test: `cargo test -p baton <test_name>`
- Lint: `cargo clippy --all-targets -- -D warnings`
- Format: `cargo fmt` (CI runs `cargo fmt --check`)
- Update snapshots: `cargo insta review`
- TUI images: `cargo xtask shots`, written to `target/shots/`

## Conventions

- A behaviour change from the JS version adds its line to `port/NOTES.md` in the same commit.
- Rust conventions: `.claude/rules/rust.md` (loads with Rust files).
- Commits: one slice per commit, reviewed with the `sol-loop` skill first, base `HEAD`. The message ends with
  `Reviewed with sol-loop: <N> rounds with <model>. Sol verdict: approved`. Details: "Review process" in
  [port/PLAN.md](port/PLAN.md).
- Push the `rust` branch to `origin` only after an approved slice.

## Gotchas

- `BATON_HOME` replaces the home folder, so it moves both `~/.baton` and `~/.claude`. Tests and manual runs always set
  it to a temporary folder; running against the real home changes the user's Claude Code setup.
- Hooks and the status line run inside every Claude Code session: they must exit 0, and hooks must print nothing to
  stdout (it reaches the model).
- The JS version was only tested on Windows. The port must work on Windows, macOS and Linux.
