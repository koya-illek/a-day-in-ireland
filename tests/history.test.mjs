import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  canonicalJson,
  encodeSnapshotRow,
  gunzipJson,
  gzipJson,
  historyRange,
  mergeSourceStatus,
  previousDublinDayBounds,
  resolveHistory,
  rollupPeriod
} from "../platform/history-store.js";
import { buildHistoryCapture, handleHistoryRequest } from "../platform/history.js";
import {
  collectBathing,
  collectMarine,
  collectWeather,
  summarizeTransit
} from "../platform/history-sources.js";
import { historyLivingSnapshot } from "../platform/cloudflare-entry.js";

test("history payload encoding is canonical, deterministic, and gzip round-trips", async () => {
  const first = { z: 3, nested: { b: 2, a: 1 }, list: [{ y: 2, x: 1 }] };
  const second = { list: [{ x: 1, y: 2 }], nested: { a: 1, b: 2 }, z: 3 };
  assert.equal(canonicalJson(first), canonicalJson(second));
  const encodedFirst = await gzipJson(first);
  const encodedSecond = await gzipJson(second);
  assert.deepEqual(encodedFirst.compressed, encodedSecond.compressed);
  assert.deepEqual(await gunzipJson(encodedFirst.compressed), second);
  const rowFirst = await encodeSnapshotRow({
    resolutionMinutes: 15, bucketStartMs: 0, periodEndMs: 900_000, collectedAtMs: 1,
    payload: first, expectedSamples: 1, collectedSamples: 1, sourceStatus: {}, gaps: []
  });
  const rowSecond = await encodeSnapshotRow({
    resolutionMinutes: 15, bucketStartMs: 0, periodEndMs: 900_000, collectedAtMs: 2,
    payload: second, expectedSamples: 1, collectedSamples: 1, sourceStatus: {}, gaps: []
  });
  assert.equal(rowFirst.contentSha256, rowSecond.contentSha256);
  assert.ok(rowFirst.payloadBytes > 0);
  assert.equal(rowFirst.codec, "gzip-json-v1");
});

test("NTA history retains only normalized route aggregates and attribution", () => {
  const summary = summarizeTransit([
    { id: "secret-1", route: "2 NX c a", label: "private-label", latitude: 53, longitude: -6 },
    { id: "secret-2", route: "2 NX c b", label: "private-label-2", latitude: 54, longitude: -7 },
    { id: "secret-3", route: "opaque|internal|identifier", latitude: 52, longitude: -8 }
  ], "live", "2026-08-05T00:00:00.000Z");
  assert.deepEqual(summary.byRoute, [{ route: "NX", count: 2 }]);
  assert.equal(summary.vehicles, 3);
  assert.equal(summary.routes, 1);
  assert.equal(summary.unmappedRouteVehicles, 1);
  assert.equal(summary.attribution.license, "CC BY 4.0");
  assert.equal(summary.attribution.source, "NTA Developer Portal");
  assert.match(summary.attribution.changes, /aggregated/i);
  assert.match(summary.attribution.disclaimer, /not responsible.*not endorse/i);
  const serialized = JSON.stringify(summary);
  for (const forbidden of ["secret-1", "private-label", "latitude", "longitude", "opaque|internal"] ) {
    assert.doesNotMatch(serialized, new RegExp(forbidden.replace(/[|]/g, "\\|")));
  }

  const unavailable = summarizeTransit([], "unavailable", "2026-08-05T00:00:00.000Z");
  assert.equal(unavailable, null);
});

