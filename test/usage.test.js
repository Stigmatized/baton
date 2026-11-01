import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { readJsonLines } from "../src/fsutil.js";
import {
  historyFile,
  inferRejection,
  loadRejections,
  parseResetTime,
  readReading,
  readingFromStatusLine,
  recordReading,
  recordRejection,
} from "../src/usage.js";
import { tempHome } from "./helpers.js";

const AT = new Date(2026, 9, 25, 10, 0, 0).getTime(); // local 10:00

test("status line rate_limits become a reading (epoch seconds to ISO)", () => {
  const r = readingFromStatusLine({
    rate_limits: {
      five_hour: { used_percentage: 23.5, resets_at: 1792920000 },
      seven_day: { used_percentage: 41.2 },
    },
  });
  assert.deepEqual(r, {
    five_hour: {
      used: 23.5,
      resetsAt: new Date(1792920000 * 1000).toISOString(),
    },
    seven_day: { used: 41.2, resetsAt: null },
  });
  assert.equal(readingFromStatusLine({}), null);
  assert.equal(
    readingFromStatusLine({
      rate_limits: { five_hour: { used_percentage: "x" } },
    }),
    null,
  );
  assert.equal(readingFromStatusLine(null), null);
});

test("readings: written on change or when old, absent windows kept, changes appended to the history", (t) => {
  const { paths } = tempHome(t);
  const first = recordReading(
    paths,
    "a",
    { five_hour: { used: 10, resetsAt: "R1" } },
    { at: AT, session: "s1" },
  );
  assert.deepEqual([first.changed, first.written], [true, true]);
  const same = recordReading(
    paths,
    "a",
    { five_hour: { used: 10, resetsAt: "R1" } },
    { at: AT + 1000 },
  );
  assert.deepEqual([same.changed, same.written], [false, false]);
  const refresh = recordReading(
    paths,
    "a",
    { five_hour: { used: 10, resetsAt: "R1" } },
    { at: AT + 31e3 },
  );
  assert.deepEqual([refresh.changed, refresh.written], [false, true]);
  recordReading(
    paths,
    "a",
    { seven_day: { used: 50, resetsAt: "W1" } },
    { at: AT + 40e3 },
  );
  const stored = readReading(paths, "a");
  assert.equal(stored.five_hour.used, 10);
  assert.equal(stored.seven_day.used, 50);
  const history = readJsonLines(historyFile(paths, "readings", AT));
  assert.deepEqual(
    history.map((h) => [h.window, h.used]),
    [
      ["five_hour", 10],
      ["seven_day", 50],
    ],
  );
  assert.equal(
    recordReading(paths, "../evil", { five_hour: { used: 1 } }).written,
    false,
  );
  assert.deepEqual(
    readdirSync(paths.usage).filter((f) => f.endsWith(".tmp")),
    [],
  );
});

test("refusals are stored per account and window", (t) => {
  const { paths } = tempHome(t);
  recordRejection(paths, "a", {
    window: "five_hour",
    at: "T1",
    until: "U1",
    session: "s",
  });
  recordRejection(paths, "a", { window: "seven_day", at: "T2" });
  recordRejection(paths, "b", { window: "bogus", at: "T3" });
  const all = loadRejections(paths, ["a", "b", "c"]);
  assert.equal(all.a.five_hour.until, "U1");
  assert.equal(all.a.seven_day.until, null);
  assert.equal(all.b.unknown.at, "T3");
  assert.deepEqual(all.c, {});
});

test("reset times in Claude Code's limit messages", () => {
  const local = (h, m = 0, dayOffset = 0) =>
    new Date(2026, 9, 25 + dayOffset, h, m).getTime();
  assert.equal(
    parseResetTime("You've hit your session limit · resets 3pm", AT),
    local(15),
  );
  assert.equal(
    parseResetTime("limit reached · resets 3:20pm (Europe/Athens)", AT),
    local(15, 20),
  );
  assert.equal(parseResetTime("resets at 15:20", AT), local(15, 20));
  assert.equal(parseResetTime("resets 9am", AT), local(9, 0, 1)); // already past today
  assert.equal(
    parseResetTime("You've hit your weekly limit · resets Oct 27, 9am", AT),
    local(9, 0, 2),
  );
  assert.equal(parseResetTime("resets in 2h 30m", AT), AT + 150 * 60e3);
  assert.equal(parseResetTime("resets in 45 min", AT), AT + 45 * 60e3);
  assert.equal(parseResetTime("API Error: Rate limit reached", AT), null);
  assert.equal(parseResetTime("resets 7", AT), null);
  assert.equal(parseResetTime(undefined, AT), null);
});

test("refusal inference: the window from the message or the reading, the end from the message or the reading", () => {
  const reading = {
    five_hour: { used: 100, resetsAt: new Date(AT + 3600e3).toISOString() },
    seven_day: { used: 60, resetsAt: new Date(AT + 3 * 864e5).toISOString() },
  };
  assert.deepEqual(
    inferRejection({
      error: "rate_limit",
      message: "You've hit your session limit · resets 3pm",
      reading,
      at: AT,
    }),
    {
      window: "five_hour",
      until: new Date(new Date(2026, 9, 25, 15).getTime()).toISOString(),
      untilSource: "message",
    },
  );
  assert.deepEqual(
    inferRejection({
      error: "rate_limit",
      message: "You've hit your weekly limit",
      reading,
      at: AT,
    }),
    {
      window: "seven_day",
      until: reading.seven_day.resetsAt,
      untilSource: "reading",
    },
  );
  assert.deepEqual(
    inferRejection({
      error: "rate_limit",
      message: "API Error: Rate limit reached",
      reading,
      at: AT,
    }),
    {
      window: "five_hour",
      until: reading.five_hour.resetsAt,
      untilSource: "reading",
    },
  );
  assert.equal(
    inferRejection({
      error: "rate_limit",
      message: "Opus limit reached",
      reading: null,
      at: AT,
    }).window,
    "seven_day",
  );
  assert.deepEqual(
    inferRejection({
      error: "billing_error",
      message: "credit balance too low",
      reading: null,
      at: AT,
    }),
    {
      window: "unknown",
      until: null,
      untilSource: "none",
    },
  );
});
