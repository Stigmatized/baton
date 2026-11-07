# Review: runtime, hooks and usage polling

This was a read-only review of the JS version at commit f676a1e.

All paths are under D:\Programming\Vibe\Claude\baton\src unless marked test/.

## 1. Responsibilities

- **lead.js**: the `baton [args]` wrapper (class `Lead`). It picks an account, spawns claude with the terminal inherited, polls the session files every 250 ms, asks `policy.decideTurnEnd` at each turn end, ends claude, then runs the countdown or wait and relaunches with `--resume`. It also holds the session lock and the wrapper registry, and carries a PollHost.
- **hop.js**: `baton hop` and `/hop`. It resolves the session (lines 23-42), checks that a live lock holder exists, validates and predicts the target, and writes `sessions/<id>/hop.json`. It never talks to the wrapper directly.
- **hooks.js**: `handleHook` (5 events, lines 74-231) writes the session files. `handleStatusLine` (236-326) records `rate_limits`, writes `live.json`, keeps the wrapper-to-session mapping, renders Baton's line and chains the user's previous status line (`statusLineShell` 472, `runPreviousStatusLine` 504).
- **claude-args.js**: a table-driven parser of claude 2.1.302's CLI (BOOLEAN/VALUE/OPTIONAL/VARIADIC/SUBCOMMANDS, 105-193). It works out the session mode, whether the run is interactive, and `resumeArgs` (351-393).
- **claude-path.js**: finds the claude executable without a shell. It honours PATHEXT on Windows, unwraps npm `.cmd` shims, and falls back to `~/.local/bin`.
- **terminate.js**: `endClaude`. Windows types two Ctrl+C into the console through a PowerShell+C# helper; Unix sends SIGTERM; then a forced tree kill and a terminal reset.
- **countdown.js**: `keyPrompt`. A one-line ticking prompt in raw mode: Enter means go, Ctrl+C means quit, any other key means stay. It ignores keys for the first 500 ms.
- **prompts.js**: the text for the resume note (`continuePrompt` 116), the stay note (134) and the hop/wait lines.
- **poller.js**: `Poller` probes each account in turn (auth status, then `/usage`). It records readings with source "poll", applies backoff, and keeps `poll/state.json`.
- **poll-host.js**: `PollHost` runs the lease election among running Baton instances, with a 3 s heartbeat, takes poll requests, and ticks the Poller.
- **probe.js**: `readPlanUsage` runs an Agent SDK `query({prompt:"/usage"})` under a profile and turns `usage_report` into an outcome. It also has the timeout and process-kill handling and deletes the probe's transcript.

## 2. The lead loop

**Entry.** cli.js:743-760: no argv, or a first argument starting with `-`, means `start`. `start`, `claude` and `start` itself are `raw:true`, so `rest` goes to `runLead` untouched.

**Constructor** (lead.js:56-119):
- `parsed = parseClaudeArgs(args)`.
- `wrapper = "<pid>-<8 hex>"`.
- `sessionId` comes from the args only if it is a UUID (from `--resume <uuid>` or `--session-id`).
- `state = "starting"`.

**run()** (202-219):
- Installs ignore handlers for SIGINT+SIGBREAK on Windows, SIGINT+SIGQUIT on Unix.
- `finally`: removes the handlers, releases the lock, removes `wrappers/<w>.json` and `<w>.session.json`, awaits `pollHost.stop()`.

**main()** (221-277):
1. No accounts: return 1. Resolve claude (an error returns 1).
2. Start `PollHost{kind:"start", low:true}`, then `pruneSessions` (30 days).
3. Pick with `pickStart(states, policy)`. If nothing is open, start on `pick.earliest` (or the first account) and print "Claude Code's own wait applies".
4. Not interactive (a subcommand, `-p`, `--help`, `--version`, `--bg`, `--desktop`, `--cloud`, `--teleport`, `--from-pr`; claude-args.js:306-317): `passthrough` spawns once and returns claude's exit code. No lock, no hooks logic.
5. With a known session id: `acquireLock`. If another live pid holds it, print and return 1.
6. Loop: `runClaude` → on "exit" return the code; else `afterEnd` → on "quit" return 130; else `resumeLaunch`, then repeat.

**runClaude** (322-380):
- If the account changed, `carryTrust(from, to, cwd)`.
- `prepare` → `linkProfile` (refreshes the links).
- Set `arrivedAt` when the account changed, and `launchedAt = now`.
- `state = "running"`, register, log.
- Spawn `launcher.command [...prefix, ...args]` with:
  - env = parent env minus every case variant of CLAUDE_CONFIG_DIR, plus `CLAUDE_CONFIG_DIR=~/.baton/accounts/<id>` and `BATON_WRAPPER=<w>` (178-186);
  - `stdio:"inherit"`, `windowsHide:false`.
- Loop: race exit against `sleep(pollMs=250)`, then `poll()`. A decision of type `hop` or `wait`:
  - `state = "ending"`, register;
  - `endClaude(child, {method: config.endMethod})`, where `endMethod` is auto|keys|signal|kill (config.js:13,146);
  - await the exit, return `{type, decision}`.
- If claude exits on its own: return `{type:"exit", code: code ?? (signal ? 1 : 0)}`.

