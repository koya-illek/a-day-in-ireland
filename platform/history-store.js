import { parseIrelandLocalTimestamp } from "./river-source.js";

export const HISTORY_SCHEMA_VERSION = 1;
export const HISTORY_CODEC = "gzip-json-v1";
export const RAW_RESOLUTION_MINUTES = 15;
export const HOUR_RESOLUTION_MINUTES = 60;
export const DAY_RESOLUTION_MINUTES = 1440;
export const MAX_COMPRESSED_ROW_BYTES = 1_999_999;

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const RAW_RETENTION_MS = 30 * DAY_MS;
const HOUR_RETENTION_MS = 365 * DAY_MS;
const HISTORY_TOLERANCE_MS = new Map([
  [RAW_RESOLUTION_MINUTES, 30 * MINUTE_MS],
  [HOUR_RESOLUTION_MINUTES, 2 * HOUR_MS],
  [DAY_RESOLUTION_MINUTES, 48 * HOUR_MS]
]);

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

const canonicalValue = (value) => {
  if (Array.isArray(value)) return value.map((item) => canonicalValue(item));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value).sort().flatMap((key) => value[key] === undefined
      ? []
      : [[key, canonicalValue(value[key])]])
  );
};

export const canonicalJson = (value) => JSON.stringify(canonicalValue(value));

const byteArray = (value) => {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  if (Array.isArray(value)) return Uint8Array.from(value);
  throw new TypeError("History payload is not a supported D1 BLOB value");
};

const transformBytes = async (bytes, stream) => {
  const writer = stream.writable.getWriter();
  await writer.write(bytes);
  await writer.close();
  return new Uint8Array(await new Response(stream.readable).arrayBuffer());
};

export const gzipJson = async (value) => {
  const json = canonicalJson(value);
  const uncompressed = textEncoder.encode(json);
  const compressed = await transformBytes(uncompressed, new CompressionStream("gzip"));
  if (compressed.byteLength >= MAX_COMPRESSED_ROW_BYTES) {
    throw new RangeError(`Compressed history row is ${compressed.byteLength} bytes; D1 rows must stay below 2 MB`);
  }
  return { json, compressed, uncompressedBytes: uncompressed.byteLength };
};

export const gunzipJson = async (value) => {
  const decompressed = await transformBytes(byteArray(value), new DecompressionStream("gzip"));
  return JSON.parse(textDecoder.decode(decompressed));
};

export const sha256Hex = async (value) => {
  const bytes = typeof value === "string" ? textEncoder.encode(value) : byteArray(value);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return [...digest].map((item) => item.toString(16).padStart(2, "0")).join("");
};

export const rawBucketStart = (timestamp) =>
  Math.floor(timestamp / (RAW_RESOLUTION_MINUTES * MINUTE_MS)) * RAW_RESOLUTION_MINUTES * MINUTE_MS;

export const hourBucketStart = (timestamp) => Math.floor(timestamp / HOUR_MS) * HOUR_MS;

const dublinPartsFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Europe/Dublin",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  hourCycle: "h23"
});

const dublinParts = (timestamp) => Object.fromEntries(
  dublinPartsFormatter.formatToParts(new Date(timestamp)).map((part) => [part.type, part.value])
);

const dublinMidnight = (year, month, day) => Date.parse(
  parseIrelandLocalTimestamp(
    `${String(day).padStart(2, "0")}-${String(month).padStart(2, "0")}-${year}`,
    "00:00:00"
  ) ?? ""
);

export const previousDublinDayBounds = (timestamp) => {
  const current = dublinParts(timestamp);
  const currentMidnight = dublinMidnight(Number(current.year), Number(current.month), Number(current.day));
  const previousDate = new Date(Date.UTC(Number(current.year), Number(current.month) - 1, Number(current.day) - 1));
  const previousMidnight = dublinMidnight(
    previousDate.getUTCFullYear(),
    previousDate.getUTCMonth() + 1,
    previousDate.getUTCDate()
  );
  if (!Number.isFinite(currentMidnight) || !Number.isFinite(previousMidnight)) {
    throw new RangeError("Could not calculate Europe/Dublin day bounds");
  }
  return { start: previousMidnight, end: currentMidnight };
};

export const isDublinHour = (timestamp, hour) => Number(dublinParts(timestamp).hour) === hour;