test("history capture is fail-closed for Irish Rail and truthful during provider failure", async () => {
  const failedFetch = async () => new Response("unavailable", { status: 503 });
  const capture = await buildHistoryCapture({
    env: { NTA_API_KEY: "configured" },
    capturedAtMs: Date.parse("2026-08-05T00:00:00.000Z"),
    fetcher: failedFetch,
    loadLiving: async () => ({
      trains: [{ id: "must-not-retain", direction: "Southbound", status: "running", message: "private" }],
      rivers: [],
      sourceStatus: { trains: "live", rivers: "unavailable" },
      sourceProvenance: { trains: { latestObservedAt: "2026-08-05T00:00:00.000Z" } }
    }),
    loadTransit: async () => ({
      transitStatus: "live",
      transit: [{ id: "vehicle-secret", route: "1 15 c a", label: "hidden", latitude: 53, longitude: -6, observedAt: "2026-08-05T00:00:00.000Z" }]
    })
  });
  assert.equal(capture.payload.movementSummary.rail, null);
  assert.equal(capture.sources.rail.status, "unavailable");
  assert.ok(capture.gaps.some((item) => item.source === "rail" && item.reason === "not-retained"));
  assert.ok(capture.gaps.some((item) => item.source === "weather"));
  assert.deepEqual(capture.payload.snapshot.stations, []);
  assert.equal(capture.payload.snapshot.summary.reporting, null);
  assert.equal(capture.payload.snapshot.summary.runningTrains, null);
  const serialized = JSON.stringify(capture.payload);
  assert.doesNotMatch(serialized, /must-not-retain|vehicle-secret|"latitude":53|"longitude":-6/);
});

test("unavailable movement providers remain unknown rather than becoming zero", async () => {
  const failedFetch = async () => new Response("unavailable", { status: 503 });
  const capture = await buildHistoryCapture({
    env: { NTA_API_KEY: "configured" },
    capturedAtMs: Date.parse("2026-08-05T00:00:00.000Z"),
    fetcher: failedFetch,
    loadLiving: async () => ({
      trains: [], rivers: [],
      sourceStatus: { trains: "unavailable", rivers: "unavailable" },
      sourceProvenance: {}
    }),
    loadTransit: async () => ({ transit: [], transitStatus: "unavailable" })
  });
  assert.deepEqual(capture.payload.movementSummary, { rail: null, transit: null });
  assert.equal(capture.sources.rail.itemCount, null);
  assert.equal(capture.sources.transit.itemCount, null);
  assert.equal(capture.payload.snapshot.summary.runningTrains, null);
  assert.equal(capture.payload.snapshot.summary.riverStations, null);
});

test("weather is partial when any configured station is absent", async () => {
  const now = Date.parse("2026-08-05T00:00:00.000Z");
  const providerNames = new Map([
    ["malin-head", "Malin Head"], ["finner", "Finner"], ["belmullet", "Belmullet"],
    ["athenry", "Athenry"], ["dublin", "Dublin Airport"], ["gurteen", "Gurteen"],
    ["valentia", "Valentia"], ["cork", "Cork"], ["johnstown-castle", "Johnstown Castle"]
  ]);
  const fetcher = async (input) => {
    const endpoint = new URL(input).pathname.split("/").at(-2);
    if (endpoint === "johnstown-castle") return Response.json([]);
    return Response.json([{
      name: providerNames.get(endpoint), date: "05-08-2026", reportTime: "00:30",
      temperature: "12", rainfall: "0", windSpeed: "4", cardinalWindDirection: "W",
      weatherDescription: "Cloudy"
    }]);
  };
  const result = await collectWeather(fetcher, now);
  assert.equal(result.envelope.status, "partial");
  assert.equal(result.envelope.data.summary.reporting, 8);
  assert.ok(result.gaps.some((item) => item.source === "weather" && item.reason === "partial-provider-response"));
});

test("marine history is explicitly partial while coastal sources are excluded", async () => {
  const now = Date.parse("2026-08-05T00:00:00.000Z");
  const result = await collectMarine(async () => Response.json({
    table: { rows: [["M2", -5.4, 53.5, "2026-08-04T23:30:00.000Z", 10, 1.2, 5, 14]] }
  }), now);
  assert.equal(result.envelope.status, "partial");
  assert.equal(result.envelope.data.length, 1);
  assert.ok(result.gaps.some((item) => item.reason === "partial-provider-coverage"));
});

