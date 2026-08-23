import assert from "node:assert/strict";
import test from "node:test";

// Iteration 7 consolidated both Worker entrypoints onto platform/api-core.js.
// These tests drive the two adapters through identical stubs and pin one
// cross-adapter contract for methods, unknown paths, health, living tiers,
// and transit failure handling, so the entrypoint drift that produced earlier
// divergences cannot silently return.

const trainXml = `<?xml version="1.0"?>
<objTrainPositions>
  <TrainCode>A800</TrainCode>
  <TrainStatus>R</TrainStatus>
  <Direction>Northbound</Direction>
  <PublicMessage>Parity service</PublicMessage>
  <TrainLatitude>53.35</TrainLatitude>
  <TrainLongitude>-6.26</TrainLongitude>
</objTrainPositions>`;

const riverGeoJson = () => JSON.stringify({
  type: "FeatureCollection",
  features: [{
    type: "Feature",
    geometry: { type: "Point", coordinates: [-8.5, 53.0] },
    properties: {
      sensor_ref: "0001",
      station_ref: "1234",
      station_name: "Iteration Seven Gauge",
      value: 1.23,
      datetime: new Date(Date.now() - 30_000).toISOString()
    }
  }]
});

const ADAPTERS = ["server-entry.js", "cloudflare-entry.js"];
const loadWorker = async (entry, tag) =>
  (await import(`../platform/${entry}?iteration7-${tag}`)).default;

const sharedHeaders = (response) => ({
  contentType: response.headers.get("content-type"),
  cacheControl: response.headers.get("cache-control"),
  cors: response.headers.get("access-control-allow-origin"),
  robots: response.headers.get("x-robots-tag")
});

test("both adapters enforce one JSON method boundary on every API path", async () => {
  for (const entry of ADAPTERS) {
    const worker = await loadWorker(entry, `methods-${entry}`);
    for (const path of ["/api/health", "/api/living", "/api/transit", "/api/nonsense"]) {
      const rejected = await worker.fetch(new Request(`https://day.illek.ie${path}`, { method: "POST" }), {});
      assert.equal(rejected.status, 405, `${entry} ${path} status`);
      assert.equal(rejected.headers.get("allow"), "GET, HEAD, OPTIONS", `${entry} ${path} allow`);
      assert.match(rejected.headers.get("content-type"), /application\/json/, `${entry} ${path} content-type`);
      assert.equal(rejected.headers.get("cache-control"), "no-store", `${entry} ${path} cache`);
      assert.equal(rejected.headers.get("x-robots-tag"), "noindex, nofollow", `${entry} ${path} robots`);
      const preflight = await worker.fetch(new Request(`https://day.illek.ie${path}`, { method: "OPTIONS" }), {});
      assert.equal(preflight.status, 204, `${entry} ${path} options`);
      assert.equal(preflight.headers.get("allow"), "GET, HEAD, OPTIONS");
    }
  }
});

test("unknown API paths answer JSON 404 instead of an HTML page on both adapters", async () => {
  for (const entry of ADAPTERS) {
    const worker = await loadWorker(entry, `unknown-${entry}`);
    const response = await worker.fetch(new Request("https://day.illek.ie/api/nonsense"), {});
    assert.equal(response.status, 404, entry);
    const body = await response.json();
    assert.ok(body.error, entry);
    assert.match(response.headers.get("content-type"), /application\/json/, entry);
    assert.equal(response.headers.get("cache-control"), "no-store", entry);
    assert.equal(response.headers.get("access-control-allow-origin"), "*", entry);
    assert.equal(response.headers.get("x-robots-tag"), "noindex, nofollow", entry);
  }
});

test("health shares one payload shape with truthful runtime labels", async () => {
  const serverWorker = await loadWorker("server-entry.js", "health-server");
  const edgeWorker = await loadWorker("cloudflare-entry.js", "health-edge");
  const local = await (await serverWorker.fetch(new Request("https://day.illek.ie/api/health"), {})).json();
  const edge = await (await edgeWorker.fetch(
    new Request("https://day.illek.ie/api/health"),
    {
      EDGE_RUNTIME: "cloudflare",
      ASSETS: { fetch: async () => new Response("nope", { status: 500 }) }
    }
  )).json();
  assert.deepEqual(Object.keys(local).sort(), Object.keys(edge).sort());
  assert.deepEqual(Object.keys(local.build).sort(), Object.keys(edge.build).sort());
  assert.deepEqual(local.storage, edge.storage);
  assert.equal(local.runtime, "local-worker");
  assert.equal(edge.runtime, "cloudflare-worker");
  for (const value of Object.values(local.build)) assert.equal(value, "unknown");
});

const coordinatedRivers = (status) => ({
  getByName: () => ({
    fetch: async () => Response.json({
      rivers: [{ id: "r1", latitude: 53, longitude: -8, level: 1, observedAt: new Date().toISOString() }],
      status,
      provenance: { provider: "OPW waterlevel.ie", endpoint: "", status }
    })
  })
});

