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
  pruneHistory,
  resolveHistory,
  rollupPeriod,
  summarizeDailyRepresentatives,
  writeSnapshot
} from "../platform/history-store.js";
import { buildHistoryCapture, captureHistory, handleHistoryRequest, maintainHistory } from "../platform/history.js";
import {
  collectBathing,
  collectEarthquakes,
  collectMarine,
  collectModelledAir,
  collectTides,
  collectWarnings,
  collectWeather,
  eirGridDublinHourWindow,
  summarizeTransit
} from "../platform/history-sources.js";
import { historyLivingSnapshot, runPaidHistoryTick } from "../platform/cloudflare-entry.js";
import { TestD1Database } from "./d1-test-helper.mjs";

test("paid tick captures every quarter-hour and maintains only at minute 15", async () => {
  const calls = [];
  const capture = async (_env, scheduledTime, loaders) => {
    calls.push(["capture", scheduledTime]);
    assert.equal(typeof loaders.loadLiving, "function");
    assert.equal(typeof loaders.loadTransit, "function");
    return { skipped: false };
  };
  const maintain = async (_env, scheduledTime) => { calls.push(["maintain", scheduledTime]); };
  const at00 = Date.parse("2026-08-05T12:00:00.000Z");
  const at15 = Date.parse("2026-08-05T12:15:00.000Z");
  await runPaidHistoryTick({}, at00, { capture, maintain });
  await runPaidHistoryTick({}, at15, { capture, maintain });
  assert.deepEqual(calls, [
    ["capture", at00],
    ["capture", at15],
    ["maintain", at15]
  ]);
});

