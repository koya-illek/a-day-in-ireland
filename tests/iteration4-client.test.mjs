import assert from "node:assert/strict";
import test from "node:test";
import { importBrowserLive, importStandaloneTypeScript } from "./import-ts.mjs";



test("transit destination merge applies the dictionary onto current positions without inventing stops", async () => {
  const { applyTransitDestinations } = await importBrowserLive();
  // The vehicle array is the one that committed while the dictionary loaded:
  // fresher positions must survive, and trips absent from the schedule
  // dictionary must keep whatever they had.
  const current = [
    { id: "v1", tripId: "trip-1", destination: undefined, latitude: 53.1 },
    { id: "v2", tripId: "trip-2", destination: "Earlier terminus", latitude: 52.2 },
    { id: "v3", tripId: undefined, destination: undefined, latitude: 51.9 }
  ];
  const merged = applyTransitDestinations(current, { "trip-1": "Dublin (O'Connell St)" });
  assert.equal(merged[0].destination, "Dublin (O'Connell St)");
  assert.equal(merged[0].latitude, 53.1);
  assert.equal(merged[1].destination, "Earlier terminus");
  assert.equal(merged[2].destination, undefined);
  assert.notEqual(merged[0], current[0], "merge returns new objects instead of mutating snapshot state");
});

test("national forecast survives a degraded warnings feed", async () => {
  const { createInitialSnapshot } = await importStandaloneTypeScript("../lib/initial-snapshot.ts");
  const { refreshCurrentContexts } = await importBrowserLive();
  const now = Date.parse("2026-08-05T12:00:00Z");
  const previous = createInitialSnapshot(new Date(now).toISOString());
  const originalFetch = globalThis.fetch;
  const originalWindow = globalThis.window;
  globalThis.window = {
    location: { hostname: "localhost" },
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout
  };
  globalThis.fetch = async () => Response.json({
    generatedAt: new Date(now).toISOString(),
    marine: [], radar: [], grid: null, airQuality: [], aurora: null, tides: [], bathingAlerts: [],
    warnings: [], warningsStatus: "partial",
    satellite: null, earthquakes: [], issTle: null,
    forecast: {
      // The client validates the issued stamp against the real clock.
      issued: new Date(Date.now() - 60 * 60_000).toISOString(),
      region: "Mostly cloudy with scattered showers.",
      today: "", tonight: "", tomorrow: "", outlook: ""
    },
    contextStatus: {
      marine: "partial", radar: "unavailable", grid: "unavailable", measuredAir: "unavailable",
      modelledAir: "unavailable", aurora: "unavailable", tides: "stale", bathing: "live",
      satellite: "unavailable", earthquakes: "unavailable", iss: "unavailable", warnings: "partial"
    }
  });
  try {
    const refreshed = await refreshCurrentContexts(previous);
    assert.equal(refreshed.contextStatus.warnings, "partial");
    assert.equal(refreshed.contextStatus.forecast, "live");
    assert.equal(refreshed.forecast?.region, "Mostly cloudy with scattered showers.");
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.window = originalWindow;
  }
});