const asRows = (result) => result?.results ?? [];

const snapshotSelect = `
  SELECT resolution_minutes, bucket_start_ms, period_end_ms, representative_at_ms, collected_at_ms,
         schema_version, codec, payload, payload_bytes, uncompressed_bytes,
         content_sha256, expected_samples, collected_samples,
         source_status_json, gaps_json
  FROM history_snapshots`;

const effectiveAtSql = `CASE
  WHEN resolution_minutes = ${DAY_RESOLUTION_MINUTES} THEN bucket_start_ms
  ELSE COALESCE(representative_at_ms, bucket_start_ms)
END`;

export async function encodeSnapshotRow({
  resolutionMinutes,
  bucketStartMs,
  periodEndMs,
  representativeAtMs = resolutionMinutes === DAY_RESOLUTION_MINUTES ? null : bucketStartMs,
  collectedAtMs,
  payload,
  expectedSamples,
  collectedSamples,
  sourceStatus,
  gaps
}) {
  const encoded = await gzipJson(payload);
  return {
    resolutionMinutes,
    bucketStartMs,
    periodEndMs,
    representativeAtMs,
    collectedAtMs,
    codec: HISTORY_CODEC,
    payload: encoded.compressed,
    payloadBytes: encoded.compressed.byteLength,
    uncompressedBytes: encoded.uncompressedBytes,
    contentSha256: await sha256Hex(encoded.json),
    expectedSamples,
    collectedSamples,
    sourceStatusJson: canonicalJson(sourceStatus),
    gapsJson: canonicalJson(gaps)
  };
}

export async function writeSnapshot(db, row, { replace = false } = {}) {
  const conflict = replace
    ? `ON CONFLICT(resolution_minutes, bucket_start_ms) DO UPDATE SET
         period_end_ms=excluded.period_end_ms,
         representative_at_ms=excluded.representative_at_ms,
         collected_at_ms=excluded.collected_at_ms,
         codec=excluded.codec,
         payload=excluded.payload,
         payload_bytes=excluded.payload_bytes,
         uncompressed_bytes=excluded.uncompressed_bytes,
         content_sha256=excluded.content_sha256,
         expected_samples=excluded.expected_samples,
         collected_samples=excluded.collected_samples,
         source_status_json=excluded.source_status_json,
         gaps_json=excluded.gaps_json`
    : "ON CONFLICT(resolution_minutes, bucket_start_ms) DO NOTHING";
  return db.prepare(`
    INSERT INTO history_snapshots (
      resolution_minutes, bucket_start_ms, period_end_ms, representative_at_ms, collected_at_ms,
      schema_version, codec, payload, payload_bytes, uncompressed_bytes,
      content_sha256, expected_samples, collected_samples, source_status_json, gaps_json
    ) VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ${conflict}
  `).bind(
    row.resolutionMinutes,
    row.bucketStartMs,
    row.periodEndMs,
    row.representativeAtMs,
    row.collectedAtMs,
    row.codec,
    row.payload,
    row.payloadBytes,
    row.uncompressedBytes,
    row.contentSha256,
    row.expectedSamples,
    row.collectedSamples,
    row.sourceStatusJson,
    row.gapsJson
  ).run();
}

export async function historyRange(db) {
  const rows = asRows(await db.prepare(`
    SELECT resolution_minutes,
           MIN(${effectiveAtSql}) AS available_from_ms,
           MAX(${effectiveAtSql}) AS available_to_ms,
           COUNT(*) AS snapshot_count
    FROM history_snapshots
    GROUP BY resolution_minutes
    ORDER BY resolution_minutes
  `).all());
  const resolutions = rows.map((row) => ({
    name: row.resolution_minutes === 15 ? "raw" : row.resolution_minutes === 60 ? "hour" : "day",
    resolutionMinutes: Number(row.resolution_minutes),
    availableFrom: new Date(Number(row.available_from_ms)).toISOString(),
    availableTo: new Date(Number(row.available_to_ms)).toISOString(),
    snapshotCount: Number(row.snapshot_count)
  }));
  const timestamps = resolutions.flatMap((item) => [Date.parse(item.availableFrom), Date.parse(item.availableTo)]);
  const availableToMs = timestamps.length
    ? Math.max(...resolutions.map((item) => Date.parse(item.availableTo)))
    : null;
  const freshestResolution = availableToMs === null
    ? null
    : resolutions
      .filter((item) => Date.parse(item.availableTo) === availableToMs)
      .sort((first, second) => first.resolutionMinutes - second.resolutionMinutes)[0]?.resolutionMinutes ?? null;
  return {
    schemaVersion: HISTORY_SCHEMA_VERSION,
    availableFrom: timestamps.length ? new Date(Math.min(...timestamps)).toISOString() : null,
    availableTo: availableToMs === null ? null : new Date(availableToMs).toISOString(),
    resolutionMinutes: freshestResolution,
    resolutions,
    snapshotCount: resolutions.reduce((total, item) => total + item.snapshotCount, 0)
  };
}

