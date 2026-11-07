# Review: data model, policy and usage

A read-only review of the JS version at commit f676a1e.

Read-only review of src/config.js, accounts.js, names.js, paths.js, state.js, fsutil.js, policy.js, usage.js, stats.js and sessions.js. I also read their tests and followed callers into hooks.js, lead.js, hop.js, poller.js, probe.js and poll-host.js. Nothing was run or edited.

**The findings that matter most:**
1. A failed or corrupt read of config.json silently becomes an empty config, and the next account or policy change then saves that, deleting every account.
2. Once an account is over its threshold, the session only leaves it if a cost estimate exists and the minimum stay has passed. Otherwise it stays until Claude Code refuses a turn.
3. The session lock has a race in which two wrappers can both get it.
4. usage/<id>.json is read-modify-written by several processes at once with no lock, so updates can be lost.
5. An id made from a name can be a Windows reserved device name ("con", "nul"…). That profile folder cannot be created on Windows.
6. Storage: the hot state and the history should move to one SQLite database. config.json and the profile folders stay as they are (section 8).

## 1. Responsibilities
- **paths.js** finds the home folder (`BATON_HOME`, otherwise the OS home) and builds every path under it. It also holds the id regexes (`ID_RE` up to 128 characters, `ACCOUNT_ID_RE` up to 64: paths.js:12-14).
  - `profileEnv` (paths.js:50) builds the environment for `claude`: it deletes every case variant of `CLAUDE_CONFIG_DIR` and sets it to the profile folder.
  - `accountFromEnv` (paths.js:86) turns `CLAUDE_CONFIG_DIR` back into an account id. It returns the id only when the folder's parent is `~/.baton/accounts` and the folder name matches the id regex.
  - `samePath` and `isInside` compare paths, ignoring case only on win32. `forward` swaps backslashes for slashes.
- **fsutil.js** provides synchronous helpers:
  - `readJson`/`readText` return the fallback on any error (fsutil.js:20-34).
  - `writeFileAtomic` writes a temp file in the same folder, then renames it, retrying on Windows (fsutil.js:38-62). `writeJsonAtomic` writes 2-space JSON plus a newline.
  - `appendJsonLine` writes compact JSON plus a newline; `readJsonLines` skips torn lines.
  - It also has `sleepSync` (an `Atomics.wait` trick), `lowerPriority`, `isAlive(pid)` (signal 0) and the time helpers `iso`/`ms` (fsutil.js:107-112).
- **names.js** validates account names: NFC, trimmed, 1–120 code points, no control characters, line or paragraph separators, or bidi overrides (names.js:8-24). `sameName` compares after NFC, trim and lowercase. `idFromName` makes the slug id (names.js:33-42).
- **config.js** defines the config.json schema and its normalisation, the policy defaults and limits, account lookup, saving, the effective policy and per-account thresholds.
- **accounts.js** holds the account operations the CLI and TUI share: add, rename, remove, order, move, set, and `setPolicy`. Each is a load-modify-save of config.json. `add` and `remove` also call profile.js `linkProfile`/`unlinkProfile` and copies.js `forgetCopies`.
- **state.js** `loadSnapshot` (state.js:11) reads config, readings and rejections and computes the account states. It optionally adds the running wrappers, recent sessions and poll state. `nextWork` is `pickStart` over the snapshot.
- **policy.js** is pure decision logic:
  - window and account state;
  - `pickStart` (where new work goes) and `pickSpread` (used only by tests, never by the app);
  - `turnCost`, `burnRate` and `hoursToBlock`;
  - `decideTurnEnd` (stay, wait in place, hop or wait) and `decideWait`.
- **usage.js** handles readings and refusals:
  - the reading store with merge, dedupe and history (`recordReading`);
  - the refusal store;
  - the event log (`recordEvent`);
  - status line parsing;
  - reset-time text parsing (`parseTimeAfter`);
  - working out which window a refusal belongs to (`inferRejection`);
  - picking the fullest weekly limit (`strictestWeekly`).
- **stats.js** reads the monthly JSONL history and computes per-day usage, hops and refusals, unused weekly allowance, and per-session hops and cost.
- **sessions.js** handles per-session files and turn samples, hop requests, the exclusive per-session lock, the wrapper registry, `recentSessions` and `pruneSessions`.

## 2. On-disk formats (the compatibility contract)
**Common rules**
- The root is `<home>/.baton`, where `<home>` is `BATON_HOME` if set, otherwise the OS home folder. `BATON_HOME` is the home folder, not the `.baton` folder.
- Timestamps are written as `Date.toISOString()`: UTC with milliseconds and a `Z` (`2026-10-25T12:00:00.000Z`).
  - Readers go through `ms()` (fsutil.js:108). It accepts a number (epoch ms) or anything `Date.parse` accepts, and returns null otherwise.
  - Rust must accept RFC3339 and plain numbers, and treat anything unparseable as null.
  - When a `resetsAt` cannot be parsed, `samePeriod` falls back to plain string equality (usage.js:31-37). The tests rely on this with values like "R1" and "W".
- Every JSON state file is written by `writeFileAtomic`:
  - It creates the folder if needed (`mkdir -p`) and writes `.<name>.<pid>.<8 hex>.tmp` in the same folder.
  - It then renames over the target. On EPERM, EACCES or EBUSY it retries up to 6 times, sleeping 5, 10, 15, 20, 25 and 30 ms.
  - There is no fsync, and temp files orphaned by a crash are never cleaned up.
