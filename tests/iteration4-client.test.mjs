import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const importStandaloneTypeScript = async (relativePath) => {
  const source = await readFile(new URL(relativePath, import.meta.url), "utf8");
  const output = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.ESNext }
  }).outputText;
  return import(`data:text/javascript,${encodeURIComponent(output)}`);
};

const importBrowserLive = async () => {
  const source = await readFile(new URL("../lib/browser-live.ts", import.meta.url), "utf8");
  const latestSource = await readFile(new URL("../lib/latest-observations.ts", import.meta.url), "utf8");
  const latestOutput = ts.transpileModule(latestSource, {
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.ESNext }
  }).outputText;
  const weatherUrl = new URL("../platform/weather-stations.js", import.meta.url).href;
  const latestUrl = `data:text/javascript,${encodeURIComponent(latestOutput.replace('"./weather-stations"', JSON.stringify(weatherUrl)))}`;
  const platformUrl = new URL("../platform/river-source.js", import.meta.url).href;
  const liveNormalizeUrl = new URL("../platform/live-normalize.js", import.meta.url).href;
  const skySourceUrl = new URL("../platform/sky-source.js", import.meta.url).href;
  const satelliteUrl = new URL("../node_modules/satellite.js/lib/index.js", import.meta.url).href;
  const timelineUrl = new URL("../lib/weather-timeline.js", import.meta.url).href;
  const output = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.ESNext }
  }).outputText
    .replace('"./latest-observations"', JSON.stringify(latestUrl))
    .replace('"./weather-stations"', JSON.stringify(weatherUrl))
    .replace('"./weather-timeline.js"', JSON.stringify(timelineUrl))
    .replace('"../platform/river-source.js"', JSON.stringify(platformUrl))
    .replace('"../platform/live-normalize.js"', JSON.stringify(liveNormalizeUrl))
    .replace('"../platform/sky-source.js"', JSON.stringify(skySourceUrl))
    .replace('"satellite.js"', JSON.stringify(satelliteUrl));
  return import(`data:text/javascript,${encodeURIComponent(output)}`);
};

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
