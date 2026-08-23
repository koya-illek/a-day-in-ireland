import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { TestD1Database } from "./d1-test-helper.mjs";
import { encodeSnapshotRow, writeSnapshot } from "../platform/history-store.js";

const applyMigration = async (db) => {
  db.exec(await readFile(new URL("../migrations/0001_history_v1.sql", import.meta.url), "utf8"));
};

const insertFixtureRow = async (db, { resolutionMinutes, bucketStartMs, periodEndMs, expectedSamples, collectedSamples }) => {
  const row = await encodeSnapshotRow({
    resolutionMinutes,
    bucketStartMs,
    periodEndMs,
    representativeAtMs: resolutionMinutes === 1440 ? null : bucketStartMs,
    collectedAtMs: periodEndMs,
    payload: { label: `${resolutionMinutes}@${bucketStartMs}` },
    expectedSamples,
    collectedSamples,
    sourceStatus: {},
    gaps: []
  });
  await writeSnapshot(db, row);
};

test("maintenance repairs an hour whose rollup tick was missed", async (t) => {
  const db = new TestD1Database();
  t.after(() => db.close());
  await applyMigration(db);
  // Raw snapshots in two hours; the maintenance ticks that would have rolled
  // up [12:00,13:00) and [13:00,14:00) are simulated as missed.
  await insertFixtureRow(db, {
    resolutionMinutes: 15, bucketStartMs: Date.parse("2026-08-05T12:00:00Z"),
    periodEndMs: Date.parse("2026-08-05T12:15:00Z"), expectedSamples: 1, collectedSamples: 1
  });
  await insertFixtureRow(db, {
    resolutionMinutes: 15, bucketStartMs: Date.parse("2026-08-05T12:30:00Z"),
    periodEndMs: Date.parse("2026-08-05T12:45:00Z"), expectedSamples: 1, collectedSamples: 1
  });
  await insertFixtureRow(db, {
    resolutionMinutes: 15, bucketStartMs: Date.parse("2026-08-05T13:15:00Z"),
    periodEndMs: Date.parse("2026-08-05T13:30:00Z"), expectedSamples: 1, collectedSamples: 1
  });
  const { maintainHistory } = await import("../platform/history.js");
  await maintainHistory({ HISTORY_DB: db }, Date.parse("2026-08-05T15:15:00Z"));
  const hourly = db.sqlite.prepare(`
    SELECT bucket_start_ms, collected_samples, expected_samples FROM history_snapshots
    WHERE resolution_minutes = 60 ORDER BY bucket_start_ms
  `).all().map((row) => [Number(row.bucket_start_ms), Number(row.collected_samples), Number(row.expected_samples)]);
  assert.deepEqual(hourly, [
    [Date.parse("2026-08-05T12:00:00Z"), 2, 4],
    [Date.parse("2026-08-05T13:00:00Z"), 1, 4],
    // The routine previous-hour rollup still runs for [14:00,15:00).
    [Date.parse("2026-08-05T14:00:00Z"), 0, 4]
  ]);
});

test("maintenance leaves complete hourly rollups untouched", async (t) => {
  const db = new TestD1Database();
  t.after(() => db.close());
  await applyMigration(db);
  // A raw snapshot in the 09:00 hour whose hourly row is already complete.
  await insertFixtureRow(db, {
    resolutionMinutes: 15, bucketStartMs: Date.parse("2026-08-05T09:00:00Z"),
    periodEndMs: Date.parse("2026-08-05T09:15:00Z"), expectedSamples: 1, collectedSamples: 1
  });
  const completeHour = Date.parse("2026-08-05T09:00:00Z");
  await insertFixtureRow(db, {
    resolutionMinutes: 60, bucketStartMs: completeHour,
    periodEndMs: completeHour + 3_600_000, expectedSamples: 4, collectedSamples: 4
  });
  const before = db.sqlite.prepare(`
    SELECT collected_at_ms FROM history_snapshots WHERE resolution_minutes = 60 AND bucket_start_ms = ?
  `).get(completeHour);
  const { maintainHistory } = await import("../platform/history.js");
  await maintainHistory({ HISTORY_DB: db }, Date.parse("2026-08-05T12:15:00Z"));
  const after = db.sqlite.prepare(`
    SELECT collected_at_ms FROM history_snapshots WHERE resolution_minutes = 60 AND bucket_start_ms = ?
  `).get(completeHour);
  assert.equal(Number(after.collected_at_ms), Number(before.collected_at_ms));
});

