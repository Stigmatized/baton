// A stand-in for a baton instance (the menu or a baton session wrapper) as far
// as the usage poll goes: a PollHost in a process of its own, with the fake
// usage claude. It logs every account it polls to $INSTANCE_LOG and stops
// (releasing the lease) when its stdin closes.
import { appendFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { batonPaths } from "../../src/paths.js";
import { PollHost } from "../../src/poll-host.js";

const env = process.env;
const fake = join(
  dirname(fileURLToPath(import.meta.url)),
  "fake-usage-claude.js",
);
const log = (event) =>
  appendFileSync(
    env.INSTANCE_LOG,
    JSON.stringify({ pid: process.pid, at: Date.now(), ...event }) + "\n",
  );
const host = new PollHost({
  paths: batonPaths(env.BATON_HOME),
  kind: env.INSTANCE_KIND ?? "start",
  env,
  launcher: { command: process.execPath, prefix: [fake], path: fake },
  heartbeatMs: Number(env.HEARTBEAT_MS) || 200,
  staleMs: Number(env.STALE_MS) || 1500,
  log: (line) => log({ event: "polled", line }),
});
host.start();
log({ event: "ready" });
const end = async () => {
  await host.stop();
  log({ event: "stopped" });
  process.exit(0);
};
process.stdin.on("end", end);
process.stdin.on("close", end);
process.stdin.resume();