const allowedResolutions = (requestedAt, now) => {
  const age = now - requestedAt;
  if (age <= RAW_RETENTION_MS) return [15, 60, 1440];
  if (age <= HOUR_RETENTION_MS) return [60, 1440];
  return [1440];
};

const nearestAtOrBefore = async (db, resolutionMinutes, requestedAt) =>
  db.prepare(`${snapshotSelect}
    WHERE resolution_minutes = ? AND ${effectiveAtSql} <= ?
    ORDER BY ${effectiveAtSql} DESC LIMIT 1
  `).bind(resolutionMinutes, requestedAt).first();

const adjacentTimestamp = async (db, resolutionMinutes, resolvedAt, direction) => {
  const before = direction === "previous";
  const row = await db.prepare(`
    SELECT ${effectiveAtSql} AS effective_at_ms FROM history_snapshots
    WHERE resolution_minutes = ? AND ${effectiveAtSql} ${before ? "<" : ">"} ?
    ORDER BY ${effectiveAtSql} ${before ? "DESC" : "ASC"} LIMIT 1
  `).bind(resolutionMinutes, resolvedAt).first();
  return row ? new Date(Number(row.effective_at_ms)).toISOString() : null;
};

export async function resolveHistory(db, requestedAt, now = Date.now()) {
  const range = await historyRange(db);
  let selected = null;
  let resolutionMinutes = allowedResolutions(requestedAt, now)[0];
  for (const resolution of allowedResolutions(requestedAt, now)) {
    const candidate = await nearestAtOrBefore(db, resolution, requestedAt);
    resolutionMinutes = resolution;
    if (!candidate) continue;
    const candidateAt = resolution === DAY_RESOLUTION_MINUTES
      ? Number(candidate.bucket_start_ms)
      : Number(candidate.representative_at_ms ?? candidate.bucket_start_ms);
    if (requestedAt - candidateAt <= HISTORY_TOLERANCE_MS.get(resolution)) {
      selected = candidate;
      break;
    }
  }
  if (!selected) {
    return {
      schemaVersion: 1,
      requestedAt: new Date(requestedAt).toISOString(),
      resolvedAt: null,
      periodStartAt: null,
      periodEndAt: null,
      availableFrom: range.availableFrom,
      availableTo: range.availableTo,
      previousAt: null,
      nextAt: null,
      resolutionMinutes,
      snapshot: null,
      movementSummary: { rail: null, transit: null },
      periodSummary: null,
      gaps: [{
        source: "history",
        scope: "collector",
        reason: "no-nearby-snapshot",
        detail: "No stored snapshot exists at or before the requested time within this resolution's allowed tolerance."
      }]
    };
  }
  const selectedResolution = Number(selected.resolution_minutes);
  const resolvedAtMs = selectedResolution === DAY_RESOLUTION_MINUTES
    ? Number(selected.bucket_start_ms)
    : Number(selected.representative_at_ms ?? selected.bucket_start_ms);
  const stored = await gunzipJson(selected.payload);
  const [previousAt, nextAt] = await Promise.all([
    adjacentTimestamp(db, Number(selected.resolution_minutes), resolvedAtMs, "previous"),
    adjacentTimestamp(db, Number(selected.resolution_minutes), resolvedAtMs, "next")
  ]);
  return {
    schemaVersion: 1,
    requestedAt: new Date(requestedAt).toISOString(),
    resolvedAt: new Date(resolvedAtMs).toISOString(),
    periodStartAt: new Date(Number(selected.bucket_start_ms)).toISOString(),
    periodEndAt: new Date(Number(selected.period_end_ms)).toISOString(),
    availableFrom: range.availableFrom,
    availableTo: range.availableTo,
    previousAt,
    nextAt,
    resolutionMinutes: selectedResolution,
    snapshot: stored.snapshot ?? null,
    movementSummary: stored.movementSummary ?? { rail: null, transit: null },
    periodSummary: stored.periodSummary ?? null,
    gaps: Array.isArray(stored.gaps) ? stored.gaps : JSON.parse(selected.gaps_json)
  };
}

