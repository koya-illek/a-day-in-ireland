import assert from "node:assert/strict";
import test from "node:test";
import { importBrowserLive, importStandaloneTypeScript } from "./import-ts.mjs";

// Drives refreshCurrentContexts against a stubbed /api/contexts response.
const refreshContextsWith = async ({ body, seedPrevious }) => {
  const { createInitialSnapshot } = await importStandaloneTypeScript("../lib/initial-snapshot.ts");
  const { refreshCurrentContexts } = await importBrowserLive();
  const now = Date.now();
  const previous = createInitialSnapshot(new Date(now).toISOString());
  if (seedPrevious) seedPrevious(previous);
  const originalFetch = globalThis.fetch;
  const originalWindow = globalThis.window;
  globalThis.window = {
    location: { hostname: "localhost" },
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout
  };
  globalThis.fetch = async () => Response.json(body);
  try {
    return { previous, refreshed: await refreshCurrentContexts(previous) };
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.window = originalWindow;
  }
};

const emptyStatusMap = {
  marine: "unavailable", radar: "unavailable", grid: "unavailable", measuredAir: "unavailable",
  modelledAir: "unavailable", aurora: "unavailable", tides: "unavailable", bathing: "unavailable",
  satellite: "unavailable", earthquakes: "unavailable", iss: "unavailable", warnings: "unavailable"
};

test("a contexts response without a provenance map retains the previous refresh's provenance", async () => {
  const { refreshed } = await refreshContextsWith({
    seedPrevious: (previous) => {
      previous.contextProvenance = {
        radar: { provider: "Met Éireann", status: "live", fetchedAt: new Date(Date.now() - 60_000).toISOString() }
      };
    },
    body: {
      generatedAt: new Date().toISOString(),
      marine: [], radar: [], grid: null, airQuality: [], aurora: null, tides: [], bathingAlerts: [],
      warnings: [], warningsStatus: "unavailable", satellite: null, earthquakes: [], issTle: null,
      contextStatus: emptyStatusMap
    }
  });
  // The omitted field must never erase what the previous snapshot carried.
  assert.equal(refreshed.contextProvenance.radar.provider, "Met Éireann");
});

test("delivered payloads without a context status map are not presented as live", async () => {
  const { refreshed } = await refreshContextsWith({
    body: {
      generatedAt: new Date().toISOString(),
      marine: [], radar: [{ frame: "https://example.test/frame-1.png", time: "2026-08-23T12:00:00Z" }],
      grid: null, airQuality: [], aurora: null, tides: [], bathingAlerts: [],
      warnings: [], warningsStatus: "unavailable", satellite: null, earthquakes: [], issTle: null
    }
  });
  // No contextStatus field at all: the delivered radar array must fall back to
  // retained/unavailable semantics instead of being inferred live.
  assert.notEqual(refreshed.contextStatus.radar, "live");
});

test("an element set that fails local propagation is not labelled live with a null prediction", async () => {
  const { previous, refreshed } = await refreshContextsWith({
    seedPrevious: (snapshot) => {
      snapshot.iss = {
        observedAt: new Date(Date.now() - 120_000).toISOString(),
        latitude: 53.4, longitude: -8, altitudeKm: 420,
        passes: []
      };
    },
    body: {
      generatedAt: new Date().toISOString(),
      marine: [], radar: [], grid: null, airQuality: [], aurora: null, tides: [], bathingAlerts: [],
      warnings: [], warningsStatus: "unavailable", satellite: null, earthquakes: [],
      issTle: { line1: "not a real tle line", line2: "also not a real tle line", observedAt: new Date().toISOString() },
      contextStatus: { ...emptyStatusMap, iss: "live" }
    }
  });
  // A claimed-live source must not survive as live with a null payload: the
  // retained prediction stays and the status degrades to unavailable.
  assert.equal(refreshed.contextStatus.iss, "unavailable");
  assert.equal(refreshed.iss.observedAt, previous.iss.observedAt);
});

// --- Round 3: capture honesty ------------------------------------------------

test("stale river readings keep their stale label and station count in stored history", async () => {
  const { buildHistoryCapture } = await import("../platform/history.js");
  const capturedAtMs = Date.parse("2026-08-05T00:00:00.000Z");
  const observedAt = "2026-08-04T23:40:00.000Z";
  const capture = await buildHistoryCapture({
    env: { NTA_API_KEY: "configured" },
    capturedAtMs,
    fetcher: async () => new Response("unavailable", { status: 503 }),
    loadLiving: async () => ({
      trains: [],
      rivers: [{ id: "river-1", name: "Suir", latitude: 52.2, longitude: -7.9, level: 1.4, observedAt }],
      sourceStatus: { trains: "unavailable", rivers: "stale" },
      sourceProvenance: {
        rivers: { provider: "OPW waterlevel.ie", endpoint: "", status: "stale", fetchedAt: observedAt, latestObservedAt: observedAt, fallback: null }
      }
    }),
    loadTransit: async () => ({ transit: [], transitStatus: "unavailable" })
  });
  assert.equal(capture.sources.rivers.status, "stale");
  assert.equal(capture.sources.rivers.itemCount, 1);
  assert.equal(capture.payload.snapshot.summary.riverStations, 1);
  assert.equal(capture.payload.snapshot.contextStatus.rivers ?? null, null);
  assert.ok(capture.gaps.some((item) => item.source === "rivers" && item.reason === "stale"));
});

test("a malformed warning timestamp is reported as malformed, never as a post-cutoff update", async () => {
  const { collectWarnings } = await import("../platform/history-sources.js");
  const now = Date.parse("2026-08-05T00:00:00.000Z");
  const rows = [{
    id: "warn-bad", capId: "cap-bad", type: "Yellow; Moderate; Rain",
    onset: "2026-08-04T18:00:00Z", expiry: "2026-08-05T06:00:00Z",
    regions: ["Galway"], status: "Warning", severity: "Moderate", certainty: "Likely",
    headline: "Rain warning", description: "Heavy rain",
    issued: "not-a-timestamp", updated: "2026-08-04T20:00:00Z"
  }];
  globalThis.fetch = async () => Response.json(rows);
  try {
    const result = await collectWarnings(globalThis.fetch, now);
    assert.equal(result.envelope.status, "partial");
    assert.equal(result.envelope.errorCode, "malformed-timestamp");
    assert.ok(result.gaps.some((item) => item.reason === "malformed-timestamp"));
    assert.deepEqual(result.gaps.filter((item) => item.reason === "post-cutoff-update"), []);
  } finally {
    delete globalThis.fetch;
  }
});

test("provider free-text is capped per field before it reaches stored history", async () => {
  const { collectEarthquakes } = await import("../platform/history-sources.js");
  const now = Date.parse("2026-08-05T00:00:00.000Z");
  const feature = {
    id: "us6000", geometry: { coordinates: [-10.0, 53.0, 8] },
    properties: { mag: 2.1, time: now - 60_000, place: "x".repeat(500), url: "https://earthquake.usgs.gov/x" }
  };
  globalThis.fetch = async () => Response.json({ features: [feature] });
  try {
    const result = await collectEarthquakes(globalThis.fetch, now);
    assert.equal(result.envelope.data[0].place.length, 300);
  } finally {
    delete globalThis.fetch;
  }
});
