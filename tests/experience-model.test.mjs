import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const { irelandClockParts, irelandEditorialMoment, formatTime, restoredRadarFrameIndex, weatherNarrative, buildHeroFacts } = await (async () => {
  const source = await readFile(new URL("../components/experience-model.ts", import.meta.url), "utf8");
  const output = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.ESNext }
  }).outputText;
  return import(`data:text/javascript,${encodeURIComponent(output)}`);
})();

test("the editorial lead names the Irish calendar day, clock, and period", () => {
  assert.equal(
    irelandEditorialMoment(new Date("2026-08-14T00:23:00+01:00")),
    "Friday 14 August, 00:23 Irish time. Before dawn across Ireland."
  );
  assert.equal(
    irelandEditorialMoment(new Date("2026-08-14T08:05:00+01:00")),
    "Friday 14 August, 08:05 Irish time. Morning across Ireland."
  );
  assert.equal(
    irelandEditorialMoment(new Date("2026-08-14T15:40:00+01:00")),
    "Friday 14 August, 15:40 Irish time. Afternoon across Ireland."
  );
  assert.equal(
    irelandEditorialMoment(new Date("2026-08-14T19:10:00+01:00")),
    "Friday 14 August, 19:10 Irish time. Evening across Ireland."
  );
  assert.equal(
    irelandEditorialMoment(new Date("2026-08-14T22:45:00+01:00")),
    "Friday 14 August, 22:45 Irish time. Night across Ireland."
  );
});

test("Irish midnight is 00:00 rather than 24:00", () => {
  const midnight = irelandClockParts(new Date("2026-08-14T00:00:00+01:00"));
  assert.equal(midnight.clock, "00:00");
  assert.equal(formatTime(new Date("2026-08-14T00:00:00+01:00")), "00:00");
  assert.equal(midnight.weekday, "Friday");
});

test("radar refresh keeps the parked frame by wall-clock instant, not raw position", () => {
  const previousFrames = ["10:00", "10:05", "10:10", "10:15", "10:20"].map((time) => ({ observedAt: `2026-08-05T${time}:00Z` }));
  // The window slides: two new frames arrive at the end and the oldest drops off.
  const nextFrames = ["10:05", "10:10", "10:15", "10:20", "10:25", "10:30"].map((time) => ({ observedAt: `2026-08-05T${time}:00Z` }));

  assert.equal(restoredRadarFrameIndex(previousFrames, 2, nextFrames), 1, "a parked older frame follows its instant through the slide");
  assert.equal(restoredRadarFrameIndex(previousFrames, previousFrames.length - 1, nextFrames), nextFrames.length - 1, "riding the newest frame follows the window forward");
  assert.equal(restoredRadarFrameIndex(previousFrames, 0, nextFrames), nextFrames.length - 1, "an instant the provider dropped falls back to the newest frame");
  assert.equal(restoredRadarFrameIndex([], 0, nextFrames), nextFrames.length - 1, "no previous frames lands on the newest frame");
  assert.equal(restoredRadarFrameIndex(previousFrames, 2, []), 0, "an empty refreshed window is clamped safely");
});

const narrativeSnapshot = (summary) => ({
  sourceStatus: "live",
  summary: { warmest: null, wettest: null, ...summary }
});

test("the weather narrative never appends a degree sign to a missing temperature", () => {
  const warm = { name: "Shannon Airport", temperature: 18.3 };
  assert.equal(
    weatherNarrative(narrativeSnapshot({ warmest: warm })),
    "Shannon Airport is 18.3°. None of the reporting stations have measured rain."
  );
  // A station whose row lacks a temperature is described in words; the old
  // string appended the unit outside the null check and read "Unavailable°".
  assert.equal(
    weatherNarrative(narrativeSnapshot({ warmest: { name: "Shannon Airport", temperature: null } })),
    "Shannon Airport has no current temperature reading. None of the reporting stations have measured rain."
  );
  assert.equal(
    weatherNarrative(narrativeSnapshot({})),
    "Current weather observations are unavailable."
  );
});

test("the weather narrative keeps the rain lead when only rainfall is known", () => {
  const snapshot = narrativeSnapshot({
    wettest: { name: "Valentia Observatory", rainfall: 2.4 },
    warmest: { name: "Shannon Airport", temperature: null }
  });
  const narrative = weatherNarrative(snapshot);
  assert.match(narrative, /^Rain is being observed around Valentia Observatory\. /);
  assert.doesNotMatch(narrative, /Unavailable°/);
  assert.equal(
    weatherNarrative(narrativeSnapshot({ wettest: { name: "Malin Head", rainfall: 1 } })),
    "Rain is being observed around Malin Head. The warmest station is unavailable."
  );
});

test("hero notice facts separate presence evidence from all-clear claims", () => {
  const base = { activeNoticeCount: 0, upcomingNoticeCount: 0, weatherNotableCurrent: false, warmestStation: null, wettestStation: null, windiestStation: null };
  const notices = (options) => buildHeroFacts({ ...base, ...options }).filter((fact) => fact.key === "warnings");

  const clear = notices({ warningsUsable: true, warningsCurrent: true, activeNoticeCount: 0 });
  assert.equal(clear.length, 1);
  assert.equal(clear[0].value, "Clear");
  assert.equal(clear[0].detail, "No current or upcoming notices");

  const stalePresence = notices({ warningsUsable: true, warningsCurrent: false, activeNoticeCount: 2 });
  assert.equal(stalePresence.length, 1);
  assert.equal(stalePresence[0].value, "2");
  assert.equal(stalePresence[0].detail, "Notices now in effect");

  assert.deepEqual(notices({ warningsUsable: true, warningsCurrent: false }), []);
  assert.deepEqual(notices({ warningsUsable: false, warningsCurrent: false }), []);
});