- JSONL files are appended with `appendFileSync` (O_APPEND), one compact JSON object per line. Readers skip blank lines and lines that fail to parse.
- Any read error (missing file, file in use, parse error) is the same as "file absent".

**config.json** (written only by `saveConfig`, config.js:169-184; read by `loadConfig` and `normalizeConfig`)
```
{ "version": 1,
  "accounts": [ { "id": str, "name": str, "mark": "preferred"|"normal"|"last-resort",
                  "fiveHour"?: number, "weekly"?: number } ...],   // array order = priority
  "policy": { <sparse overrides of POLICY_DEFAULTS> },
  "endMethod"?: "auto"|"keys"|"signal"|"kill",   // written only when not "auto"
  "claudePath"?: str }                           // written only when set; nothing sets these two but hand edits
```

How each field is read back (config.js:92-149):
- `version` is never checked on read and is always written as 1.
- **Account id:** `raw.id` if it matches `ACCOUNT_ID_RE`; otherwise `raw.name` if the name itself matches the regex (case kept); otherwise `idFromName(raw.name)` if the name is valid. If none of these works, the entry is dropped.
- **Account name:** the cleaned name if valid, otherwise the id.
- **Mark:** read as-is if valid; a legacy `lastResort: true` means `"last-resort"`; otherwise `"normal"`.
- **Thresholds:** any finite `Number(v)`. On read there is no 1–100 range check, although `setAccount` checks 1–100.
- **Duplicates:** a later entry with the same id (exact) or the same name (ignoring case) is dropped.
- **Policy:** each key goes through `checkPolicyValue`; an unknown or out-of-range key is dropped and falls back to its default.
  - Numbers are coerced with `Number()`, so `"25"` and `true` are accepted (as 25 and 1).
  - Booleans accept true, false, "true", "on", "yes", "1", "false", "off", "no", "0" (any case).
  - Floats are allowed everywhere, including counts such as `costSamples` and `maxReblocks`.
- Unknown top-level fields and unknown account fields are dropped on the next save.

Policy defaults and limits (config.js:17-59):

| Key | Default | Range |
|---|---|---|
| `mode` | `"smart"` | `"smart"` or `"order"` |
| `fiveHour` | 90 | 1–100 |
| `weekly` | 95 | 1–100 |
| `startReserve` | 20 | 0–100 |
| `planFactor` | 1.5 | 0–100 |
| `costSamples` | 5 | 1–100 |
| `minStayMinutes` | 30 | 0–10080 |
| `waitInPlaceMinutes` | 20 | 0–10080 |
| `waitInPlaceMaxHours` | 24 | 0–168 |
| `rebalanceHorizonMinutes` | 60 | 0–10080 |
| `rebalanceMargin` | 20 | 0–100 |
| `burnWindowMinutes` | 60 | 1–10080 |
| `unknownRejectionHours` | 5 | 0–168 |
| `countdownSeconds` | 10 | 0–600 |
| `maxReblocks` | 3 | 0–100 |
| `reblockBackoffMinutes` | 15 | 0–10080 |
| `settleMs` | 800 | 0–60000 |
| `compactionRebalance` | true | boolean |
| `usagePollMinutes` | 30 | 0–1440 |
| `statusLineUsage` | false | boolean |

