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

const importDataStateAdapter = async () => {
  const source = await readFile(new URL("../lib/data-state.ts", import.meta.url), "utf8");
  const weatherUrl = new URL("../platform/weather-stations.js", import.meta.url).href;
  const output = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.ESNext }
  }).outputText.replace('"./weather-stations"', JSON.stringify(weatherUrl));
  return import(`data:text/javascript,${encodeURIComponent(output)}`);
};

const exerciseSatelliteContextCoalescing = async ({ sharedSucceeds }) => {
  const moduleUrl = new URL("../platform/server-entry.js", import.meta.url);
  moduleUrl.searchParams.set("satellite-race", sharedSucceeds ? "newer-success" : "newer-failure");
  const api = await import(moduleUrl.href);
  const originalFetch = globalThis.fetch;
  const advertisedDate = new Date(Date.now() - 24 * 60 * 60_000).toISOString().slice(0, 10);
  const tileResolvers = [];
  let tileRequests = 0;
  globalThis.fetch = async (input) => {
    const url = typeof input === "string"
      ? input
      : input instanceof URL
        ? input.href
        : input.url;
    if (url.endsWith("/all/all.xml")) {
      return new Response(`<Domain>2026-01-01/${advertisedDate}/P1D</Domain>`);
    }
    if (url.includes("gibs.earthdata.nasa.gov") && url.endsWith(".jpeg")) {
      tileRequests += 1;
      if (tileRequests <= 2) {
        return new Promise((resolve) => tileResolvers.push(resolve));
      }
      return new Response(null, { status: 503 });
    }
    return new Response("upstream unavailable", { status: 503 });
  };

  const waitForTileBatches = async (count) => {
    for (let attempt = 0; attempt < 100 && tileResolvers.length < count; attempt += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    assert.equal(tileResolvers.length, count, `expected ${count} controlled satellite tile requests`);
  };
  const settle = async () => {
    for (let attempt = 0; attempt < 25; attempt += 1) await new Promise((resolve) => setImmediate(resolve));
  };
  const satelliteTile = () => new Response(null, {
    status: 200,
    headers: {
      "content-type": "image/jpeg",
      "layer-time-actual": `${advertisedDate}T00:00:00Z`
    }
  });
  const failedTile = () => new Response(null, { status: 503 });

  try {
    const firstResponse = api.default.fetch(
      new Request("https://day.illek.ie/api/contexts"),
      { EDGE_RUNTIME: "cloudflare" }
    );
    await waitForTileBatches(2);
    // A second cold request arriving while discovery is in flight must
    // share that refresh instead of duplicating its upstream probes.
    const secondResponse = api.default.fetch(
      new Request("https://day.illek.ie/api/contexts"),
      { EDGE_RUNTIME: "cloudflare" }
    );
    await settle();
    assert.equal(tileRequests, 2, "concurrent contexts must not duplicate satellite probes");

    tileResolvers.forEach((resolve) => resolve(sharedSucceeds ? satelliteTile() : failedTile()));
    const firstBody = await (await firstResponse).json();
    const secondBody = await (await secondResponse).json();
    const tileRequestsBeforeThirdContext = tileRequests;
    const thirdBody = await (await api.default.fetch(
      new Request("https://day.illek.ie/api/contexts"),
      { EDGE_RUNTIME: "cloudflare" }
    )).json();

    return { advertisedDate, firstBody, secondBody, thirdBody, tileRequests, tileRequestsBeforeThirdContext };
  } finally {
    globalThis.fetch = originalFetch;
  }
};

test("the static page starts with a truthful empty shell", async () => {
  const { createInitialSnapshot } = await importStandaloneTypeScript("../lib/initial-snapshot.ts");
  const snapshot = createInitialSnapshot("2026-08-03T09:00:00.000Z");

  assert.equal(snapshot.generatedAt, "2026-08-03T09:00:00.000Z");
  assert.equal(snapshot.sourceStatus, "fallback");
  assert.deepEqual(snapshot.stations, []);
  assert.deepEqual(snapshot.radar, []);
  assert.equal(snapshot.grid, null);
  assert.equal(snapshot.summary.reporting, null);
  assert.equal(snapshot.summary.runningTrains, null);
  assert.equal(snapshot.summary.riverStations, null);
  assert.ok(Object.values(snapshot.contextStatus).every((status) => status === "unavailable"));
});

test("service display states keep connecting, refreshing, offline, cached, stale, and unavailable distinct", async () => {
  const { createInitialSnapshot } = await importStandaloneTypeScript("../lib/initial-snapshot.ts");
  const { getServiceDisplayState } = await importDataStateAdapter();
  const now = Date.parse("2026-08-04T12:00:00.000Z");
  const empty = createInitialSnapshot(new Date(now).toISOString());

  assert.equal(getServiceDisplayState(empty, { initialRefreshComplete: false, refreshing: true, online: true, now }), "connecting");
  assert.equal(getServiceDisplayState(empty, { initialRefreshComplete: true, refreshing: false, online: true, now }), "unavailable");
  assert.equal(getServiceDisplayState(empty, { initialRefreshComplete: true, refreshing: true, online: true, now }), "refreshing");
  assert.equal(getServiceDisplayState(empty, { initialRefreshComplete: false, refreshing: true, online: false, now }), "offline");

  const observation = {
    id: "station", name: "Station", latitude: 53.3, longitude: -7.2,
    temperature: 14, rainfall: 0, windSpeed: 8, windDirection: "W", description: "Dry",
    observedAt: new Date(now - 4 * 60 * 60_000).toISOString(), fresh: true
  };
  const stale = { ...empty, sourceStatus: "live", stations: [observation], summary: { ...empty.summary, reporting: 1 } };
  assert.equal(getServiceDisplayState(stale, { initialRefreshComplete: true, refreshing: false, online: true, now }), "stale");
  assert.equal(getServiceDisplayState({ ...stale, sourceStatus: "stale" }, { initialRefreshComplete: true, refreshing: false, online: true, now }), "cached");

  const liveCore = {
    ...empty,
    sourceStatus: "live",
    stations: [{ ...observation, observedAt: new Date(now - 60_000).toISOString() }],
    summary: { ...empty.summary, reporting: 1 },
    sourceProvenance: {
      trains: { ...empty.sourceProvenance.trains, status: "live" },
      rivers: { ...empty.sourceProvenance.rivers, status: "live" }
    },
    transitStatus: "credential-required",
    contextStatus: Object.fromEntries(
      Object.keys(empty.contextStatus).map((name) => [name, name === "satellite" ? "fallback" : "live"])
    )
  };
  assert.equal(getServiceDisplayState(liveCore, { initialRefreshComplete: true, refreshing: false, online: true, now }), "live");

  const mixedHealthy = {
    ...liveCore,
    sourceStatus: "partial",
    sourceProvenance: {
      trains: { ...liveCore.sourceProvenance.trains, status: "unavailable" },
      rivers: { ...liveCore.sourceProvenance.rivers, status: "fallback", fallback: "Cloudflare Browser Run" }
    },
    contextStatus: Object.fromEntries(
      Object.keys(empty.contextStatus).map((name) => [name, name === "warnings" ? "live" : "unavailable"])
    )
  };
  assert.equal(getServiceDisplayState(mixedHealthy, { initialRefreshComplete: true, refreshing: false, online: true, now }), "live");
});

test("selected-source assessment never reassures when a chosen provider is unavailable or cached", async () => {
  const { createInitialSnapshot } = await importStandaloneTypeScript("../lib/initial-snapshot.ts");
  const { getSelectedSourceAssessment } = await importDataStateAdapter();
  const now = Date.parse("2026-08-04T12:00:00.000Z");
  const empty = createInitialSnapshot(new Date(now).toISOString());
  const unavailable = getSelectedSourceAssessment(empty, new Set(["weather", "warnings", "trains"]), now);

  assert.equal(unavailable.assessedSourceCount, 3);
  assert.equal(unavailable.fullyAssessed, false);
  assert.deepEqual(unavailable.unavailableSources, ["weather observations", "official notices", "rail positions"]);

  const authoritativeEmpty = {
    ...empty,
    contextStatus: { ...empty.contextStatus, warnings: "live", bathing: "live", earthquakes: "live" }
  };
  const assessed = getSelectedSourceAssessment(authoritativeEmpty, new Set(["warnings", "bathing", "earthquakes"]), now);
  assert.equal(assessed.fullyAssessed, true);
  assert.deepEqual(assessed.unavailableSources, []);

  const cached = {
    ...empty,
    contextStatus: { ...empty.contextStatus, warnings: "stale" }
  };
  assert.equal(getSelectedSourceAssessment(cached, new Set(["warnings"]), now).fullyAssessed, false);
});

test("last-good retention is age bounded and is always relabelled cached rather than live", async () => {
  const { createInitialSnapshot } = await importStandaloneTypeScript("../lib/initial-snapshot.ts");
  const {
    retainLastGoodContexts,
    retainLastGoodLiving,
    retainLastGoodTransit,
    retainLastGoodWeather
  } = await importWarningAdapter("../lib/browser-live.ts");
  const now = Date.parse("2026-08-04T12:00:00.000Z");
  const observedAt = new Date(now - 5 * 60_000).toISOString();
  const empty = createInitialSnapshot(new Date(now).toISOString());
  const station = {
    id: "station", name: "Station", latitude: 53.3, longitude: -7.2,
    temperature: 14, rainfall: 0, windSpeed: 8, windDirection: "W", description: "Dry",
    observedAt, fresh: true
  };
  const train = {
    id: "train", latitude: 53.3, longitude: -7.2, status: "running", direction: "South",
    message: "", observedAt, speedKmh: null, speedSource: null
  };
  const river = { id: "river", name: "River", latitude: 53.3, longitude: -7.2, level: 1.2, observedAt, fresh: true };
  const transit = {
    id: "bus", latitude: 53.3, longitude: -7.2, route: "1", label: "Bus", bearing: null,
    speedKmh: null, speedSource: null, observedAt
  };
  const previous = {
    ...empty,
    lastSuccessAt: observedAt,
    sourceStatus: "live",
    stations: [station],
    trains: [train],
    rivers: [river],
    transit: [transit],
    transitStatus: "live",
    grid: {
      observedAt, demandMW: 1000, generationMW: 1000, windMW: 300, windSharePercent: 30,
      carbonIntensity: 200, carbonEmissions: 100, frequencyHz: 50, interconnectorMW: 0
    },
    sourceProvenance: {
      trains: { provider: "Irish Rail", endpoint: "", status: "live", fetchedAt: observedAt, latestObservedAt: observedAt, fallback: null },
      rivers: { provider: "OPW", endpoint: "", status: "live", fetchedAt: observedAt, latestObservedAt: observedAt, fallback: null }
    },
    contextStatus: { ...empty.contextStatus, grid: "live" },
    summary: { ...empty.summary, warmest: station, wettest: station, windiest: station, reporting: 1, runningTrains: 1, riverStations: 1 }
  };

  const weather = retainLastGoodWeather(previous, now);
  const living = retainLastGoodLiving(previous, now);
  const contexts = retainLastGoodContexts(previous, now);
  const retainedTransit = retainLastGoodTransit(previous, now);
  assert.equal(weather.sourceStatus, "stale");
  assert.equal(weather.summary.reporting, 1);
  assert.equal(living.sourceProvenance.trains.status, "stale");
  assert.equal(living.sourceProvenance.rivers.status, "stale");
  assert.equal(living.summary.runningTrains, 1);
  assert.equal(contexts.contextStatus.grid, "stale");
  assert.equal(contexts.grid.windSharePercent, 30);
  assert.equal(retainedTransit.transitStatus, "stale");
  assert.equal(weather.lastSuccessAt, observedAt);

  assert.equal(retainLastGoodWeather(previous, now + 7 * 60 * 60_000).sourceStatus, "unavailable");
  assert.deepEqual(retainLastGoodLiving(previous, now + 4 * 60 * 60_000).trains, []);
  assert.equal(retainLastGoodLiving(previous, now + 4 * 60 * 60_000).sourceProvenance.rivers.status, "unavailable");
  assert.equal(retainLastGoodContexts(previous, now + 31 * 60 * 60_000).contextStatus.grid, "unavailable");
  assert.equal(retainLastGoodTransit(previous, now + 31 * 60_000).transitStatus, "unavailable");
});

const bathingRefreshFixtureAlert = () => {
  const now = Date.now();
  return {
    id: "beach-retained",
    name: "Retained Beach",
    county: "Clare",
    latitude: 52.7,
    longitude: -9.2,
    restriction: "Advice not to swim",
    description: "Advisory issued earlier today",
    startedAt: new Date(now - 60 * 60_000).toISOString(),
    updatedAt: new Date(now - 60 * 60_000).toISOString(),
    endsAt: new Date(now + 24 * 60 * 60_000).toISOString(),
    noticeUrl: null
  };
};

const refreshContextsWithBathing = async ({ status, alerts, retainedAlert }) => {
  const { createInitialSnapshot } = await importStandaloneTypeScript("../lib/initial-snapshot.ts");
  const { refreshCurrentContexts } = await importWarningAdapter("../lib/browser-live.ts");
  const now = Date.now();
  const previous = createInitialSnapshot(new Date(now).toISOString());
  previous.bathingAlerts = [retainedAlert ?? bathingRefreshFixtureAlert()];
  const originalFetch = globalThis.fetch;
  const originalWindow = globalThis.window;
  globalThis.window = {
    location: { hostname: "localhost" },
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout
  };
  globalThis.fetch = async () => Response.json({
    generatedAt: new Date(now).toISOString(),
    marine: [], radar: [], grid: null, airQuality: [], aurora: null, tides: [],
    bathingAlerts: alerts,
    warnings: [], warningsStatus: "unavailable", satellite: null, earthquakes: [], issTle: null,
    contextStatus: {
      marine: "unavailable", radar: "unavailable", grid: "unavailable", measuredAir: "unavailable",
      modelledAir: "unavailable", aurora: "unavailable", tides: "unavailable", bathing: status,
      satellite: "unavailable", earthquakes: "unavailable", iss: "unavailable", warnings: "unavailable"
    }
  });
  try {
    return await refreshCurrentContexts(previous);
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.window = originalWindow;
  }
};

test("a live all-clear drops retained bathing advisories instead of resurrecting them", async () => {
  const refreshed = await refreshContextsWithBathing({ status: "live", alerts: [] });
  assert.equal(refreshed.contextStatus.bathing, "live");
  assert.deepEqual(refreshed.bathingAlerts, []);
});

test("degraded bathing tiers keep previously seen advisories until the provider confirms removal", async () => {
  for (const status of ["partial", "stale", "fallback"]) {
    const retained = bathingRefreshFixtureAlert();
    const refreshed = await refreshContextsWithBathing({ status, alerts: [], retainedAlert: retained });
    assert.equal(refreshed.contextStatus.bathing, status);
    assert.deepEqual(refreshed.bathingAlerts, [retained], status);
  }
});

test("browser context refresh preserves partial/stale warnings truth and valid live-empty truth", async () => {
  const { createInitialSnapshot } = await importStandaloneTypeScript("../lib/initial-snapshot.ts");
  const { refreshCurrentContexts } = await importWarningAdapter("../lib/browser-live.ts");
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
    warnings: [], warningsStatus: "partial", satellite: null, earthquakes: [], issTle: null,
    contextStatus: {
      marine: "partial", radar: "unavailable", grid: "unavailable", measuredAir: "unavailable",
      modelledAir: "unavailable", aurora: "unavailable", tides: "stale", bathing: "live",
      satellite: "unavailable", earthquakes: "unavailable", iss: "unavailable", warnings: "partial"
    }
  });
  try {
    const refreshed = await refreshCurrentContexts(previous);
    assert.equal(refreshed.contextStatus.marine, "partial");
    assert.equal(refreshed.contextStatus.tides, "stale");
    assert.equal(refreshed.contextStatus.warnings, "partial");
    assert.equal(refreshed.contextStatus.bathing, "live");
    assert.deepEqual(refreshed.marine, []);
    assert.deepEqual(refreshed.tides, []);
    assert.deepEqual(refreshed.warnings, []);
    assert.deepEqual(refreshed.bathingAlerts, []);
    assert.ok(![refreshed.contextStatus.marine, refreshed.contextStatus.tides, refreshed.contextStatus.warnings]
      .includes("live"));
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.window = originalWindow;
  }
});

