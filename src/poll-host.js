import { randomBytes, randomUUID } from "node:crypto";
import {
  closeSync,
  mkdirSync,
  openSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { join } from "node:path";
import { isAlive, iso, ms, readJson, writeJsonAtomic } from "./fsutil.js";
import { Poller } from "./poller.js";

// The usage poll runs only while a baton instance the operator started
// runs (there is no background service): the menu
// (`baton view`) and every `baton` wrapper carry a PollHost, and exactly
// one of them, the holder of the poll lease, polls on the schedule. No Baton
// process outlives the last instance: when it exits, nothing polls.
//
// ~/.baton/poll/lease.json   { pid, kind ("menu" | "start"), instance, since,
//                            heartbeatAt }: renewed every heartbeat (3 s);
//                            a lease whose process is gone, or not renewed
//                            for 10 s, is taken by another live instance
//                            (one at a time, through lease.json.take)
// ~/.baton/poll/requests/    a poll asked for by a command (an account
//                            added, renamed or signed in): the holder takes
//                            it at its next heartbeat; with no instance
//                            running, nothing polls.

export const HEARTBEAT_MS = 3e3;
export const LEASE_STALE_MS = 10e3;
export const KIND_WORDS = { menu: "the menu", start: "baton" };

const pollDir = (paths) => join(paths.root, "poll");
export const leaseFile = (paths) => join(pollDir(paths), "lease.json");
export const requestDir = (paths) => join(pollDir(paths), "requests");

const live = (lease, now, alive, staleMs = LEASE_STALE_MS) =>
  !!lease &&
  Number.isInteger(lease.pid) &&
  alive(lease.pid) &&
  now - (ms(lease.heartbeatAt) ?? 0) < staleMs;

// Who polls now: { kind, pid, since } or null (no baton instance runs).
export function pollHolder(paths, { now = Date.now(), alive = isAlive } = {}) {
  const lease = readJson(leaseFile(paths));
  return live(lease, now, alive)
    ? { kind: lease.kind, pid: lease.pid, since: lease.since ?? null }
    : null;
}

// A poll a command asks for (an account added, renamed or signed in).
export function requestPoll(paths, account, reason, at = Date.now()) {
  try {
    writeJsonAtomic(
      join(requestDir(paths), `${at}-${randomBytes(3).toString("hex")}.json`),
      { account, reason, at: iso(at) },
    );
  } catch {
    // the next scheduled poll reads it anyway
  }
}

export class PollHost {
  constructor({
    paths,
    kind,
    env = process.env,
    launcher = null,
    low = false,
    poller = null,
    now = Date.now,
    alive = isAlive,
    pid = process.pid,
    heartbeatMs = HEARTBEAT_MS,
    staleMs = LEASE_STALE_MS,
    log = () => {},
  }) {
    this.paths = paths;
    this.kind = kind;
    this.now = now;
    this.alive = alive;
    this.pid = pid;
    this.heartbeatMs = heartbeatMs;
    this.staleMs = staleMs;
    this.instance = randomUUID();
    this.holding = false;
    this.stopped = false;
    this.timer = null;
    this.poller =
      poller ??
      new Poller({
        paths,
        env,
        launcher,
        low,
        now,
        log,
        may: () => this.holds(),
      });
  }

  // Whether the lease is this instance's now.
  holds() {
    return (
      !this.stopped &&
      readJson(leaseFile(this.paths))?.instance === this.instance
    );
  }

  start() {
    this.timer = setInterval(() => this.beat(), this.heartbeatMs);
    this.timer.unref?.();
    this.beat();
    return this;
  }

  // Every heartbeat: hold (renew or take) the lease; the holder polls when a
  // poll is due or asked for. The poll itself runs in the background: a
  // heartbeat never waits for it.
  beat() {
    if (this.stopped) return false;
    try {
      this.holding = this.hold();
      if (!this.holding) return false;
      for (const request of this.takeRequests())
        this.poller
          .refresh({ account: request.account, reason: request.reason })
          .catch(() => {});
      this.poller.tick()?.catch?.(() => {});
    } catch {
      // a heartbeat never fails the instance
    }
    return this.holding;
  }

  hold() {
    const file = leaseFile(this.paths);
    const now = this.now();
    const lease = readJson(file);
    const record = (since) => ({
      pid: this.pid,
      kind: this.kind,
      instance: this.instance,
      since,
      heartbeatAt: iso(now),
    });
    if (lease?.instance === this.instance) {
      writeJsonAtomic(file, record(lease.since ?? iso(now)));
      return true;
    }
    if (live(lease, now, this.alive, this.staleMs)) return false;
    // Taking a free or stale lease: one instance at a time.
    mkdirSync(pollDir(this.paths), { recursive: true });
    const guard = `${file}.take`;
    let fd;
    try {
      fd = openSync(guard, "wx");
    } catch {
      try {
        // A guard left by an instance that died while taking the lease.
        if (Date.now() - statSync(guard).mtimeMs > this.staleMs)
          rmSync(guard, { force: true });
      } catch {
        // gone already
      }
      return false;
    }
    try {
      const again = readJson(file);
      if (
        again?.instance !== this.instance &&
        live(again, now, this.alive, this.staleMs)
      )
        return false;
      writeJsonAtomic(file, record(iso(now)));
      return true;
    } finally {
      closeSync(fd);
      rmSync(guard, { force: true });
    }
  }

  takeRequests() {
    const dir = requestDir(this.paths);
    let names = [];
    try {
      names = readdirSync(dir).filter((n) => n.endsWith(".json"));
    } catch {
      return [];
    }
    const out = [];
    for (const name of names.sort()) {
      const file = join(dir, name);
      const request = readJson(file);
      rmSync(file, { force: true });
      if (request && typeof request.account === "string") out.push(request);
    }
    // One poll per account.
    return out.filter(
      (r, i) => out.findIndex((x) => x.account === r.account) === i,
    );
  }

  // Lets the lease go (another live instance takes it within a heartbeat)
  // and ends a read in progress, its claude with it.
  async stop() {
    if (this.stopped) return;
    this.stopped = true;
    clearInterval(this.timer);
    try {
      const file = leaseFile(this.paths);
      if (readJson(file)?.instance === this.instance)
        rmSync(file, { force: true });
    } catch {
      // gone already
    }
    await this.poller.stop?.();
  }
}
