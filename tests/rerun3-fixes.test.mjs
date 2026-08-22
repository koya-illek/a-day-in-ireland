import assert from "node:assert/strict";
import test from "node:test";

const train = {
  id: "P801",
  latitude: 53.35,
  longitude: -6.26,
  observedAt: new Date(Date.now() - 30_000).toISOString(),
  status: "running",
  direction: "Northbound",
  message: "Test service",
  speedKmh: null,
  speedSource: null
};

const jsonResponse = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { "content-type": "application/json" }
});

const makeRiverEnv = (payload, { rejectFetch = false, malformedBody = false } = {}) => ({
  RIVER_FEED: {
    getByName: () => ({
      fetch: async () => {
        if (rejectFetch) throw new Error("coordinator unreachable");
        if (malformedBody) return new Response("<not json>", { headers: { "content-type": "application/json" } });
        return jsonResponse(payload);
      }
    })
  }
});

test("/api/living keeps the cacheable tier when trains fail but rivers carry data", async () => {
  const { livingResponse } = await import("../platform/cloudflare-entry.js?rerun3-living-partial");
  const env = makeRiverEnv({
    rivers: [{ id: "r1", observedAt: new Date().toISOString() }],
    status: "partial",
    provenance: { provider: "OPW waterlevel.ie", status: "partial" }
  });
  const response = await livingResponse(env, { loadTrains: async () => Promise.reject(new Error("rail down")) });
  const cacheControl = response.headers.get("cache-control");
  assert.match(cacheControl, /s-maxage=15/);
  assert.doesNotMatch(cacheControl, /no-store/);
  const payload = await response.json();
  assert.equal(payload.sourceStatus.rivers, "partial");
  assert.equal(payload.sourceStatus.trains, "unavailable");
});

test("/api/living treats stale and fallback river data as usable for the partial tier", async () => {
  const { livingResponse } = await import("../platform/cloudflare-entry.js?rerun3-living-stale");
  for (const status of ["stale", "fallback"]) {
    const env = makeRiverEnv({
      rivers: [{ id: "r1", observedAt: new Date().toISOString() }],
      status,
      provenance: { provider: "OPW waterlevel.ie", status }
    });
    const response = await livingResponse(env, { loadTrains: async () => [] });
    assert.doesNotMatch(response.headers.get("cache-control"), /no-store/, status);
  }
});

test("/api/living answers no-store only when neither source has anything to show", async () => {
  const { livingResponse } = await import("../platform/cloudflare-entry.js?rerun3-living-unavailable");
  const env = makeRiverEnv({ rivers: [], status: "unavailable", provenance: null });
  const response = await livingResponse(env, { loadTrains: async () => [] });
  assert.match(response.headers.get("cache-control"), /no-store/);
  const payload = await response.json();
  assert.equal(payload.sourceStatus.rivers, "unavailable");
});

test("/api/living survives a rejected or malformed coordinator body without a runtime error", async () => {
  const { livingResponse } = await import("../platform/cloudflare-entry.js?rerun3-living-malformed");
  for (const options of [{ rejectFetch: true }, { malformedBody: true }]) {
    const env = makeRiverEnv({}, options);
    const response = await livingResponse(env, { loadTrains: async () => [train] });
    assert.equal(response.status, 200, JSON.stringify(options));
    // Trains still live, so the answer stays in the cacheable partial tier.
    assert.doesNotMatch(response.headers.get("cache-control"), /no-store/, JSON.stringify(options));
    const payload = await response.json();
    assert.equal(payload.sourceStatus.rivers, "unavailable");
    assert.equal(payload.sourceStatus.trains, "live");
  }
});
