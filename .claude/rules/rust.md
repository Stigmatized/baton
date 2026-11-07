---
paths:
  - "**/*.rs"
  - "**/Cargo.toml"
---

# Rust conventions

- Errors: one `thiserror` enum per module. Only `cli` maps errors to exit codes (0 ok, 1 failure, 2 usage error,
  3 nothing to pick). Hook and status-line entry points catch every error and exit 0.
- Newtypes for ids (`AccountId`, `SessionId`, `WrapperId`) and percentages; enums for closed sets, with serde renames
  matching the JS strings in `port/review/data.md`.
- Files Baton does not own (`settings.json`, `.claude.json`) stay `serde_json::Value`; `config.json` keeps unknown
  fields through `#[serde(flatten)]`. Never `deny_unknown_fields` on files a user or Claude Code writes.
- `policy`, `usage` and `stats` are pure: no file, process or clock access; they take `now` as an argument.
- Every path comes from `BatonPaths`.
- OS-specific code and `unsafe` live only in `platform` modules.
- No async runtime: threads and `crossbeam-channel`.
- Only the crates in the Architecture section of `port/PLAN.md`; another one needs a reason in the commit message.
- Every fix and behaviour change gets a test that fails without it.
- Comments explain why and change with the code they describe. No history in comments ("fixed", "now", review
  findings): that goes in commit messages and `port/NOTES.md`. Point to `port/review/` sections, never to JS files
  or lines; the JS code is deleted in milestone 9.