test("bathing alerts without authoritative coordinates are omitted and gapped", async () => {
  const now = Date.parse("2026-08-05T00:00:00.000Z");
  const fetcher = async (input) => String(input).includes("/alerts")
    ? Response.json({ list: [{
        incident_id: 77, beach_id: 99, beach_name: "Unknown beach", county_name: "Cork",
        incident_start_date: "2026-08-04T00:00:00Z", incident_end_date: null,
        bathing_restriction_type: "Advice", incident_description: "Test"
      }] })
    : Response.json({ list: [] });
  const result = await collectBathing(fetcher, now);
  assert.equal(result.envelope.status, "partial");
  assert.deepEqual(result.envelope.data, []);
  assert.ok(result.gaps.some((item) => item.reason === "missing-location"));
  assert.doesNotMatch(JSON.stringify(result), /"latitude":0|"longitude":0/);
});

test("default history living loader does not call Irish Rail", async () => {
  let riverCalls = 0;
  const result = await historyLivingSnapshot({
    RIVER_FEED: {
      getByName() {
        return { async fetch() {
          riverCalls += 1;
          return Response.json({ rivers: [{ id: "river-1" }], status: "live" });
        } };
      }
    }
  });
  assert.equal(riverCalls, 1);
  assert.deepEqual(result.trains, []);
  assert.equal(result.sourceStatus.trains, "unavailable");
  assert.deepEqual(result.rivers, [{ id: "river-1" }]);
});

const makeReadDb = (rows) => ({
  prepare(sql) {
    return {
      values: [],
      bind(...values) { this.values = values; return this; },
      async all() {
        if (sql.includes("GROUP BY resolution_minutes")) {
          const grouped = new Map();
          for (const row of rows) grouped.set(row.resolution_minutes, [...(grouped.get(row.resolution_minutes) ?? []), row]);
          return { results: [...grouped].map(([resolution, items]) => ({
            resolution_minutes: resolution,
            available_from_ms: Math.min(...items.map((item) => item.bucket_start_ms)),
            available_to_ms: Math.max(...items.map((item) => item.bucket_start_ms)),
            snapshot_count: items.length
          })).sort((a, b) => a.resolution_minutes - b.resolution_minutes) };
        }
        throw new Error(`Unexpected all query: ${sql}`);
      },
      async first() {
        const [resolution, at] = this.values;
        const candidates = rows.filter((row) => row.resolution_minutes === resolution);
        if (sql.includes("bucket_start_ms <=")) {
          return candidates.filter((row) => row.bucket_start_ms <= at).sort((a, b) => b.bucket_start_ms - a.bucket_start_ms)[0] ?? null;
        }
        if (sql.includes("bucket_start_ms <")) {
          const row = candidates.filter((item) => item.bucket_start_ms < at).sort((a, b) => b.bucket_start_ms - a.bucket_start_ms)[0];
          return row ? { bucket_start_ms: row.bucket_start_ms } : null;
        }
        if (sql.includes("bucket_start_ms >")) {
          const row = candidates.filter((item) => item.bucket_start_ms > at).sort((a, b) => a.bucket_start_ms - b.bucket_start_ms)[0];
          return row ? { bucket_start_ms: row.bucket_start_ms } : null;
        }
        throw new Error(`Unexpected first query: ${sql}`);
      }
    };
  }
});

