import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

import {
  isIrelandCoordinate,
  latestEirGridValue,
  normalizeBathingAlerts,
  normalizeOfficialNotices,
  normalizeOfficialWeatherWarnings,
  normalizeRiverReadings,
  parseEirGridLocalTimestamp,
  parseIrelandLocalTimestamp
} from "../platform/river-source.js";

const importStandaloneTypeScript = async (relativePath) => {
  const source = await readFile(new URL(relativePath, import.meta.url), "utf8");
  const output = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.ESNext }
  }).outputText;
  return import(`data:text/javascript,${encodeURIComponent(output)}`);
};

const importWarningAdapter = async (relativePath) => {
  const source = await readFile(new URL(relativePath, import.meta.url), "utf8");
  const latestSource = await readFile(new URL("../lib/latest-observations.ts", import.meta.url), "utf8");
  const latestOutput = ts.transpileModule(latestSource, {
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.ESNext }
  }).outputText;
  const weatherSource = await readFile(new URL("../lib/weather-stations.ts", import.meta.url), "utf8");
  const weatherOutput = ts.transpileModule(weatherSource, {
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.ESNext }
  }).outputText;
  const weatherUrl = `data:text/javascript,${encodeURIComponent(weatherOutput)}`;
  const latestUrl = `data:text/javascript,${encodeURIComponent(latestOutput.replace('"./weather-stations"', JSON.stringify(weatherUrl)))}`;
  const platformUrl = new URL("../platform/river-source.js", import.meta.url).href;
  const satelliteUrl = new URL("../node_modules/satellite.js/lib/index.js", import.meta.url).href;
  const output = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.ESNext }
  }).outputText
    .replace('"./latest-observations"', JSON.stringify(latestUrl))
    .replace('"./weather-stations"', JSON.stringify(weatherUrl))
    .replace('"../platform/river-source.js"', JSON.stringify(platformUrl))
    .replace('"satellite.js"', JSON.stringify(satelliteUrl));
  return import(`data:text/javascript,${encodeURIComponent(output)}`);
};

test("the static page starts with a truthful empty shell", async () => {
  const { createInitialSnapshot } = await importStandaloneTypeScript("../lib/initial-snapshot.ts");
  const snapshot = createInitialSnapshot("2026-08-03T09:00:00.000Z");

  assert.equal(snapshot.generatedAt, "2026-08-03T09:00:00.000Z");
  assert.equal(snapshot.sourceStatus, "fallback");
  assert.deepEqual(snapshot.stations, []);
  assert.deepEqual(snapshot.radar, []);
  assert.equal(snapshot.grid, null);
  assert.equal(snapshot.summary.reporting, 0);
  assert.ok(Object.values(snapshot.contextStatus).every((status) => status === "unavailable"));
});

test("Met Éireann station definitions use canonical endpoints and reject mismatched identities", async () => {
  const weather = await importStandaloneTypeScript("../lib/weather-stations.ts");
  const dublin = weather.WEATHER_STATIONS.find((station) => station.name === "Dublin");
  const cork = weather.WEATHER_STATIONS.find((station) => station.name === "Cork");

  assert.equal(dublin.endpoint, "dublin");
  assert.equal(dublin.csvName, "Dublin");
  assert.equal(cork.endpoint, "cork");
  assert.equal(cork.csvName, "Cork");
  assert.equal(weather.matchesWeatherStationIdentity(dublin, "Dublin Airport"), true);
  assert.equal(weather.matchesWeatherStationIdentity(cork, "Dublin Airport"), false);
  assert.equal(weather.matchesWeatherStationIdentity(cork, "Cork"), true);
});

test("weather freshness follows the provider's hourly cadence", async () => {
  const weather = await importStandaloneTypeScript("../lib/weather-stations.ts");
  const now = Date.parse("2026-08-03T09:50:00.000Z");

  assert.equal(weather.isWeatherObservationFresh("2026-08-03T09:00:00.000Z", now), true);
  assert.equal(weather.isWeatherObservationFresh("2026-08-03T06:50:00.000Z", now), false);
  assert.equal(weather.isWeatherObservationFresh("2026-08-03T10:00:00.000Z", now), false);
});