const emptyCounts = () => ({
  live: 0,
  partial: 0,
  fallback: 0,
  stale: 0,
  unavailable: 0,
  "credential-required": 0
});

export const mergeSourceStatus = (rows, sourceKeys, expectedSamples) => {
  const merged = Object.fromEntries(sourceKeys.map((source) => [source, {
    status: "unavailable",
    expectedSamples,
    collectedSamples: rows.length,
    counts: emptyCounts()
  }]));
  for (const row of rows) {
    const statuses = JSON.parse(row.source_status_json);
    for (const source of sourceKeys) {
      const current = statuses[source];
      if (!current) {
        merged[source].counts.unavailable += 1;
        continue;
      }
      const status = current.status in merged[source].counts ? current.status : "unavailable";
      merged[source].counts[status] += 1;
    }
  }
  const missing = Math.max(0, expectedSamples - rows.length);
  for (const source of sourceKeys) {
    merged[source].counts.unavailable += missing;
    const counts = merged[source].counts;
    merged[source].status = counts.live === expectedSamples
      ? "live"
      : counts.live + counts.partial + counts.fallback + counts.stale > 0
        ? "partial"
        : counts["credential-required"] === expectedSamples
          ? "credential-required"
          : "unavailable";
  }
  return merged;
};

const finiteValues = (values) => values.filter((value) => Number.isFinite(value));
const minimum = (values) => {
  const usable = finiteValues(values);
  return usable.length ? Math.min(...usable) : null;
};
const maximum = (values) => {
  const usable = finiteValues(values);
  return usable.length ? Math.max(...usable) : null;
};

const distinctObservedCount = (payloads, collection, statusKey) => {
  const identities = new Set();
  let represented = false;
  for (const payload of payloads) {
    const snapshot = payload?.snapshot;
    if (!snapshot || snapshot.contextStatus?.[statusKey] === "unavailable") continue;
    if (!snapshot.contextStatus?.[statusKey]) continue;
    represented = true;
    for (const item of Array.isArray(snapshot[collection]) ? snapshot[collection] : []) {
      const identity = String(item?.id ?? "").trim();
      if (identity) identities.add(identity);
    }
  }
  return represented ? identities.size : null;
};

export const summarizeDailyRepresentatives = (payloads) => {
  const represented = payloads.filter((payload) => payload?.snapshot);
  if (!represented.length) return null;
  const stations = represented.flatMap((payload) =>
    Array.isArray(payload.snapshot.stations) ? payload.snapshot.stations : []
  );
  const grids = represented.map((payload) => payload.snapshot.grid).filter(Boolean);
  const transit = represented.map((payload) => payload.movementSummary?.transit).filter(Boolean);
  return {
    basis: "retained-hourly-representatives",
    representedSamples: represented.length,
    weather: {
      highestTemperatureC: maximum(stations.map((item) => item?.temperature)),
      highestWindSpeedKmh: maximum(stations.map((item) => item?.windSpeed)),
      highestStationRainfallMm: maximum(stations.map((item) => item?.rainfall))
    },
    grid: {
      minWindSharePercent: minimum(grids.map((item) => item?.windSharePercent)),
      maxWindSharePercent: maximum(grids.map((item) => item?.windSharePercent)),
      minDemandMW: minimum(grids.map((item) => item?.demandMW)),
      maxDemandMW: maximum(grids.map((item) => item?.demandMW))
    },
    transit: {
      maxVehicles: maximum(transit.map((item) => item?.vehicles)),
      maxRoutes: maximum(transit.map((item) => item?.routes))
    },
    distinctCounts: {
      officialWarnings: distinctObservedCount(represented, "warnings", "warnings"),
      bathingAlerts: distinctObservedCount(represented, "bathingAlerts", "bathing"),
      earthquakes: distinctObservedCount(represented, "earthquakes", "earthquakes")
    }
  };
};

