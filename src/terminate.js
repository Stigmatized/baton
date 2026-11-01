import { spawn, spawnSync } from "node:child_process";

// Ending the `claude` process at the end of a turn, as gently as the platform
// allows, so it runs its own shutdown (transcript flushed, MCP servers and
// background shells stopped, terminal restored, SessionEnd hooks run):
//
// - Windows: Claude Code reads the console in raw mode, so Ctrl+C is a key to
//   it, not a signal, and it exits on two Ctrl+C at its prompt. Node cannot
//   send a console control event to one process (process.kill is
//   TerminateProcess; CTRL_BREAK would reach every process on the console,
//   the operator's shell included). Baton types the keys: a short PowerShell
//   helper with its own hidden console attaches to Baton's console and writes
//   two Ctrl+C key events into its input buffer with WriteConsoleInput, exactly
//   what the operator's keyboard would produce. Up to three rounds (a first
//   Ctrl+C may only clear typed text, close a dialog or cancel Claude Code's
//   own limit wait); if claude is still running, `taskkill /T /F` ends its
//   process tree and Baton restores the terminal modes.
// - Elsewhere: SIGTERM (Claude Code shuts down gracefully on it), SIGKILL
//   after a timeout.
// - "kill" (tests, or config endMethod): terminate at once.