test("browser living refresh preserves partial river provenance instead of upgrading it to live", async () => {
  const { createInitialSnapshot } = await importStandaloneTypeScript("../lib/initial-snapshot.ts");
  const { refreshLivingLayers } = await importWarningAdapter("../lib/browser-live.ts");
  const now = Date.now();
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
    trains: [],
    rivers: [{
      id: "partial-river",
      name: "Partial river",
      latitude: 53.3,
      longitude: -8.2,
      level: 1.2,
      observedAt: new Date(now - 60_000).toISOString(),
      fresh: true
    }],
    sourceStatus: { trains: "unavailable", rivers: "partial" }
  });
  try {
    const refreshed = await refreshLivingLayers(previous);
    assert.deepEqual(refreshed.rivers.map((river) => river.id), ["partial-river"]);
    assert.equal(refreshed.sourceProvenance.rivers.status, "partial");
    assert.equal(refreshed.summary.riverStations, 1);
    assert.notEqual(refreshed.sourceProvenance.rivers.status, "live");
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.window = originalWindow;
  }
});

test("browser weather removes future station rows before latest selection and timeline aggregation", async () => {
  const { createInitialSnapshot } = await importStandaloneTypeScript("../lib/initial-snapshot.ts");
  const { refreshWeather } = await importWarningAdapter("../lib/browser-live.ts");
  const now = Date.now();
  const previous = createInitialSnapshot(new Date(now).toISOString());
  const originalFetch = globalThis.fetch;
  const originalWindow = globalThis.window;
  globalThis.window = {
    location: { hostname: "localhost" },
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout
  };
  const wall = (instant) => Object.fromEntries(new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Dublin", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23"
  }).formatToParts(new Date(instant)).map((part) => [part.type, part.value]));
  const current = wall(Math.floor(now / 3_600_000) * 3_600_000);
  const future = wall(Math.floor(now / 3_600_000) * 3_600_000 + 3_600_000);
  const rows = [
    { name: "Dublin Airport", date: `${future.day}-${future.month}-${future.year}`, reportTime: `${future.hour}:00`, temperature: 99, rainfall: 99, windSpeed: 99 },
    { name: "Dublin Airport", date: `${current.day}-${current.month}-${current.year}`, reportTime: `${current.hour}:00`, temperature: 12, rainfall: 1, windSpeed: 10 }
  ];
  globalThis.fetch = async (input) => String(input).includes("/observations/dublin/today")
    ? Response.json(rows)
    : new Response("unavailable", { status: 503 });
  try {
    const refreshed = await refreshWeather(previous);
    assert.equal(refreshed.stations[0].temperature, 12);
    assert.ok(Date.parse(refreshed.stations[0].observedAt) <= now);
    assert.doesNotMatch(JSON.stringify(refreshed.timeline), /99/);
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.window = originalWindow;
  }
});