test("tide query windows remain stable inside a cache bucket", async () => {
  const { tideQueryWindow } = await import("../platform/server-entry.js");
  const first = Date.parse("2026-08-03T09:01:01.000Z");
  const second = Date.parse("2026-08-03T09:14:59.000Z");
  const nextBucket = Date.parse("2026-08-03T09:15:00.000Z");

  assert.deepEqual(tideQueryWindow(first), tideQueryWindow(second));
  assert.notDeepEqual(tideQueryWindow(first), tideQueryWindow(nextBucket));
  assert.deepEqual(tideQueryWindow(first), {
    since: "2026-08-02T09:00:00Z",
    until: "2026-08-04T21:00:00Z"
  });
});

test("tide trend uses the recent 30-minute movement instead of only the latest pair", async () => {
  const { classifyTideTrend } = await import("../platform/server-entry.js");
  const sample = (minutes, waterLevel) => ({
    observedAt: new Date(Date.parse("2026-08-04T12:00:00.000Z") + minutes * 60_000).toISOString(),
    waterLevel
  });

  assert.equal(classifyTideTrend([
    sample(0, 1.52),
    sample(10, 1.48),
    sample(20, 1.45),
    sample(30, 1.45)
  ]), "falling");
  assert.equal(classifyTideTrend([
    sample(0, 1.20),
    sample(10, 1.23),
    sample(20, 1.26),
    sample(30, 1.26)
  ]), "rising");
  assert.equal(classifyTideTrend([
    sample(0, 1.200),
    sample(10, 1.204),
    sample(20, 1.198),
    sample(30, 1.202)
  ]), "steady");
});

test("tide trend ignores readings outside its recent window and requires three valid samples", async () => {
  const { classifyTideTrend } = await import("../platform/server-entry.js");
  const sample = (minutes, waterLevel) => ({
    observedAt: new Date(Date.parse("2026-08-04T12:00:00.000Z") + minutes * 60_000).toISOString(),
    waterLevel
  });

  assert.equal(classifyTideTrend([
    sample(0, 1.60),
    sample(30, 1.40),
    sample(40, 1.40),
    sample(50, 1.40),
    sample(60, 1.40)
  ]), "steady");
  assert.equal(classifyTideTrend([
    sample(0, 1.20),
    { observedAt: "invalid", waterLevel: 1.30 },
    sample(10, null)
  ]), "unknown");
});

test("official notice normalization excludes future and expired windows at an injected time", () => {
  const now = Date.parse("2026-08-02T12:00:00.000Z");
  const notices = normalizeOfficialNotices([
    { id: "future", onset: "2026-08-02T13:00:00Z", expiry: "2026-08-03T00:00:00Z" },
    { id: "current", onset: "2026-08-02T11:00:00Z", expiry: "2026-08-03T00:00:00Z" },
    { id: "expired", onset: "2026-08-01T00:00:00Z", expiry: "2026-08-02T11:59:59Z" }
  ], now);

  assert.deepEqual(notices.map((notice) => notice.id), ["current"]);
});

test("all warning adapters preserve Met Éireann metadata and decode entities", async () => {
  const now = Date.parse("2026-08-03T09:00:00.000Z");
  const raw = [{
    id: 7,
    capId: "cap-rain-1",
    type: "yellow; Moderate",
    severity: "Moderate",
    certainty: "Likely",
    regions: ["EI27", "EI30"],
    status: "Warning",
    issued: "2026-08-03T08:00:00+01:00",
    updated: "2026-08-03T08:30:00+01:00",
    level: "Yellow",
    headline: "Rain warning for Waterford, Wexford &amp; Wicklow",
    description: "Heavy rain &amp; difficult travel",
    onset: "2026-08-03T10:00:00+01:00",
    expiry: "2026-08-03T18:00:00+01:00"
  }];
  const shared = normalizeOfficialWeatherWarnings(raw, now);
  const server = (await import("../platform/server-entry.js")).normalizeWeatherWarnings(raw, now);
  const build = (await importWarningAdapter("../lib/live-data.ts")).normalizeWeatherWarnings(raw, now);
  const browser = (await importWarningAdapter("../lib/browser-live.ts")).normalizeBrowserWarnings(raw, now);
  for (const adapter of [shared, server, build, browser]) {
    assert.equal(adapter.length, 1);
    assert.equal(adapter[0].id, "7");
    assert.equal(adapter[0].capId, "cap-rain-1");
    assert.equal(adapter[0].type, "yellow; Moderate");
    assert.equal(adapter[0].severity, "Moderate");
    assert.equal(adapter[0].certainty, "Likely");
    assert.deepEqual(adapter[0].regions, ["EI27", "EI30"]);
    assert.equal(adapter[0].status, "Warning");
    assert.equal(adapter[0].headline, "Rain warning for Waterford, Wexford & Wicklow");
    assert.equal(adapter[0].description, "Heavy rain & difficult travel");
    assert.equal(adapter[0].issued, "2026-08-03T07:00:00.000Z");
    assert.equal(adapter[0].updated, "2026-08-03T07:30:00.000Z");
    assert.equal(adapter[0].onset, "2026-08-03T09:00:00.000Z");
    assert.equal(adapter[0].expiry, "2026-08-03T17:00:00.000Z");
  }
});