**poll()**, one look per tick (399-499):
1. Read `wrappers/<w>.session.json`. If it names a different valid session: `switchSession`. That releases the old lock and acquires the new one; if another holder has it, it only logs and still drives the session (386-390).
2. Read `turn.json` and `hop.json`. Adopt `turn.permissionMode` if `at >= launchedAt`.
3. Pending hop: `hop.at > lastHopAt && >= launchedAt`.
4. Fresh turn end: `turn.state === "idle"`, `at > lastTurnAt`, `at >= launchedAt`.
5. A pending hop is deferred while `turn.state === "running"`.
6. On a fresh turn end:
   - `stop` sets `okSinceResume` and resets `reblocks`;
   - a `stop-failure` with a limit error (`rate_limit` or `billing_error`, usage.js:24) right after a Baton resume, with no successful turn since, increments `reblocks`.
7. On a plain `stop` without a hop request: sleep `settleMs` (800 default) so the last status line can land. Abort if claude exited or a newer turn.json appeared.
8. Build the inputs:
   - samples = `turns.jsonl`, plus `live.json` if it is newer and on the same account;
   - `compacted` = `compact.json.at > lastStopAt && >= launchedAt`;
   - call `decideTurnEnd({..., session:{arrivedAt, stayUntil, vetoUntil, reblocks, compacted, backgroundTasks, cost: turnCost, burn: burnRate}})`.
9. Return only `hop` or `wait`. `wait-in-place` and `none` leave claude running.

**decideTurnEnd** (policy.js:398-535), in priority order:
1. **hopRequest** → `hop`, reason "manual", no countdown (an explicit target, or `pickStart` excluding the current account). Otherwise `none`.
2. **stop-failure**:
   - Not a limit error → none.
   - `stayUntil` in the future → none.
   - `reblocks >= maxReblocks` (3) → `wait` until `max(ready, now + reblockBackoffMinutes 15)`, reason "reblocked".
   - 5-hour-only block resetting within `waitInPlaceMinutes` 20 → `wait-in-place`.
   - Another account open → `hop`, reason "refusal", with countdown.
   - None open, reset unknown → `wait-in-place`.
   - Current account is first back, 5-hour only, within `waitInPlaceMaxHours` 24 → `wait-in-place`.
   - Otherwise → `wait`, reason "all-blocked-wait".
3. **stop**, in "smart" mode only:
   - No move while vetoed (`vetoUntil`), while busy (background task type subagent, workflow or teammate), or within `minStayMinutes` 30 of arriving.
   - Planned hop if `headroom < planFactor 1.5 × cost` in either window and the target has room (countdown).
   - Compaction rebalance if blocked within `rebalanceHorizonMinutes` 60 and the target has `+rebalanceMargin` 20 more headroom.

**afterEnd** (502-626):
- **hop** without a countdown (manual, or `countdownSeconds <= 0`): print `hopLine`, resume.
- **hop** with a countdown: `state = "countdown"`, then `keyPrompt` with `tickMs = min(tickMs, 1000)` and a deadline of `now + countdownSeconds (10) × 1000`. Enter or the deadline means go; Ctrl+C means `quit()` (prints `baton --resume <id>`, code 130); any other key means `stay()`.
- **wait**: `state = "waiting"`. Every `tickMs` (1 s) it reloads the snapshot and calls `decideWait`. While the reason is "reblocked" it only re-picks after `at`. If any account is open it resumes there. If the target or time changes it re-registers. If the time is due but no account is open, it pushes `at` by 60 s (593). Any key (Enter included) means `stay`; Ctrl+C means quit. The resume reason is "all-blocked-wait" or "reblocked".
- **stay()** (636-660):
  - After a limit (reasons refusal, all-blocked-wait or reblocked): `stayUntil = availableAt` (or `now + unknownRejectionHours 5 h`). The relaunch on the same account carries `stayPrompt`.
  - Otherwise: `vetoUntil = now + minStay 30 min`, and the relaunch has no prompt.

**resumeLaunch** (662-714):
- cwd = the first existing of `live.cwd` (status line `workspace.current_dir`), `start.cwd`, and the wrapper's cwd.
- prompt = `continuePrompt` (prompts.js:116): `[Baton] This conversation was moved from account X to account Y because <reason>. Carry on exactly where you stopped. If a workflow run was interrupted, relaunch it the same way (with resumeFromRunId...)... Background agents and background shells ... have ended; restart the ones that are still needed.`
- args = `resumeArgs(parsed, id, prompt, {model: live.model, effort: live.effort, permissionMode})` (claude-args.js:351):
  - drops `--continue --resume --session-id --fork-session --from-pr --worktree --tmux --name --teleport` and all positionals;
  - `--model` and `--effort` keep their flag but take the live value; `--effort live` is appended if it was absent;
  - a live permission mode replaces `--permission-mode`, with "default" sent as "manual";
  - `--dangerously-skip-permissions` is kept only if the live mode is still bypass, else turned into `--allow-dangerously-skip-permissions`;
  - ends with `--resume <id> "<prompt>"`.
  - Verified by test/lead.test.js:173-183: `--model claude-opus-5-5 --add-dir extra --permission-mode manual --resume SID <prompt>`.