const uniqueGaps = (gaps) => [...new Map(gaps.map((gap) => [
  `${gap.source}\u0000${gap.scope}\u0000${gap.reason}\u0000${gap.detail}`,
  gap
])).values()].sort((first, second) =>
  `${first.source}\u0000${first.scope}\u0000${first.reason}\u0000${first.detail}`.localeCompare(
    `${second.source}\u0000${second.scope}\u0000${second.reason}\u0000${second.detail}`
  )
);

export async function rollupPeriod(db, {
  fromResolutionMinutes,
  resolutionMinutes,
  startMs,
  endMs,
  expectedSamples,
  sourceKeys,
  emptyPayload,
  summaryOnly = false
}) {
  const rows = asRows(await db.prepare(`${snapshotSelect}
    WHERE resolution_minutes = ? AND bucket_start_ms >= ? AND bucket_start_ms < ?
    ORDER BY bucket_start_ms ASC
  `).bind(fromResolutionMinutes, startMs, endMs).all());
  const decoded = summaryOnly
    ? await Promise.all(rows.map((row) => gunzipJson(row.payload)))
    : rows.length ? [await gunzipJson(rows[0].payload)] : [];
  const representative = decoded[0] ?? emptyPayload(startMs);
  const representativeAtMs = summaryOnly || !rows.length
    ? null
    : Number(rows[0].representative_at_ms ?? rows[0].bucket_start_ms);
  const sourceStatus = mergeSourceStatus(rows, sourceKeys, expectedSamples);
  const gaps = uniqueGaps([
    ...rows.flatMap((row) => JSON.parse(row.gaps_json)),
    ...(rows.length < expectedSamples ? [{
      source: "history",
      scope: resolutionMinutes === 60 ? "hour" : "day",
      reason: "collector-gap",
      detail: `${rows.length} of ${expectedSamples} expected lower-resolution snapshots were collected.`
    }] : []),
    ...(summaryOnly ? [{
      source: "history",
      scope: "day",
      reason: "summary-only",
      detail: "Daily history is a compact coverage and movement summary, not a point-in-time map snapshot."
    }] : [])
  ]);
  const payload = {
    ...representative,
    schemaVersion: 1,
    capturedAt: summaryOnly || representativeAtMs === null
      ? new Date(startMs).toISOString()
      : new Date(representativeAtMs).toISOString(),
    resolutionMinutes,
    snapshot: summaryOnly ? null : representative.snapshot ?? null,
    movementSummary: summaryOnly ? { rail: null, transit: null } : representative.movementSummary ?? { rail: null, transit: null },
    periodSummary: summaryOnly ? summarizeDailyRepresentatives(decoded) : null,
    gaps
  };
  const row = await encodeSnapshotRow({
    resolutionMinutes,
    bucketStartMs: startMs,
    periodEndMs: endMs,
    representativeAtMs,
    collectedAtMs: Date.now(),
    payload,
    expectedSamples,
    collectedSamples: rows.length,
    sourceStatus,
    gaps
  });
  await writeSnapshot(db, row, { replace: true });
  return row;
}

export async function pruneHistory(db, now = Date.now()) {
  const rawCutoff = now - RAW_RETENTION_MS;
  const hourCutoff = now - HOUR_RETENTION_MS;
  await db.prepare(`
    DELETE FROM history_snapshots AS raw
    WHERE raw.resolution_minutes = 15 AND raw.bucket_start_ms < ?
      AND EXISTS (
        SELECT 1 FROM history_snapshots AS hourly
        WHERE hourly.resolution_minutes = 60
          AND hourly.bucket_start_ms = raw.bucket_start_ms - (raw.bucket_start_ms % ?)
      )
  `).bind(rawCutoff, HOUR_MS).run();
  await db.prepare(`
    DELETE FROM history_snapshots AS hourly
    WHERE hourly.resolution_minutes = 60 AND hourly.bucket_start_ms < ?
      AND EXISTS (
        SELECT 1 FROM history_snapshots AS daily
        WHERE daily.resolution_minutes = 1440
          AND daily.bucket_start_ms <= hourly.bucket_start_ms
          AND daily.period_end_ms > hourly.bucket_start_ms
      )
  `).bind(hourCutoff).run();
  await db.prepare("DELETE FROM history_collection_runs WHERE bucket_start_ms < ?")
    .bind(now - 90 * DAY_MS).run();
}