test("nearest history lookup is strictly at-or-before and exposes navigation", async () => {
  const base = Date.parse("2026-08-05T12:00:00.000Z");
  const makeRow = async (offset, label) => {
    const encoded = await gzipJson({ snapshot: { generatedAt: new Date(base + offset).toISOString(), label }, movementSummary: { rail: null, transit: null }, gaps: [] });
    return {
      resolution_minutes: 15,
      bucket_start_ms: base + offset,
      period_end_ms: base + offset + 900_000,
      collected_at_ms: base + offset,
      schema_version: 1,
      codec: "gzip-json-v1",
      payload: encoded.compressed,
      payload_bytes: encoded.compressed.byteLength,
      uncompressed_bytes: encoded.uncompressedBytes,
      content_sha256: "hash",
      expected_samples: 1,
      collected_samples: 1,
      source_status_json: "{}",
      gaps_json: "[]"
    };
  };
  const rows = [await makeRow(0, "earlier"), await makeRow(15 * 60_000, "future")];
  const result = await resolveHistory(makeReadDb(rows), base + 10 * 60_000, base + 20 * 60_000);
  assert.equal(result.resolvedAt, new Date(base).toISOString());
  assert.equal(result.snapshot.label, "earlier");
  assert.equal(result.nextAt, new Date(base + 15 * 60_000).toISOString());
});

test("history range reports the finest tier at the freshest available instant", async () => {
  const latest = Date.parse("2026-08-05T12:00:00.000Z");
  const range = await historyRange(makeReadDb([
    { resolution_minutes: 1440, bucket_start_ms: latest - 86_400_000 },
    { resolution_minutes: 60, bucket_start_ms: latest },
    { resolution_minutes: 15, bucket_start_ms: latest }
  ]));
  assert.equal(range.availableTo, new Date(latest).toISOString());
  assert.equal(range.resolutionMinutes, 15);
  assert.deepEqual(range.resolutions.map((item) => item.resolutionMinutes), [15, 60, 1440]);
});

test("source coverage merging preserves unavailable samples rather than zero-filling", () => {
  const rows = [
    { source_status_json: JSON.stringify({ weather: { status: "live" } }) },
    { source_status_json: JSON.stringify({ weather: { status: "unavailable" } }) },
    { source_status_json: JSON.stringify({ weather: { status: "live" } }) }
  ];
  const merged = mergeSourceStatus(rows, ["weather"], 4);
  assert.equal(merged.weather.status, "partial");
  assert.deepEqual(merged.weather.counts, {
    live: 2, partial: 0, fallback: 0, stale: 0, unavailable: 2, "credential-required": 0
  });
});

test("Europe/Dublin daily rollup boundaries preserve DST day lengths", () => {
  const spring = previousDublinDayBounds(Date.parse("2026-03-30T00:30:00.000Z"));
  const autumn = previousDublinDayBounds(Date.parse("2026-10-26T01:30:00.000Z"));
  assert.equal((spring.end - spring.start) / 3_600_000, 23);
  assert.equal((autumn.end - autumn.start) / 3_600_000, 25);
});

test("daily rollups are summary-only and never clone a point-in-time map", async () => {
  const start = Date.parse("2026-08-04T23:00:00.000Z");
  const encoded = await gzipJson({
    schemaVersion: 1,
    capturedAt: new Date(start).toISOString(),
    resolutionMinutes: 60,
    snapshot: { generatedAt: new Date(start).toISOString(), stations: [{ id: "must-not-survive" }] },
    movementSummary: { rail: { total: 4 }, transit: { total: 20 } },
    gaps: []
  });
  const inputRow = {
    resolution_minutes: 60,
    bucket_start_ms: start,
    period_end_ms: start + 3_600_000,
    collected_at_ms: start,
    schema_version: 1,
    codec: "gzip-json-v1",
    payload: encoded.compressed,
    payload_bytes: encoded.compressed.byteLength,
    uncompressed_bytes: encoded.uncompressedBytes,
    content_sha256: "input-hash",
    expected_samples: 1,
    collected_samples: 1,
    source_status_json: JSON.stringify({ weather: { status: "live" } }),
    gaps_json: "[]"
  };
  const db = {
    prepare(sql) {
      return {
        bind() { return this; },
        async all() {
          assert.match(sql, /FROM history_snapshots/);
          return { results: [inputRow] };
        },
        async run() {
          assert.match(sql, /INSERT INTO history_snapshots/);
          return { success: true };
        }
      };
    }
  };
  const row = await rollupPeriod(db, {
    fromResolutionMinutes: 60,
    resolutionMinutes: 1440,
    startMs: start,
    endMs: start + 24 * 3_600_000,
    expectedSamples: 24,
    sourceKeys: ["weather"],
    emptyPayload: () => ({}),
    summaryOnly: true
  });
  const payload = await gunzipJson(row.payload);
  assert.equal(payload.snapshot, null);
  assert.deepEqual(payload.movementSummary, { rail: null, transit: null });
  assert.ok(payload.gaps.some((item) => item.reason === "summary-only"));
  assert.doesNotMatch(JSON.stringify(payload), /must-not-survive/);
});