test("paid scheduler stays fail-closed for Irish Rail when the legacy opt-in flag is set", async () => {
  const originalFetch = globalThis.fetch;
  let upstreamCalls = 0;
  let riverCalls = 0;
  const scheduledTime = Date.parse("2026-08-05T12:00:00.000Z");
  const env = {
    HISTORY_INCLUDE_IRISH_RAIL: "true",
    RIVER_FEED: {
      getByName() {
        return { async fetch() {
          riverCalls += 1;
          return Response.json({ rivers: [{ id: "river-1" }], status: "live" });
        } };
      }
    }
  };
  globalThis.fetch = async () => {
    upstreamCalls += 1;
    return new Response("unexpected upstream call", { status: 503 });
  };
  try {
    await runPaidHistoryTick(env, scheduledTime, {
      capture: async (_env, cutoff, loaders) => {
        const living = await loaders.loadLiving(cutoff);
        assert.deepEqual(living.trains, []);
        assert.equal(living.sourceStatus.trains, "unavailable");
        return { skipped: false };
      },
      maintain: async () => {}
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(riverCalls, 1);
  assert.equal(upstreamCalls, 0);
});

test("paid minute-15 tick settles capture and maintenance independently and reports every failure", async () => {
  const at15 = Date.parse("2026-08-05T12:15:00.000Z");
  let maintenanceFinished = false;
  await assert.rejects(
    runPaidHistoryTick({}, at15, {
      capture: async () => { throw new Error("capture-sentinel-failure"); },
      maintain: async () => {
        await new Promise((resolve) => setImmediate(resolve));
        maintenanceFinished = true;
      }
    }),
    (error) => {
      assert.ok(error instanceof AggregateError);
      assert.match(error.message, /capture/);
      assert.deepEqual(error.failures.map((failure) => failure.operation), ["capture"]);
      assert.match(String(error.errors[0]), /capture-sentinel-failure/);
      return true;
    }
  );
  assert.equal(maintenanceFinished, true);

  let captureFinished = false;
  await assert.rejects(
    runPaidHistoryTick({}, at15, {
      capture: async () => {
        await new Promise((resolve) => setImmediate(resolve));
        captureFinished = true;
        return { skipped: false };
      },
      maintain: async () => { throw new Error("maintenance-sentinel-failure"); }
    }),
    (error) => {
      assert.ok(error instanceof AggregateError);
      assert.match(error.message, /maintenance/);
      assert.deepEqual(error.failures.map((failure) => failure.operation), ["maintenance"]);
      assert.match(String(error.errors[0]), /maintenance-sentinel-failure/);
      return true;
    }
  );
  assert.equal(captureFinished, true);
});

test("direct paid capture claims a bucket once and passes its cutoff to both coordinator loaders", async (t) => {
  const db = new TestD1Database();
  t.after(() => db.close());
  db.exec(await readFile(new URL("../migrations/0001_history_v1.sql", import.meta.url), "utf8"));
  const cutoff = Date.parse("2026-08-05T12:15:00.000Z");
  const loaderCutoffs = [];
  const loaders = {
    scoped: { sources: {}, gaps: [] },
    loadLiving: async (value) => {
      loaderCutoffs.push(["living", value]);
      return { trains: [], rivers: [], sourceStatus: { trains: "unavailable", rivers: "unavailable" }, sourceProvenance: {} };
    },
    loadTransit: async (value) => {
      loaderCutoffs.push(["transit", value]);
      return { transit: [], transitStatus: "unavailable", aggregate: null, latestObservedAt: null };
    }
  };
  const results = await Promise.all([
    captureHistory({ HISTORY_DB: db, NTA_API_KEY: "configured" }, cutoff, loaders),
    captureHistory({ HISTORY_DB: db, NTA_API_KEY: "configured" }, cutoff, loaders)
  ]);
  assert.equal(results.filter((result) => result.skipped === false).length, 1);
  assert.deepEqual(results.find((result) => result.skipped), {
    skipped: true,
    reason: "duplicate-bucket",
    bucketStartMs: cutoff
  });
  assert.deepEqual(loaderCutoffs, [["living", cutoff], ["transit", cutoff]]);
  assert.equal(Number(db.sqlite.prepare("SELECT COUNT(*) AS count FROM history_snapshots").get().count), 1);
  const runs = db.sqlite.prepare(`SELECT outcome, completed_at_ms FROM history_collection_runs
    WHERE bucket_start_ms = ?`).all(cutoff);
  assert.equal(runs.length, 1);
  assert.notEqual(runs[0].outcome, "running");
  assert.ok(Number.isFinite(Number(runs[0].completed_at_ms)));
});

test("migration v1 alone supports direct capture, hourly and daily maintenance, and pruning", async (t) => {
  const db = new TestD1Database();
  t.after(() => db.close());
  db.exec(await readFile(new URL("../migrations/0001_history_v1.sql", import.meta.url), "utf8"));
  const capturedAt = Date.parse("2026-08-05T12:00:00.000Z");
  const loaders = {
    scoped: { sources: {}, gaps: [] },
    loadLiving: async () => ({
      trains: [], rivers: [],
      sourceStatus: { trains: "unavailable", rivers: "unavailable" },
      sourceProvenance: {}
    }),
    loadTransit: async () => ({
      transit: [], transitStatus: "unavailable", aggregate: null, latestObservedAt: null
    })
  };
  await captureHistory({ HISTORY_DB: db, NTA_API_KEY: "configured" }, capturedAt, loaders);
  await maintainHistory({ HISTORY_DB: db }, Date.parse("2026-08-05T13:15:00.000Z"));
  await maintainHistory({ HISTORY_DB: db }, Date.parse("2026-08-05T23:15:00.000Z"));
  await maintainHistory({ HISTORY_DB: db }, Date.parse("2026-08-06T02:15:00.000Z"));
  const rows = db.sqlite.prepare(`SELECT resolution_minutes, COUNT(*) AS count
    FROM history_snapshots GROUP BY resolution_minutes ORDER BY resolution_minutes`).all();
  assert.deepEqual(rows.map((row) => [Number(row.resolution_minutes), Number(row.count)]), [
    [15, 1], [60, 3], [1440, 1]
  ]);
  assert.equal(Number(db.sqlite.prepare("SELECT COUNT(*) AS count FROM history_collection_runs").get().count), 1);

  const insertFixture = async (resolutionMinutes, bucketStartMs, periodEndMs, label) => {
    const row = await encodeSnapshotRow({
      resolutionMinutes,
      bucketStartMs,
      periodEndMs,
      representativeAtMs: resolutionMinutes === 1440 ? null : bucketStartMs,
      collectedAtMs: periodEndMs,
      payload: { label },
      expectedSamples: 1,
      collectedSamples: 1,
      sourceStatus: {},
      gaps: []
    });
    await writeSnapshot(db, row);
  };
  const pruneAt = Date.parse("2026-08-06T03:15:00.000Z");
  const expiredRaw = Date.parse("2026-06-01T12:15:00.000Z");
  const liveRawHour = Date.parse("2026-08-05T12:00:00.000Z");
  const expiredHour = Date.parse("2025-07-01T12:00:00.000Z");
  const liveHour = Date.parse("2026-07-01T12:00:00.000Z");
  const coveringDay = Date.parse("2025-07-01T00:00:00.000Z");
  // Rows past their published window are pruned even when no coarser rollup
  // ever covered them (an outage hour can never become complete).
  await insertFixture(15, expiredRaw, expiredRaw + 15 * 60_000, "expired-unrolled-raw");
  // Rows inside their windows are never pruned.
  await insertFixture(60, liveRawHour, liveRawHour + 60 * 60_000, "live-hourly-recent");
  await insertFixture(60, expiredHour, expiredHour + 60 * 60_000, "expired-hourly-covered");
  await insertFixture(60, liveHour, liveHour + 60 * 60_000, "live-hourly-within-year");
  await insertFixture(1440, coveringDay, coveringDay + 24 * 60 * 60_000, "covering-day");
  await pruneHistory(db, pruneAt);
  const retainedFixtureTimes = new Set(db.sqlite.prepare(`SELECT resolution_minutes, bucket_start_ms
    FROM history_snapshots`).all().map((row) => `${row.resolution_minutes}:${row.bucket_start_ms}`));
  assert.equal(retainedFixtureTimes.has(`15:${expiredRaw}`), false, "raw data is pruned at its retention window even without rollup coverage");
  assert.equal(retainedFixtureTimes.has(`60:${expiredHour}`), false, "hourly data is pruned at its retention window even before its covering daily row");
  assert.equal(retainedFixtureTimes.has(`60:${liveRawHour}`), true, "recent hourly coverage is preserved");
  assert.equal(retainedFixtureTimes.has(`60:${liveHour}`), true, "hourly data within its window is preserved");
  assert.equal(retainedFixtureTimes.has(`1440:${coveringDay}`), true, "daily summaries are retained indefinitely");
});

test("pruning enforces the published windows through the real maintenance path after an outage hour", async (t) => {
  const db = new TestD1Database();
  t.after(() => db.close());
  db.exec(await readFile(new URL("../migrations/0001_history_v1.sql", import.meta.url), "utf8"));
  const { maintainHistory } = await import("../platform/history.js");

  const insert = async ({ resolutionMinutes, bucketStartMs, periodEndMs, collectedAtMs, expectedSamples, collectedSamples }) => {
    await writeSnapshot(db, await encodeSnapshotRow({
      resolutionMinutes,
      bucketStartMs,
      periodEndMs,
      representativeAtMs: resolutionMinutes === 1440 ? null : bucketStartMs,
      collectedAtMs,
      payload: { marker: `${resolutionMinutes}:${bucketStartMs}` },
      expectedSamples,
      collectedSamples,
      sourceStatus: {},
      gaps: []
    }));
  };

  // An outage hour from over a year ago: only two of four raw snapshots
  // arrived, so the hourly rollup stayed incomplete forever and the daily
  // summary froze before the last repair bumped the hourly row.
  const outageRawA = Date.parse("2025-06-01T12:00:00.000Z");
  const outageRawB = Date.parse("2025-06-01T12:30:00.000Z");
  const outageHour = Date.parse("2025-06-01T12:00:00.000Z");
  // Dublin-day bounds for 2025-06-01 (IST = UTC+1).
  const outageDay = Date.parse("2025-05-31T23:00:00.000Z");
  await insert({ resolutionMinutes: 15, bucketStartMs: outageRawA, periodEndMs: outageRawA + 15 * 60_000, collectedAtMs: outageRawA, expectedSamples: 1, collectedSamples: 1 });
  await insert({ resolutionMinutes: 15, bucketStartMs: outageRawB, periodEndMs: outageRawB + 15 * 60_000, collectedAtMs: outageRawB, expectedSamples: 1, collectedSamples: 1 });
  await insert({ resolutionMinutes: 1440, bucketStartMs: outageDay, periodEndMs: outageDay + 24 * 3_600_000, collectedAtMs: Date.parse("2025-06-01T23:45:00.000Z"), expectedSamples: 24, collectedSamples: 24 });
  // A maintenance tick repairs the incomplete hour (48 h lookback), bumping
  // its collected_at past the frozen daily row — the state that permanently
  // inverted the former prune predicates.
  await maintainHistory({ HISTORY_DB: db }, outageHour + 25 * 3_600_000);
  const repaired = db.sqlite.prepare(`
    SELECT collected_at_ms, collected_samples FROM history_snapshots
    WHERE resolution_minutes = 60 AND bucket_start_ms = ?
  `).get(outageHour);
  assert.ok(repaired, "repair must have produced an hourly row for the outage hour");
  assert.equal(Number(repaired.collected_samples), 2);
  const dailyCollectedAt = Number(db.sqlite.prepare(`
    SELECT collected_at_ms FROM history_snapshots WHERE resolution_minutes = 1440
  `).get().collected_at_ms);
  assert.ok(Number(repaired.collected_at_ms) > dailyCollectedAt, "fixture must reproduce the collected_at inversion");

  // A recent incomplete hour must survive; everything past its window must go.
  const recentRaw = Date.parse("2026-08-05T12:00:00.000Z");
  await insert({ resolutionMinutes: 15, bucketStartMs: recentRaw, periodEndMs: recentRaw + 15 * 60_000, collectedAtMs: recentRaw, expectedSamples: 1, collectedSamples: 1 });
  // 02:15Z is 03:15 in Dublin in August — the pruning hour.
  await maintainHistory({ HISTORY_DB: db }, Date.parse("2026-08-06T02:15:00.000Z"));
  const retained = new Set(db.sqlite.prepare("SELECT resolution_minutes, bucket_start_ms FROM history_snapshots")
    .all().map((row) => `${row.resolution_minutes}:${row.bucket_start_ms}`));
  assert.equal(retained.has(`60:${outageHour}`), false, "the incomplete outage-hour rollup cannot outlive its retention window");
  assert.equal(retained.has(`15:${outageRawA}`), false, "outage-hour raw rows cannot outlive their retention window");
  assert.equal(retained.has(`15:${outageRawB}`), false, "outage-hour raw rows cannot outlive their retention window");
  assert.equal(retained.has(`1440:${outageDay}`), true, "daily summaries are retained indefinitely");
  assert.equal(retained.has(`15:${recentRaw}`), true, "raw rows within their window are preserved");
});

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

test("history compression and decompression consume transform streams without backpressure deadlock", async () => {
  const withTimeout = async (operation, label) => {
    let timer;
    try {
      return await Promise.race([
        operation,
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error(`${label}-timeout`)), 5_000);
        })
      ]);
    } finally {
      clearTimeout(timer);
    }
  };
  let state = 0x12345678;
  const noise = Array.from({ length: 140_000 }, () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return String.fromCharCode(32 + state % 95);
  }).join("");
  const incompressible = { noise };
  const encodedNoise = await withTimeout(gzipJson(incompressible), "incompressible-compression");
  assert.ok(encodedNoise.uncompressedBytes > 100_000);
  assert.ok(encodedNoise.compressed.byteLength > 65_536, "fixture must exceed the old transform backpressure threshold");
  assert.deepEqual(
    await withTimeout(gunzipJson(encodedNoise.compressed), "incompressible-decompression"),
    incompressible
  );

  const expanding = { repeated: "x".repeat(250_000) };
  const encodedExpanding = await withTimeout(gzipJson(expanding), "compressible-compression");
  assert.ok(encodedExpanding.compressed.byteLength < 65_536);
  assert.deepEqual(
    await withTimeout(gunzipJson(encodedExpanding.compressed), "high-expansion-decompression"),
    expanding
  );
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