test("browser weather resolves both autumn folds by capture time and rejects the spring gap", async () => {
  const { createInitialSnapshot } = await importStandaloneTypeScript("../lib/initial-snapshot.ts");
  const { refreshWeather } = await importWarningAdapter("../lib/browser-live.ts");
  const originalFetch = globalThis.fetch;
  const originalWindow = globalThis.window;
  const originalDateNow = Date.now;
  let providerRow;
  globalThis.window = {
    location: { hostname: "localhost" },
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout
  };
  globalThis.fetch = async (input) => String(input).includes("/observations/dublin/today")
    ? Response.json([providerRow])
    : new Response("unavailable", { status: 503 });
  const refreshAt = async (captureNow, date, reportTime) => {
    Date.now = () => captureNow;
    providerRow = {
      name: "Dublin Airport",
      date,
      reportTime,
      temperature: 12,
      rainfall: 0,
      windSpeed: 5,
      cardinalWindDirection: "W",
      weatherDescription: "Test"
    };
    return refreshWeather(createInitialSnapshot(new Date(captureNow).toISOString()));
  };
  try {
    const firstFold = await refreshAt(Date.parse("2026-10-25T01:00:00.000Z"), "25-10-2026", "01:30");
    assert.equal(firstFold.stations[0].observedAt, "2026-10-25T00:30:00.000Z");

    const secondFold = await refreshAt(Date.parse("2026-10-25T01:45:00.000Z"), "25-10-2026", "01:30");
    assert.equal(secondFold.stations[0].observedAt, "2026-10-25T01:30:00.000Z");

    const springGap = await refreshAt(Date.parse("2026-03-29T02:00:00.000Z"), "29-03-2026", "01:30");
    assert.deepEqual(springGap.stations, []);
  } finally {
    Date.now = originalDateNow;
    globalThis.fetch = originalFetch;
    globalThis.window = originalWindow;
  }
});

