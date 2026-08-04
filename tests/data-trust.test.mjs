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

const importDataStateAdapter = async () => {
  const source = await readFile(new URL("../lib/data-state.ts", import.meta.url), "utf8");
  const weatherSource = await readFile(new URL("../lib/weather-stations.ts", import.meta.url), "utf8");
  const weatherOutput = ts.transpileModule(weatherSource, {
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.ESNext }
  }).outputText;
  const weatherUrl = `data:text/javascript,${encodeURIComponent(weatherOutput)}`;
  const output = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.ESNext }
  }).outputText.replace('"./weather-stations"', JSON.stringify(weatherUrl));
  return import(`data:text/javascript,${encodeURIComponent(output)}`);
};

const exerciseSatelliteContextRace = async ({ newerSucceeds }) => {
  const moduleUrl = new URL("../platform/server-entry.js", import.meta.url);
  moduleUrl.searchParams.set("satellite-race", newerSucceeds ? "newer-success" : "newer-failure");
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
      if (tileRequests <= 8) {
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
  const satelliteTile = () => new Response(null, {
    status: 200,
    headers: {
      "content-type": "image/jpeg",
      "layer-time-actual": `${advertisedDate}T00:00:00Z`
    }
  });
  const failedTile = () => new Response(null, { status: 503 });

  try {
    const olderResponse = api.default.fetch(
      new Request("https://day.illek.ie/api/contexts"),
      { EDGE_RUNTIME: "cloudflare" }
    );
    await waitForTileBatches(4);
    const newerResponse = api.default.fetch(
      new Request("https://day.illek.ie/api/contexts"),
      { EDGE_RUNTIME: "cloudflare" }
    );
    await waitForTileBatches(8);

    const newerResolvers = tileResolvers.slice(4, 8);
    newerResolvers.forEach((resolve) => resolve(newerSucceeds ? satelliteTile() : failedTile()));
    const newerBody = await (await newerResponse).json();

    const olderResolvers = tileResolvers.slice(0, 4);
    olderResolvers.forEach((resolve) => resolve(newerSucceeds ? failedTile() : satelliteTile()));
    const olderBody = await (await olderResponse).json();
    const tileRequestsBeforeThirdContext = tileRequests;
    const thirdBody = await (await api.default.fetch(
      new Request("https://day.illek.ie/api/contexts"),
      { EDGE_RUNTIME: "cloudflare" }
    )).json();

    return { advertisedDate, newerBody, olderBody, thirdBody, tileRequests, tileRequestsBeforeThirdContext };
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
  assert.equal(snapshot.summary.reporting, 0);
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
  assert.equal(probes.length, 8);
  assert.ok(probes.every((probe) => probe.method === "HEAD"));
  assert.ok(probes.some((probe) => probe.url.endsWith("/6/20/30.jpeg")));
  assert.ok(probes.some((probe) => probe.url.endsWith("/6/21/31.jpeg")));
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

test("concurrent context endpoints retain a newer satellite success after the older request fails", async () => {
  const result = await exerciseSatelliteContextRace({ newerSucceeds: true });
  assert.equal(result.newerBody.contextStatus.satellite, "fallback");
  assert.equal(result.newerBody.satellite?.observedAt?.slice(0, 10), result.advertisedDate);
  assert.equal(result.olderBody.contextStatus.satellite, "unavailable");
  assert.equal(result.olderBody.satellite, null);
  assert.equal(result.thirdBody.contextStatus.satellite, "fallback");
  assert.deepEqual(result.thirdBody.satellite, result.newerBody.satellite);
  assert.equal(result.tileRequests, result.tileRequestsBeforeThirdContext, "third context must reuse the newer success without probing tiles");
});

test("concurrent context endpoints retain a newer satellite failure after the older request succeeds", async () => {
  const result = await exerciseSatelliteContextRace({ newerSucceeds: false });
  assert.equal(result.newerBody.contextStatus.satellite, "unavailable");
  assert.equal(result.newerBody.satellite, null);
  assert.equal(result.olderBody.contextStatus.satellite, "fallback");
  assert.ok(result.olderBody.satellite);
  assert.equal(result.thirdBody.contextStatus.satellite, "unavailable");
  assert.equal(result.thirdBody.satellite, null);
  assert.equal(result.tileRequests, result.tileRequestsBeforeThirdContext, "third context must retain the newer failure without probing tiles");
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
