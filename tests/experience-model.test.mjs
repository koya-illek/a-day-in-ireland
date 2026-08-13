import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const { irelandClockParts, irelandEditorialMoment, formatTime } = await (async () => {
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