test("bathing-alert normalization excludes future and ended incidents", () => {
  const now = Date.parse("2026-08-02T12:00:00.000Z");
  const alerts = normalizeBathingAlerts([
    { id: "future", incident_start_date: "2026-08-02T13:00:00Z", incident_end_date: null },
    { id: "current", incident_start_date: "2026-08-02T11:00:00Z", incident_end_date: "2026-08-03T00:00:00Z" },
    { id: "expired", incident_start_date: "2026-08-01T00:00:00Z", incident_end_date: "2026-08-02T11:59:59Z" },
    { id: "expected-expired", incident_start_date: "2026-07-31T00:00:00Z", incident_expected_duration: 1 }
  ], now);

  assert.deepEqual(alerts.map((alert) => alert.id), ["current"]);
});

test("Met Éireann and EirGrid local timestamps use Europe/Dublin deterministically", () => {
  assert.equal(parseIrelandLocalTimestamp("02-08-2026", "12:00"), "2026-08-02T11:00:00.000Z");
  assert.equal(parseIrelandLocalTimestamp("02-01-2026", "12:00"), "2026-01-02T12:00:00.000Z");
  assert.equal(parseEirGridLocalTimestamp("02-Aug-2026 12:00:00"), "2026-08-02T11:00:00.000Z");
  assert.equal(parseEirGridLocalTimestamp("02-Jan-2026 12:00:00"), "2026-01-02T12:00:00.000Z");
  assert.equal(parseIrelandLocalTimestamp("31-02-2026", "12:00"), null);
});

test("EirGrid selection keeps only the newest current value", () => {
  const now = Date.parse("2026-08-02T12:00:00.000Z");
  const rows = [
    { FieldName: "SYSTEM_DEMAND", EffectiveTime: "02-Aug-2026 05:00:00", Value: "4100" },
    { FieldName: "SYSTEM_DEMAND", EffectiveTime: "02-Aug-2026 11:00:00", Value: "4200" },
    { FieldName: "SYSTEM_DEMAND", EffectiveTime: "02-Aug-2026 13:30:00", Value: "4300" },
    { FieldName: "WIND_ACTUAL", EffectiveTime: "02-Aug-2026 11:00:00", Value: "900" }
  ];

  assert.deepEqual(latestEirGridValue(rows, "SYSTEM_DEMAND", now), {
    value: 4200,
    observedAt: "2026-08-02T10:00:00.000Z",
    timestamp: Date.parse("2026-08-02T10:00:00.000Z")
  });
  assert.equal(latestEirGridValue(rows.slice(0, 1), "SYSTEM_DEMAND", now), null);
});

test("Met Éireann CSV fallback does not invent fetch-time freshness", async () => {
  const source = await readFile(new URL("../lib/latest-observations.ts", import.meta.url), "utf8");
  let output = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.ESNext }
  }).outputText;
  const weatherSource = await readFile(new URL("../lib/weather-stations.ts", import.meta.url), "utf8");
  const weatherOutput = ts.transpileModule(weatherSource, {
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.ESNext }
  }).outputText;
  const weatherUrl = `data:text/javascript,${encodeURIComponent(weatherOutput)}`;
  output = output.replace('"./weather-stations"', JSON.stringify(weatherUrl));
  const observations = await import(`data:text/javascript,${encodeURIComponent(output)}`);
  const [reading] = observations.parseLatestObservations(
    "Name,Temperature,Description,Wind,Unused,Direction,Unused,Rain,Unused\nStation,12,Clear,10,,N,,1,",
    [{ id: "test", name: "Test", csvName: "Station", latitude: 53.3, longitude: -7.2 }]
  );

  assert.equal(reading.observedAt, null);
  assert.equal(reading.fresh, false);
});

