import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const importHistory = async () => {
  const source = await readFile(new URL("../lib/history.ts", import.meta.url), "utf8");
  const output = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext }
  }).outputText;
  return import(`data:text/javascript,${encodeURIComponent(output)}`);
};

test("history accepts zoned instants and rejects ambiguous URL timestamps", async () => {
  const history = await importHistory();
  assert.equal(history.canonicalHistoryAt("2026-08-04T18:45:00+01:00"), "2026-08-04T17:45:00.000Z");
  assert.equal(history.canonicalHistoryAt("2026-08-04T17:45:00Z"), "2026-08-04T17:45:00.000Z");
  assert.equal(history.canonicalHistoryAt("2026-08-04T17:45"), null);
  assert.equal(history.canonicalHistoryAt("not-a-date"), null);
});

test("Ireland wall-time conversion exposes DST gaps and both repeated instants", async () => {
  const history = await importHistory();
  assert.deepEqual(history.irelandWallTimeCandidates("2026-03-29", "01:30"), []);
  assert.deepEqual(history.irelandWallTimeCandidates("2026-10-25", "01:30"), [
    "2026-10-25T00:30:00.000Z",
    "2026-10-25T01:30:00.000Z"
  ]);
  assert.deepEqual(history.irelandWallTimeCandidates("2026-08-04", "18:45"), [
    "2026-08-04T17:45:00.000Z"
  ]);
});

test("history range and envelope preserve resolution, nullable movement, and provider gaps", async () => {
  const history = await importHistory();
  const range = history.normalizeHistoryRange({
    schemaVersion: 1,
    availableFrom: "2026-07-01T00:00:00Z",
    availableTo: "2026-08-04T23:45:00Z",
    resolutions: [
      { name: "raw", resolutionMinutes: 15, availableFrom: "2026-07-06T00:00:00Z", availableTo: "2026-08-04T23:45:00Z" },
      { name: "daily", resolutionMinutes: 1440, availableFrom: "2026-07-01T00:00:00Z", availableTo: "2026-07-05T00:00:00Z" }
    ]
  });
  assert.equal(range.resolutionMinutes, 15);
  assert.equal(range.resolutions.length, 2);

  const envelope = history.normalizeHistoryEnvelope({
    schemaVersion: 1,
    requestedAt: "2026-07-01T12:00:00Z",
    resolvedAt: "2026-07-01T00:00:00Z",
    availableFrom: "2026-07-01T00:00:00Z",
    availableTo: "2026-08-04T23:45:00Z",
    resolutionMinutes: 1440,
    snapshotCount: null,
    snapshot: null,
    movementSummary: {
      rail: null,
      transit: { vehicles: 810, routes: 96 }
    },
    gaps: [
      {
        source: "Iarnród Éireann",
        scope: "positions",
        reason: "not-retained",
        detail: "Rail history is not retained — permission pending."
      },
      {
        source: "NASA satellite",
        scope: "imagery",
        reason: "not-collected",
        detail: "Satellite pixels were not archived."
      }
    ]
  }, "2026-07-01T12:00:00Z");

  assert.equal(envelope.resolvedAt, "2026-07-01T00:00:00.000Z");
  assert.equal(envelope.resolutionMinutes, 1440);
  assert.equal(envelope.snapshotCount, null);
  assert.equal(envelope.snapshot, null);
  assert.equal(envelope.movementSummary.rail, null);
  assert.deepEqual(envelope.movementSummary.transit, { vehicles: 810, routes: 96 });
  assert.equal(envelope.gaps[0].detail, "Rail history is not retained — permission pending.");
  assert.equal(envelope.gaps[1].scope, "imagery");
});

test("history accepts backend transit total/byRoute aliases without inventing missing aggregates", async () => {
  const history = await importHistory();
  const base = {
    schemaVersion: 1,
    requestedAt: "2026-08-04T17:45:00Z",
    resolvedAt: "2026-08-04T17:45:00Z",
    resolutionMinutes: 15,
    snapshot: null,
    gaps: []
  };
  const aliased = history.normalizeHistoryEnvelope({
    ...base,
    movementSummary: {
      rail: null,
      transit: { total: 810, byRoute: [{ route: "1", count: 20 }, { route: "2", count: 10 }] }
    }
  }, base.requestedAt);
  const unavailable = history.normalizeHistoryEnvelope({
    ...base,
    movementSummary: { rail: null, transit: { byRoute: [] } }
  }, base.requestedAt);
  const explicitNulls = history.normalizeHistoryEnvelope({
    ...base,
    movementSummary: { rail: null, transit: { vehicles: null, routes: null } }
  }, base.requestedAt);
  const blankStrings = history.normalizeHistoryEnvelope({
    ...base,
    movementSummary: { rail: null, transit: { vehicles: "   ", routes: "\t" } }
  }, base.requestedAt);
  assert.deepEqual(aliased.movementSummary.transit, { vehicles: 810, routes: 2 });
  assert.equal(unavailable.movementSummary.transit, null);
  assert.equal(explicitNulls.movementSummary.transit, null);
  assert.equal(blankStrings.movementSummary.transit, null);
});

test("only daily summaries may be usable without a detailed snapshot", async () => {
  const history = await importHistory();
  const base = {
    schemaVersion: 1,
    requestedAt: "2026-08-04T17:45:00Z",
    resolvedAt: "2026-08-04T17:45:00Z",
    snapshot: null,
    movementSummary: { rail: null, transit: null },
    gaps: []
  };
  const hourly = history.normalizeHistoryEnvelope({ ...base, resolutionMinutes: 60 }, base.requestedAt);
  const daily = history.normalizeHistoryEnvelope({
    ...base,
    resolutionMinutes: 1440,
    periodSummary: {
      basis: "retained-hourly-representatives",
      representedSamples: 20,
      weather: {},
      grid: {},
      transit: {},
      distinctCounts: {}
    }
  }, base.requestedAt);
  const emptyDaily = history.normalizeHistoryEnvelope({
    ...base,
    resolutionMinutes: 1440,
    periodSummary: {
      basis: "retained-hourly-representatives",
      representedSamples: 0,
      weather: {},
      grid: {},
      transit: {},
      distinctCounts: {}
    }
  }, base.requestedAt);
  assert.equal(history.isUsableHistoryEnvelope(hourly), false);
  assert.equal(history.isUsableHistoryEnvelope(daily), true);
  assert.equal(history.isUsableHistoryEnvelope(emptyDaily), false);
  assert.equal(daily.periodSummary.weather.highestTemperatureC, null);
});

test("history fetches the documented at-or-before endpoints without cache substitution", async () => {
  const history = await importHistory();
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url: String(url), cache: options?.cache });
    if (String(url).endsWith("/range")) {
      return Response.json({ availableFrom: null, availableTo: null, resolutionMinutes: 15 });
    }
    return Response.json({
      schemaVersion: 1,
      requestedAt: "2026-08-04T17:45:00Z",
      resolvedAt: null,
      availableFrom: null,
      availableTo: null,
      previousAt: null,
      nextAt: null,
      resolutionMinutes: 15,
      snapshot: null,
      movementSummary: { rail: null, transit: null },
      gaps: []
    });
  };
  try {
    await history.fetchHistoryRange();
    await history.fetchHistorySnapshot("2026-08-04T18:45:00+01:00");
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.deepEqual(calls, [
    { url: "/api/history/range", cache: "no-store" },
    { url: "/api/history?at=2026-08-04T17%3A45%3A00.000Z", cache: "no-store" }
  ]);
});