- Records a history event `{type:"hop", session, from, to, reason, wrapper}` (or `{type:"stay"}`), sets `resumedByBaton`, prints "resuming".

**How the session id travels.** It is either in the args, or learned from `wrappers/<w>.session.json`. The SessionStart hook writes that file (hooks.js:104-111), and the status line rewrites it whenever it differs (279-289). The same id is reused with `--resume`.

**States** written to `wrappers/<w>.json`: `starting → running → ending → (countdown | waiting) → running ...`, then exit. Decision types: none, wait-in-place, hop, wait.

**Every timing constant:**

| Constant | Value | Where |
|---|---|---|
| pollMs | 250 ms | lead.js:69 |
| tickMs | 1000 ms | lead.js:70 |
| settleMs | 800 | config.js:34 |
| countdownSeconds | 10 | config.js |
| graceMs | 500 | countdown.js:11 |
| wait re-check | 60 s | lead.js:593 |
| endClaude rounds | 3 | terminate.js:327 |
| roundWaitMs | 2000 | terminate.js |
| signalWaitMs | 5000 | terminate.js |
| key delayMs | 250 | terminate.js:241 |
| helper timeout | 20 s | terminate.js |
| PROBE_TIMEOUT | 60 s, then 2 × 5 s exit waits | probe.js:26, 286-289 |
| auth status timeout | 30 s | doctor.js:41 |
| HEARTBEAT | 3 s | poll-host.js |
| LEASE_STALE | 10 s | poll-host.js |
| take-guard staleness | 10 s | poll-host.js |
| backoff | 5 min doubling to 2 h; a named "until" capped at 24 h | poller.js:27-29 |
| usagePollMinutes | 30 | config.js |
| previous status line timeout | 15 s | hooks.js:514 |
| live.json and usage re-write dedupe | 30 s | hooks.js:277, usage.js:90 |
| period tolerance | 10 min | usage.js:30 |
| hook timeout | 10 s | install.js:84 |
| stdin read cap | 4 MB | cli.js:20 |
| prune | 30 days | sessions.js:288 |
| recent sessions window | 6 h | sessions.js |
| minStay | 30 min | policy |
| waitInPlace | 20 min | policy |
| waitInPlaceMax | 24 h | policy |
| unknownRejection | 5 h | policy |
| reblockBackoff | 15 min, maxReblocks 3 | policy |
| burnWindow | 60 min | policy |

## 3. The interface with Claude Code

**Installed entries** (install.js):
- Hooks are exec-form `{type:"command", command:"<node>", args:["<.../src/cli.js>","hook","<event>"], timeout:10}` (79-86).
- The events are SessionStart→session-start, UserPromptSubmit→prompt, Stop→stop, StopFailure→stop-failure, SessionEnd→session-end (hooks.js:53).
- Status line: `<node or "node"> "<cli.js>" statusline` (76), keeping the user's padding, refreshInterval and hideVimModeIndicator.
- `/hop` is `commands/hop.md` with `` !`node "<cli>" hop --session "${CLAUDE_SESSION_ID}" --from-command --to='$ARGUMENTS'` `` (97).
- The Rust uninstall and upgrade must still recognise the old JS entries: `isBatonHandler` matches args[0] against `/src/cli.js$` (53-62), and `isBatonStatusLine` matches `cli.js"? statusline` (64).

**Input.** cli.js:20 reads all of fd 0 synchronously (an empty string if stdin is a TTY), parses JSON, and never fails: always exit 0, no stdout for hooks.

**Gate.** `batonAccount` (hooks.js:43): `CLAUDE_CONFIG_DIR`'s parent must equal `~/.baton/accounts` (paths.js:395), the folder name must match `ACCOUNT_ID_RE`, and the id must be in config. `session_id` must match `ID_RE`. Otherwise nothing happens. `BATON_WRAPPER` is optional.

**Fields read and written per event** (all under ~/.baton):

| Event | Reads | Writes |
|---|---|---|
| SessionStart | `session_id, cwd, source, transcript_path, model` | `sessions/<id>/start.json {at,source,account,cwd,transcriptPath,model,wrapper}`; `wrappers/<w>.session.json {session,at,source,account}`; with source=compact also `compact.json {at}`; appends to `history/events-YYYY-MM.jsonl` `{type:"session"}` |
| UserPromptSubmit | `permission_mode` | `turn.json {at,state:"running",event:"prompt",account,permissionMode}` |
| Stop | `permission_mode`, `background_tasks[] {type,status,name\|agent_type}` (max 50) | `turn.json {state:"idle",event:"stop",backgroundTasks}`; appends `turns.jsonl {at,account,five_hour,seven_day}` from `live.json` if the account matches |
| StopFailure | `error`, `last_assistant_message` (clipped to 400), `error_details` (string or object) | for limit errors: `inferRejection` (window from the text regex, else from the reading; `until` from "resets ..." in the message, else the reading), writes `rejected/<acct>.<window>.json` and appends a refusal event; then `turn.json {state:"idle",event:"stop-failure",error,window,until,message}`. The refusal is written before turn.json on purpose. |
| SessionEnd | `reason` | `end.json {at,reason,account}` |
| Status line | `session_id`; `rate_limits.{five_hour,seven_day}.{used_percentage, resets_at (epoch seconds)}`; `model.id`; `effort.level`; `workspace.current_dir \|\| cwd`; env `COLUMNS` | `recordReading` → `usage/<acct>.json` (when changed or older than 30 s) plus `history/readings-YYYY-MM.jsonl` per changed window; `live.json {at,account,model,effort,cwd,reading}` (when changed or older than 30 s); the wrapper mapping if it differs |