test("living responses share one cache-tier matrix and payload statuses", async () => {
  const serverWorker = await loadWorker("server-entry.js", "living-server");
  const edgeWorker = await loadWorker("cloudflare-entry.js", "living-edge");
  const request = new Request("https://day.illek.ie/api/living");
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async (url) => {
    if (String(url).includes("api.irishrail.ie")) return new Response(trainXml, { status: 200 });
    if (String(url).includes("waterlevel.ie")) return new Response(riverGeoJson(), { status: 200 });
    throw new Error(`unexpected fetch target ${url}`);
  };
  try {
    const serverLive = await serverWorker.fetch(request, {});
    const edgeLive = await edgeWorker.fetch(request, { RIVER_FEED: coordinatedRivers("live") });
    assert.equal(serverLive.status, 200);
    assert.equal(edgeLive.status, 200);
    assert.equal(serverLive.headers.get("cache-control"), edgeLive.headers.get("cache-control"));
    assert.match(serverLive.headers.get("cache-control"), /^public, max-age=15, s-maxage=15$/);
    assert.equal(serverLive.headers.get("x-robots-tag"), "noindex, nofollow");
    const serverLiveBody = await serverLive.json();
    const edgeLiveBody = await edgeLive.json();
    assert.deepEqual(serverLiveBody.sourceStatus, edgeLiveBody.sourceStatus);
    assert.equal(serverLiveBody.sourceStatus.rivers, "live");
    assert.equal(serverLiveBody.sourceStatus.trains, "live");

    // Trains down but usable rivers: the partial tier keeps responses cached.
    globalThis.fetch = async (url) => {
      if (String(url).includes("waterlevel.ie")) return new Response(riverGeoJson(), { status: 200 });
      return new Response("Irish Rail down", { status: 503 });
    };
    const serverPartial = await serverWorker.fetch(request, {});
    const edgePartial = await edgeWorker.fetch(request, { RIVER_FEED: coordinatedRivers("partial") });
    assert.equal(serverPartial.headers.get("cache-control"), edgePartial.headers.get("cache-control"));
    assert.match(serverPartial.headers.get("cache-control"), /stale-while-revalidate=0/);
    assert.doesNotMatch(serverPartial.headers.get("cache-control"), /no-store/);
    const serverPartialBody = await serverPartial.json();
    assert.equal(serverPartialBody.sourceStatus.trains, "unavailable");
    assert.equal(serverPartialBody.sourceProvenance.rivers.status, serverPartialBody.sourceStatus.rivers);

    // Nothing usable anywhere: both adapters must refuse caching.
    globalThis.fetch = async () => new Response("upstream unavailable", { status: 503 });
    const serverDown = await serverWorker.fetch(request, {});
    const edgeDown = await edgeWorker.fetch(request, { RIVER_FEED: coordinatedRivers("unavailable") });
    assert.deepEqual(sharedHeaders(serverDown), sharedHeaders(edgeDown));
    assert.equal(serverDown.headers.get("cache-control"), "no-store");
    const serverDownBody = await serverDown.json();
    assert.equal(serverDownBody.sourceStatus.rivers, "unavailable");
    assert.deepEqual(serverDownBody.rivers, []);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

const transitCoordinator = (payload) => ({
  NTA_API_KEY: "test-key",
  NTA_FEED: {
    getByName: () => ({
      fetch: async () => Response.json({
        generatedAt: "2026-08-22T12:00:00.000Z",
        transit: payload.transit ?? [],
        transitStatus: payload.status
      })
    })
  }
});

const liveVehicle = {
  id: "v1",
  latitude: 53.3,
  longitude: -6.2,
  observedAt: "2026-08-22T11:59:00.000Z"
};

test("transit answers through one resolver with shared tiers and failure contract", async () => {
  const serverWorker = await loadWorker("server-entry.js", "transit-server");
  const edgeWorker = await loadWorker("cloudflare-entry.js", "transit-edge");
  const request = new Request("https://day.illek.ie/api/transit");
  const liveEnv = () => transitCoordinator({ status: "live", transit: [liveVehicle] });

  const serverLive = await serverWorker.fetch(request, liveEnv());
  const edgeLive = await edgeWorker.fetch(request, liveEnv());
  assert.equal(serverLive.status, 200);
  assert.equal(edgeLive.status, 200);
  assert.equal(
    serverLive.headers.get("cache-control"),
    "public, max-age=15, s-maxage=60, stale-while-revalidate=0"
  );
  assert.equal(serverLive.headers.get("cache-control"), edgeLive.headers.get("cache-control"));
  const serverLiveBody = await serverLive.json();
  const edgeLiveBody = await edgeLive.json();
  assert.equal(serverLiveBody.transitStatus, "live");
  assert.deepEqual(serverLiveBody.transit, edgeLiveBody.transit);

  const rejectingEnv = () => ({
    NTA_API_KEY: "test-key",
    NTA_FEED: {
      getByName: () => ({ fetch: () => Promise.reject(new Error("durable object storage fault")) })
    }
  });
  const serverFailed = await serverWorker.fetch(request, rejectingEnv());
  const edgeFailed = await edgeWorker.fetch(request, rejectingEnv());
  for (const [entry, failed] of [["server", serverFailed], ["edge", edgeFailed]]) {
    assert.equal(failed.status, 503, entry);
    const body = await failed.json();
    assert.match(body.error, /temporarily unavailable/, entry);
    assert.equal(failed.headers.get("cache-control"), "no-store", entry);
    assert.equal(failed.headers.get("x-robots-tag"), "noindex, nofollow", entry);
  }

  // Without a coordinator binding the direct upstream still feeds the same
  // tier matrix, including the credential-aware no-store tier.
  const credentialResponse = await serverWorker.fetch(request, {});
  const credentialBody = await credentialResponse.json();
  assert.equal(credentialBody.transitStatus, "credential-required");
  assert.deepEqual(credentialBody.transit, []);
  assert.equal(credentialResponse.headers.get("cache-control"), "no-store");
});
