import assert from "node:assert/strict";
import test from "node:test";
import { importStandaloneTypeScript } from "./import-ts.mjs";

const { compareBriefings, dailyBriefing } = await importStandaloneTypeScript("../lib/daily-briefing.ts");

const snapshot = (observedAt, temperature, overrides = {}) => ({
  sourceStatus: "live", contextStatus: { grid: "live" },
  sourceProvenance: { rivers: { status: "live" } },
  stations: [{ id: "cork", name: "Cork", temperature, observedAt }],
  rivers: [], grid: { windSharePercent: temperature, observedAt }, ...overrides
});
const morning = snapshot("2026-09-05T05:00:00Z", 12);
const current = snapshot("2026-09-05T12:00:00Z", 17);

test("briefing comparisons use matching stations and percentage points", () => {
  const result = compareBriefings(current, morning);
  assert.match(result[0], /Cork: 5.0°C warmer.*1 matched stations/);
  assert.match(result[1], /5.0 percentage points higher/);
  assert.equal(compareBriefings({ ...current, stations: [{ ...current.stations[0], id: "different" }] }, morning).length, 1);
});

test("stale states and non-increasing observation times cannot support a comparison", () => {
  assert.deepEqual(compareBriefings(morning, current), []);
  assert.deepEqual(compareBriefings({ ...current, sourceStatus: "stale", contextStatus: { grid: "stale" } }, morning), []);
  assert.deepEqual(compareBriefings(snapshot(null, 17), morning), []);
});

test("the national summary does not substitute missing temperatures or unavailable grid data", () => {
  assert.deepEqual(dailyBriefing(snapshot(null, null), true, false), []);
  assert.deepEqual(dailyBriefing(current, false, false), []);
  assert.match(dailyBriefing(current, true, true)[0], /17°C/);
});
