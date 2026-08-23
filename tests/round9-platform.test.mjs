import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { TestD1Database } from "./d1-test-helper.mjs";
import { encodeSnapshotRow, writeSnapshot } from "../platform/history-store.js";

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
      station_name: "Round Gauge",
      value: 1.23,
      datetime: new Date(Date.now() - 30_000).toISOString()
    }
  }]
});

test("a malformed Kp body degrades to no index instead of discarding aurora probabilities", async () => {
  const { fetchAurora } = await import("../platform/api-core.js?round9-kp");
  const ovation = {
    "Observation Time": "2026-08-22T12:00:00Z",
    "Forecast Time": "2026-08-22T12:30:00Z",
    coordinates: [[350, 52, 55], [351, 53, 10]]
  };
  const originalFetch = globalThis.fetch;
  const stubFetch = (kpBody) => async (url) => String(url).includes("planetary_k")
    ? new Response(kpBody, { status: 200 })
    : new Response(JSON.stringify(ovation), { status: 200 });
  try {
    globalThis.fetch = stubFetch("<html>gateway noise</html>");
    let result = await fetchAurora();
    assert.equal(result.probability, 55, "valid probabilities survive a malformed Kp body");
    assert.equal(result.kpIndex, null);

    globalThis.fetch = stubFetch(JSON.stringify({ error: "not an array" }));
    result = await fetchAurora();
    assert.equal(result.kpIndex, null, "a non-array Kp JSON body is not fatal either");

    globalThis.fetch = stubFetch(JSON.stringify([{ estimated_kp: "4.3" }, { estimated_kp: 5 }]));
    result = await fetchAurora();
    assert.equal(result.kpIndex, 5);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("the solar source refuses cached readings whose Dublin day has rolled over", async () => {
  const { contextDefinitions } = await import("../platform/api-core.js?round9-solar");
  const definitions = contextDefinitions({}, Date.parse("2026-08-23T00:30:00+01:00"));
  const stillFresh = definitions.solar.stillFresh;
  assert.equal(typeof stillFresh, "function", "solar must pin freshness to its Dublin day");
  assert.equal(stillFresh({ reading: { date: "2026-08-22" } }, Date.parse("2026-08-23T00:30:00+01:00")), false,
    "yesterday's window must be refused just past midnight even while the TTL runs");
  assert.equal(stillFresh({ reading: { date: "2026-08-23" } }, Date.parse("2026-08-23T00:30:00+01:00")), true,
    "today's window stays fresh for the whole day");
  assert.equal(stillFresh({ reading: null }, Date.parse("2026-08-23T12:00:00+01:00")), false);
  assert.equal(stillFresh(null, Date.parse("2026-08-23T12:00:00+01:00")), false);
  // Other sources have no day keying and keep the plain TTL behaviour.
  assert.equal(definitions.marine.stillFresh, undefined);
});

test("hourly repair drains an outage backlog oldest-first with a per-tick cap", async (t) => {
  const db = new TestD1Database();
  t.after(() => db.close());
  db.exec(await readFile(new URL("../migrations/0001_history_v1.sql", import.meta.url), "utf8"));
  const { maintainHistory } = await import("../platform/history.js?round9-repair");

  // Sixteen complete outage hours: raw evidence exists but no covering
  // hourly rollup, so every hour is a repair candidate.
  const firstHour = Date.parse("2026-08-04T00:00:00.000Z");
  const HOUR_MS = 3_600_000;
  for (let hourIndex = 0; hourIndex < 16; hourIndex += 1) {
    for (let quarter = 0; quarter < 4; quarter += 1) {
      const rawStart = firstHour + hourIndex * HOUR_MS + quarter * 15 * 60_000;
      await writeSnapshot(db, await encodeSnapshotRow({
        resolutionMinutes: 15,
        bucketStartMs: rawStart,
        periodEndMs: rawStart + 15 * 60_000,
        representativeAtMs: rawStart,
        collectedAtMs: rawStart,
        payload: { marker: `${hourIndex}:${quarter}` },
        expectedSamples: 1,
        collectedSamples: 1,
        sourceStatus: {},
        gaps: []
      }));
    }
  }
  const hourlyRows = () => db.sqlite.prepare(
    "SELECT bucket_start_ms FROM history_snapshots WHERE resolution_minutes = 60 ORDER BY bucket_start_ms"
  ).all().map((row) => Number(row.bucket_start_ms));

  const tickAt = firstHour + 17 * HOUR_MS;
  await maintainHistory({ HISTORY_DB: db }, tickAt);
  let rows = hourlyRows();
  // The clock-driven rollup covers the hour before the tick ([16:00, 17:00));
  // backlog repairs are capped at 12 per tick and take the OLDEST first.
  assert.ok(rows.includes(firstHour + 16 * HOUR_MS), "the clock hour still gets its rollup");
  assert.equal(rows.length, 13, `one tick repairs at most the capped batch plus the clock hour, saw ${rows.length}`);
  for (let hourIndex = 0; hourIndex < 12; hourIndex += 1) {
    assert.ok(rows.includes(firstHour + hourIndex * HOUR_MS), `outage hour ${hourIndex} was repaired`);
  }
  assert.ok(!rows.includes(firstHour + 15 * HOUR_MS), "newer backlog hours wait for later ticks");

  // A second tick drains the remaining backlog.
  await maintainHistory({ HISTORY_DB: db }, tickAt + 15 * 60_000);
  rows = hourlyRows();
  for (let hourIndex = 0; hourIndex < 16; hourIndex += 1) {
    assert.ok(rows.includes(firstHour + hourIndex * HOUR_MS), `outage hour ${hourIndex} is repaired after two ticks`);
  }

  // Completed hours stop being repair candidates: nothing changes further.
  const beforeIdle = hourlyRows();
  await maintainHistory({ HISTORY_DB: db }, tickAt + 2 * 15 * 60_000);
  assert.deepEqual(hourlyRows(), beforeIdle, "an idle tick must not rewrite completed hours");
});

test("both adapters answer unknown document paths with a true branded 404", async () => {
  const brandedPage = "<html><body><h1>Not found</h1></body></html>";
  const assets = {
    fetch: async (request) => {
      const path = new URL(request.url).pathname;
      if (path === "/404.html") return new Response(brandedPage, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } });
      if (path === "/index.html") throw new Error("the SPA fallback must not be consulted");
      return new Response(null, { status: 404 });
    }
  };
  for (const entry of ["server-entry.js", "cloudflare-entry.js"]) {
    const { default: worker } = await import(`../platform/${entry}?round9-404`);
    const response = await worker.fetch(new Request("https://day.illek.ie/junk-path"), { ASSETS: assets });
    assert.equal(response.status, 404, `${entry} must not soft-200 unknown documents`);
    assert.equal(response.headers.get("content-type"), "text/html; charset=utf-8");
    assert.equal(await response.text(), brandedPage);

    const missingAsset = await worker.fetch(new Request("https://day.illek.ie/nope.js"), { ASSETS: assets });
    assert.equal(missingAsset.status, 404, `${entry} keeps asset misses as plain 404 responses`);

    // Known pages still resolve through the assets binding untouched.
    const known = await worker.fetch(new Request("https://day.illek.ie/about"), {
      ASSETS: { fetch: async () => new Response("<html>about</html>", { status: 200 }) }
    });
    assert.equal(known.status, 200);
  }
});

test("alternate adapter health reports the shipped build provenance once per isolate", async () => {
  const { default: worker } = await import("../platform/server-entry.js?round9-health");
  const provenance = {
    source: { commitSha: "feedc0de" },
    builtAt: "2026-08-23T09:00:00.000Z",
    generatedData: { sha256: "datasha" },
    deploymentId: "not-deployed"
  };
  let assetFetches = 0;
  const env = {
    ASSETS: { fetch: async (request) => {
      assert.equal(new URL(request.url).pathname, "/build-provenance.json");
      assetFetches += 1;
      return new Response(JSON.stringify(provenance), { status: 200 });
    } }
  };
  const response = await worker.fetch(new Request("https://day.illek.ie/api/health"), env);
  const body = await response.json();
  assert.equal(body.status, "ok");
  assert.equal(body.build.commitSha, "feedc0de");
  assert.equal(body.build.transitDataSha256, "datasha");
  assert.equal(body.build.deploymentId, "unknown", "a local build must not claim a deployment id");
  await worker.fetch(new Request("https://day.illek.ie/api/health"), env);
  assert.equal(assetFetches, 1, "provenance reads are memoised");
});

test("alternate adapter coalesces concurrent living requests into one Irish Rail call", async () => {
  const { default: worker } = await import("../platform/server-entry.js?round9-coalesce");
  const originalFetch = globalThis.fetch;
  let irishRailCalls = 0;
  globalThis.fetch = async (url) => {
    const target = String(url);
    if (target.includes("api.irishrail.ie")) {
      irishRailCalls += 1;
      await new Promise((resolve) => setTimeout(resolve, 25));
      return new Response(trainXml, { status: 200 });
    }
    if (target.includes("waterlevel.ie")) return new Response(riverGeoJson(), { status: 200 });
    throw new Error(`unexpected fetch target ${target}`);
  };
  try {
    const [first, second] = await Promise.all([
      worker.fetch(new Request("https://day.illek.ie/api/living"), {}),
      worker.fetch(new Request("https://day.illek.ie/api/living"), {})
    ]);
    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    const firstPayload = await first.json();
    assert.equal(firstPayload.sourceStatus.trains, "live");
    assert.equal(irishRailCalls, 1, "concurrent cold requests must share one upstream refresh");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