test("late history capture excludes post-cutoff warning updates but keeps future validity intervals", async () => {
  const cutoff = Date.parse("2026-08-05T12:00:00.000Z");
  const warning = (id, issued, updated, onset = "2026-08-05T10:00:00.000Z") => ({
    id,
    capId: `cap-${id}`,
    type: "Rain",
    severity: "Moderate",
    certainty: "Likely",
    regions: ["EI27"],
    status: "Warning",
    issued,
    updated,
    level: "Yellow",
    headline: id,
    description: `${id} description`,
    onset,
    expiry: "2026-08-06T12:00:00.000Z"
  });
  const result = await collectWarnings(async () => Response.json([
    warning("before-cutoff", "2026-08-05T10:00:00.000Z", "2026-08-05T11:30:00.000Z"),
    warning("updated-after-cutoff", "2026-08-05T10:00:00.000Z", "2026-08-05T12:00:00.001Z"),
    warning("issued-after-cutoff", "2026-08-05T12:00:00.001Z", "2026-08-05T12:00:00.001Z", "2026-08-05T13:00:00.000Z")
  ]), cutoff);
  assert.equal(result.envelope.status, "partial");
  assert.equal(result.envelope.errorCode, "post-cutoff-update");
  assert.deepEqual(result.envelope.data.map((item) => item.id), ["before-cutoff"]);
  assert.equal(result.envelope.data[0].expiry, "2026-08-06T12:00:00.000Z");
  assert.ok(Date.parse(result.envelope.data[0].issued) <= cutoff);
  assert.ok(Date.parse(result.envelope.data[0].updated) <= cutoff);
  assert.equal(result.gaps.length, 1);
  assert.equal(result.gaps[0].reason, "post-cutoff-update");
  assert.match(result.gaps[0].detail, /^1 warning record was updated/);
});