The status line also reads `install.json` (previousStatusLine), config, and every account's `usage/*.json` for the bars. With a previous status line it runs that through Git Bash (`CLAUDE_CODE_GIT_BASH_PATH`, then next to git.exe on PATH, then Program Files) or else PowerShell; on Unix `/bin/sh -c`. Same stdin, 15 s timeout, Baton's line appended only if `statusLineUsage`.

**Wrapper↔hook IPC is files only.**
- Env: `BATON_WRAPPER` (wrapper id) and `CLAUDE_CONFIG_DIR` (account).
- Hooks to wrapper: `turn.json`, `hop.json`, `live.json`, `compact.json`, `wrappers/<w>.session.json`.
- `baton hop` to wrapper: `hop.json {at,to,by}`.
- Wrapper to the world: `wrappers/<w>.json` and `sessions/<id>/lock.json {pid,wrapper,at,account}` (exclusive create; a lock whose pid is dead is taken over, sessions.js:182).
- No signals are exchanged between the hooks and the wrapper.
- hop.js resolves the session in this order: argument, then `BATON_WRAPPER` mapping, then `CLAUDE_CODE_SESSION_ID`, then the only live wrapper.

**Claude flags parsed.** The tables in claude-args.js:105-193. Interactive means no subcommand and none of `-p --help --version --bg --desktop --cloud --teleport --from-pr`. The only flags Baton injects are on resume: `--resume <id>`, the prompt positional, `--model`, `--effort`, `--permission-mode` (with "manual" for "default"), and `--allow-dangerously-skip-permissions`. Unknown flags are kept verbatim but are treated as boolean, so `--unknown value` turns `value` into a positional and it is dropped on resume.

**Locating claude** (claude-path.js:106-151):
1. `config.claudePath`, else env `BATON_CLAUDE`: absolute, or looked up on PATH.
2. Else `claude` on PATH:
   - Windows: each PATH folder in turn, PATHEXT order (default `.COM;.EXE;.BAT;.CMD`), files only.
   - Unix: the first X_OK file.