test("daily summary backfills when the Dublin-midnight maintenance was missed, and skips empty days", async (t) => {
  const db = new TestD1Database();
  t.after(() => db.close());
  await applyMigration(db);
  const { maintainHistory } = await import("../platform/history.js");
  // Aug 4 has no hourly evidence at all: no daily row may be invented.
  await maintainHistory({ HISTORY_DB: db }, Date.parse("2026-08-04T10:15:00Z"));
  let dailyRows = db.sqlite.prepare("SELECT COUNT(*) AS count FROM history_snapshots WHERE resolution_minutes = 1440").get();
  assert.equal(Number(dailyRows.count), 0);

  // Hourly rows land inside Aug 4's Dublin day ([Aug 3 23:00Z, Aug 4 23:00Z)).
  for (const bucketStart of [Date.parse("2026-08-04T06:00:00Z"), Date.parse("2026-08-04T09:00:00Z"), Date.parse("2026-08-04T18:00:00Z")]) {
    await insertFixtureRow(db, {
      resolutionMinutes: 60, bucketStartMs: bucketStart,
      periodEndMs: bucketStart + 3_600_000, expectedSamples: 4, collectedSamples: 4
    });
  }
  // A tick during Aug 5 repairs Aug 4 even though its midnight run was missed.
  await maintainHistory({ HISTORY_DB: db }, Date.parse("2026-08-05T12:15:00Z"));
  const daily = db.sqlite.prepare(`
    SELECT bucket_start_ms, collected_samples, expected_samples FROM history_snapshots
    WHERE resolution_minutes = 1440
  `).all();
  assert.equal(daily.length, 1);
  assert.equal(Number(daily[0].bucket_start_ms), Date.parse("2026-08-03T23:00:00Z"));
  assert.equal(Number(daily[0].collected_samples), 3);
  assert.equal(Number(daily[0].expected_samples), 24);
});

test("maintenance never rewrites a complete daily summary", async (t) => {
  const db = new TestD1Database();
  t.after(() => db.close());
  await applyMigration(db);
  const dayStart = Date.parse("2026-08-03T23:00:00Z");
  // Hourly evidence exists for the previous Dublin day...
  await insertFixtureRow(db, {
    resolutionMinutes: 60, bucketStartMs: Date.parse("2026-08-04T06:00:00Z"),
    periodEndMs: Date.parse("2026-08-04T07:00:00Z"), expectedSamples: 4, collectedSamples: 4
  });
  // ...and the daily row for that day is already complete.
  await insertFixtureRow(db, {
    resolutionMinutes: 1440, bucketStartMs: dayStart,
    periodEndMs: Date.parse("2026-08-04T23:00:00Z"), expectedSamples: 24, collectedSamples: 24
  });
  const before = db.sqlite.prepare(`
    SELECT collected_at_ms FROM history_snapshots WHERE resolution_minutes = 1440
  `).get();
  const { maintainHistory } = await import("../platform/history.js");
  // A tick during Aug 5 sees Aug 4 as the previous Dublin day.
  await maintainHistory({ HISTORY_DB: db }, Date.parse("2026-08-05T12:15:00Z"));
  const after = db.sqlite.prepare(`
    SELECT collected_at_ms FROM history_snapshots WHERE resolution_minutes = 1440
  `).get();
  assert.equal(Number(after.collected_at_ms), Number(before.collected_at_ms));
});
