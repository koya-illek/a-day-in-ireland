import assert from "node:assert/strict";
import test from "node:test";

const trainXml = `<?xml version="1.0"?>
<objTrainPositions>
  <TrainCode>A800</TrainCode>
  <TrainStatus>R</TrainStatus>
  <Direction>Northbound</Direction>
  <PublicMessage>Test service</PublicMessage>
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
      station_name: "Review Gauge",
      value: 1.23,
      datetime: new Date(Date.now() - 30_000).toISOString()
    }
  }]
});

const stubFetch = (route) => async (url) => {
  const target = String(url);
  if (target.includes("api.irishrail.ie")) return new Response(trainXml, { status: 200 });
  if (target.includes("waterlevel.ie")) return route();
  throw new Error(`unexpected fetch target ${target}`);
};

test("alternate adapter living payload agrees with the river status it reports", async () => {
  const { default: worker } = await import("../platform/server-entry.js?living-status=ok");
  const originalFetch = globalThis.fetch;
  globalThis.fetch = stubFetch(() => new Response(riverGeoJson(), { status: 200 }));
  try {
    const response = await worker.fetch(new Request("https://day.illek.ie/api/living"), {});
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.sourceStatus.trains, "live");
    assert.equal(payload.sourceStatus.rivers, "live");
    assert.equal(payload.sourceProvenance.rivers.status, payload.sourceStatus.rivers);
    assert.equal(payload.sourceProvenance.rivers.latestObservedAt !== null, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("alternate adapter living payload reports unavailable rivers when OPW fails", async () => {
  const { default: worker } = await import("../platform/server-entry.js?living-status=fail");
  const originalFetch = globalThis.fetch;
  globalThis.fetch = stubFetch(() => new Response("upstream unavailable", { status: 503 }));
  try {
    const response = await worker.fetch(new Request("https://day.illek.ie/api/living"), {});
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.sourceStatus.trains, "live");
    assert.equal(payload.sourceStatus.rivers, "unavailable");
    assert.equal(payload.sourceProvenance.rivers.status, payload.sourceStatus.rivers);
    assert.deepEqual(payload.rivers, []);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("river bridge fallback stays disabled unless an HTTPS URL is configured", async () => {
  const { acquireRiverRaw } = await import("../platform/server-entry.js?living-status=bridge");
  let bridgeCalled = false;
  const fetcher = async (url) => {
    if (String(url).includes("waterlevel.ie")) return new Response("nope", { status: 500 });
    bridgeCalled = true;
    return new Response("{}", { status: 200 });
  };
  await assert.rejects(
    acquireRiverRaw({}, fetcher),
    /OPW returned 500.*fallback unavailable/s
  );
  assert.equal(bridgeCalled, false);

  const configured = await acquireRiverRaw({ RIVER_BRIDGE_URL: "https://bridge.example/api/living" }, async (url) => {
    if (String(url).includes("waterlevel.ie")) return new Response("nope", { status: 500 });
    bridgeCalled = true;
    return new Response(JSON.stringify({ rivers: [{ id: "r1", latitude: 53, longitude: -8, level: 1, observedAt: new Date().toISOString() }] }), { status: 200 });
  });
  assert.equal(bridgeCalled, true);
  assert.equal(configured.status, "fallback");
  assert.equal(configured.fallback, "Configured river bridge");
});

test("transit context prefers the NTA coordinator when the binding is wired", async () => {
  const { default: worker } = await import("../platform/server-entry.js?living-status=transit");
  let directUpstreamCalls = 0;
  const env = {
    NTA_API_KEY: "test-key",
    NTA_FEED: {
      getByName: () => ({
        fetch: async () => new Response(JSON.stringify({
          generatedAt: "2026-08-22T12:00:00.000Z",
          transit: [{ id: "v1", latitude: 53.3, longitude: -6.2, observedAt: "2026-08-22T11:59:00.000Z" }],
          transitStatus: "live"
        }), { status: 200 })
      })
    }
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    directUpstreamCalls += 1;
    return new Response("{}", { status: 200 });
  };
  try {
    const response = await worker.fetch(new Request("https://day.illek.ie/api/transit"), env);
    const payload = await response.json();
    assert.equal(directUpstreamCalls, 0);
    assert.equal(payload.transitStatus, "live");
    assert.equal(payload.transit.length, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