test("history API isolates a missing binding and rejects invalid or future timestamps", async () => {
  const missing = await handleHistoryRequest(new Request("https://day.illek.ie/api/history/range"), {});
  assert.equal(missing.status, 503);
  const db = makeReadDb([]);
  const invalid = await handleHistoryRequest(new Request("https://day.illek.ie/api/history?at=nope"), { HISTORY_DB: db });
  assert.equal(invalid.status, 400);
  const dateOnly = await handleHistoryRequest(new Request("https://day.illek.ie/api/history?at=2026-08-05"), { HISTORY_DB: db });
  assert.equal(dateOnly.status, 400);
  const noTimezone = await handleHistoryRequest(new Request("https://day.illek.ie/api/history?at=2026-08-04T23:00:00"), { HISTORY_DB: db });
  assert.equal(noTimezone.status, 400);
  const invalidCalendar = await handleHistoryRequest(new Request("https://day.illek.ie/api/history?at=2026-02-30T23:00:00Z"), { HISTORY_DB: db });
  assert.equal(invalidCalendar.status, 400);
  const future = await handleHistoryRequest(
    new Request("https://day.illek.ie/api/history?at=2026-08-06T00:00:00.000Z"),
    { HISTORY_DB: db },
    Date.parse("2026-08-05T00:00:00.000Z")
  );
  assert.equal(future.status, 400);
  const post = await handleHistoryRequest(new Request("https://day.illek.ie/api/history/range", { method: "POST" }), { HISTORY_DB: db });
  assert.equal(post.status, 405);
  assert.equal(post.headers.get("allow"), "GET, HEAD");
  const head = await handleHistoryRequest(new Request("https://day.illek.ie/api/history/range", { method: "HEAD" }), { HISTORY_DB: db });
  assert.equal(head.status, 200);
  const range = await historyRange(db);
  assert.deepEqual(range, {
    schemaVersion: 1, availableFrom: null, availableTo: null,
    resolutionMinutes: null, resolutions: [], snapshotCount: 0
  });
});

test("migration and Wrangler configs enforce aggregate BLOB storage and safe provisioning", async () => {
  const migration = await readFile(new URL("../migrations/0001_history_v1.sql", import.meta.url), "utf8");
  const production = await readFile(new URL("../wrangler.api.toml", import.meta.url), "utf8");
  const local = await readFile(new URL("../wrangler.history.local.toml", import.meta.url), "utf8");
  assert.match(migration, /payload BLOB NOT NULL/);
  assert.match(migration, /codec TEXT NOT NULL/);
  assert.doesNotMatch(migration, /history_observations/);
  assert.match(production, /crons = \["\*\/15 \* \* \* \*", "7 \* \* \* \*"\]/);
  assert.doesNotMatch(production, /^\s*\[\[d1_databases\]\]/m);
  assert.match(local, /binding = "HISTORY_DB"/);
  assert.match(local, /database_name = "a-day-in-ireland-history-local"/);
});