test("late history capture excludes post-cutoff bathing updates but keeps active notices with future ends", async () => {
  const cutoff = Date.parse("2026-08-05T12:00:00.000Z");
  const alert = (incidentId, beachId, startedAt, updatedAt) => ({
    incident_id: incidentId,
    beach_id: beachId,
    beach_name: `Beach ${incidentId}`,
    county_name: "Cork",
    incident_start_date: startedAt,
    incident_end_date: "2026-08-06T12:00:00.000Z",
    last_updated: updatedAt,
    bathing_restriction_type: "Advice",
    incident_description: `${incidentId} description`
  });
  const fetcher = async (input) => String(input).includes("/alerts")
    ? Response.json({ list: [
        alert("before-cutoff", "beach-before", "2026-08-05T10:00:00.000Z", "2026-08-05T11:30:00.000Z"),
        alert("updated-after-cutoff", "beach-updated", "2026-08-05T10:00:00.000Z", "2026-08-05T12:00:00.001Z"),
        alert("started-after-cutoff", "beach-future", "2026-08-05T12:00:00.001Z", "2026-08-05T12:00:00.001Z")
      ] })
    : Response.json({ list: [
        { beach_id: "beach-before", latitude: 51.9, longitude: -8.5 },
        { beach_id: "beach-updated", latitude: 52.0, longitude: -8.4 },
        { beach_id: "beach-future", latitude: 52.1, longitude: -8.3 }
      ] });
  const result = await collectBathing(fetcher, cutoff);
  assert.equal(result.envelope.status, "partial");
  assert.deepEqual(result.envelope.data.map((item) => item.id), ["bathing-before-cutoff"]);
  assert.equal(result.envelope.data[0].endsAt, "2026-08-06T12:00:00.000Z");
  assert.ok(Date.parse(result.envelope.data[0].startedAt) <= cutoff);
  assert.ok(Date.parse(result.envelope.data[0].updatedAt) <= cutoff);
  assert.equal(result.gaps.length, 1);
  assert.equal(result.gaps[0].reason, "post-cutoff-update");
  assert.match(result.gaps[0].detail, /^1 active bathing notice was updated/);
});

test("earthquake history filters by cutoff before capping and reports truncation", async () => {
  const cutoff = Date.parse("2026-08-05T12:00:00.000Z");
  const feature = (id, observedAt) => ({
    id,
    geometry: { coordinates: [-8, 53, 5] },
    properties: { mag: 1.2, time: observedAt, place: id, url: `https://example.test/${id}` }
  });
  const postCutoff = Array.from({ length: 30 }, (_, index) => feature(`future-${index}`, cutoff + index + 1));
  const older = feature("valid-before-cutoff", cutoff - 1_000);
  const filtered = await collectEarthquakes(async () => Response.json({ features: [...postCutoff, older] }), cutoff);
  assert.equal(filtered.envelope.status, "live");
  assert.deepEqual(filtered.envelope.data.map((item) => item.id), ["valid-before-cutoff"]);

  const valid = Array.from({ length: 31 }, (_, index) => feature(`valid-${index}`, cutoff - index * 1_000));
  const capped = await collectEarthquakes(async () => Response.json({ features: valid }), cutoff);
  assert.equal(capped.envelope.status, "partial");
  assert.equal(capped.envelope.errorCode, "result-cap");
  assert.equal(capped.envelope.data.length, 30);
  assert.ok(capped.gaps.some((item) => item.reason === "result-cap"));
});

