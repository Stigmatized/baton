// A one-line prompt that redraws itself and waits for a key: Enter -> "go",
// Ctrl+C -> "quit", any other key -> "stay", or whatever onTick decides
// ({ result }). Keys in the first graceMs are ignored (leftovers of the keys
// typed to end claude). Input and output are injected so tests drive it.

export function keyPrompt({
  input = process.stdin,
  output = process.stderr,
  onTick,
  tickMs = 1000,
  graceMs = 500,
  now = Date.now,
}) {
  const started = now();
  return new Promise((resolve) => {
    let done = false;
    let timer = null;
    const raw = input.isTTY && typeof input.setRawMode === "function";
    const finish = (result) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      input.off("data", onData);
      if (raw) {
        try {
          input.setRawMode(false);
        } catch {
          // the console went away
        }
      }
      input.pause?.();
      output.write("\n");
      resolve(result);
    };
    const onData = (chunk) => {
      if (now() - started < graceMs) return;
      const text = chunk.toString("latin1");
      if (text.includes("\x03")) finish("quit");
      else if (/^[\r\n]+$/.test(text)) finish("go");
      else finish("stay");
    };
    const tick = async () => {
      if (done) return;
      let step;
      try {
        step = await onTick(now());
      } catch (error) {
        step = { line: `baton: ${error.message}` };
      }
      if (done) return;
      if (step?.line) output.write(`\r${step.line}\x1b[K`);
      if (step?.result) finish(step.result);
      else timer = setTimeout(tick, tickMs);
    };
    if (raw) {
      try {
        input.setRawMode(true);
      } catch {
        // not a console after all
      }
    }
    input.on("data", onData);
    input.resume?.();
    tick();
  });
}
