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