test("river normalization rejects malformed and out-of-Ireland coordinates before deduplication", () => {
  const now = Date.parse("2026-08-02T12:00:00.000Z");
  const readings = normalizeRiverReadings([
    { id: "valid", name: "Valid", latitude: 53.3, longitude: -7.2, level: 1.2, observedAt: "2026-08-02T11:30:00Z" },
    { id: "outside-north", latitude: 56, longitude: -7.2, level: 1.2, observedAt: "2026-08-02T11:30:00Z" },
    { id: "outside-west", latitude: 53.3, longitude: -12, level: 1.2, observedAt: "2026-08-02T11:30:00Z" },
    { id: "malformed", latitude: "", longitude: null, level: 1.2, observedAt: "2026-08-02T11:30:00Z" },
    { id: "future", latitude: 53.3, longitude: -7.2, level: 2.2, observedAt: "2026-08-02T13:00:00Z" }
  ], now);

  assert.equal(isIrelandCoordinate(53.3, -7.2), true);
  assert.equal(isIrelandCoordinate(56, -7.2), false);
  assert.equal(isIrelandCoordinate("", -7.2), false);
  assert.deepEqual(readings.map((reading) => reading.id), ["valid"]);
});

test("out-of-order transit positions never produce a calculated speed", async () => {
  const { addEstimatedSpeeds } = await import("../platform/cloudflare-entry.js");
  const previous = [{
    id: "vehicle",
    latitude: 53.3,
    longitude: -7.2,
    observedAt: "2026-08-02T12:05:00.000Z",
    speedKmh: null,
    speedSource: null
  }];
  const [vehicle] = addEstimatedSpeeds([{
    ...previous[0],
    latitude: 53.31,
    observedAt: "2026-08-02T12:00:00.000Z"
  }], previous);

  assert.equal(vehicle.speedKmh, null);
  assert.equal(vehicle.speedSource, null);
});