3. Else `~/.local/bin/claude[.exe]`.
4. Windows `.cmd`/`.bat` shims are unwrapped: the regex `%~dp0%\…(js|cjs|mjs|exe)` (77) prefers an exe, then a script, then guesses `node_modules/@anthropic-ai/claude-code/{bin/claude.exe, cli.js}`.
5. A `.js` target is launched as `{command: process.execPath (node), prefix:[script]}`. In Rust there is no `process.execPath`, so a cli.js target needs `node` located (the shim's `%dp0%\node.exe` first, then PATH).

## 4. The usage probe and the poller

**Probe today** (probe.js:186-318). The SDK spawns the binary with `--output-format stream-json --verbose --input-format stream-json --no-session-persistence --setting-sources= --tools= --strict-mcp-config --max-turns=1` (asserted at test/poller.test.js:417-425) and answers an `initialize` control_request.
- Env: `profileEnv` minus `CLAUDECODE, CLAUDE_CODE_ENTRYPOINT, CLAUDE_CODE_SESSION_ID, CLAUDE_CODE_SSE_PORT, BATON_WRAPPER, CLAUDE_CODE_OAUTH_TOKEN, ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN, ANTHROPIC_BASE_URL` (33).
- cwd: `~/.baton/probe`. `stdio` is all pipes, `windowsHide`, `lowerPriority` when `low`.

**Messages consumed:**
- `type:"assistant"`: the first one carrying a top-level `usage_report` (a sibling of `.message`, not inside it) wins. Its text is `message.content` (a string, or the joined `type:"text"` blocks). Without a report, the first assistant's text becomes `reply`.
- `type:"result"`: stop reading; `result` (string), `is_error`, `subtype`.
- Everything else (system/init) is ignored. The last 20 stderr chunks are kept for the failure reason.

**usage_report shape:**
```
{ rate_limits: null | {
    limits: [{ kind ("session" | "weekly_all" | "weekly_*"...), group ("session" | "weekly"),
               percent, resets_at (ISO; parsed with ms()), severity, is_active,
               scope: { model: { display_name }, surface: { display_name } } }],
    extra_usage: { is_enabled, monthly_limit, used_credits, utilization, currency } } }
```

**usageFromReport** (116):
- `five_hour` = the fullest `kind==="session"` meter (else group "session" with no label).
- `seven_day` = the fullest `kind==="weekly_all"` (else a weekly meter with no label).
- All meters go into `limits`.
- When `limits` is not an array, the text decides: `/rate.?limited/` → rate-limited with "until <time>" parsed; `/not logged in|\/login/` → signed-out; else unavailable.
- Outcomes: ok, rate-limited, unavailable, signed-out, timeout, failed, stopped.

**Timeout and kill.** A 60 s deadline or an abort signal ends the read: SDK abort, then `forceKill` (Windows `taskkill /PID /T /F`; Unix SIGKILL to the direct child only). Then `waitExit` 5 s, then force again, then `removeProbeTranscripts` (only the dir matching `-baton-probe`, with the 200-character truncation rule).

**For the direct spawn decided in the brief:**
- `claude -p "/usage" --output-format stream-json` needs `--verbose` (print mode refuses stream-json without it). Keep `--no-session-persistence --setting-sources "" --tools "" --strict-mcp-config --max-turns 1`.
- Use `stdin = Stdio::null()` (print mode reads piped stdin).
- No control handshake is needed.
- Consume the same two message types.

**Poller** (poller.js):
- `tick` runs only if nothing is pending and `now - lastRunAt >= usagePollMinutes`.
- `run` sets `lastRunAt` up front (all-accounts runs only), then polls accounts in order and checks `may()` (still holding the lease) before each account.
- `pollOne`: skip while backing off, write `running`, `authStatusAsync` (`claude auth status --json`, 30 s, not abortable), skip if signed out, probe, then `record`.
- `poll/state.json`: `{ lastRunAt, running:{account,since,reason}|null, accounts:{<id>:{at,status,reason,okAt,backoffUntil,backoffMs,failures}} }`.
- Backoff: `until` capped at 24 h, else 5 min doubling to 2 h.

**Lease protocol** (poll-host.js):
- `poll/lease.json`: `{pid, kind:"menu"|"start", instance:uuid, since, heartbeatAt}`.
- Every 3 s each instance runs `hold()`. If the lease is its own it rewrites it (renew, no guard). If the lease is live (pid alive and heartbeat under 10 s old) it backs off. Otherwise it takes it under `lease.json.take` (exclusive create; a guard older than 10 s is removed) with a re-check.
- The holder drains `poll/requests/<ms>-<6hex>.json {account,reason,at}` (sorted, deleted, de-duplicated per account) into `refresh`, then `tick`.
- Hand-over: `stop()` deletes `lease.json` if it is its own and aborts the poller. Another instance takes over within 3 s. A dead pid is taken over at once; a hung holder after 10 s.
- `requestPoll` is written by add, rename and login.

## 5. Process handling per platform

- **Lead spawn.** `stdio:"inherit"`, `windowsHide:false`, same console and process group, no new pgid or job.
- **Signals.** The wrapper ignores SIGINT/SIGBREAK on Windows and SIGINT/SIGQUIT on Unix through JS handlers, so the child is unaffected. SIGTERM, SIGHUP and CTRL_CLOSE are not handled: the `finally` cleanup does not run, and the stale lock and wrapper files are left for pid-liveness checks.
- **Raw mode.** Claude owns the console while it runs. Baton enters raw mode only in `keyPrompt` (`setRawMode(true)`, then `false` plus `pause` at the end).
- **Ending claude on Windows** (terminate.js:173-279). Each round spawns `powershell -EncodedCommand` with a hidden console of its own. The script `Add-Type`-compiles C#, then `FreeConsole`, `SetConsoleCtrlHandler(NULL,TRUE)`, `AttachConsole(batonPid)`, `CreateFileW("CONIN$")`, and `WriteConsoleInputW` with key down/up for VK 'C' with `LEFT_CTRL_PRESSED` and char 0x03, twice, 250 ms apart. Up to 3 rounds, 2 s each. Then `taskkill /T /F`, a 5 s wait, and `restoreTerminal`: writes `TERMINAL_RESET` (alt screen off, cursor on, mouse, focus, bracketed paste, kitty `<u`, win32-input-mode 9001 off, SGR reset) to stdout, and toggles raw mode on stdin.
- **Ending claude on Unix.** SIGTERM, wait 5 s, SIGKILL to the child only, then restore.
- **Probe and auth status.** Pipes, `windowsHide`. The probe is killed as a tree on Windows but only as the direct child on Unix. The auth status timeout kills only the direct child.
- **Priority.** `os.setPriority(pid, BELOW_NORMAL)` after spawn (fsutil.js:88) for the probe and auth status in the wrapper. Windows: priority class. Linux: setpriority on the thread whose tid equals the pid.
- **Liveness.** `process.kill(pid, 0)`, where EPERM counts as alive.

## 6. Weaknesses and improvement candidates

1. **Nested claude hijacks the wrapper** (hooks.js:104-111, 279-289; hop.js:28-31). *Why it matters:* any `claude` started inside a Baton session's Bash tool inherits `BATON_WRAPPER` and `CLAUDE_CONFIG_DIR`. Its SessionStart and status line remap `wrappers/<w>.session.json` to the inner session, so the outer wrapper `switchSession`s and hops or locks the wrong conversation, and `/hop` resolves to the wrong one. *Better design:* the wrapper records its claude child's pid; a hook or status line accepts the mapping only if its parent pid (exec-form hooks are direct children) equals that pid, or its ancestor chain reaches it. *Confidence:* medium-high.

2. **Session lock judged by pid liveness only** (sessions.js:182-210). Windows reuses pids quickly, so a stale lock can refuse "already running under baton". `switchSession` ignores a failed lock (lead.js:385-390), and `--continue` or the picker take no lock up front, so two wrappers can drive one conversation. *Better design:* an OS advisory lock (LockFileEx or flock via fs4) on `sessions/<id>/lock`, held for the process lifetime and released by the kernel on death; keep the JSON as information only. Refuse, or stop driving, when the lock is held. *Confidence:* high.

3. **Windows key typing through PowerShell plus Add-Type** (terminate.js:173-279). Each round pays PowerShell startup and a C# compile (roughly 1-3 s); it breaks under Constrained Language Mode or AppLocker; and EncodedCommand plus Add-Type triggers AV heuristics. *Better design:* Baton is already attached to that console, so call `CreateFileW("CONIN$")` plus `WriteConsoleInputW` in-process (windows-sys). No helper, no Attach/Free. *Confidence:* high.

4. **Leftover input** (countdown.js:36, terminate.js). Extra Ctrl+C from an earlier round, or type-ahead, can reach the countdown after the 500 ms grace or reach the next claude when there is no countdown (manual hops). *Better design:* after claude exits, call `FlushConsoleInputBuffer` on Windows or `tcflush(TCIFLUSH)` on Unix before the prompt and before relaunching. *Confidence:* medium.

5. **Terminal state restored only after a forced kill** (terminate.js:350,359). *Better design:* save the console modes (GetConsoleMode on CONIN$/CONOUT$) or termios before every spawn and always restore them after claude exits; write `TERMINAL_RESET` to the TTY (not to stdout when stdout is redirected). *Confidence:* high.

6. **Unix kills only the direct child** (terminate.js:378, probe forceKill). MCP servers and shells are orphaned on SIGKILL. *Better design:* the probe and auth status run in their own process group (`process_group(0)`) and are killed with `killpg`. The interactive claude must stay in the TTY's foreground group, so on SIGKILL fallback enumerate its descendants (sysinfo) and kill them. On Windows put the probe in a KILL_ON_JOB_CLOSE job object (no orphans even if Baton crashes) and use a job for claude's tree instead of `taskkill /T`, which loses descendants whose parent already exited. *Confidence:* high.

7. **Wrapper death or termination unhandled.** No SIGTERM/SIGHUP/CTRL_CLOSE handler, so the lock, wrapper files and lease stay behind and claude may be orphaned. *Better design:* handle SIGTERM/SIGHUP by forwarding SIGTERM to claude and cleaning up; handle `CTRL_CLOSE_EVENT` with a handler routine that cleans up within its 5 s. *Confidence:* high.

8. **Shutdown can hang up to 30 s** (poller.js:215, doctor.js:35). `authStatusAsync` ignores the abort signal and `PollHost.stop()` awaits the queue, so exiting `baton` can block. *Better design:* make auth status abortable or kill it by tree on stop. *Confidence:* medium-high.

9. **Unguarded read-modify-write on shared JSON.** `poll/state.json` is written by the holder, by `baton usage --refresh` and by the menu (poller.js:101). `usage/<acct>.json` is written by N status lines plus the poller (usage.js:97-136). Both lose updates; the lease renewal is also unguarded (poll-host.js:431). *Better design:* SQLite transactions (see section 9), or a lock file around each read-modify-write. *Confidence:* medium on harm (mostly benign last-writer-wins), high that the race exists.

10. **Polling for turn ends** (lead.js:353-358, 3+ file reads every 250 ms; the wait reloads the full snapshot every 1 s). Cheap but laggy and noisy. *Better design:* each hook and status line, after writing its file, sends a one-line datagram to the wrapper's endpoint (a named pipe `\\.\pipe\baton-<w>` or a UDS at `~/.baton/run/<w>.sock`, derived from `BATON_WRAPPER`), connect timeout of about 50 ms, fire and forget. The wrapper also re-reads on a 1-2 s timer for robustness, and the files stay the source of truth. Alternatively, `notify` on `sessions/<id>/`. *Confidence:* medium on value.

11. **The resume cwd prefers `live.cwd`** (= `workspace.current_dir`, lead.js:666). If the session's current dir drifted from the project dir, `--resume <id>` may not find the transcript, because it is keyed by project folder. *Better design:* prefer `start.cwd` (the original project dir; the status line also has `workspace.project_dir`). *Confidence:* medium-low.

12. **Unknown claude flags are treated as boolean** (claude-args.js:240), so the value of a new value-taking flag is silently dropped on resume, and the tables are pinned to 2.1.302. *Better design:* keep the tables, but treat an unknown `--flag` followed by a non-flag token conservatively: pass both through on resume and log a warning. *Confidence:* medium.

13. **`resets_at` parsing** (probe.js:100). `ms()` treats a number as epoch milliseconds; if a report ever sends epoch seconds (as the status line does) the date lands in 1970. *Better design:* in the serde parse, accept ISO, or a number below 1e12 read as seconds. *Confidence:* low-medium (the fixture uses ISO).

14. **A held poll overlaps after losing the lease** (poller.js:149). Only checked between accounts, so two pollers can probe the same account and hit the usage endpoint's rate limit. *Better design:* check the lease before each probe and abort the probe on loss. *Confidence:* medium-low.

15. **Node-only workarounds that disappear in Rust:**
    - `sleepSync` via `Atomics.wait`, and the rename retry (fsutil.js:50-61). Keep the retry: Windows renames over open files fail with EPERM; `tempfile::persist` plus retry.
    - The `.js` launch through `process.execPath`.
    - The libuv stdin `pause()` quirk on Windows, where a pending console read can steal a keystroke from the child after `keyPrompt`. Avoid any background stdin reader; poll crossterm events only while the countdown is shown. *Confidence:* low that it bites today.

16. **Smaller issues:**
    - `logs/lead-<w>.log` is never pruned.
    - `/hop` breaks on account names containing `'` (install.js:97).
    - A `hop.json` written between ending claude and relaunching is dropped (`hopAt < launchedAt`).
    - A wait that ends with `go` to the same account records a `from == to` hop event.
    - A claude killed by a signal maps to exit 1; use 128+n on Unix.

## 7. Rust mapping

- **Modules:** `runtime::{lead (state machine enum Starting|Running|Ending|Countdown|Waiting), claude_args, claude_path, terminate, prompt (countdown), notes (prompts)}`, `hooks::{events, statusline}`, `usage::{probe, poller, poll_host}`, `ipc` (lock, lease, optional wrapper socket), `platform::{windows, unix}`.
- **Key types:**
  - `Launcher{command, prefix, path}`
  - `ParsedArgs{options: Vec<Opt{flag,name,values,raw}>, positionals, subcommand, session: SessionSel, interactive}`
  - `Decision{kind: None|WaitInPlace|Hop|Wait, to, at, reason, countdown}`
  - `TurnFile` and the other session files as serde structs with `#[serde(default)]` and lenient `Option`s (the hooks' null tolerance)
  - `HookInput` per event
  - `StatusInput`
  - `StreamMsg` as an internally tagged enum with `#[serde(other)]`
  - `UsageReport`
  - `Lease`, `PollState`
- **Crates:**
  - clap; serde/serde_json; ratatui+crossterm (raw mode and key polling for the countdown).
  - Windows: `windows-sys` (WriteConsoleInputW, FlushConsoleInputBuffer, Get/SetConsoleMode, SetConsoleCtrlHandler, job objects).
  - Unix: `nix` or `rustix` (killpg, setpriority/nice in `pre_exec`, tcgetattr/tcsetattr/tcflush, getppid).
  - `signal-hook` for SIGINT/SIGQUIT/SIGTERM/SIGHUP.
  - `sysinfo` (descendant enumeration, parent-pid checks).
  - `fs4` (advisory locks); `tempfile` (atomic writes); `uuid`; `time` or `chrono`.
  - `which` as a base for the PATH lookup (keep the custom shim unwrapping).
  - `interprocess` (named pipe/UDS) if the IPC in item 10 is adopted; `rusqlite` if SQLite is adopted.
- **Concurrency:** std threads plus `crossbeam-channel`. One thread waits on the child; a ticker (or the IPC listener) feeds the lead loop; PollHost runs on its own thread; the probe reads stdout lines on a thread with `recv_timeout(60 s)`. No async runtime is needed.

## 8. OS-specific behaviour and what Rust should do

| Concern | JS today | Rust: Windows | Rust: Unix (macOS + Linux) |
|---|---|---|---|
| Ignoring Ctrl+C in the wrapper while claude runs | JS handlers for SIGINT/SIGBREAK, SIGINT/SIGQUIT | `SetConsoleCtrlHandler(handler_returning_TRUE_for CTRL_C/BREAK)`. Never `SetConsoleCtrlHandler(NULL, TRUE)`: that "ignore Ctrl+C" flag is inherited by claude. | Install a handler (signal-hook), never `SIG_IGN`: SIG_IGN survives exec, so claude would inherit ignored SIGINT. |
| Wrapper killed or console closed | not handled | Handle `CTRL_CLOSE/LOGOFF/SHUTDOWN` in the same handler: forward to claude, clean up within 5 s. | Handle SIGTERM/SIGHUP: SIGTERM claude, wait, clean up. Leave SIGTSTP/SIGCONT at their defaults (job control works because claude stays in the foreground group). |
| Ending claude gracefully | PowerShell types two Ctrl+C | In-process `WriteConsoleInputW` of two Ctrl+C key records into CONIN$ (3 rounds, 2 s), because claude reads raw console input and Ctrl+C is a key, not an event. `GenerateConsoleCtrlEvent` cannot target one process: CTRL_C is broadcast, and CTRL_BREAK is an ungraceful SIGBREAK to Node. | SIGTERM (Claude Code shuts down gracefully). TIOCSTI injection is disabled on modern Linux, so do not use it. |
| Forced tree kill | `taskkill /T /F` / SIGKILL to the child | Assign claude to a job object at spawn (no kill-on-close for interactive claude), then `TerminateJobObject`. Probe and auth status: a job with `KILL_ON_JOB_CLOSE`. | Probe and auth status: `process_group(0)` plus `killpg(SIGKILL)`. Interactive claude: SIGKILL plus its descendants via sysinfo (it must stay in the TTY's foreground pgrp). |
| Raw mode / terminal restore | `setRawMode` only in the countdown; reset only after a forced kill | Save the CONIN$/CONOUT$ modes before each spawn and restore them after every exit; `FlushConsoleInputBuffer` before the countdown and the relaunch; crossterm raw mode for the countdown. | `tcgetattr` before spawn and `tcsetattr` after every exit; `tcflush(TCIFLUSH)`; write `TERMINAL_RESET` to the TTY. |
| Locating claude | PATH, `~/.local/bin` | PATHEXT order per PATH folder; unwrap `.cmd`/`.bat` npm shims (never spawn them: BatBadBut quoting of the prompt); a `.js` target means `%dp0%\node.exe` or `node` on PATH; then `%USERPROFILE%\.local\bin\claude.exe`. | The first executable `claude` on PATH, then `~/.local/bin/claude`, `~/.claude/local/claude` (the older local installer), `/opt/homebrew/bin/claude` and `/usr/local/bin/claude` (GUI or Ferry launches on macOS often lack the shell PATH). |
| Priority lowering | `setPriority` after spawn | `creation_flags(BELOW_NORMAL_PRIORITY_CLASS \| CREATE_NO_WINDOW)` at spawn (no race; children inherit). | `pre_exec(nice(10))`: applies to the whole process and all its threads (Linux setpriority after spawn hits only one tid). |
| Hidden console for background children | `windowsHide` | `CREATE_NO_WINDOW` for the probe and auth status, so they get their own hidden console and are isolated from the operator's console control events. | n/a; `Stdio::null()` for stdin. |
| Status line previous command | Git Bash, else PowerShell | Keep the same detection (Claude Code's own rule). | `/bin/sh -c`. |
| Path comparisons | case-insensitive on win32 (paths.js:372) | case-insensitive and canonicalised (junction/`\\?\` aware) for the `CLAUDE_CONFIG_DIR` check | case-sensitive; resolve symlinks (macOS `/var` vs `/private/var`). |
| Liveness | `kill(pid, 0)` | `OpenProcess` plus `GetExitCodeProcess`; prefer OS file locks over pid checks (item 2). | `kill(pid, 0)`; same preference. |

## 9. State access patterns (for the SQLite decision)

**Writers and frequency:**
- **Status line process.** Claude Code runs it on every assistant or message update, debounced to roughly 300 ms during streaming, plus `refreshInterval` if set. One short-lived process per run, per session. Each run reads `install.json`, `config.json`, all `usage/*.json`, `wrappers/<w>.session.json` and `live.json`. It writes `usage/<acct>.json` and appends to `history/readings-*.jsonl` only when a value changes or the reading is 30 s old; `live.json` on change or 30 s; and the wrapper mapping rarely. Effectively at most about 1 write per 30 s per session when idle, more while percentages tick.
- **Hooks.** Per turn: UserPromptSubmit writes 1 file; Stop writes 1 file plus 1 append; StopFailure writes 1 file plus 1 append, and for limits also the rejection. Per session: SessionStart (2-3 files plus 1 append) and SessionEnd (1). Each is a separate process, about 100 ms in Node.
- **Lead wrapper.** Long-lived. Reads 3 files every 250 ms (`<w>.session.json`, `turn.json`, `hop.json`). At each turn end it reads config, all usage and rejections, `turns.jsonl`, `live.json` and `compact.json`. During a wait it reads the full snapshot every second. Writes `wrappers/<w>.json` and appends to `logs/lead-<w>.log` on each state change; the lock on start and on a session switch; and a history event per hop or stay.
- **PollHost.** Every instance reads `lease.json` and lists `requests/` every 3 s; the holder writes `lease.json` every 3 s.
- **Poller.** Every 30 min per account, about 3 read-modify-writes of `state.json` plus the usage file and history appends.
- **CLI.** `baton hop`: 1 write. `requestPoll`: 1 file.

**Concurrency.** Typically 1-5 sessions, so about 1-5 wrappers plus an optional menu as long-lived readers. Each session has bursts of 1-3 overlapping short-lived hook and status line processes: Stop and a status line refresh often fire together, and Claude Code runs the hooks for one event in parallel. The poller adds 1 background writer. Peak is about 10 processes touching `~/.baton` within the same second.

**Where races exist today.** Shared read-modify-write targets: `usage/<acct>.json` (N status lines plus the poller), `poll/state.json` (the holder, `usage --refresh` and the menu), and the lease. The per-session files really are single-writer, as sessions.js:134 claims.

**Fit.** SQLite in WAL mode with `busy_timeout` of about 2-5 s fits:
- writes are tiny and infrequent;
- the short-lived hook processes stay well inside their 10 s budget;
- it fixes the read-modify-write races with transactions;
- the lead loop's polling becomes a cheap `PRAGMA data_version` check, or stays on the IPC notification from item 10.

Risks:
- `~/.baton` on network or OneDrive-redirected homes, where WAL is unsupported;
- AV scanners holding `-wal`/`-shm` files on Windows;
- a migration from the JSON/JSONL layout above is required.

Keep the lock and lease as OS file locks rather than SQLite rows, so they are released automatically when a process dies.