test("Met Éireann station definitions use canonical endpoints and reject mismatched identities", async () => {
  const weather = await import("../platform/weather-stations.js");
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
  const weather = await import("../platform/weather-stations.js");
  const now = Date.parse("2026-08-03T09:50:00.000Z");

  assert.equal(weather.isWeatherObservationFresh("2026-08-03T09:00:00.000Z", now), true);
  assert.equal(weather.isWeatherObservationFresh("2026-08-03T06:50:00.000Z", now), false);
  assert.equal(weather.isWeatherObservationFresh("2026-08-03T10:00:00.000Z", now), false);
});

test("history weather and marine ingest reuse the shared station and buoy modules", async () => {
  const historySource = await readFile(new URL("../platform/history-sources.js", import.meta.url), "utf8");
  const { WEATHER_STATIONS } = await import("../platform/weather-stations.js");
  assert.match(historySource, /from "\.\/weather-stations\.js"/);
  assert.match(historySource, /parseWeatherBuoyRows/);
  assert.match(historySource, /weatherBuoyQuery/);
  assert.equal(WEATHER_STATIONS.length, 9);
  assert.ok(WEATHER_STATIONS.every((station) => station.csvName));
});

test("Cloudflare and local living adapters share one payload builder", async () => {
  const { buildLivingPayload } = await import("../platform/river-source.js");
  const cloudflare = await readFile(new URL("../platform/cloudflare-entry.js", import.meta.url), "utf8");
  const server = await readFile(new URL("../platform/server-entry.js", import.meta.url), "utf8");
  assert.match(cloudflare, /buildLivingPayload\(/);
  assert.match(server, /buildLivingPayload\(/);
  const payload = buildLivingPayload({ trains: [], rivers: [], riverStatus: "unavailable" });
  assert.equal(payload.sourceStatus.trains, "unavailable");
  assert.equal(payload.sourceStatus.rivers, "unavailable");
  assert.equal(payload.sourceProvenance.trains.provider, "Irish Rail");
  assert.equal(payload.trains.length, 0);
});

test("radar no-data masking removes only the provider's grey sentinel pixels", async () => {
  const { maskRadarNoDataPixels } = await importStandaloneTypeScript("../lib/radar-tiles.ts");
  const pixels = new Uint8ClampedArray([
    229, 229, 229, 255,
    226, 228, 225, 180,
    0, 128, 194, 255,
    245, 245, 245, 255,
    0, 0, 0, 31
  ]);

  assert.equal(maskRadarNoDataPixels(pixels), 2);
  assert.deepEqual([...pixels], [
    229, 229, 229, 0,
    226, 228, 225, 0,
    0, 128, 194, 255,
    245, 245, 245, 255,
    0, 0, 0, 31
  ]);
  assert.throws(() => maskRadarNoDataPixels(new Uint8ClampedArray(3)), /RGBA/);
});

test("radar frame normalization keeps Met Éireann provenance and rejects malformed provider URLs", async () => {
  const { normalizeRadarFrames } = await import("../platform/server-entry.js");
  const frames = normalizeRadarFrames([
    { src: "202608041510", modifiedTime: 1785856549, server: "https://gdal.met.ie/" },
    { src: "not-a-frame", modifiedTime: 1, server: "https://gdal.met.ie" },
    { src: "202608041515", modifiedTime: 1785856804, server: "https://malicious.example" }
  ]);

  assert.deepEqual(frames, [{
    id: "202608041510",
    observedAt: "2026-08-04T15:10:00Z",
    modifiedTime: 1785856549,
    provider: "Met Éireann",
    tileTemplate: "https://gdal.met.ie/api/maps/radar/202608041510/{x}/{y}/{z}/1785856549"
  }]);
});

test("satellite discovery walks back from the advertised GIBS date until every Ireland tile is valid", async () => {
  const { findLatestSatelliteFrame } = await import("../platform/server-entry.js");
  const probes = [];
  const fetcher = async (url, init = {}) => {
    if (String(url).endsWith("/all/all.xml")) {
      return new Response("<Domain>2026-07-16/2026-08-03/P1D</Domain>");
    }
    probes.push({ url: String(url), method: init.method });
    const date = String(url).includes("/2026-08-02/") ? "2026-08-02" : null;
    return new Response(null, {
      status: date ? 200 : 404,
      headers: date ? {
        "content-type": "image/jpeg",
        "layer-time-actual": `${date}T00:00:00Z`
      } : { "content-type": "text/html" }
    });
  };

  const frame = await findLatestSatelliteFrame({
    now: Date.parse("2026-08-04T12:00:00Z"),
    fetcher,
    maximumLookbackDays: 3
  });

  assert.equal(frame.observedAt, "2026-08-02T00:00:00Z");
  assert.match(frame.label, /verified NASA archive/);
  assert.equal(
    frame.tileTemplate,
    "https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/VIIRS_SNPP_CorrectedReflectance_TrueColor/default/2026-08-02/GoogleMapsCompatible_Level9/{z}/{y}/{x}.jpeg"
  );
  assert.equal(probes.length, 4);
  assert.ok(probes.every((probe) => probe.method === "HEAD"));
  assert.ok(probes.some((probe) => probe.url.endsWith("/6/20/30.jpeg")));
  assert.ok(probes.some((probe) => probe.url.endsWith("/6/21/31.jpeg")));
});

test("satellite availability starts at today when the active GIBS range ends in the future", async () => {
  const { resolveSatelliteAvailability } = await import("../platform/server-entry.js");
  const availability = await resolveSatelliteAvailability({
    now: Date.parse("2026-08-04T12:00:00Z"),
    fetcher: async () => new Response(
      "<Domain>2015-11-24/2022-07-27/P1D,2026-07-16/2026-08-05/P1D</Domain>"
    )
  });

  assert.deepEqual(availability, {
    advertisedDate: "2026-08-04",
    startDate: "2026-08-04",
    cacheKey: "2026-08-04|2026-08-04"
  });
});

test("satellite discovery suppresses the layer when no recent Ireland tile is valid", async () => {
  const { findLatestSatelliteFrame } = await import("../platform/server-entry.js");
  const fetcher = async (url) => String(url).endsWith("/all/all.xml")
    ? new Response("<Domain>2026-08-03/2026-08-03/P1D</Domain>")
    : new Response(null, { status: 404, headers: { "content-type": "text/html" } });

  await assert.rejects(
    findLatestSatelliteFrame({
      now: Date.parse("2026-08-04T12:00:00Z"),
      fetcher,
      maximumLookbackDays: 2
    }),
    /no verified Ireland satellite frame/
  );
});

test("satellite discovery defaults to five lookback days and two Ireland tiles", async () => {
  const { findLatestSatelliteFrame } = await import("../platform/server-entry.js");
  const probes = [];
  const fetcher = async (url, init = {}) => {
    if (String(url).endsWith("/all/all.xml")) {
      return new Response("<Domain>2026-08-03/2026-08-03/P1D</Domain>");
    }
    probes.push({ url: String(url), method: init.method });
    return new Response(null, { status: 404, headers: { "content-type": "text/html" } });
  };

  await assert.rejects(
    findLatestSatelliteFrame({
      now: Date.parse("2026-08-04T12:00:00Z"),
      fetcher
    }),
    /no verified Ireland satellite frame/
  );

  assert.equal(probes.length, 12);
  assert.ok(probes.every((probe) => probe.method === "HEAD"));
  assert.equal(new Set(probes.map((probe) => probe.url.replace(/.*\/6\/(\d+)\/(\d+)\.jpeg$/, "$1/$2"))).size, 2);
});

test("an older failed satellite context cannot clear a newer successful cache publication", async () => {
  const { createSatelliteAvailabilityResolver } = await import("../platform/server-entry.js");
  const pending = [];
  const frame = {
    observedAt: "2026-08-03T00:00:00Z",
    label: "verified",
    tileTemplate: "https://example.test/{z}/{y}/{x}.jpeg"
  };
  const resolver = createSatelliteAvailabilityResolver({
    clock: () => Date.parse("2026-08-04T12:00:00Z"),
    resolveAvailability: async () => ({
      advertisedDate: "2026-08-03",
      startDate: "2026-08-03",
      cacheKey: "2026-08-04|2026-08-03"
    }),
    discoverFrame: () => new Promise((resolve, reject) => pending.push({ resolve, reject }))
  });

  const older = resolver();
  await new Promise((resolve) => setImmediate(resolve));
  const newer = resolver();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(pending.length, 2);

  pending[1].resolve(frame);
  assert.deepEqual(await newer, frame);
  pending[0].reject(new Error("older context failed"));
  await assert.rejects(older, /older context failed/);

  assert.deepEqual(await resolver(), frame);
  assert.equal(pending.length, 2, "the third context must reuse the newer successful publication");
});

test("an older successful satellite context cannot overwrite a newer failed cache publication", async () => {
  const { createSatelliteAvailabilityResolver } = await import("../platform/server-entry.js");
  const pending = [];
  const olderFrame = {
    observedAt: "2026-08-02T00:00:00Z",
    label: "older verified frame",
    tileTemplate: "https://example.test/{z}/{y}/{x}.jpeg"
  };
  const resolver = createSatelliteAvailabilityResolver({
    clock: () => Date.parse("2026-08-04T12:00:00Z"),
    resolveAvailability: async () => ({
      advertisedDate: "2026-08-03",
      startDate: "2026-08-03",
      cacheKey: "2026-08-04|2026-08-03"
    }),
    discoverFrame: () => new Promise((resolve, reject) => pending.push({ resolve, reject }))
  });

  const older = resolver();
  await new Promise((resolve) => setImmediate(resolve));
  const newer = resolver();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(pending.length, 2);

  pending[1].reject(new Error("newer context failed"));
  await assert.rejects(newer, /newer context failed/);
  pending[0].resolve(olderFrame);
  assert.deepEqual(await older, olderFrame);

  await assert.rejects(resolver(), /recent failed state/);
  assert.equal(pending.length, 2, "the third context must retain the newer failed publication");
});

test("concurrent context endpoints share one satellite discovery and reuse its success", async () => {
  const result = await exerciseSatelliteContextCoalescing({ sharedSucceeds: true });
  assert.equal(result.firstBody.contextStatus.satellite, "fallback");
  assert.equal(result.firstBody.satellite?.observedAt?.slice(0, 10), result.advertisedDate);
  assert.deepEqual(result.secondBody.satellite, result.firstBody.satellite, "both requests receive the same shared discovery");
  assert.equal(result.thirdBody.contextStatus.satellite, "fallback");
  assert.deepEqual(result.thirdBody.satellite, result.firstBody.satellite);
  assert.equal(result.tileRequests, result.tileRequestsBeforeThirdContext, "third context must reuse the success without probing tiles");
});

test("concurrent context endpoints share one satellite failure and retain it", async () => {
  const result = await exerciseSatelliteContextCoalescing({ sharedSucceeds: false });
  assert.equal(result.firstBody.contextStatus.satellite, "unavailable");
  assert.equal(result.firstBody.satellite, null);
  assert.deepEqual(result.secondBody.satellite, null);
  assert.equal(result.thirdBody.contextStatus.satellite, "unavailable");
  assert.equal(result.thirdBody.satellite, null);
  assert.equal(result.tileRequests, result.tileRequestsBeforeThirdContext, "third context must retain the failure without probing tiles");
});

test("satellite cache revalidates at UTC rollover and when the provider-advertised date advances", async () => {
  const { createSatelliteAvailabilityResolver } = await import("../platform/server-entry.js");
  let now = Date.parse("2026-08-04T23:59:00Z");
  let advertisedDate = "2026-08-03";
  let metadataCalls = 0;
  let discoveries = 0;
  const resolver = createSatelliteAvailabilityResolver({
    clock: () => now,
    fetcher: async () => {
      metadataCalls += 1;
      return new Response(`<Domain>2026-07-16/${advertisedDate}/P1D</Domain>`);
    },
    discoverFrame: async ({ startDate }) => {
      discoveries += 1;
      return {
        observedAt: `${startDate}T00:00:00Z`,
        label: `verified ${startDate}`,
        tileTemplate: `https://example.test/${startDate}/{z}/{y}/{x}.jpeg`
      };
    }
  });

  const first = await resolver();
  assert.equal((await resolver()).observedAt, first.observedAt);
  assert.equal(discoveries, 1, "same provider date and UTC day should reuse the verified frame");

  now = Date.parse("2026-08-05T00:01:00Z");
  await resolver();
  assert.equal(discoveries, 2, "UTC rollover must force metadata-keyed tile revalidation");

  advertisedDate = "2026-08-04";
  const advanced = await resolver();
  assert.equal(advanced.observedAt, "2026-08-04T00:00:00Z");
  assert.equal(discoveries, 3, "a newer provider-advertised date must bypass the prior frame cache");
  assert.equal(metadataCalls, 4, "provider metadata is checked before every cache reuse decision");
});

test("tide query windows remain stable inside a cache bucket", async () => {
  const { tideQueryWindow } = await import("../platform/server-entry.js");
  const first = Date.parse("2026-08-03T09:01:01.000Z");
  const second = Date.parse("2026-08-03T09:14:59.000Z");
  const nextBucket = Date.parse("2026-08-03T09:15:00.000Z");

  assert.deepEqual(tideQueryWindow(first), tideQueryWindow(second));
  assert.notDeepEqual(tideQueryWindow(first), tideQueryWindow(nextBucket));
  assert.deepEqual(tideQueryWindow(first), {
    since: "2026-08-03T08:15:00Z",
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
  assert.equal(parseIrelandLocalTimestamp("29-03-2026", "01:30"), null, "spring DST gap does not exist");
  assert.equal(parseEirGridLocalTimestamp("29-Mar-2026 01:30:00"), null, "EirGrid spring DST gap does not exist");

  const beforeSecondFold = Date.parse("2026-10-25T01:00:00.000Z");
  const afterSecondFold = Date.parse("2026-10-25T01:45:00.000Z");
  assert.equal(
    parseIrelandLocalTimestamp("25-10-2026", "01:30", beforeSecondFold),
    "2026-10-25T00:30:00.000Z"
  );
  assert.equal(
    parseIrelandLocalTimestamp("25-10-2026", "01:30", afterSecondFold),
    "2026-10-25T01:30:00.000Z"
  );
  assert.equal(
    parseEirGridLocalTimestamp("25-Oct-2026 01:30:00", beforeSecondFold),
    "2026-10-25T00:30:00.000Z"
  );
  assert.equal(
    parseEirGridLocalTimestamp("25-Oct-2026 01:30:00", afterSecondFold),
    "2026-10-25T01:30:00.000Z"
  );
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

test("EirGrid scans the full byte-bounded row set instead of assuming metric order", () => {
  const now = Date.parse("2026-08-02T12:30:00.000Z");
  const rows = [
    { FieldName: "SYSTEM_DEMAND", Value: "4321", EffectiveTime: "02-Aug-2026 13:15:00" },
    ...Array.from({ length: 2_100 }, (_, index) => ({
      FieldName: "OTHER_SERIES",
      Value: String(index),
      EffectiveTime: "02-Aug-2026 13:00:00"
    }))
  ];
  assert.equal(latestEirGridValue(rows, "SYSTEM_DEMAND", now)?.value, 4321);
});

test("server and public grid integrations use the newest component timestamp", async () => {
  const now = Date.parse("2026-08-02T12:30:00.000Z");
  const rowsByChart = {
    demand: [{ FieldName: "SYSTEM_DEMAND", Value: "4200", EffectiveTime: "02-Aug-2026 13:00:00" }],
    generation: [{ FieldName: "GEN_EXP", Value: "4300", EffectiveTime: "02-Aug-2026 13:10:00" }],
    wind: [{ FieldName: "WIND_ACTUAL", Value: "1000", EffectiveTime: "02-Aug-2026 12:55:00" }],
    co2: [
      { FieldName: "CO2_INTENSITY", Value: "250", EffectiveTime: "02-Aug-2026 13:05:00" },
      { FieldName: "CO2_EMISSIONS", Value: "900", EffectiveTime: "02-Aug-2026 13:05:00" }
    ],
    frequency: [{ FieldName: "SYS_FREQUENCY", Value: "50", EffectiveTime: "02-Aug-2026 13:01:00" }],
    interconnection: [{ FieldName: "INTER_NET", Value: "200", EffectiveTime: "02-Aug-2026 12:50:00" }]
  };
  const fetcher = async (input) => {
    const chart = new URL(input).searchParams.get("chartType");
    return Response.json({ Rows: rowsByChart[chart] ?? [] });
  };
  const server = await (await import("../platform/server-entry.js")).fetchGrid(fetcher, now);
  const browser = await (await importWarningAdapter("../lib/live-data.ts")).fetchGrid(fetcher, now);
  for (const result of [server, browser]) {
    assert.equal(result.status, "live");
    assert.equal(result.reading.observedAt, "2026-08-02T12:10:00.000Z");
    assert.equal(result.reading.demandMW, 4200);
    assert.equal(result.reading.generationMW, 4300);
    assert.equal(result.reading.carbonIntensity, 250);
  }
  assert.deepEqual(browser, server);
});

test("Met Éireann CSV fallback does not invent fetch-time freshness", async () => {
  const source = await readFile(new URL("../lib/latest-observations.ts", import.meta.url), "utf8");
  let output = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.ESNext }
  }).outputText;
  const weatherUrl = new URL("../platform/weather-stations.js", import.meta.url).href;
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

test("river dedupe keeps distinct nearby gauges and collapses only repeated station ids", () => {
  const now = Date.parse("2026-08-02T12:00:00.000Z");
  // Two real stations ~1.3 km apart share one former spatial-dedupe cell.
  const readings = normalizeRiverReadings([
    { id: "1500", name: "Gauge A", latitude: 53.34, longitude: -6.26, level: 1.1, observedAt: "2026-08-02T11:30:00Z" },
    { id: "1501", name: "Gauge B", latitude: 53.352, longitude: -6.272, level: 0.8, observedAt: "2026-08-02T11:30:00Z" },
    { id: "1500", name: "Gauge A", latitude: 53.34, longitude: -6.26, level: 1.4, observedAt: "2026-08-02T11:45:00Z" }
  ], now);

  assert.deepEqual(readings.map((reading) => reading.id), ["1500", "1501"]);
  assert.equal(readings.find((reading) => reading.id === "1500").level, 1.4, "a repeated station keeps its newest observation");
});

test("river normalization does not silently truncate valid unique gauges", () => {
  const now = Date.parse("2026-08-02T12:00:00.000Z");
  const readings = [];
  const cells = new Set();
  for (let latitude = 51.4; latitude <= 55.5 && readings.length < 110; latitude += 0.11) {
    for (let longitude = -10.7; longitude <= -5.4 && readings.length < 110; longitude += 0.11) {
      if (!isIrelandCoordinate(latitude, longitude)) continue;
      const cell = `${Math.round(longitude * 4)}:${Math.round(latitude * 5)}`;
      if (cells.has(cell)) continue;
      cells.add(cell);
      readings.push({
        id: `gauge-${readings.length}`,
        name: `Gauge ${readings.length}`,
        latitude,
        longitude,
        level: 1,
        observedAt: "2026-08-02T11:30:00.000Z"
      });
    }
  }
  assert.ok(readings.length > 90, "fixture must contain more than the former 90-reading cap");
  assert.equal(normalizeRiverReadings(readings, now).length, readings.length);
});

const chunkedBodyResponse = (chunkSizes, { status = 200 } = {}) => {
  const state = { chunksRead: 0, cancelled: false };
  let index = 0;
  const body = new ReadableStream({
    pull(controller) {
      if (index >= chunkSizes.length) {
        controller.close();
        return;
      }
      const size = chunkSizes[index];
      index += 1;
      state.chunksRead += 1;
      controller.enqueue(new Uint8Array(size).fill(120));
    },
    cancel() {
      state.cancelled = true;
    }
  }, { highWaterMark: 0 });
  return { response: new Response(body, { status }), state };
};

test("OPW non-OK diagnostics cancel a chunked body as soon as it reaches the cap", async () => {
  const { acquireRiverRaw } = await import("../platform/server-entry.js");
  const oversized = chunkedBodyResponse([16_000, 16_000, 8_000], { status: 503 });
  let calls = 0;
  const fetcher = async () => {
    calls += 1;
    return calls === 1 ? oversized.response : new Response("bridge unavailable", { status: 503 });
  };
  await assert.rejects(
    acquireRiverRaw({}, fetcher),
    /opw-error-body-too-large/
  );
  assert.equal(oversized.state.chunksRead, 2);
  assert.equal(oversized.state.cancelled, true);
});

test("server, public, and scheduled EirGrid readers cancel before consuming later chunks", async () => {
  const serverApi = await import("../platform/server-entry.js");
  const browserApi = await importWarningAdapter("../lib/live-data.ts");
  const { collectGrid } = await import("../platform/history-sources.js");
  const now = Date.parse("2026-08-05T12:00:00.000Z");

  const serverBody = chunkedBodyResponse([128_000, 128_000, 64]);
  await assert.rejects(
    serverApi.fetchGridRows("demand", "demandactual", async () => serverBody.response, now),
    /eirgrid-demand-body-too-large/
  );
  assert.deepEqual(serverBody.state, { chunksRead: 2, cancelled: true });

  const browserBodies = [];
  const browserResult = await browserApi.fetchGrid(async () => {
    const body = chunkedBodyResponse([128_000, 128_000, 64]);
    browserBodies.push(body);
    return body.response;
  }, now);
  assert.deepEqual(browserResult, { reading: null, status: "unavailable" });
  assert.equal(browserBodies.length, 6);
  assert.ok(browserBodies.every((body) => body.state.chunksRead === 2 && body.state.cancelled));

  const scheduledBodies = [];
  const scheduledResult = await collectGrid(async () => {
    const body = chunkedBodyResponse([256_000, 256_000, 64]);
    scheduledBodies.push(body);
    return body.response;
  }, now);
  assert.equal(scheduledResult.envelope.status, "unavailable");
  assert.equal(scheduledBodies.length, 6);
  assert.ok(scheduledBodies.every((body) => body.state.chunksRead === 2 && body.state.cancelled));
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

test("failed NTA refresh relabels an expired snapshot stale and never serves its positions", async () => {
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
    assert.equal(body.transitStatus, "stale");
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

test("a truncated NTA feed stays partial through normalization and the shared cache", async () => {
  const { fetchTransit } = await import("../platform/server-entry.js");
  const { NtaFeedCoordinator } = await import("../platform/cloudflare-entry.js");
  const now = Date.now();
  const entity = (index) => ({
    id: `vehicle-${index}`,
    vehicle: {
      vehicle: { id: `vehicle-${index}`, label: String(index) },
      trip: { routeId: "03C 126 e a" },
      position: { latitude: 53.3, longitude: -7.2 },
      timestamp: Math.floor(now / 1000)
    }
  });
  const fetcher = async () => Response.json({ entity: Array.from({ length: 1_201 }, (_, index) => entity(index)) });
  const result = await fetchTransit({ NTA_API_KEY: "test-key" }, fetcher, now);
  assert.equal(result.status, "partial");
  assert.equal(result.truncated, true);
  assert.equal(result.sourceEntityCount, 1_201);
  assert.equal(result.vehicles.length, 1_200);

  const state = new Map([["snapshot", { expiresAt: now + 60_000, result }]]);
  const coordinator = new NtaFeedCoordinator({
    storage: { get: async (key) => state.get(key), put: async (key, value) => state.set(key, value) }
  }, { NTA_API_KEY: "test-key" });
  const response = await coordinator.fetch(new Request("https://internal/transit"));
  assert.equal((await response.json()).transitStatus, "partial");
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
          trip: { routeId: "03C 126 e a" },
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
    assert.deepEqual(bodies.map((body) => body.transit[0].route), ["03C 126 e a", "03C 126 e a"]);
    assert.equal("destination" in bodies[0].transit[0], false, "GTFS-RT TripDescriptor does not carry a headsign");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("history coordinator summaries enforce the scheduled cutoff and keep vehicle positions private", async () => {
  const { NtaFeedCoordinator, RiverFeedCoordinator } = await import("../platform/cloudflare-entry.js");
  const cutoff = Date.now() - 1_000;
  const ntaState = new Map([["snapshot", {
    expiresAt: Date.now() + 60_000,
    result: {
      status: "live",
      vehicles: [
        { id: "before", route: "03C 126 e a", label: "private", latitude: 53.3, longitude: -7.2, observedAt: new Date(cutoff - 1_000).toISOString() },
        { id: "after", route: "03C 126 e a", label: "future", latitude: 53.4, longitude: -7.3, observedAt: new Date(cutoff + 1).toISOString() }
      ]
    }
  }]]);
  const storage = (state) => ({ get: async (key) => state.get(key), put: async (key, value) => state.set(key, value) });
  const nta = new NtaFeedCoordinator({ storage: storage(ntaState) }, { NTA_API_KEY: "test-key" });
  const transit = await (await nta.fetch(new Request(`https://internal/history-summary?captureBucketStartMs=${cutoff}`))).json();
  assert.equal(transit.transitStatus, "partial");
  assert.deepEqual(transit.transit, []);
  assert.equal(transit.aggregate.vehicles, 1);
  assert.equal(transit.latestObservedAt, new Date(cutoff - 1_000).toISOString());
  assert.doesNotMatch(JSON.stringify(transit), /before|after|private|future|latitude|longitude/);

  const riverState = new Map([["snapshot", {
    expiresAt: Date.now() + 60_000,
    rivers: [
      { id: "river-before", name: "Before", latitude: 53.1, longitude: -8.5, level: 1, observedAt: new Date(cutoff - 1_000).toISOString() },
      { id: "river-after", name: "After", latitude: 53.2, longitude: -7, level: 2, observedAt: new Date(cutoff + 1).toISOString() }
    ],
    provenance: { provider: "OPW", endpoint: "", status: "live", fetchedAt: new Date().toISOString(), latestObservedAt: null, fallback: null }
  }]]);
  const rivers = new RiverFeedCoordinator({ storage: storage(riverState) }, {});
  const river = await (await rivers.fetch(new Request(`https://internal/history-summary?captureBucketStartMs=${cutoff}`))).json();
  assert.equal(river.status, "partial");
  assert.deepEqual(river.rivers.map((item) => item.id), ["river-before"]);
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

test("public contexts preserve partial marine, tide, modelled-air, and bathing coverage while caching the snapshot", async () => {
  const api = await import("../platform/server-entry.js");
  const originalFetch = globalThis.fetch;
  const now = Date.now();
  const observedAt = new Date(now - 30 * 60_000).toISOString();
  const airTime = new Date(now - 60 * 60_000).toISOString().slice(0, 16);
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.includes("IWBNetwork.json")) {
      return Response.json({ table: { rows: [["M2", -5.4, 53.5, observedAt, 10, 1.2, 5, 14]] } });
    }
    if (url.includes("IrishNationalTideGaugeNetwork.json")) {
      return Response.json({ table: { rows: [["Dublin", -6.2, 53.3, observedAt, 1.1]] } });
    }
    if (url.includes("imiSurgeObservationINTGN") || url.includes("IMI_TidePrediction_HighLow")) {
      throw new Error("optional-tide-network-sentinel");
    }
    if (url.includes("air-quality-api.open-meteo.com")) {
      return Response.json([{ current: { time: airTime, european_aqi: 21 } }, {}, {}, {}, {}, {}, {}]);
    }
    if (url.includes("/bw/api/v1/alerts")) {
      return Response.json({ list: [{
        incident_id: 77,
        beach_id: 99,
        beach_name: "Missing location beach",
        incident_start_date: new Date(now - 60 * 60_000).toISOString(),
        incident_end_date: new Date(now + 24 * 60 * 60_000).toISOString(),
        bathing_restriction_type: "Advice"
      }] });
    }
    if (url.includes("/bw/api/v1/locations")) return Response.json({ list: [] });
    return new Response("upstream unavailable", { status: 503 });
  };
  try {
    const response = await api.default.fetch(
      new Request("https://day.illek.ie/api/contexts"),
      { EDGE_RUNTIME: "cloudflare" }
    );
    const body = await response.json();
    assert.match(response.headers.get("cache-control") ?? "", /s-maxage=30/);
    assert.equal(body.contextStatus.marine, "partial");
    assert.equal(body.marine.length, 1);
    assert.equal(body.contextStatus.tides, "partial");
    assert.equal(body.tides.length, 1);
    assert.equal(body.tides[0].surge, null);
    assert.equal(body.tides[0].nextHighAt, null);
    assert.equal(body.contextStatus.modelledAir, "partial");
    assert.equal(body.airQuality.filter((item) => item.source === "modelled").length, 1);
    assert.equal(body.contextStatus.bathing, "partial");
    assert.deepEqual(body.bathingAlerts, []);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("public contexts mark successful empty marine and tide payloads unavailable", async () => {
  const api = await import("../platform/server-entry.js");
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.includes("erddap.marine.ie")) return Response.json({ table: { rows: [] } });
    if (url.includes("air-quality-api.open-meteo.com")) return Response.json([{}, {}, {}, {}, {}, {}, {}]);
    if (url.includes("/bw/api/v1/alerts")) return Response.json({ list: [] });
    return new Response("upstream unavailable", { status: 503 });
  };
  try {
    const response = await api.default.fetch(
      new Request("https://day.illek.ie/api/contexts"),
      { EDGE_RUNTIME: "cloudflare" }
    );
    const body = await response.json();
    assert.equal(body.contextStatus.marine, "unavailable");
    assert.deepEqual(body.marine, []);
    assert.equal(body.contextStatus.tides, "unavailable");
    assert.deepEqual(body.tides, []);
    assert.equal(body.contextStatus.modelledAir, "unavailable");
    assert.equal(body.contextStatus.bathing, "live", "an authoritative empty alert list remains live-empty");
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
    panY: -180,
    at: null
  });
  assert.equal(new URL(url).searchParams.has("ignored"), false);
});

test("shared view state round-trips only explicit RFC3339 history instants", async () => {
  const source = await readFile(new URL("../lib/view-state.ts", import.meta.url), "utf8");
  const output = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.ESNext }
  }).outputText;
  const viewState = await import(`data:text/javascript,${encodeURIComponent(output)}`);
  const historicalUrl = viewState.serializeViewState("https://day.illek.ie/?at=discard-me", {
    placeId: "island",
    view: "water",
    layers: [],
    at: "2026-08-04T18:45:00+01:00"
  });
  const parsed = viewState.parseViewState(new URL(historicalUrl).search, ["island"]);

  assert.equal(parsed.at, "2026-08-04T17:45:00.000Z");
  assert.equal(new URL(historicalUrl).searchParams.get("at"), "2026-08-04T17:45:00.000Z");
  assert.equal(viewState.parseViewState("?at=2026-08-04T17:45", ["island"]).at, null);
  assert.equal(new URL(viewState.serializeViewState(historicalUrl, {
    placeId: "island",
    view: "weather",
    layers: [],
    at: "not-a-date"
  })).searchParams.has("at"), false);
});

test("production CSP permits the browser-side live providers without broad connect access", async () => {
  const headers = await readFile(new URL("../public/_headers", import.meta.url), "utf8");
  const csp = headers.match(/^\s*Content-Security-Policy:\s*(.+)$/m)?.[1] ?? "";
  const connectDirective = csp.split(";")
    .map((directive) => directive.trim())
    .find((directive) => directive.startsWith("connect-src ")) ?? "";
  const sources = connectDirective.slice("connect-src ".length).split(/\s+/).filter(Boolean);

  assert.deepEqual(sources, [
    "'self'",
    "https://prodapi.metweb.ie",
    "https://www.met.ie",
    "https://gdal.met.ie",
    "https://discomap.eea.europa.eu",
    "https://cloudflareinsights.com"
  ]);
  assert.equal(sources.some((source) => source.includes("*")), false);
});