**accounts/<id>/** is a Claude Code profile (`CLAUDE_CONFIG_DIR`). Its links are owned by profile.js. A removed account's folder is kept. New ids are made unique against both the config's ids (ignoring case) and the folders that exist (accounts.js:51-58): `base`, then `base-2`, `base-3`, and so on.

**usage/<accountId>.json** (written by `recordReading`, usage.js:82-148; callers are the status line in hooks.js:248 and the poller in poller.js:253)
```
{ "account": id, "at": iso, "session": sessionId|null, "source": "statusline"|"poll",
  "five_hour": { "used": number, "resetsAt": iso|null, "readAt": iso, "source": str } | null,
  "seven_day": { same } | null,
  "limits": [Meter] | null, "limitsAt": iso|null,
  "extraUsage": { "enabled": bool, "monthlyLimit": num|null, "usedCredits": num|null,
                  "utilization": num|null, "currency": str|null } | null }
Meter (probe.js:89-103) = { kind: str ("session","weekly_all","unknown",...), group: str|null,
  label: str|null (model/surface display name), used: number, resetsAt: iso|null,
  severity: str|null, active: bool }
```

The merge rules:
- A window missing from the new reading keeps its previous value.
- `limits`, `limitsAt` and `extraUsage` are replaced only when the caller passes them. The poll always does; the status line never does.
- The file is written when:
  - a window changed (a different `used`, or a reset time that is not `samePeriod`); or
  - `limits` were passed; or
  - the stored `at` is at least `refreshMs` old (30 s for the status line, 0 for the poll).
- Ids that fail `ACCOUNT_ID_RE` are refused, which guards against path traversal.
- Old files may lack `limits`, `limitsAt` and `extraUsage`, and windows may lack `source` or `readAt`, so all of these must be optional.

**rejected/<accountId>.<five_hour|seven_day|unknown>.json** (written by `recordRejection`, usage.js:157-172, from the StopFailure hook; read by `loadRejections`, which uses the file name regex `^(.+)\.(five_hour|seven_day|unknown)\.json$`)
```
{ "account", "window", "at": iso, "until": iso|null, "untilSource": "message"|"reading"|"none",
  "error": "rate_limit"|"billing_error"|..., "session": str|null, "message": str|null (≤400 chars) }
```
Only the last refusal per window is kept, and the files are never deleted.

**history/readings-YYYY-MM.jsonl** (the month is the UTC month of `at`, usage.js:40-42) has one line per changed window:
`{ at, account, window, used, resetsAt, session, source }`.

**history/events-YYYY-MM.jsonl** (`recordEvent`, which writes `{ at, ...event }`):
- `{type:"session", session, account, source, wrapper}` from SessionStart (hooks.js:117).
- `{type:"refusal", session, account, error, window, until}` (hooks.js:194).
- `{type:"hop", session, from, to, reason, wrapper}` (lead.js:686). The reason is one of manual, refusal, planned, compaction, reblocked, all-blocked-wait.
- `{type:"stay", session, account, wrapper}` (lead.js:701).

These files are never pruned.

**sessions/<sessionId>/** (`sessionId` matches `ID_RE`; layout in sessions.js:20-35):
- `start.json`, written by SessionStart: `{at, source, account, cwd, transcriptPath, model, wrapper}`.
- `turn.json`, overwritten at each turn edge:
  - UserPromptSubmit: `{at, state:"running", event:"prompt", account, permissionMode}`.
  - Stop: `{at, state:"idle", event:"stop", account, permissionMode, backgroundTasks:[{type, status, name}] (≤50 entries, name ≤80 chars)}`.
  - StopFailure: `{at, state:"idle", event:"stop-failure", account, error, window, until, message}`.
- `live.json`, written by the status line: `{at, account, model, effort, cwd, reading: {five_hour?:{used,resetsAt}, seven_day?:{...}}|null}`. It is skipped when nothing changed and the old one is under 30 s old.
- `compact.json`: `{at}`, written on SessionStart with source "compact".
- `end.json`: `{at, reason, account}`.
- `hop.json`: `{at, to: accountId|null, by: "cli"|...}`, from `baton hop` or `/hop` (`requestHop`).
- `lock.json`: `{pid, wrapper, at, account}`. It is created exclusively (`wx`, not an atomic rename) by `acquireLock` and deleted by `releaseLock`.
- `turns.jsonl`: one line per Stop, `{at, account, five_hour:{used,resetsAt}|null, seven_day:...}`, copied from `live.reading` when `live.account` is the current account.
- Folders whose mtime is more than 30 days old and that have no live lock are deleted by `pruneSessions` (sessions.js:176-196), which lead.js:242 runs at start.

**wrappers/<wrapperId>.json** (lead.js:150; the wrapper id is `${pid}-${8 hex}`): `{pid, wrapper, account, session, startedAt, cwd, state, target?, until?}`. `listWrappers` returns only entries whose `pid` is alive. Dead entries are never removed.

**wrappers/<wrapperId>.session.json** (hooks.js:105 and 283): `{session, at, source, account}`. Source is the SessionStart source or "statusline".

**Outside my area but under ~/.baton** (for section 8):
- logs/lead-<wrapper>.log (JSONL, never pruned)
- poll/state.json, poll/lease.json and the lease.json.take guard (`wx`), poll/requests/<ms>-<hex>.json
- install.json, copies.json, conflicts.json, backups/
- probe/, tmp/

## 3. Environment and external inputs
**Environment**
- `BATON_HOME` overrides the home folder.
- `os.homedir()` is the default home: `USERPROFILE` on Windows, `HOME` on Unix.
- `CLAUDE_CONFIG_DIR` gives a hook's account.
- `BATON_WRAPPER` is set by the lead for claude's children (lead.js:184).
- `CLAUDE_CODE_SESSION_ID` is read by hop.js.

**Implicit inputs**
- The process's local time zone: `parseTimeAfter` reads "3pm" as local time, and stats groups days by local date.
- The wall clock (`Date.now`).
- PID liveness.

**Hook input on stdin** (hooks.js):
- `session_id`, `cwd`, `source`, `transcript_path`, `model`, `permission_mode`, `reason`
- `background_tasks[]` with `{type, status, name|agent_type}`
- `error`, `last_assistant_message`, `error_details` (a string or an object)

**Status line input:** `session_id`, `rate_limits.{five_hour,seven_day}.{used_percentage, resets_at (epoch seconds)}`, `model.id`, `effort.level`, `workspace.current_dir`, `cwd`.

**Probe input** (`usage_report`): `rate_limits.limits[]` with `{kind, group, percent, resets_at, scope.model.display_name, scope.surface.display_name, severity, is_active}`, and `rate_limits.extra_usage` with `{is_enabled, monthly_limit, used_credits, utilization, currency}`.

## 4. Core algorithms
**Constants:**
- Window lengths: 5 h and 168 h.
- `PERIOD_TOLERANCE_MS` = 10 min.
- `LIMIT_ERRORS` = `rate_limit`, `billing_error`.
- `BUSY_TASKS` = subagent, workflow, teammate.

**Window state** (`windowState`, policy.js:25-96), with `threshold` = the account override, otherwise the policy value:
- **Reset:** if `used` is finite and `resetsAt` is at or before now, the window has reset. It has also reset if `now - readAt` is more than the window length; that case is also marked `stale`. A reset window has `used` = null.
- **Headroom:** `threshold - (used ?? 0)`. No reading means 0% used.
- **Usage block:** `usageBlocked` = `used` is not null and headroom ≤ 0.
- **Refusal in force:**
  - `at` = `ms(at)` (0 if missing); `expiry` = `until`, or `at + maxAge` when `until` is unknown.
  - `maxAge` is 168 h for a seven_day refusal and `unknownRejectionHours` for the others.
  - The refusal is in force if `expiry > now` and it is not superseded.
  - Superseded means `used` is not null, `readAt > at`, and `used < threshold`.
- **When it opens:** `blockUntil` = the maximum of (`resetsAt` if usage-blocked) and (`until` if refused). It is null, and `blockKnown` false, if any of these is null.

**Account state** (policy.js:118-173):
- **Which readings:**
  - `five_hour` = `{source: reading.source, ...reading.five_hour}`.
  - `seven_day` = `strictestWeekly(reading, now)` (usage.js:300-323). That is the all-models `seven_day`, replaced by any weekly meter from `limits` that is fuller. Such a meter has `isWeeklyMeter` (group "weekly", or a kind starting with "weekly"), is not "weekly_all", has a finite `used`, and has not expired. Without a reset time, a meter expires when `now - limitsAt` exceeds 168 h. The replacement is `{used, resetsAt, readAt: limitsAt, source: "poll", label: label ?? kind}`.
- **Account-wide refusal:** the "unknown" refusal blocks until `until`, or until `at + unknownRejectionHours`. It is cleared when any window has `readAt > at` and no window is usage-blocked.
- **Blocking:** `blockedBy` = the blocked windows, plus "unknown". `availableAt` = now if not blocked, otherwise the maximum of the ends (null if any end is unknown).
- **Urgency:** `hoursLeft` = max((week.resetsAt − now)/h, 1/60) if week `used` and `resetsAt` are known, otherwise 168. `urgency` = max(0, weekly headroom) / `hoursLeft`.
- **Effective headroom:** the smaller of the 5-hour and weekly headroom.

**pickStart** (policy.js:222-267). `open` = the accounts that are not excluded and not blocked, sorted by config order.
- **order mode:** the first open account that is not last-resort (reason "order"), otherwise the first open last-resort account (reason "last-resort").
- **smart mode,** in this order:
  1. The first open preferred account with 5-hour headroom ≥ `startReserve` ("preferred").
  2. Otherwise the open normal account with 5-hour headroom ≥ reserve and the highest urgency, ties by order ("urgency").
  3. Otherwise any open non-last-resort account with the most 5-hour headroom, ties by order ("low-reserve").
  4. Otherwise the first open last-resort account ("last-resort").
- **Nothing open:** `{account: null, reason: "all-blocked", earliest, availableAt, availableKnown, state}`. `earliest` is chosen over all accounts, the excluded ones included: known times before unknown ones, then earliest `availableAt`, then order.

**turnCost** (policy.js:317-337), per window:
- Take the deltas `y.used − x.used` between consecutive samples.
- Count a pair only if both samples are on the same account, both values are finite, the reset times are the same period, and `y ≥ x`.
- Cost = the mean of the last `costSamples` deltas, or null if there are none.
- The samples are turns.jsonl plus the newest `live.json` reading when it is newer (lead.js:458-463).

**burnRate** (policy.js:342-361), per window:
- Take the samples with `at ≥ now − burnWindowMinutes` and a finite `used`. `last` is the last of them.
- `first` is the earliest of those on `last`'s account and in the same period (they need not be next to each other).
- Rate = max(0, Δused / hours), or null if `hours ≤ 0`.

**hoursToBlock** (policy.js:365-379): the minimum over windows with rate > 0 of max(0, headroom)/rate, counted only when that comes before the window resets. Returns Infinity otherwise.

**decideTurnEnd** (policy.js:398-534), checked in this order:
1. **A hop was requested:**
   - With a named target: the same account gives `none("manual-same-account")`, an unknown account gives `none("manual-unknown-account")`, otherwise hop with reason "manual" and no countdown.
   - Without a target: `pickStart` excluding the current account; hop if it finds one, otherwise `none("manual-no-account")`.
2. **stop-failure:**
   - An error that is not in `LIMIT_ERRORS` gives `none("other-error")`.
   - `stayUntil > now` gives `none("stayed")`.
   - `reblocks ≥ maxReblocks` gives `wait` with reason "reblocked":
     - `to` = `pickStart` (not excluding current), its earliest account, or current.
     - `at` = max(ready, now + `reblockBackoffMinutes`).
   - If the current account is blocked only by the 5-hour window, its time is known, and it opens within `waitInPlaceMinutes`, the result is `wait-in-place` with reason "reset-soon".
   - Otherwise, if `pickStart` excluding current finds an account, hop there with reason "refusal" and a countdown.
   - Otherwise:
     - no accounts at all: wait-in-place, "no-accounts";
     - the earliest time is unknown: wait-in-place, "all-blocked-unknown";
     - the current account is first back, blocked only by the 5-hour window, and back within `waitInPlaceMaxHours`: wait-in-place, "all-blocked-current-first";
     - otherwise `wait` for the earliest account until its `availableAt`, reason "all-blocked-wait".
3. **Not a turn end:** an event other than "stop", or a current account that is unknown, gives "not-a-turn-end".
4. **Normal stop, guards:** order mode gives `none`; so does `vetoUntil > now`, any busy background task, or `now − arrivedAt < minStayMinutes`.
5. **Planned hop:** the windows where the cost is known and headroom < `planFactor` × cost.
   - If there are any, take `pickStart` excluding current. Hop there with reason "planned" and a countdown only if the target has headroom ≥ `planFactor` × cost in every window with a known cost.
   - Otherwise `none("planned-no-target")`.
6. **Compaction rebalance:** applies when `compacted` is set and `compactionRebalance` is on. If `hoursToBlock ≤ rebalanceHorizonMinutes/60` and the pick's effective headroom is at least current + `rebalanceMargin`, hop with reason "compaction" and a countdown.
7. Otherwise `none("stay")`.

**decideWait:** resume if `pickStart` finds an open account. Otherwise follow the earliest account if its time is known. Otherwise keep the current target and time.

**Refusal inference** (usage.js:250-290), where the text is the message plus the details:
- **Which window:**
  - Text matching `/weekly|7-day|seven[- ]day|opus limit|sonnet limit|fable limit/i` means seven_day.
  - Text matching `/session limit|5-hour|five[- ]hour/i` means five_hour.
  - Otherwise, for `rate_limit` only, use the current, unexpired reading: a week at ≥ 99.5 means seven_day; otherwise five_hour at ≥ 99.5 means five_hour; otherwise the fuller window, with ties going to five_hour.
  - Otherwise "unknown".
- **Until when:** a reset time parsed from the message that lies in the future ("message"); otherwise the window's reading `resetsAt` if in the future ("reading"); otherwise null ("none").

**Reset-time parsing** (`parseTimeAfter`, usage.js:200-244):
- Relative form: `<word> in Nh Mm`, computed from `at`.
- Absolute form: `<word> [at] [Mon DD[,] [at]] H[:MM][am|pm]`.
  - A bare hour with neither minutes nor am/pm returns null.
  - `12am` means hour 0. An hour above 23 or minutes above 59 return null.
  - The time is read in local time.
  - Without a date, it moves to the next day if it is at or before `at`.
  - With a date, it moves to the next year if it is more than 24 h before `at`.

**Status line reading** (usage.js:50-66): for each window with a finite `used_percentage`, `{used, resetsAt: resets_at > 0 ? iso(resets_at × 1000) : null}`.

**Stats** (stats.js:42-188):
- **Inputs:** the readings history from `since − 7 d`, and events from `since`, where `since = now − days × 24 h`.
- **Dates:** local dates from stepping `now − (days−1)×24 h` by 24 h, plus today.
- **Totals per day:** hops, refusals, and sessions (only session events with source startup or clear). `hopReasons` counts hops by reason.
- **Per account per day:** the highest five_hour `used`, the last seven_day `used`, refusals, hops in and hops out.
- **Unused weekly allowance:** group seven_day readings by `samePeriod(resetsAt)` and keep the last of each group. For each group whose reset falls in [since, now]: `headroomLeft` = max(0, current weekly threshold − used) and `unused` = max(0, 100 − used).
- **Sessions:** every session id found in session, hop or refusal events, with its first-seen time, account names, hops, refusal count, `turns` = the turns.jsonl line count, and `turnCost`.
- **Recent hops:** the last 20.

**recentSessions** (sessions.js:129-172):
- Folders whose mtime is under 6 h old.
- `at` = the maximum of the live, turn and start `at` times and the folder mtime; the session is dropped if that is over 6 h old, or if `end.at ≥ at − 1 s`.
- The account comes from live, then turn, then start.
- Sorted newest first.

## 5. Concurrency
Writers:
- Every hook and every status line run is its own short-lived process. The status line runs very often, for every session.
- Several lead wrappers, the menu, CLI commands and the poller (one lease holder) all run at the same time.

What happens, file by file:
- **config.json:** every change reads, modifies and saves the whole file with no lock (accounts.js throughout). Two changes at once lose one of them.
  - Readers see either the old or the new file because of the rename, except on a transient Windows error. That error is read as "absent", which is the data-loss bug in section 6, item 1.
- **usage/<id>.json:** read, merged and written with no lock, by the status line of every session on the account plus the poller.
  - The last writer wins on the whole object. A status line write that read the file before a poll landed brings back the old `limits` and `extraUsage`.
  - Both writers may append the same change to the history.
- **rejected/\*:** one writer at a time per window (StopFailure); they are replaced whole.
- **sessions/\*:** "one kind of writer per file" (sessions.js:20). This holds per file. The lead polls turn.json and hop.json and reacts, so ordering is by `at` timestamps, and a writer that is late can be missed or misordered. The refusal is written before turn.json on purpose (hooks.js:186).
- **lock.json:** exclusive create, read the holder, and if its pid is dead, delete and retry (sessions.js:70-86). This is open to a race (section 6, item 3).
- **History JSONL:** concurrent `O_APPEND` writes of small lines. In practice this is per-line atomic on NTFS, ext4 and APFS, but it is not guaranteed. Torn lines are skipped.
- **wrappers/\*.session.json:** written by both SessionStart and the status line. The last writer wins, which is harmless.

## 6. Weaknesses and improvement candidates
1. **A failed read wipes the config.** (High confidence, high impact.)
   - Where: `readJson` returns null on any error, including a parse error or a sharing violation (fsutil.js:20). `loadConfig` then normalises `{}` into an empty config (config.js:152). Every accounts.js operation loads, mutates and saves.
   - Why it matters: a config with a trailing comma after a hand edit, or one read during an antivirus lock, becomes zero accounts. The next `account add` or `setPolicy` then saves that, permanently deleting every account entry. The policy is also silently reset.
   - Better design: treat a missing file and an unreadable or invalid file differently. Retry transient errors. Never write a config built from a failed read; stop with a clear error. Keep config.json.bak on each save.
2. **An account over its threshold is often not left.** (Medium-high confidence that this is unintended.)
   - Where: `decideTurnEnd` on a normal stop (policy.js:481-533). The thresholds only trigger a planned hop when a cost estimate exists, and the minimum-stay and veto guards apply first. A current account that is already over its threshold (`usageBlocked`) with no cost samples yet (a new session, or one just hopped in) keeps working until Claude Code refuses a turn. A cost of 0 with headroom exactly 0 does not trigger either.
   - Better design: "current account is blocked" should be its own rule: hop at the turn end if another account is open, ignoring the minimum stay.
3. **The session lock can be held by two wrappers.** (High confidence.)
   - Where: sessions.js:70-86. Two wrappers both see a stale lock; A deletes it and creates its own; B then deletes A's fresh lock and creates its own. Both believe they hold it.
   - Also:
     - PID reuse: on Windows especially, a recycled pid keeps a dead lock "alive".
     - Torn reads: the `wx` write is not atomic, so a reader can see an empty file, read the holder as null and delete a live lock.
   - Better design: an OS advisory lock (fs4/fd-lock `try_lock_exclusive` on sessions/<id>/lock) held for the wrapper's lifetime. The OS releases it when the process dies, so no pid check is needed. Write the metadata separately.
4. **Lost updates on usage/<id>.json.** (Medium-high confidence; medium impact.)
   - Where: usage.js:97-136, read-modify-write with no lock.
   - Why it matters: concurrent status line and poll writes drop `limits`, the per-model weekly meter that only the poll provides. Policy then ignores a real per-model limit until the next poll, which is 30 minutes by default.
   - Better design: SQLite transactions (section 8), or a per-account file lock around the read-modify-write.
5. **`readAt` is the time Baton recorded a reading, not the time it was measured.** (Medium confidence.)
   - Where: usage.js:121-126. The status line does not say when its `rate_limits` were observed. A session can re-emit old numbers from its last API response, which overwrite a fresh poll and make old data look new for the staleness and refusal-superseding checks.
   - Better design: keep the record time and also keep the poll as authoritative while it is newer than the session's last API activity. At minimum, do not let a status line value with an unchanged `used` refresh `readAt` over a newer poll.
6. **A per-model weekly refusal can be cancelled immediately.** (Medium confidence.)
   - Where: policy.js:59-60. The all-models seven_day reading (say 40%) arrives after the refusal, and because 40 is under the threshold it supersedes the refusal. That leads to a refuse, re-pick, refuse loop, only damped by `maxReblocks`.
   - Also, `inferRejection` maps "Opus limit" to seven_day for the whole account (usage.js:262).
   - Better design: give refusals a scope (model label). Supersede only with a reading of the same meter. Consider blocking per model.
7. **Ids can be Windows reserved device names.** (Medium-high confidence.)
   - Where: names.js:33-42 and accounts.js:51. A name like "Con", "NUL", "aux", "com1" or "lpt1" becomes an id that cannot be a folder or file name on Windows: `accounts/con` and `usage/con.json` fail.
   - Better design: reject reserved names in `idFromName` or give them a suffix, on every OS so data stays portable.
8. **Case handling of ids.** (Medium confidence.)
   - `ACCOUNT_ID_RE` allows upper case (legacy and hand-edited ids). `normalizeConfig` removes duplicates only by exact id, so "Foo" and "foo" can both exist and share one folder on Windows and macOS.
   - `accountFromEnv` keeps the case from `CLAUDE_CONFIG_DIR` and `batonAccount` compares exactly. A case difference makes the hooks silently do nothing.
   - On macOS (APFS is usually case-insensitive), `samePath` compares case-sensitively (paths.js:63-67).
   - Better design: compare ids ignoring ASCII case on all OSes; lowercase new ids; follow the filesystem's case rule in path comparisons.
9. **Config validation is lax and lossy.** (High confidence.)
   - Thresholds are not range-checked on read (config.js:111), although `checkThreshold` requires 1–100.
   - Integer settings (`costSamples`, `maxReblocks`, `countdownSeconds`) accept floats.
   - `Number(true)` is accepted as 1.
   - `version` is ignored, so a newer config would be silently rewritten as v1 and lose fields.
   - Unknown fields are dropped on save.
   - Better design: typed serde structs with `#[serde(default)]` and range validation, the same check on read and write, unknown fields kept via `#[serde(flatten)] extra`, and a refusal to write when `version` is newer than known.
10. **Cost estimates count other sessions' usage.** (High confidence about the mechanism.)
    - Where: `turnCost` and `burnRate` use account-wide percentages, so another session on the same account inflates "this session's" cost and burn.
    - Also, the Stop hook copies `live.json` before the turn's final status line lands; the lead's settle step only partly fixes this.
    - The weekly cost is measured on the all-models meter, but compared with headroom that may come from a stricter per-model meter.
    - Better design: subtract the increases recorded by other sessions on the same account during the turn (the history keeps the session id), or use token counts from the transcript as the cost basis.
11. **Stats dates are built by adding 24 hours.** (High confidence, low impact.)
    - Where: stats.js:65-69. Around DST changes this can skip a local date, and events on a skipped date are dropped.
    - Stats also filters every event list per account per day (O(accounts × days × events)), and the history is never pruned.
    - Better design: iterate calendar days (`chrono::NaiveDate`), group in one pass, and add retention.
12. **Duplicated and dead code.** (High confidence.)
    - The refusal-expiry logic is written twice (policy.js:50-65 and 101-111).
    - Threshold validation exists in three places.
    - `HOUR`/`MINUTE` constants and the date helpers are defined in several files.
    - `pickSpread` is used only by tests ("phase 2").
    - `loadSnapshot` is called up to three times per lead poll (lead.js:444, 456, 579).
    - Better design: drop `pickSpread`, keep one time and validation module, and load one snapshot per decision.
13. **Session activity comes from the folder mtime.** (Medium confidence.)
    - Where: `recentSessions` and `pruneSessions` (sessions.js:144, 187) assume that renaming a file into the folder updates the folder's mtime. Appends to turns.jsonl do not update it, and the semantics differ on network or FAT filesystems.
    - Better design: use the `at` fields (or a `last_seen` column).
14. **Things that exist only because of JS or Node.** (High confidence.)
    - `sleepSync` via `Atomics.wait`.
    - `readJson` swallowing every error.
    - `isAlive` via `kill(pid, 0)`.
    - The rename retry loop.
    - No durability: there is no fsync before the rename.
    - Rust: use `tempfile::NamedTempFile::persist`, sync before the rename, use OS locks, and return typed errors.
15. **Nothing cleans up after itself.** (High confidence.)
    - Dead wrappers/*.json, orphaned temp files, logs/*, history/* and rejected/* of removed accounts all stay forever.
    - Removing an account leaves usage/ and rejected/. Re-adding the same id after deleting its profile folder by hand inherits stale data.
    - Better design: garbage-collect at startup.
16. **Name validation misses some invisible characters.** (Low impact.)
    - `FORBIDDEN` allows LRM/RLM (U+200E/F), ALM (U+061C), zero-width and other Cf characters.
    - Better design: forbid all Cf except ZWJ (U+200D, needed by emoji).
17. **The poller's empty reading.** (Low impact.)
    - When `usageFromReport` finds no session or weekly meter, the reading is `{}`, which is truthy. `recordReading` still writes the limits, so this is fine, but the case should be explicit in Rust.

## 7. Rust mapping
**Modules**
- `paths`: `BatonPaths`, `account_from_env`.
- `store`: atomic write, file lock, the SQLite connection and migrations.
- `names`.
- `config`: `Config`, `Account`, `Mark`, `Policy`, `EndMethod`.
- `usage`: `Reading`, `WindowReading`, `Meter`, `ExtraUsage`, `Rejection`, `infer_rejection`, `parse_time_after`, `strictest_weekly`.
- `policy`: pure functions. `WindowState`, `AccountState`, `Pick { account, reason: PickReason, all_blocked, ... }`, `Decision` (an enum: `None{reason}`, `WaitInPlace{reason, at}`, `Hop{to, reason, countdown, windows}`, `Wait{to, at, reason}`), `WaitDecision`.
- `stats`.
- `sessions`: the files or tables, `SessionLock` (RAII), wrapper registry.

**Types**
- `enum Window { FiveHour, SevenDay }` and `enum RejWindow { FiveHour, SevenDay, Unknown }`, with serde renames.
- `type Ts = chrono::DateTime<Utc>`, with a lenient deserializer that accepts RFC3339 or epoch ms, and anything else as `None`.
- Write timestamps with `to_rfc3339_opts(Millis, true)`.
- Pass a `Clock` into everything for tests.
- `Policy` is a struct with every field and `#[serde(default)]`; on disk it stays a sparse `Map<String, Value>` of overrides, validated per key.

**Crates:** serde, serde_json, chrono, rusqlite (bundled), fs4 (or fd-lock), tempfile, unicode-normalization, regex, thiserror, sysinfo (only if pid liveness remains anywhere).

## 8. Storage: SQLite or files
Today's access patterns:
- **Hot paths:**
  - Every status line run reads config.json and install.json, reads usage/<id>.json, may write it (on change, or every 30 s), may append to the history, reads and writes live.json, and reads and writes the wrapper session file.
  - Every hook writes turn.json and, at Stop, appends to turns.jsonl.
  - Each lead polls turn.json, hop.json and live.json and loads a full snapshot (config, all usage files, a readdir of rejected) on every tick.
- **Concurrency today:** N sessions × a status line and five hooks each, plus N leads, the menu, the poller and CLI commands. They rely on temp-file renames with Windows retries, `wx` exclusive create plus pid checks, heartbeat leases, and folder mtimes.
- **The data is relational:** readings, rejections and samples are joined by account, session and time in policy and stats.

Per-file verdict:

| Item | Verdict | Why |
|---|---|---|
| config.json | Stay a file | The README documents it and people edit it by hand. Writes are rare. Add a lock around read-modify-write (fs4 on `config.lock`), a .bak, strict parsing and preserved unknown fields. |
| accounts/<id>/ | Stay folders | They are `CLAUDE_CONFIG_DIR` profiles. |
| usage/<id>.json, rejected/* | SQLite tables `reading(account, window, used, resets_at, read_at, source, session)`, `account_meta(account, at, source, session, limits_json, limits_at, extra_json)`, `rejection(account, window, ...)` | Hot read-modify-write by several writers. A transaction fixes the lost updates (section 6, item 4). A snapshot becomes one query. |
| history/*.jsonl | SQLite `reading_history` and `event` (indexed on account and at; event payload as JSON) | Append-only and only queried by stats, which today scans and filters every month file. Retention becomes a DELETE. Keep a `baton export` to JSONL so people can still inspect it. |
| sessions/<id>/{start,turn,live,compact,end,hop}.json, turns.jsonl | SQLite `session` (one row per session with columns for each record) and `turn_sample` | Hot hook and lead traffic. `recentSessions` uses a `last_seen` column instead of folder mtimes; pruning is a DELETE. A hop request is a row, which the lead reads in a transaction. |
| sessions/<id>/lock.json | Something else: an OS advisory lock on `run/session-<id>.lock`, with metadata in the db | Released automatically when the process dies. Fixes the race and PID reuse (section 6, item 3). |
| wrappers/*.json, *.session.json | SQLite `wrapper` table, with liveness from a per-instance OS lock file `run/<wrapper>.lock` | Removes the pid-liveness guesswork. |
| poll/lease.json + .take, state.json, requests/ | Lease becomes an OS lock on `poll.lock` (the holder holds it, so no heartbeat or 10 s staleness); state and requests go to SQLite | Same reasoning (another reviewer owns this area). |
| install.json, copies.json, conflicts.json, backups/, logs/ | Stay files | Rare writes, records people inspect, file copies; logs are rotated text. |

Caveats for SQLite:
- Hooks and the status line must never block. Use `busy_timeout` of about 100–250 ms and drop the write on SQLITE_BUSY, as the JS version tolerates.
- Open the database per process with WAL and `synchronous = NORMAL`.
- WAL does not work on network filesystems. Fall back to journal mode DELETE if `~/.baton` is on SMB or NFS.
- Use the `bundled` feature so all three OSes get the same SQLite.
- Track the schema with `PRAGMA user_version`.
- Opening the database costs about a millisecond per process, which is fine compared with Node's start-up.

Migration (run once, idempotent, inside one transaction):
- **Trigger:** the database file is missing, or the meta row `migrated_from_js` is absent.
- **What it imports:**
  - usage/*.json into `reading` and `account_meta`;
  - rejected/*.json into `rejection`;
  - history/*.jsonl into the history tables. Skip unparseable lines and dedupe on the whole row (at, account, window or type, session, …).
  - session folders updated in the last 30 days: their JSON files and turns.jsonl;
  - wrapper entries: skip them, they are only live state.
- **Afterwards:** move the imported folders to `~/.baton/legacy-js/` rather than deleting them, so a rollback is possible.
- **Old JS hooks:** the hooks installed in `~/.claude/settings.json` still point at `node src/cli.js` until `baton install` runs again. A stale JS hook would keep writing the old files after migration. So:
  - make `baton install` (and `doctor`) rewrite the hooks;
  - have the Rust binary re-run the idempotent import whenever legacy folders reappear with files newer than the migration time.
- **config.json** is read in place. A schema change bumps `version` with a read-old, write-new step, and a version newer than known is refused.

Things that differ per OS:
- **Path comparison:** `samePath`/`isInside` ignore case only on win32 (paths.js:63-75), but macOS is usually case-insensitive too (section 6, item 8). Use `same-file`/canonicalize, or compare ignoring case where the filesystem does.
- **Home folder:** USERPROFILE on Windows, HOME on Unix. Use `std::env::home_dir` (correct since Rust 1.85) or `dirs`.
- **Reserved names:** device-name ids break only on Windows (section 6, item 7).
- **Renames:**
  - The EPERM/EACCES/EBUSY retry is for Windows, where a rename over a file open without delete-sharing fails.
  - POSIX renames always replace atomically. Rust's `fs::rename` on Windows uses MoveFileExW with REPLACE_EXISTING, so keep a short retry there.
  - Readers on Windows can hit transient sharing errors; retry those instead of treating them as "absent" (section 6, item 1).
- **File permissions:** `mode`/`dirMode` (fsutil.js:38) apply only on Unix. On Windows they are ignored.
- **Locks:** fs4 uses `LockFileEx` on Windows, which is mandatory: other processes cannot read a locked byte range. On Unix it uses `flock`, which is advisory. Lock a separate `.lock` file, never the data file itself. Avoid `flock` on NFS.
- **Appends:** `O_APPEND` appends are per-write atomic on local POSIX filesystems. On Windows, FILE_APPEND_DATA is effectively atomic for small writes. SQLite removes this concern.
- **Process liveness and priority:** `kill(pid, 0)` is POSIX; Node emulates it on Windows, where PIDs are reused quickly. `lowerPriority` means BELOW_NORMAL on Windows and nice +10 on Unix (also used by the probe). OS locks replace the pid checks.
- **Folder mtime:** the reliance on folder mtimes (section 6, item 13) varies by filesystem.
- **Clocks and time zone:**
  - All persisted times compare wall clocks across processes, so an NTP step or a resume from sleep shifts leases and staleness. Use wall-clock UTC for stored values and `Instant` for in-process timers and countdowns.
  - "resets 3pm" parsing and stats days use the process's local time zone, which is `TZ` on Unix and the system setting on Windows. Use `chrono::Local` consistently.
- **Line endings:** JSON is always written with "\n", and serde_json tolerates a trailing "\r" from CRLF hand edits.