test("modelled-air history status reflects all seven configured locations", async () => {
  const now = Date.parse("2026-08-05T12:00:00.000Z");
  const current = { time: "2026-08-05T11:00", european_aqi: 20 };
  const partial = await collectModelledAir(async () => Response.json([
    { current }, {}, {}, {}, {}, {}, {}
  ]), now);
  assert.equal(partial.envelope.status, "partial");
  assert.equal(partial.envelope.data.length, 1);
  assert.equal(partial.gaps[0].reason, "partial-provider-response");
  assert.match(partial.gaps[0].detail, /^6 of 7/);

  const live = await collectModelledAir(async () => Response.json(
    Array.from({ length: 7 }, () => ({ current }))
  ), now);
  assert.equal(live.envelope.status, "live");
  assert.equal(live.envelope.data.length, 7);
  assert.deepEqual(live.gaps, []);

  const unavailable = await collectModelledAir(async () => Response.json(
    Array.from({ length: 7 }, () => ({}))
  ), now);
  assert.equal(unavailable.envelope.status, "unavailable");
  assert.equal(unavailable.envelope.data, null);
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

test("tide auxiliary feed failures remain explicit partial gaps", async () => {
  const now = Date.parse("2026-08-05T00:00:00.000Z");
  const result = await collectTides(async (input) => String(input).includes("IrishNationalTideGaugeNetwork")
    ? Response.json({ table: { rows: [["Dublin", -6.2, 53.3, "2026-08-04T23:30:00.000Z", 1.1]] } })
    : new Response("unavailable", { status: 503 }), now);
  assert.equal(result.envelope.status, "partial");
  assert.equal(result.envelope.data.length, 1);
  assert.equal(result.envelope.data[0].waterLevel, 1.1);
  assert.equal(result.envelope.data[0].surge, null);
  assert.equal(result.envelope.data[0].nextHighAt, null);
  assert.equal(result.gaps.length, 2);
  assert.ok(result.gaps.every((item) => item.reason === "upstream-http-503"));
  assert.match(result.gaps.map((item) => item.detail).join(" "), /surge.*high\/low/i);

  const payload = {
    snapshot: { generatedAt: new Date(now).toISOString(), tides: result.envelope.data },
    movementSummary: { rail: null, transit: null },
    gaps: result.gaps
  };
  const encoded = await gzipJson(payload);
  const rawRows = [{
    resolution_minutes: 15,
    bucket_start_ms: now,
    period_end_ms: now + 15 * 60_000,
    representative_at_ms: now,
    payload: encoded.compressed,
    source_status_json: JSON.stringify({ tides: { status: "partial" } }),
    gaps_json: JSON.stringify(result.gaps)
  }];
  const db = {
    prepare(sql) {
      return {
        bind() { return this; },
        async all() { return { results: rawRows }; },
        async run() {
          assert.match(sql, /INSERT INTO history_snapshots/);
          return { success: true };
        }
      };
    }
  };
  const hourly = await rollupPeriod(db, {
    fromResolutionMinutes: 15,
    resolutionMinutes: 60,
    startMs: now,
    endMs: now + 60 * 60_000,
    expectedSamples: 4,
    sourceKeys: ["tides"],
    emptyPayload: () => ({})
  });
  const retained = await gunzipJson(hourly.payload);
  assert.equal(retained.gaps.filter((item) => item.source === "tides").length, 2);
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

test("migration-v1 capture and every raw/hour/day rollup retain movement aggregates without private entities", async (t) => {
  const db = new TestD1Database();
  t.after(() => db.close());
  db.exec(await readFile(new URL("../migrations/0001_history_v1.sql", import.meta.url), "utf8"));
  const capturedAt = Date.parse("2026-08-04T23:00:00.000Z");
  const ntaSentinel = {
    id: "NTA-PRIVATE-ID-7f56",
    route: "2 NX c a",
    label: "NTA-PRIVATE-LABEL-7f56",
    latitude: 53.123456789,
    longitude: -7.987654321,
    observedAt: new Date(capturedAt - 30_000).toISOString()
  };
  const railSentinel = {
    id: "RAIL-PRIVATE-ID-9a42",
    direction: "RAIL-PRIVATE-DIRECTION-9a42",
    message: "RAIL-PRIVATE-MESSAGE-9a42",
    latitude: 52.246813579,
    longitude: -8.135792468,
    status: "running",
    observedAt: new Date(capturedAt - 60_000).toISOString()
  };
  await captureHistory({
    HISTORY_DB: db,
    NTA_API_KEY: "configured",
    HISTORY_INCLUDE_IRISH_RAIL: "true"
  }, capturedAt, {
    scoped: { sources: {}, gaps: [] },
    loadLiving: async () => ({
      trains: [railSentinel],
      rivers: [],
      sourceStatus: { trains: "live", rivers: "unavailable" },
      sourceProvenance: {
        trains: {
          provider: "Irish Rail",
          endpoint: "test",
          status: "live",
          fetchedAt: new Date(capturedAt).toISOString(),
          latestObservedAt: railSentinel.observedAt,
          fallback: null
        }
      }
    }),
    loadTransit: async () => ({ transit: [ntaSentinel], transitStatus: "live" })
  });
  await maintainHistory({ HISTORY_DB: db }, Date.parse("2026-08-05T00:15:00.000Z"));
  await maintainHistory({ HISTORY_DB: db }, Date.parse("2026-08-05T23:15:00.000Z"));

  const rows = db.sqlite.prepare(`SELECT resolution_minutes, payload
    FROM history_snapshots ORDER BY resolution_minutes, bucket_start_ms`).all();
  assert.deepEqual([...new Set(rows.map((row) => Number(row.resolution_minutes)))], [15, 60, 1440]);
  const forbiddenScalars = new Set([
    ntaSentinel.id,
    ntaSentinel.label,
    ntaSentinel.latitude,
    ntaSentinel.longitude,
    railSentinel.id,
    railSentinel.direction,
    railSentinel.message,
    railSentinel.latitude,
    railSentinel.longitude
  ]);
  const scalarValues = (value, result = []) => {
    if (Array.isArray(value)) value.forEach((item) => scalarValues(item, result));
    else if (value && typeof value === "object") Object.values(value).forEach((item) => scalarValues(item, result));
    else result.push(value);
    return result;
  };

  const decoded = [];
  for (const row of rows) {
    const payload = await gunzipJson(row.payload);
    decoded.push([Number(row.resolution_minutes), payload]);
    assert.deepEqual(payload.snapshot?.trains ?? [], []);
    assert.deepEqual(payload.snapshot?.transit ?? [], []);
    const rail = payload.movementSummary?.rail;
    if (rail) {
      assert.deepEqual(Object.keys(rail).sort(), ["capturedAt", "notStarted", "running", "status", "total"]);
    }
    const transit = payload.movementSummary?.transit;
    if (transit) {
      assert.deepEqual(Object.keys(transit).sort(), [
        "attribution", "byRoute", "capturedAt", "mappedRouteVehicles", "routes", "status", "total",
        "unmappedRouteVehicles", "vehicles"
      ]);
      assert.ok(transit.byRoute.every((item) =>
        Object.keys(item).sort().join(",") === "count,route" && Number.isInteger(item.count)
      ));
    }
    for (const value of scalarValues(payload)) {
      assert.equal(forbiddenScalars.has(value), false, `private scalar leaked into ${row.resolution_minutes}-minute row`);
    }
  }

  const raw = decoded.find(([resolution]) => resolution === 15)[1];
  assert.equal(raw.movementSummary.rail, null);
  assert.equal(raw.movementSummary.transit.vehicles, 1);
  assert.deepEqual(raw.movementSummary.transit.byRoute, [{ route: "NX", count: 1 }]);
  const day = decoded.find(([resolution]) => resolution === 1440)[1];
  assert.equal(day.snapshot, null);
  assert.deepEqual(day.movementSummary, { rail: null, transit: null });
});

test("EirGrid frequency history queries use the Europe/Dublin wall-clock hour", () => {
  assert.deepEqual(eirGridDublinHourWindow(Date.parse("2026-08-02T23:30:00.000Z")), {
    dateFrom: "2026-08-03T00:00:00",
    dateTo: "2026-08-03T00:59:59"
  });
  assert.deepEqual(eirGridDublinHourWindow(Date.parse("2026-01-02T23:30:00.000Z")), {
    dateFrom: "2026-01-02T23:00:00",
    dateTo: "2026-01-02T23:59:59"
  });
});

const effectiveAt = (row) => row.resolution_minutes === 1440
  ? row.bucket_start_ms
  : row.representative_at_ms ?? row.bucket_start_ms;

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
            available_from_ms: Math.min(...items.map(effectiveAt)),
            available_to_ms: Math.max(...items.map(effectiveAt)),
            snapshot_count: items.length
          })).sort((a, b) => a.resolution_minutes - b.resolution_minutes) };
        }
        throw new Error(`Unexpected all query: ${sql}`);
      },
      async first() {
        const [resolution, at] = this.values;
        const candidates = rows.filter((row) => row.resolution_minutes === resolution);
        if (sql.includes("<= ?")) {
          return candidates.filter((row) => effectiveAt(row) <= at).sort((a, b) => effectiveAt(b) - effectiveAt(a))[0] ?? null;
        }
        if (sql.includes("< ?")) {
          const row = candidates.filter((item) => effectiveAt(item) < at).sort((a, b) => effectiveAt(b) - effectiveAt(a))[0];
          return row ? { effective_at_ms: effectiveAt(row) } : null;
        }
        if (sql.includes("> ?")) {
          const row = candidates.filter((item) => effectiveAt(item) > at).sort((a, b) => effectiveAt(a) - effectiveAt(b))[0];
          return row ? { effective_at_ms: effectiveAt(row) } : null;
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

test("hourly rollups preserve their actual representative time and never return future evidence", async () => {
  const hourStart = Date.parse("2026-06-01T10:00:00.000Z");
  const representativeAt = hourStart + 45 * 60_000;
  const encoded = await gzipJson({
    snapshot: { generatedAt: new Date(representativeAt).toISOString(), label: "10:45 observation" },
    movementSummary: { rail: null, transit: null },
    gaps: []
  });
  const rawRows = [{
    resolution_minutes: 15,
    bucket_start_ms: representativeAt,
    period_end_ms: representativeAt + 15 * 60_000,
    representative_at_ms: representativeAt,
    collected_at_ms: representativeAt,
    schema_version: 1,
    codec: "gzip-json-v1",
    payload: encoded.compressed,
    payload_bytes: encoded.compressed.byteLength,
    uncompressed_bytes: encoded.uncompressedBytes,
    content_sha256: "raw-hash",
    expected_samples: 1,
    collected_samples: 1,
    source_status_json: JSON.stringify({ weather: { status: "live" } }),
    gaps_json: "[]"
  }];
  const rollupDb = {
    prepare(sql) {
      return {
        bind() { return this; },
        async all() {
          assert.match(sql, /FROM history_snapshots/);
          return { results: rawRows };
        },
        async run() {
          assert.match(sql, /INSERT INTO history_snapshots/);
          return { success: true };
        }
      };
    }
  };
  const row = await rollupPeriod(rollupDb, {
    fromResolutionMinutes: 15,
    resolutionMinutes: 60,
    startMs: hourStart,
    endMs: hourStart + 60 * 60_000,
    expectedSamples: 4,
    sourceKeys: ["weather"],
    emptyPayload: () => ({})
  });
  assert.equal(row.bucketStartMs, hourStart);
  assert.equal(row.representativeAtMs, representativeAt);
  const storedRow = {
    resolution_minutes: 60,
    bucket_start_ms: row.bucketStartMs,
    period_end_ms: row.periodEndMs,
    representative_at_ms: row.representativeAtMs,
    collected_at_ms: row.collectedAtMs,
    schema_version: 1,
    codec: row.codec,
    payload: row.payload,
    payload_bytes: row.payloadBytes,
    uncompressed_bytes: row.uncompressedBytes,
    content_sha256: row.contentSha256,
    expected_samples: row.expectedSamples,
    collected_samples: row.collectedSamples,
    source_status_json: row.sourceStatusJson,
    gaps_json: row.gapsJson
  };
  const afterRawRetention = hourStart + 31 * 86_400_000;
  const tooEarly = await resolveHistory(makeReadDb([storedRow]), hourStart + 10 * 60_000, afterRawRetention);
  assert.equal(tooEarly.resolvedAt, null);
  const afterRepresentative = await resolveHistory(makeReadDb([storedRow]), hourStart + 50 * 60_000, afterRawRetention);
  assert.equal(afterRepresentative.resolvedAt, new Date(representativeAt).toISOString());
  assert.equal(afterRepresentative.periodStartAt, new Date(hourStart).toISOString());
  assert.equal(afterRepresentative.periodEndAt, new Date(hourStart + 60 * 60_000).toISOString());
  assert.equal(afterRepresentative.snapshot.generatedAt, new Date(representativeAt).toISOString());
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

test("daily coverage counts each hourly input once instead of re-summing raw counts", () => {
  const rows = Array.from({ length: 24 }, () => ({
    source_status_json: JSON.stringify({
      weather: {
        status: "live",
        expectedSamples: 4,
        collectedSamples: 4,
        counts: { live: 4, partial: 0, fallback: 0, stale: 0, unavailable: 0, "credential-required": 0 }
      }
    })
  }));
  const merged = mergeSourceStatus(rows, ["weather"], 24);
  assert.equal(merged.weather.status, "live");
  assert.equal(merged.weather.counts.live, 24);
});

test("Europe/Dublin daily rollup boundaries preserve DST day lengths", () => {
  const spring = previousDublinDayBounds(Date.parse("2026-03-30T00:30:00.000Z"));
  const autumn = previousDublinDayBounds(Date.parse("2026-10-26T01:30:00.000Z"));
  assert.equal((spring.end - spring.start) / 3_600_000, 23);
  assert.equal((autumn.end - autumn.start) / 3_600_000, 25);
});

test("daily rollups are summary-only and never clone a point-in-time map", async () => {
  const start = Date.parse("2026-08-04T23:00:00.000Z");
  const makeInputRow = async (offset, payload) => {
    const encoded = await gzipJson(payload);
    return {
      resolution_minutes: 60,
      bucket_start_ms: start + offset,
      period_end_ms: start + offset + 3_600_000,
      collected_at_ms: start + offset,
      schema_version: 1,
      codec: "gzip-json-v1",
      payload: encoded.compressed,
      payload_bytes: encoded.compressed.byteLength,
      uncompressed_bytes: encoded.uncompressedBytes,
      content_sha256: `input-${offset}`,
      expected_samples: 4,
      collected_samples: 4,
      source_status_json: JSON.stringify({ weather: { status: "live" } }),
      gaps_json: "[]"
    };
  };
  const payloads = [{
    schemaVersion: 1,
    capturedAt: new Date(start).toISOString(),
    resolutionMinutes: 60,
    snapshot: {
      generatedAt: new Date(start).toISOString(),
      stations: [{ id: "must-not-survive", temperature: 12, windSpeed: 20, rainfall: 0.5 }],
      grid: { windSharePercent: 40, demandMW: 4_200 },
      warnings: [{ id: "warning-a" }], bathingAlerts: [{ id: "beach-a" }], earthquakes: [],
      contextStatus: { warnings: "live", bathing: "live", earthquakes: "live" }
    },
    movementSummary: { rail: null, transit: { vehicles: 100, routes: 10 } },
    gaps: []
  }, {
    schemaVersion: 1,
    capturedAt: new Date(start + 3_600_000).toISOString(),
    resolutionMinutes: 60,
    snapshot: {
      generatedAt: new Date(start + 3_600_000).toISOString(),
      stations: [{ id: "must-not-survive-either", temperature: 15, windSpeed: 25, rainfall: 1.2 }],
      grid: { windSharePercent: 55, demandMW: 4_000 },
      warnings: [{ id: "warning-a" }, { id: "warning-b" }],
      bathingAlerts: [{ id: "beach-a" }], earthquakes: [{ id: "quake-a" }],
      contextStatus: { warnings: "live", bathing: "live", earthquakes: "live" }
    },
    movementSummary: { rail: null, transit: { vehicles: 120, routes: 11 } },
    gaps: []
  }];
  const inputRows = await Promise.all(payloads.map((payload, index) => makeInputRow(index * 3_600_000, payload)));
  const db = {
    prepare(sql) {
      return {
        bind() { return this; },
        async all() {
          assert.match(sql, /FROM history_snapshots/);
          return { results: inputRows };
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
  assert.deepEqual(payload.periodSummary, {
    basis: "retained-hourly-representatives",
    representedSamples: 2,
    weather: { highestTemperatureC: 15, highestWindSpeedKmh: 25, highestStationRainfallMm: 1.2 },
    grid: { minWindSharePercent: 40, maxWindSharePercent: 55, minDemandMW: 4_000, maxDemandMW: 4_200 },
    transit: { maxVehicles: 120, maxRoutes: 11 },
    distinctCounts: { officialWarnings: 2, bathingAlerts: 1, earthquakes: 1 }
  });
  assert.ok(payload.gaps.some((item) => item.reason === "summary-only"));
  assert.doesNotMatch(JSON.stringify(payload), /must-not-survive/);

  const storedRow = {
    resolution_minutes: 1440, bucket_start_ms: start, period_end_ms: start + 86_400_000,
    collected_at_ms: row.collectedAtMs, schema_version: 1, codec: row.codec,
    payload: row.payload, payload_bytes: row.payloadBytes, uncompressed_bytes: row.uncompressedBytes,
    content_sha256: row.contentSha256, expected_samples: row.expectedSamples,
    collected_samples: row.collectedSamples, source_status_json: row.sourceStatusJson,
    gaps_json: row.gapsJson
  };
  const api = await resolveHistory(makeReadDb([storedRow]), start, start + 400 * 86_400_000);
  assert.deepEqual(api.periodSummary, payload.periodSummary);
  assert.equal(api.periodStartAt, new Date(start).toISOString());
  assert.equal(api.periodEndAt, new Date(start + 24 * 3_600_000).toISOString());
});

test("daily representative summaries keep every unobserved metric null", () => {
  assert.equal(summarizeDailyRepresentatives([]), null);
  assert.equal(summarizeDailyRepresentatives([{ snapshot: null }]), null);
  const summary = summarizeDailyRepresentatives([{
    snapshot: {
      stations: [], grid: null, warnings: [], bathingAlerts: [], earthquakes: [],
      contextStatus: { warnings: "unavailable", bathing: "unavailable", earthquakes: "unavailable" }
    },
    movementSummary: { rail: null, transit: null }
  }]);
  assert.equal(summary.representedSamples, 1);
  assert.deepEqual(summary.weather, {
    highestTemperatureC: null, highestWindSpeedKmh: null, highestStationRainfallMm: null
  });
  assert.deepEqual(summary.grid, {
    minWindSharePercent: null, maxWindSharePercent: null, minDemandMW: null, maxDemandMW: null
  });
  assert.deepEqual(summary.transit, { maxVehicles: null, maxRoutes: null });
  assert.deepEqual(summary.distinctCounts, {
    officialWarnings: null, bathingAlerts: null, earthquakes: null
  });
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

test("migration and Wrangler configs enforce aggregate BLOB storage and production binding", async () => {
  const migration = await readFile(new URL("../migrations/0001_history_v1.sql", import.meta.url), "utf8");
  const historyStore = await readFile(new URL("../platform/history-store.js", import.meta.url), "utf8");
  const production = await readFile(new URL("../wrangler.api.toml", import.meta.url), "utf8");
  const local = await readFile(new URL("../wrangler.history.local.toml", import.meta.url), "utf8");
  assert.match(migration, /payload BLOB NOT NULL/);
  assert.match(migration, /codec TEXT NOT NULL/);
  assert.match(migration, /representative_at_ms INTEGER/);
  assert.doesNotMatch(migration, /history_observations/);
  assert.doesNotMatch(historyStore, /history_workflow_runs|materialized_current|workflow_step_reservations|history_rollup_samples|history_rollup_repairs|bathing_index_workflow_runs/);
  assert.match(production, /main = "platform\/cloudflare-entry\.js"/);
  assert.match(production, /crons = \["\*\/15 \* \* \* \*"\]/);
  assert.match(production, /\[limits\][\s\S]*cpu_ms = 1000[\s\S]*subrequests = 100/);
  assert.doesNotMatch(production, /\[\[workflows\]\]|MATERIALIZED_READS|SOL_HIGH_WORKFLOW/);
  assert.match(production, /binding = "HISTORY_DB"/);
  assert.match(production, /database_name = "a-day-in-ireland-history"/);
  assert.match(production, /database_id = "[0-9a-f-]{36}"/);
  assert.match(local, /binding = "HISTORY_DB"/);
  assert.match(local, /database_name = "a-day-in-ireland-history-local"/);
});
