---
paths:
  - "**/*.rs"
  - "**/Cargo.toml"
---

# Rust conventions

## Errors

- One `thiserror` enum per module; propagate with `?`.
- No `unwrap`, `expect` or `panic!` outside tests (clippy denies them).
- To silence a lint, use `#[expect(clippy::<lint>, reason = "<why>")]`; `#[allow]` is denied.
- Only `cli` maps errors to exit codes: 0 ok, 1 failure, 2 usage error, 3 nothing to pick.
- The hook and status-line entry points catch every error, log it and exit 0.

## Types and data

- Newtypes for ids (`AccountId`, `SessionId`, `WrapperId`) and percentages; enums for closed sets (`Mark`, `Window`,
  `Decision`), with serde renames matching the JS strings in `port/review/data.md`.
- On-disk structs use `#[serde(default)]` and the lenient time parsing in `port/review/data.md`.
- Files Baton does not own (`settings.json`, `.claude.json`) stay `serde_json::Value`, so unknown keys survive.
- `config.json` keeps unknown fields through `#[serde(flatten)]`. Never use `deny_unknown_fields` on files a user or
  Claude Code writes.

## Structure

- `policy`, `usage` and `stats` are pure: no file, process or clock access. They take `now` as an argument.
- Only the edges call `Utc::now()`. In-process timers use `std::time::Instant`.
- Every path comes from `BatonPaths`. Nothing else calls `home_dir()`.
- `#[cfg(windows)]` / `#[cfg(unix)]` code and every `unsafe` block live in `platform` modules; each `unsafe` block
  has a `// SAFETY:` comment.
- No async runtime: threads and `crossbeam-channel`.
- Use only the crates in the Architecture section of `port/PLAN.md`; adding another needs a reason in the commit
  message.
- Each module starts with a `//!` comment saying what it owns and which `port/review/` section it implements.

## Tests

- Unit tests sit next to the code in `#[cfg(test)] mod tests`; cross-module tests go in `crates/baton/tests/`.
- A ported JS test keeps the JS test's name.
- Every fix and every behaviour change gets a test that fails without it.
- Tests use a temporary `BATON_HOME` and `crates/fake-claude`, never the real home folder or `claude`.
- Screen changes update the `insta` snapshots in the same commit.