test("failed NTA refresh cannot reuse an expired live snapshot", async () => {
  const { NtaFeedCoordinator } = await import("../platform/cloudflare-entry.js");
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response("upstream unavailable", { status: 503 });
  try {
    const stored = new Map([
      ["snapshot", {
        expiresAt: Date.now() - 1,
        result: {
          status: "live",
          vehicles: [{
            id: "old-vehicle",
            latitude: 53.3,
            longitude: -7.2,
            route: "15",
            label: "15",
            bearing: 180,
            speedKmh: null,
            observedAt: "2026-08-02T11:59:00.000Z"
          }]
        }
      }],
      ["nextAllowedAt", Date.now() - 1]
    ]);
    const coordinator = new NtaFeedCoordinator({
      storage: {
        get: async (key) => stored.get(key),
        put: async (key, value) => stored.set(key, value)
      }
    }, { NTA_API_KEY: "test-key" });

    const response = await coordinator.fetch();
    const body = await response.json();
    assert.equal(body.transitStatus, "unavailable");
    assert.deepEqual(body.transit, []);
    assert.equal(response.headers.get("cache-control"), "no-store");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("an empty NTA feed is unavailable and is not cached as live", async () => {
  const { fetchTransit } = await import("../platform/server-entry.js");
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ entity: [] }), {
    status: 200,
    headers: { "content-type": "application/json" }
  });
  try {
    const result = await fetchTransit({ NTA_API_KEY: "test-key" });
    assert.deepEqual(result, { vehicles: [], status: "unavailable" });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("an explicit transit upstream failure returns an uncacheable unavailable response", async () => {
  const api = await import("../platform/server-entry.js");
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response("upstream unavailable", { status: 503 });
  try {
    const response = await api.default.fetch(
      new Request("https://day.illek.ie/api/transit"),
      { NTA_API_KEY: "test-key" }
    );
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(body.transitStatus, "unavailable");
    assert.deepEqual(body.transit, []);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("concurrent NTA coordinator requests share one upstream refresh", async () => {
  const { NtaFeedCoordinator } = await import("../platform/cloudflare-entry.js");
  const originalFetch = globalThis.fetch;
  let upstreamCalls = 0;
  globalThis.fetch = async () => {
    upstreamCalls += 1;
    await new Promise((resolve) => setTimeout(resolve, 20));
    return new Response(JSON.stringify({
      entity: [{
        id: "vehicle-1",
        vehicle: {
          vehicle: { id: "vehicle-1", label: "15" },
          trip: { routeId: "15" },
          position: { latitude: 53.3, longitude: -7.2 },
          timestamp: Math.floor(Date.now() / 1000)
        }
      }]
    }), { headers: { "content-type": "application/json" } });
  };
  try {
    const stored = new Map();
    const coordinator = new NtaFeedCoordinator({
      storage: {
        get: async (key) => {
          await new Promise((resolve) => setTimeout(resolve, 5));
          return stored.get(key);
        },
        put: async (key, value) => stored.set(key, value)
      }
    }, { NTA_API_KEY: "test-key" });

    const responses = await Promise.all([coordinator.fetch(), coordinator.fetch()]);
    const bodies = await Promise.all(responses.map((response) => response.json()));
    assert.equal(upstreamCalls, 1);
    assert.deepEqual(bodies.map((body) => body.transitStatus), ["live", "live"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("concurrent river coordinator requests share one refresh", async () => {
  const { RiverFeedCoordinator } = await import("../platform/cloudflare-entry.js");
  const stored = new Map();
  const coordinator = new RiverFeedCoordinator({
    storage: {
      get: async (key) => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        return stored.get(key);
      },
      put: async (key, value) => stored.set(key, value)
    }
  }, {});
  let refreshes = 0;
  coordinator.refresh = async () => {
    refreshes += 1;
    await new Promise((resolve) => setTimeout(resolve, 20));
    return {
      rivers: [{ id: "river", name: "River", latitude: 53, longitude: -8, level: 1, observedAt: new Date().toISOString(), fresh: true }],
      status: "live",
      provenance: { provider: "OPW", endpoint: "", status: "live", fetchedAt: new Date().toISOString(), latestObservedAt: new Date().toISOString(), fallback: null }
    };
  };

  const responses = await Promise.all([coordinator.fetch(), coordinator.fetch()]);
  assert.equal(refreshes, 1);
  assert.deepEqual(await Promise.all(responses.map(async (response) => (await response.json()).status)), ["live", "live"]);
});

test("edge worker does not replay a cached live transit response over a provider failure", async () => {
  const worker = (await import("../platform/cloudflare-entry.js")).default;
  let calls = 0;
  const env = {
    NTA_FEED: {
      getByName: () => ({
        fetch: async () => {
          calls += 1;
          return Response.json(calls === 1
            ? { transit: [{ id: "live" }], transitStatus: "live" }
            : { transit: [], transitStatus: "unavailable" }, {
              headers: { "cache-control": calls === 1 ? "public, max-age=60" : "no-store" }
            });
        }
      })
    }
  };

  const first = await worker.fetch(new Request("https://day.illek.ie/api/transit"), env);
  const second = await worker.fetch(new Request("https://day.illek.ie/api/transit"), env);
  assert.equal((await first.json()).transitStatus, "live");
  assert.equal((await second.json()).transitStatus, "unavailable");
  assert.equal(calls, 2);
});

test("partial context responses are uncacheable", async () => {
  const api = await import("../platform/server-entry.js");
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response("upstream unavailable", { status: 503 });
  try {
    const response = await api.default.fetch(
      new Request("https://day.illek.ie/api/contexts"),
      { EDGE_RUNTIME: "cloudflare" }
    );
    const body = await response.json();
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(body.contextStatus.marine, "unavailable");
    assert.equal(body.contextStatus.warnings, "unavailable");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("transit feed rejects old provider positions instead of calling them live", async () => {
  const { fetchTransit } = await import("../platform/server-entry.js");
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json({
    entity: [{
      id: "old-vehicle",
      vehicle: {
        vehicle: { id: "old-vehicle" },
        position: { latitude: 53.3, longitude: -7.2 },
        timestamp: Math.floor((Date.now() - 31 * 60_000) / 1000)
      }
    }]
  });
  try {
    assert.deepEqual(await fetchTransit({ NTA_API_KEY: "test-key" }), {
      vehicles: [],
      status: "unavailable"
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("shared view state round-trips constrained map pan coordinates", async () => {
  const source = await readFile(new URL("../lib/view-state.ts", import.meta.url), "utf8");
  const output = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.ESNext }
  }).outputText;
  const viewState = await import(`data:text/javascript,${encodeURIComponent(output)}`);
  const url = viewState.serializeViewState("https://day.illek.ie/?ignored=1", {
    placeId: "cork",
    view: "custom",
    layers: ["transit", "weather"],
    zoom: 2,
    panX: -320,
    panY: -180
  });
  const parsed = viewState.parseViewState(new URL(url).search, ["island", "cork"]);

  assert.deepEqual(parsed, {
    placeId: "cork",
    view: "custom",
    layers: ["weather", "transit"],
    zoom: 2,
    panX: -320,
    panY: -180
  });
  assert.equal(new URL(url).searchParams.has("ignored"), false);
});