const KEYS_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Threading;
public static class BatonConsoleKeys {
  [StructLayout(LayoutKind.Explicit, CharSet = CharSet.Unicode)]
  public struct KEY_EVENT_RECORD {
    [FieldOffset(0)] public int bKeyDown;
    [FieldOffset(4)] public ushort wRepeatCount;
    [FieldOffset(6)] public ushort wVirtualKeyCode;
    [FieldOffset(8)] public ushort wVirtualScanCode;
    [FieldOffset(10)] public char UnicodeChar;
    [FieldOffset(12)] public uint dwControlKeyState;
  }
  [StructLayout(LayoutKind.Explicit)]
  public struct INPUT_RECORD {
    [FieldOffset(0)] public ushort EventType;
    [FieldOffset(4)] public KEY_EVENT_RECORD KeyEvent;
  }
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool FreeConsole();
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool AttachConsole(uint pid);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetConsoleCtrlHandler(IntPtr h, bool add);
  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  static extern IntPtr CreateFileW(string name, uint access, uint share, IntPtr sa, uint disp, uint flags, IntPtr tmpl);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool CloseHandle(IntPtr h);
  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  static extern bool WriteConsoleInputW(IntPtr h, INPUT_RECORD[] recs, uint n, out uint written);
  public static string Send(uint pid, int[] codes, int delayMs) {
    FreeConsole();
    SetConsoleCtrlHandler(IntPtr.Zero, true);
    if (!AttachConsole(pid)) return "attach " + Marshal.GetLastWin32Error();
    IntPtr h = CreateFileW("CONIN$", 0xC0000000, 3, IntPtr.Zero, 3, 0, IntPtr.Zero);
    if (h == new IntPtr(-1)) { FreeConsole(); return "open " + Marshal.GetLastWin32Error(); }
    try {
      for (int i = 0; i < codes.Length; i++) {
        if (i > 0) Thread.Sleep(delayMs);
        char c = (char)codes[i];
        bool ctrl = c < ' ';
        var recs = new INPUT_RECORD[2];
        for (int d = 0; d < 2; d++) {
          recs[d].EventType = 1;
          recs[d].KeyEvent.bKeyDown = d == 0 ? 1 : 0;
          recs[d].KeyEvent.wRepeatCount = 1;
          recs[d].KeyEvent.wVirtualKeyCode = ctrl ? (ushort)(c + 0x40) : (ushort)char.ToUpperInvariant(c);
          recs[d].KeyEvent.UnicodeChar = c;
          recs[d].KeyEvent.dwControlKeyState = ctrl ? 0x0008u : 0u;
        }
        uint written;
        if (!WriteConsoleInputW(h, recs, 2, out written)) return "write " + Marshal.GetLastWin32Error();
      }
      return "ok";
    } finally { CloseHandle(h); FreeConsole(); }
  }
}
'@
[BatonConsoleKeys]::Send([uint32]__PID__, [int[]]@(__CODES__), __DELAY__)
`;

const encode = (script) => Buffer.from(script, "utf16le").toString("base64");

// Types keys into the console of process `pid` (Windows). Resolves "ok" or the
// failing step.
export function typeConsoleKeys(
  pid,
  codes,
  { delayMs = 250, timeoutMs = 20e3 } = {},
) {
  const script = KEYS_SCRIPT.replace("__PID__", String(Number(pid)))
    .replace("__CODES__", codes.map((c) => Number(c)).join(","))
    .replace("__DELAY__", String(Number(delayMs)));
  return new Promise((resolve) => {
    let out = "";
    let err = "";
    let child;
    try {
      child = spawn(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-EncodedCommand", encode(script)],
        // windowsHide with no inherited stdio gives the helper a hidden
        // console of its own: PowerShell never touches the operator's console
        // until the helper attaches to it for the key write.
        { stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
      );
    } catch (error) {
      resolve(`spawn ${error.message}`);
      return;
    }
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.stdout.on("data", (d) => (out += d));
    // stderr carries PowerShell's progress records (CLIXML); the answer is on stdout.
    child.stderr.on("data", (d) => (err += d));
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve(`spawn ${error.message}`);
    });
    child.on("close", () => {
      clearTimeout(timer);
      resolve(
        out.trim().split(/\r?\n/).at(-1) ||
          `no output ${err.trim().slice(0, 200)}`,
      );
    });
  });
}

const exited = (child) => child.exitCode !== null || child.signalCode !== null;

export function waitExit(child, timeoutMs) {
  if (exited(child)) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.off("exit", done);
      resolve(false);
    }, timeoutMs);
    function done() {
      clearTimeout(timer);
      resolve(true);
    }
    child.once("exit", done);
  });
}

// What a forcibly ended full-screen program may leave behind: alternate
// screen, hidden cursor, mouse and focus reporting, bracketed paste, the
// kitty keyboard protocol, Windows Terminal's win32-input-mode, raw input.
export const TERMINAL_RESET =
  "\x1b[?1049l\x1b[?25h\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?1004l\x1b[?2004l\x1b[<u\x1b[?9001l\x1b[0m";

export function restoreTerminal({
  output = process.stdout,
  input = process.stdin,
} = {}) {
  try {
    if (output.isTTY) output.write(TERMINAL_RESET);
    if (input.isTTY && typeof input.setRawMode === "function") {
      input.setRawMode(true);
      input.setRawMode(false);
    }
  } catch {
    // best effort
  }
}

// endClaude(child, { method }) -> { method: keys|signal|kill, forced, detail }
export async function endClaude(
  child,
  {
    method = "auto",
    platform = process.platform,
    consolePid = process.pid,
    typeKeys = typeConsoleKeys,
    rounds = 3,
    roundWaitMs = 2000,
    signalWaitMs = 5000,
    restore = restoreTerminal,
  } = {},
) {
  if (exited(child)) return { method: "none", forced: false };
  const chosen =
    method === "auto" ? (platform === "win32" ? "keys" : "signal") : method;
  if (chosen === "keys") {
    const details = [];
    for (let round = 0; round < rounds && !exited(child); round++) {
      details.push(await typeKeys(consolePid, [3, 3]));
      if (await waitExit(child, roundWaitMs))
        return {
          method: "keys",
          forced: false,
          rounds: round + 1,
          detail: details,
        };
    }
    forceKill(child, platform);
    await waitExit(child, signalWaitMs);
    restore();
    return { method: "keys", forced: true, detail: details };
  }
  if (chosen === "signal") {
    child.kill("SIGTERM");
    if (await waitExit(child, signalWaitMs))
      return { method: "signal", forced: false };
    forceKill(child, platform);
    await waitExit(child, signalWaitMs);
    restore();
    return { method: "signal", forced: true };
  }
  forceKill(child, platform);
  await waitExit(child, signalWaitMs);
  return { method: "kill", forced: true };
}

export function forceKill(child, platform = process.platform) {
  if (exited(child)) return;
  if (platform === "win32" && child.pid) {
    // The whole tree: claude's MCP servers and shells would outlive it.
    spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
    });
    if (!exited(child)) child.kill();
    return;
  }
  child.kill("SIGKILL");
}
