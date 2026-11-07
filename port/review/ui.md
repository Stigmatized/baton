# Review: CLI, printed screens and TUI

A read-only review of the JS version at commit f676a1e.

Scope: src/cli.js, term.js, format.js, screens.js, src/menu/**, scripts/menu-*.js, and the menu, cli and term tests. I only read files; nothing was run.

## 1. Command surface (src/cli.js)

**Dispatch rules (main, cli.js:741-812)**
- argv[0] is `-h` or `--help` → help. `-v` or `--version` → version.
- No argv, or argv[0] starts with `-` → `start`, with the whole argv passed to claude (cli.js:757-760).
- Unknown command → stderr `unknown command X. Try baton help.`, exit 2 (cli.js:763). This one is lowercase. The help screen's own wording is `Unknown command X.` (screens.js:372).
- Every non-raw command is parsed with `parseArgs({strict:true, allowPositionals:true})` and also accepts `--json` and `-h/--help` (cli.js:771-786). `--help` prints that command's help and exits 0.
- Extra positionals are silently ignored. For example, `baton account remove a b` removes only `a`, and `baton status foo` works.

**Commands, options and outputs** (the JSON shape is in brackets)
- `hook <session-start|prompt|stop|stop-failure|session-end>` (internal)
  - Reads JSON on stdin, capped at 4 MiB, and never fails: exit 0, quiet (cli.js:69-83).
- `statusline` (internal)
  - Prints the status line, or runs the user's previous status line and appends Baton's usage using `COLUMNS` (cli.js:85-117).
  - Exits with the previous status line's code.
- `start [claude args...]`, alias `claude`. Raw: nothing is parsed (cli.js:121-139).
  - Exit code comes from `runLead`; it is 1 when there are no accounts (cli.test.js:451).
  - So `baton --help` is Baton's help; claude's `--help` needs `baton start --help`.
- `hop [session] [--session s] [--to account] [--from-command]` (cli.js:141-185)
  - Success: `{session, from, to, fromId, toId, between, ...}` (hop.js:83-90).
  - Error: `{error}`, exit 1. With the hidden `--from-command`: plain text and exit 0.
  - Piped: the text `Baton: conversation S moves from A to B now (it is between turns)|when this turn ends.`
- `account` (cli.js:189-298); no subcommand means `list`.
  - `list` → `config.accounts[]`.
  - `add <name> [--mark m] [--last-resort[=bool]] [--position n]` → `{account, position, profile, existed, links}`.
    - A bare `--last-resort` is rewritten to `=true` only when it is last or followed by a dash (cli.js:209-216). So `account add --last-resort Spare` fails with `--last-resort takes true or false.`
  - `rename <name> <new>` → `{id, from, to}`.
  - `remove <name>` → `{id, name, profile, unlinked}`.
  - `order <name...>` and `move <name> <pos>` → `{order:[names]}`.
  - `set <name> [--mark preferred|normal|last-resort] [--last-resort bool] [--five-hour n|default] [--weekly n|default]` → `{account}`.
  - Booleans accept true/on/yes/1 and false/off/no/0 (cli.js:38-44).
  - Errors: `AccountError` becomes `UsageError`, exit 2. `--five-hour` and `--weekly` give `takes a percentage or "default".`
  - Usage errors print usage strings such as `baton account add <name>`. Unknown subcommand: `Unknown: baton account X`.
- `login <account>`: exit is claude's code; quiet. Unknown account: `No account named X; add it with baton account add "X".`, exit 2 (cli.js:300-337).
- `view`, alias `menu`. Without a TTY on both stdin and stdout: `The menu needs a terminal; try baton status.`, exit 2 (cli.js:341-361).
- `usage [account] [--refresh]` (cli.js:363-402)
  - Plain: `{accounts:[statusView accounts], poll}`.
  - `--refresh`: `{results:[{name,status,reading?,until?...}]}`.
  - Unknown account: `No account named X.`, exit 2.
- `status` → `statusView` (format.js:133-185):
  - `{now, mode, accounts:[{order,id,name,mark,profile, five_hour, seven_day: {used,threshold,headroom,resetsAt,readAt,source,limit?,reset,stale,blocked,rejected,rejectedUntil,text}, blocked, blockedBy, availableAt, availableKnown, urgency, sessions:[...], poll, limits, extraUsage}], poll:{holder,everyMinutes,lastRunAt,nextAt,running}, next:{account(NAME),id,reason} | {account:null, allBlocked, earliest(NAME), earliestId, availableAt, availableKnown}}`
  - `text` uses locale-dependent clock formatting, so that JSON field is not stable.
- `pick` (cli.js:420-464)
  - `{account(ID), reason, allBlocked, earliest(ID), availableAt}`.
  - Exit 3 when every account is blocked, or with no accounts (`{account:null, accounts:0}`).
  - Piped: the bare id, or `none (all blocked; first back: X)`. The comment says "bare name" but it prints the id.
  - `next.account` is a name in `status` but an id in `pick`.
- `stats [--days n]` (1..90, default 7; error `--days takes 1 to 90.`) → `computeStats`: `{since, until, days[], totals:{hops,refusals,sessions by day}, hopReasons, hops[], accounts[{daily[], wasted[], refusals...}], sessions[]}` (stats.js:175).
- `policy [--<flag> value|default]...` with 20 flags (cli.js:489-510) → the effective policy object. `default` writes null, which deletes the key (accounts.js:189).
- `install` / `uninstall [--dry-run] [--diff]` → `{dryRun, files:[{path,diff}], notes, ...applied}`. `InstallError` exits 2.
- `doctor` → `{ok, checks:[{name, ok:true|false|null, detail}]}`; exit 1 when not ok.
- `conflicts [--clear]` → a list, or `{cleared:n}`.
- `version` → `{version}`.
- `help [cmd]` → no data (`--json` prints `null`); exit 2 for an unknown command.

**Exit codes:** 0 ok; 1 failure (hop error, doctor fail, uncaught error with the full stack printed to stderr, cli.js:809); 2 usage or parse error; 3 nothing to pick.

**Errors (cli.js:733, term.js:163-169):** a styled terminal gets `✗ message`; otherwise `baton: message`. With `--json`, errors still go to stderr as text and stdout stays empty. hop is the only exception (`{error}`).

**Things clap cannot express directly**
- The default subcommand when argv[0] is missing or starts with `-`, with full raw passthrough. Pre-scan argv before clap, as the JS does.
- Raw subcommands (`start`, `claude`): use `trailing_var_arg` + `allow_hyphen_values` + `disable_help_flag`.
- `--last-resort` is optional-value on `add` and takes a bool on `set`. Make it a plain flag on `add` and a `bool` value on `set`, using separate arg structs.
- `value|default` arguments: a custom value parser returning `Option<Setting<T>>`.
- The `prepare` hook goes away.
- Global `--json`: `#[arg(global=true)]`.
- Hidden commands: `#[command(hide=true)]` for hook, statusline and `--from-command`.
- Aliases: `visible_alias = false`.
- Help: Baton's help is a custom screen (helpScreen with groups). Disable clap's help and render your own from clap's `Command` metadata (`get_about`, `get_subcommands`).

## 2. Printed screens (term.js, screens.js, format.js)

**Model.** Every screen is `lines: [[text, styleWords]]` (menu/lines.js), the same span model the menu uses. `render()` (term.js:130-148) merges neighbouring spans of one style into one SGR run and resets with `\x1b[0m`. When not styled, it trims trailing spaces. `document()` indents 2 and, on a TTY only, adds a blank line above and below (term.js:157-160).

**Terminal detection (terminalFor, term.js:90-104)**
- `tty = stream.isTTY`. Depth comes from Node's `getColorDepth(env)`, which handles NO_COLOR, FORCE_COLOR and TERM.
- On a pipe, `FORCE_COLOR` sets depth 8.
- `styled` means depth ≥ 4, so NO_COLOR or a pipe gives unstyled text: no bold at all.
- Width = clamp(columns ‖ 100, 60, 110).
- Colours (term.js:52-72):
  - Named colours map to 30-37/90-97.
  - Hex at depth 24 → `38;2`. At depth 8 → a 256-colour cube or grey ramp. At depth 4 → nearest of 16 RGB values.
- The banner (`╺━╸ BATON`, or the full wordmark for help and install) shows only on a TTY.
- A `pipe` text overrides the screen when stdout is not a TTY (hop, pick).

**Theme (menu/theme-core.js)**
- Roles are fixed hex values for a dark scheme (theme-core.js:11-25): accent = warn = baton = `#d7ac78`, text `#d6d8dc`, muted `#7e858e`, err `#cf8b82`, ok `#92ae99`.
- Style words: bold, italic, underline, inverse, dim, label, selected, `on-<role>`, roles, named colours, `#hex` (theme-core.js:129-170).
- With colour off, `selected` and `on-*` become inverse, and `label` becomes italic.
- The comment says it "follows a light or dark scheme"; it does not.

**Glyphs (theme-core.js:46-127)**
- Two sets, `rich` and `plain`.
- `pickGlyphs`: `BATON_GLYPHS=rich|plain` wins. Any non-win32 platform gets rich. On win32, rich only if WT_SESSION, TERM_PROGRAM, `ConEmuANSI=ON`, or TERM matches xterm|mintty|alacritty|wezterm|kitty; otherwise plain.
- Plain still uses `─┌┐└┘│▄█░↑↓←→·`, which are in CP437.

**Unicode width (menu/text.js:6-45)**
- `clean()` strips CSI, OSC and other escapes and C0/C1 controls, turns tab into 2 spaces, and is applied to every span (lines.js:8). This is a security property; keep it.
- `charWidth`: controls 0; Mn/Me/Cf 0; a hand-written East-Asian-wide and emoji table 2; everything else 1.
- No grapheme clustering. ZWJ emoji, flags and VS16 are miscounted. East-Asian ambiguous glyphs (★⊘▿●○◆━) count as 1.
- Wrapping (lines.js:64-131): word wrap with a hanging indent, breaking long words at `- / \ : _ .`. Nothing is ever cut with an ellipsis. `fitLine` pads or hard-cuts as a last resort. `wrapFacts` joins facts with ` · `.

**Which screens reuse menu panes.** status, usage and stats are built from menu panes: screens.js builds a fake menu state (`initialState` with rows 40) from `loadMenuData` (screens.js:36-51). The other screens use shared helpers: heading, fact, entry, outcome, next, marks, paragraph, tildify (term.js:150-248).

## 3. Menu architecture (src/menu)

**Runtime (index.js:259-486)**
- Ink 8 with `alternateScreen`, `incrementalRendering`, `maxFps 30`, `exitOnCtrlC false`, `patchConsole false`.
- Escape sequences written by hand:
  - autowrap off `?7l` before render and `?7h` on exit;
  - mouse `?1000h ?1006h` (click and wheel only, SGR);
  - on exit, `?1000l ?1002l ?1003l ?1006l`.
- With `handleSignals`, SIGTERM, SIGHUP and SIGBREAK call `finish()` then `process.exit(143|129|149)` without awaiting `host.stop()`. Ctrl+C is a key that quits.

**Store (createStore, index.js:99-251)**
- `reduce(state, action) → {state, effects}`.
- Effects:
  - `quit`, `redraw` (Ink clear plus rerender on resize);
  - `reload` (a synchronous `loadMenuData`);
  - `auth`: `claude auth status` per account, concurrently, at startup and after sign-in only;
  - `apply {op, args, done, then}`: a synchronous core call, then an `applied` toast and reload, then an optional chained effect;
  - `refresh`: the poller for one account or all, with "Asking…" and summary toasts (refreshSummary, index.js:43-70);
  - `signin`.
- Operations (index.js:73-97): mark, move, thresholds, rename (then a quiet refresh), add (then signin), remove, policy, hop. All work by account id.

**State (state.js:3-40)**

`{now, size{cols,rows}, color, glyphs, focus: side|search|add|pane, selected: "overview"|"acct:<id>"|"sess:<id>"|"more:sessions"|"policy"|"stats", index, open{sessions}, filter, filtering, views{[key]:{top}}, form (policy draft {original, values, index}), modal, toasts[≤3] {id,text,tone,at}, toastSeq, data, splash, auth{[id]:{loggedIn,authMethod}|{error}}, busy}`.

Toast lifetimes: error 10 s, ok 5 s, info 4 s (state.js:58).

**Reducer actions (reducer.js:32-68):** splash-end (never dispatched, dead code), mouse, key, text, paste, tick (expire toasts, then reload), resize, data (then reselect), auth, busy, applied (toast, then reload).

**Data (data.js:70-111).** `loadSnapshot` (sessions and poll) plus `computeStats` for 7 days plus per-session files (start, live, turn, end json, turn samples) plus conflicts. Sessions are sorted live-first, with at most 12 recent.

**Live refresh**
- `fs.watch(~/.baton, {recursive:true})`, debounced 120 ms, then a tick (index.js:441-453).
- A `setInterval` every 2000 ms checks the size and ticks (index.js:454-460).
- Every tick does a full synchronous reload.
- The menu also hosts the usage poll: `PollHost` with kind "menu", started only once the splash is dismissed and the terminal is big enough (index.js:463-481).

**Layout (layout.js)**
- Minimum size 100×28. Below that, the splash art with "A little more room. Baton needs 100 x 28…", and only `q` works.
- The last row is reserved, so the frame is rows−1. The footer is 1 row.
- Sidebar: fixed 46 columns, a 13-row brand block (wordmark, captions, Search row), the list, then a 3-row footer (Add account, more above/below).
- Pane: paddingX 3, a 4-row header (blank, title, right note, blank), the body, and a legend/progress line ("1–20 of 45").
- `isNarrow` always returns false. Narrow-mode code is dead: sideSpan, the comments in menu-fixtures, the `side` flags in screens.

**Sidebar tree (tree.js:98-204)**
- Rows: Overview; Accounts heading with count; accounts with mark icon and a tail of `5h N · wk N` (else a short form, then none; the name is never cut); `⊘ 2h` when blocked; `sign in` when signed out.
- Then Sessions heading; live sessions with icon (◆ waiting/countdown, spinner running, ● live, ○ recent); recent sessions folded under `+ n recent`; then Policy and Stats.
- The selection is centred on scroll (sideTop).
- The filter is fuzzy (fuzzy.js, the Pelican scorer) over name, mark, account name and id, and auto-selects the first hit.

**Views (views/*.js; each `model(state,item,box) → {title,right,body}` gives pre-wrapped lines plus per-line click targets)**
- Overview (overview.js): "N ready / accounts / live sessions"; NEXT ACCOUNT with reason; an ACCOUNTS table with 3-cell meters; LIVE SESSIONS; TODAY hops and refusals; conflicts. The right note is the poll timing.
- Account (account.js): facts line, thresholds, two usage bars with a threshold mark and resets, read source, other limits, extra usage, poll status, blocked line, weekly urgency, 7-day sparklines, hops in/out, sessions.
- Session (session.js): account, state, folder, id, started, model, now/background tasks, per-turn cost, burn rate, hops.
- Sessions: the recent list.
- Policy form (policy.js:12-112): 10 of the 20 policy fields, an Apply row, and a defaults count.
- Stats (stats.js): a day-column table, or sparklines when narrow; totals; reasons; weekly allowance lost.
- Legend line per view (legend.js).

**Keys (reducer.js:98-322, modal.js:133-214)**
- Ctrl+C always quits. `q` quits except while typing in the filter.
- Sidebar:
  - ↑/↓ move, passing through the pinned Search and Add rows; Home/End jump; PgUp/PgDn scroll the pane.
  - Enter: on Overview, an account or a live session opens the Actions modal; on Policy it focuses the form; on Search it starts the filter; on Add it opens the add dialog; on `+ n recent` it toggles.
  - `/` starts search; Esc clears the filter.
- Filtering: printable keys, Backspace, Ctrl+U; Enter or ↓ leaves the filter; Esc clears it.
- Direct letter shortcuts outside a modal are deliberately inert (menu.test.js:335-376).
- Policy form: ↑↓ field, ←→ step, Home/End, `d` sets the field to its default, Enter opens a confirm (default Yes), Esc leaves with a "Policy left unchanged." toast. Moving the sidebar selection also closes the form.
- Actions modal: ↑↓, Enter, Esc, or the option's letter.
  - Account: Rename e, Change mode m (opens a choice), Usage thresholds t, Refresh usage r, Sign in s, Move up K, Move down J, Delete d.
  - Overview: r.
  - Live session: h (best account), H (choose an account).
- Confirm modal: y/n, ←→ then Enter (remove defaults to No).
- Input modal: an editable field (←→ Home End Del Backspace Ctrl+U), paste-aware. Enter submits after name validation (names.js and uniqueness); errors show as toasts.
- Choice modal: ↑↓, 1-9, Enter, Esc or q.
- Thresholds modal: ↑↓ field, ←→ ±1 from the current value or the default, `d` sets default (null), Enter saves.

**Mouse (mouse.js, input.js:37-62; `BATON_MOUSE=off` disables)**
- SGR reports are parsed out of stdin (and not while in a bracketed paste). Only left-button presses and the wheel (±3) are used.
- Splash: a click dismisses it.
- Modal: option, choice, threshold and button targets; the wheel scrolls the modal.
- Clicking a toast dismisses it. Clicking a footer hint sends its key.
- Sidebar: click a row to select (`more:sessions` toggles); click the Search row or the Add row.
- Wheel: over the sidebar it moves the selection; over the pane it scrolls.
- Pane: per-line link targets (the overview's account and session rows). Policy fields are hit by hard-coded x offsets (mouse.js:97-116).

**Splash (ui/splash.js, art.js)**
- relayArt (when rows ≥ 24), the 5-line `BATON` figlet, the slogan, two motto lines and "Press any key to start".
- It waits for a key or click (tested, menu-live.test.js:81).
- `BATON_SPLASH=off` skips it; this is undocumented.

**Sign-in inside the TUI (index.js:356-383, login.js)**
- The Ink tree is unmounted, the input released and modes restored.
- `claude auth login` runs with stdin inherited and stdout/stderr piped. Baton draws its own branded "CONNECT ACCOUNT" frame via `renderToString` on its own alternate screen.
- It extracts only a public authorize URL (claude.ai, claude.com or anthropic.com, `/oauth/authorize`, no token/secret/code params) and the "paste code" prompt; raw child output is never shown (login.js:12-72).
- The link is drawn as an OSC 8 hyperlink with text "Open Claude sign-in →" and the hostname. On a code prompt it draws `> ` and places the cursor there; the typed code echoes through the tty.
- Afterwards it re-creates the input and Ink instance and dispatches a resize.
- `baton login` uses the same `signIn`.

**Overlays.** Modals are centred, width clamp(30, cols−4, 70), and scroll to the selected option (overlays.js:171-221). Up to 2 toasts stack bottom-right with `on-ok|on-err|on-accent` backgrounds, max 3 lines each (overlays.js:227-266).

## 4. Where the code fights Ink or the terminal, and what ratatui/crossterm removes

1. **Input filter (input.js).** A PassThrough strips terminal replies (CPR, DA, focus, DECRQM, OSC/DCS/APC), holds partial escapes for 25 ms and strings for 150 ms, tracks bracketed paste, and pulls SGR mouse reports out before Ink sees them. keys.js maps Ink's flag object to names, and multi-character chunks become `text` actions.
   - **Unnecessary:** crossterm's event reader parses keys, mouse, paste, focus and resize.
2. **All geometry by hand.** Fixed constants (sidebarCols 46, sideBrandRows 13, paneHeaderRows 4, `inner()` −6). Ink's flex layout is only a container. Every line is padded with `fitLine` so backgrounds paint.
   - **Replaced by:** `Layout` plus `Block::style(bg)`.
3. **Hit-testing re-derives the layout from state.** mouse.js recomputes the sidebar lines, pane model, modal layout, toasts and footer, and hard-codes offsets (`x - side - 3`, `controlX+18`, `+8`, `+2`).
   - **Replaced by:** a `HitMap` of Rects and targets recorded during `draw`. This removes a whole class of drift bugs.
4. **Overlays.** `position:absolute` floats for modals and toasts become `Clear` plus render order.
5. **Bottom-row and autowrap work-arounds.** `?7l`, the reserved last row "to avoid Windows console scrolling", and restore handlers.
   - **Changes to:** crossterm `DisableLineWrap`/`EnableLineWrap`. The full height can then be used; keep the restore in a panic hook and `Drop`.
6. **Resize.** `instance.clear()` plus rerender (resize ghosting), plus polling the size every 2 s.
   - **Replaced by:** ratatui autoresize and `Event::Resize`. Keep a cheap size check on tick for Windows.
7. **Spinner.** A `spin` style word is parsed in the Line component and turned into `useAnimation` components at 10 fps (kit.js:17-41).
   - **Replaced by:** a frame counter in state, ticking at 100 ms only while a spinner is visible.
8. **Sign-in hand-off.** Unmount, remount and new input around the child, plus a separate `renderToString` loop that writes frames with `\x1b[H` and `\n→\r\n`. The OSC 8 escape is placed inside an Ink Text, which risks width miscounts.
   - **Becomes:** `ratatui::restore()`, then a draw loop on the same `Terminal` that does not read events (the child owns stdin) and polls the size, then `ratatui::init()` plus `clear()`.
   - Hyperlinks still need a work-around in ratatui: write OSC 8 after the draw at a known Rect, or use the hyperlink-in-first-cell trick.
9. **Incremental rendering and maxFps** become ratatui's native cell diff.
10. **Still needed in Rust:**
    - wrapping with a hanging indent and word-break characters, because `Paragraph::wrap` has no hanging indent; pre-wrap into `Vec<Line>`, which the scroll progress and line targets also need;
    - colour downsampling: ratatui emits `38;2` for `Color::Rgb` and never downsamples, so resolve roles per depth to Rgb, Indexed or named;
    - both glyph sets;
    - the sign-in URL extraction.

## 5. Weaknesses and improvements

Each item gives what, where, why, the better design, and my confidence.

1. **Two time formats, sometimes on one screen.** `format.js` uses `prompts.clock/duration` (locale-dependent, "03:20 PM", "2 h 5 min") while the menu uses `when/span` ("15:20", "2h 5m"). `statusScreen` prints `pollLine` (CLI format) directly above `overviewBody` (menu format) (screens.js:64-66). `refreshScreen` uses CLI words; `refreshSummary` uses `toLocaleTimeString`. The status `--json` `text` field depends on the locale. Better: one time module, and keep locale-free text out of JSON. High.
2. **Duplicated loading paths.** The `status` and `usage` data come from `loadSnapshot` while their screens reload through `loadMenuData`, which also computes 7-day stats and every session. `statsScreen` computes stats twice (screens.js:127-130). The printed screens depend on menu internals through a fake `initialState`. Better: one view-model layer (`views::*` returning `Vec<Line>` plus targets) fed by one loader, used by both the TUI and the printed screens. High.
3. **Heavy live refresh.**
   - The recursive watch on all of `~/.baton` includes `accounts/<id>` (where Claude Code writes constantly) and `probe/` (where the usage poll runs claude). This causes reload storms.
   - Every 2 s tick does a full synchronous reload and recomputes stats from append-only history, which grows over time, on the UI thread.
   - Better: watch only the files and folders the menu reads (config.json, usage/, sessions/, poll/, rejected/, history/, conflicts.json); load on a worker thread; cache stats by file size and mtime; tick only the clock. High.
4. **Background work tied to UI state.** The poll host does not start while the splash shows or the terminal is too small (index.js:463-470), even though the README says the menu polls while it runs. Sign-in status is only checked at startup and after an in-menu sign-in, so a `baton login` from another terminal leaves "sign in" stale. Better: start polling when the first data loads, and re-check auth on the poll's signed-out/ok changes or every few minutes. High / medium.
5. **The minimum 100×28 blocks default macOS and Linux windows (80×24).** The fixed 46-column rail. Better: a responsive layout. At 80 columns or less, a collapsible rail or single-pane mode (the dead `isNarrow` design); a hard minimum around 60×20. High (important for the cross-platform port).
6. **Light terminals.**
   - Printed screens use the `text` role `#d6d8dc` and other light hexes on the user's own background, so on light themes (macOS Terminal's default) messages and details are nearly invisible.
   - The menu paints a fixed dark background.
   - accent, warn and baton share one hex, so warnings ("signed out", "unsaved", "changed") look like accents.
   - Better: printed screens use ANSI named or default foreground (`Color::Reset`) for body text and reserve colour for roles; a distinct warn hue; the TUI keeps its own background but with a tested contrast pair; optionally detect light/dark (`COLORFGBG`, OSC 11 query). High.
7. **Hidden sign-in URL.** Only the OSC 8 link text is shown. Without OSC 8 support (conhost, older Terminal.app, some Linux terminals) and if the browser does not open, the user cannot get the URL (ui/login.js:334-392). Better: always print the full URL as wrapped plain text too; add OSC 8 only where supported. High.
8. **"Mode" means two things.** The account action says "Change mode / Account mode / Set mode / Updated the mode of" while the CLI and README say "mark"; the policy also has a "mode" (smart/order). The account view prints the raw `last-resort` where screens print "last resort". Better: "mark" everywhere, with one display function. High.
9. **The policy form's `d` pins the default value.** It sets `POLICY_DEFAULTS[key]` explicitly (policy.js:275-276) where the CLI's `default` deletes the key, so a later change of defaults will not reach it. Better: send null for "default". High.
10. **Lenient positionals.** Extra positionals are ignored (`account remove a b`). The `--last-resort` value pitfall (section 1). With `--json`, errors are not JSON (except hop). Better: clap strictness, a bool flag on `add`, and with `--json` an `{"error":…, "code":n}` object on stdout plus the same exit code. High.
11. **Wording inconsistencies.** `unknown command` vs `Unknown command`. "1 refusals" (overview.js:268-276). Better: one wording helper with plural. High.
12. **Numbers adjusted only by arrows.** Thresholds and the policy form step ±1 or ±5 (`usagePollMinutes` max 1440 in steps of 5), so reaching a value can take hundreds of presses. Better: accept typed digits and Backspace in number fields; PgUp/PgDn for ×10. Medium.
13. **README contradicts the tests.** The README says `r` in the menu refreshes, but direct shortcuts are deliberately inert (menu.test.js:335-376); it is Enter then r. There is no redraw key (Ctrl+L does nothing). Better: fix the README or allow a small documented set of global keys (r, /, q, Ctrl+L). Medium.
14. **Footer clicks.** Clicking "↑↓ Navigate" moves down, and "Home/End" jumps to the end (chrome.js:97-107). Better: only Enter, Esc, PgDn and q are clickable. Medium.
15. **Widths counted in code units.** `stats.js:526-566`, `accountsScreen` and `doctorScreen` pad with `.length`, so CJK and emoji names misalign. The CLI's narrow stats fallback prints `values.join(" ")` with no day alignment and empty gaps. Better: pad by display width everywhere. High.
16. **Hand-rolled width table** (text.js:19-45). No graphemes; ambiguous width counted as 1. Better: `unicode-width` plus `unicode-segmentation`, the same width rules ratatui uses, so measuring and drawing agree. High.
17. **Splash needs a key every launch.** It is deliberate (tested) but it is friction, and `BATON_SPLASH` is undocumented. Better: dismiss automatically once data loads, or show only on first run, and document the variable. Medium (design choice).
18. **Dead code.** `splash-end`, `isNarrow`/`sideSpan`, `headerRows=0`, `itemActions` "a" on accounts that the modal never offers, `paneHeight`, the format.js comment about `statsView`, the duplicate `plural` and `pct` in three files. Drop them in the port. High.
19. **Signal exit skips cleanup.** Signal handlers call `process.exit` without awaiting `host.stop()`, so the poll lease lingers until it expires. Better: release the lease synchronously on signal. Medium.
20. **Sign-in code entry is fragile.** It relies on the tty echoing into Baton's drawn `> ` at a hard-coded cursor position (login.js:99-100). If Claude Code puts stdin in raw mode, the user types blind. Better: document the risk; consider a PTY (portable-pty) to observe the prompt while forwarding input. Medium / low.
21. **Accessibility.** Status is often colour-only: tone of tails and meters, and the overview meters use accent where the sidebar uses ok/warn/err (overview.js:105-117 vs tree.js:58). There is no help screen; the legend line and footer are the only key documentation. Better: one tone function; text labels next to coloured numbers in the account view; a `?` key-help overlay. Medium.

## 6. Rust mapping

**Modules**
- `cli/`
  - `mod.rs`: clap derive. `Cli { #[arg(global)] json }` and `enum Cmd`.
  - `argv.rs`: the pre-scan for bare `baton [claude args]`, `-h` and `-v`.
  - `present.rs`: outputs json, screen or pipe; an `ExitCode` enum (0, 1, 2, 3).
- `ui/` (shared):
  - `theme.rs`: roles resolved per `ColorDepth` to `Color::Rgb`, `Indexed` or named.
  - `glyphs.rs`, `text.rs` (clean, width, wrap_line with indent, wrap_facts, fit, spread), `time.rs` (one format), `charts.rs` (usage_bar with threshold, spark, day cells), `art.rs`.
- `views/`: overview, account, session, sessions, stats, policy_form, status, usage. These are pure functions to `Vec<Line<'static>>` plus targets, used by both front ends.
- `screens/`: one function per command, plus `ansi.rs`, a Line-to-ANSI writer for pipes and TTYs.
- `tui/`:
  - `app.rs`: the loop. A crossterm event thread, a tick (2 s clock, 100 ms when a spinner shows), and a data channel, all into one `mpsc<Msg>`.
  - `state.rs` and `update.rs`: a pure `update(&mut State, Msg) -> Vec<Effect>`.
  - `effects.rs`: worker threads for core operations, poll and auth.
  - `data.rs`: a loader thread with `notify` (watching the narrowed paths) and a debouncer.
  - `hit.rs`: Rects and targets recorded in draw.
  - `widgets/`: sidebar, pane, footer, modal, toast, splash, login.

**Widgets**
- Sidebar: a `Paragraph` of pre-built rows with a computed offset (keep the centring rule).
- Pane: a `Paragraph` of pre-wrapped lines with `.scroll((top,0))`, plus `Scrollbar` (or the "1–20 of 45" text).
- Overview accounts: `Table`.
- Stats day grid: `Table`. The 7-day rows: custom spans, because the built-in `Sparkline` cannot do null dots or per-cell tone.
- Usage bars: custom spans; `Gauge` and `LineGauge` cannot mark the threshold.
- Modals: `Clear` plus `Block::bordered().border_type(Rounded|Plain)` plus `List` with `ListState`.
- Toasts: `Clear` plus `Paragraph` in a bottom-right Rect.
- Splash and too-small screen: centred via `Layout::flex(Flex::Center)`.
- Input field: a small own widget, or the `tui-input` crate.

**Crates:** clap 4 (derive), ratatui, crossterm, unicode-width (the version ratatui pins), unicode-segmentation, notify plus notify-debouncer-mini, serde/serde_json, jiff (local-time formatting), supports-color or anstyle-query (colour depth and Windows VT enable), signal-hook (Unix SIGTERM/SIGHUP), insta (snapshots), optionally portable-pty plus vt100 (end-to-end tests). No async runtime is needed.

**Testing**
- Keep the pure reducer tests (they port almost one-to-one from menu.test.js and menu-mouse.test.js, using hits from the recorded HitMap).
- Replace ink-testing-library frames and `scripts/menu-frames.js` with `TestBackend` plus `insta::assert_snapshot!` of the buffer, for every screen × {80×24, 100×30, 120×30, 160×45} × {rich, plain} × {colour, no colour}. Also assert that every row fits within the column count.
- Printed screens: snapshot the styled and unstyled strings.
- Replace virtual-terminal.js live tests with:
  - (a) the app loop driven through an injected `Msg` channel on `TestBackend`, with a temp `~/.baton`;
  - (b) a few PTY tests (portable-pty plus the vt100 parser) asserting the alternate screen, mouse mode set and reset, `?7h` restored, and live refresh after a file write.
- menu-demo becomes `cargo run --example menu-demo` over the same fixtures with a fake login launcher.

## 7. Terminal differences per OS

**Windows**
- *Glyphs:* keep the `BATON_GLYPHS` override and the WT_SESSION / TERM_PROGRAM / ConEmuANSI / TERM heuristic. Windows 11 conhost defaults to Cascadia Mono, so rich is usually fine there; plain remains for legacy raster fonts.
- *VT output:* Rust must enable `ENABLE_VIRTUAL_TERMINAL_PROCESSING` before printing ANSI screens (crossterm `ansi_support` or anstyle-query `windows::enable_ansi_colors`). If that fails, print unstyled. Rust std writes UTF-16 to the console itself, so the code page is not an issue.
- *Key events:* crossterm reads native console input records. It emits key **Release** events on Windows; filter to `Press | Repeat` or every key fires twice.
- *Paste:* bracketed paste is unsupported on Windows, so a paste arrives as key events, including Enter. Coalesce bursts of keys within a few ms into one paste, and turn a newline inside a burst into a space in input fields, or a pasted name with a trailing newline submits.
- *Mouse:* works in conhost and Windows Terminal through the console API. `EnableMouseCapture` turns off QuickEdit; restore it on exit.
- *Signals:* handle Ctrl+Break (SIGBREAK) via a console control handler.
- *Bottom-right cell:* use `DisableLineWrap` to avoid the scroll when it is written.
- *Resize:* comes as `Event::Resize`; keep the periodic size check as a fallback.

**macOS**
- Terminal.app opens at 80×24, below the 100×28 minimum (see 5.5).
- Terminal.app sets `TERM_PROGRAM=Apple_Terminal` and `TERM=xterm-256color` with no COLORTERM. Treat it as 256 colours.
  - Node's `getColorDepth` already does this.
  - `term.js inheritedDepth` (term.js:121-127) maps *any* TERM_PROGRAM to truecolor, which is wrong for Apple_Terminal on releases without truecolor. Fix this in the port; it affects the status line.
- Terminal.app uses PgUp/PgDn/Home/End for its own scrollback unless Shift or Fn is held. Provide alternative scroll keys (for example Space / Shift+Space, or Ctrl+↑/↓) and keep the wheel.
- Option acts as Meta only if configured. Meta keys are ignored today; keep it that way.
- OSC 8 is supported in iTerm2, WezTerm, kitty, Ghostty and recent Terminal.app. Always show the plain URL too.

**Linux**
- On the virtual console (`TERM=linux`) there is no braille spinner, ★, ⊘ or truecolor. Choose plain glyphs and 16 colours.
- With a non-UTF-8 locale (LANG, LC_ALL or LC_CTYPE without UTF-8), choose plain glyphs.
- `TERM=dumb`: no styling and no menu.
- In tmux or screen, truecolor only if COLORTERM is passed through; SGR mouse works when tmux mouse is on.
- Alternate-scroll mode (`?1007`, the default in many terminals) turns the wheel into ↑/↓ when mouse capture is off (`BATON_MOUSE=off`). So with the mouse off, the wheel moves the sidebar selection rather than scrolling the pane. Document it.

**All platforms**
- *Colour detection:* NO_COLOR, then FORCE_COLOR (0-3), then `TERM=dumb`, then COLORTERM truecolor or 24bit gives 24, then known truecolor terminals (WT_SESSION, iTerm.app, vscode, WezTerm, ghostty, kitty) give 24, then `TERM *256color` gives 8, else 4. Windows 10+ with VT enabled gives 24.
- *Downsampling:* ratatui will not downsample, so resolve role colours from this depth.
- *Mouse:* crossterm's `EnableMouseCapture` also turns on drag and any-motion reporting (`?1002/?1003`). Ignore `Moved` and `Drag` events so they do not trigger redraws. Keep `BATON_MOUSE=off`, which also restores native text selection.
- *NO_COLOR consistency:* today the menu keeps bold and inverse under NO_COLOR, but printed screens drop all styling. Make both keep bold, inverse and underline (the convention is "no colour", not "no style").
- *Terminal restore:* restore via a panic hook and `Drop` (`ratatui::init`/`restore`); on Unix also on SIGTERM, SIGHUP and SIGTSTP/SIGCONT, redrawing on resume.
