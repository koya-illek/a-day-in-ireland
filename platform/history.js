import {
  DAY_RESOLUTION_MINUTES,
  HOUR_RESOLUTION_MINUTES,
  RAW_RESOLUTION_MINUTES,
  encodeSnapshotRow,
  historyRange,
  hourBucketStart,
  isDublinHour,
  previousDublinDayBounds,
  pruneHistory,
  rawBucketStart,
  resolveHistory,
  rollupPeriod,
  writeSnapshot
} from "./history-store.js";
import {
  HISTORY_SOURCE_KEYS,
  collectScopedSources,
  summarizeTransit
} from "./history-sources.js";

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const COLLECTION_LEASE_MS = 20 * MINUTE_MS;

const responseHeaders = {
  "content-type": "application/json; charset=utf-8",
  "access-control-allow-origin": "*"
};

const json = (body, status = 200, cacheControl = "no-store") => new Response(JSON.stringify(body), {
  status,
  headers: { ...responseHeaders, "cache-control": cacheControl }
});

const countStatus = (status) => ({
  live: status === "live" ? 1 : 0,
  partial: status === "partial" ? 1 : 0,
  fallback: status === "fallback" ? 1 : 0,
  stale: status === "stale" ? 1 : 0,
  unavailable: status === "unavailable" ? 1 : 0,
  "credential-required": status === "credential-required" ? 1 : 0
});

const statusMetadata = (sources) => Object.fromEntries(HISTORY_SOURCE_KEYS.map((key) => {
  const status = sources[key]?.status ?? "unavailable";
  return [key, { status, expectedSamples: 1, collectedSamples: 1, counts: countStatus(status) }];
}));

const usable = (status) => status === "live" || status === "partial" || status === "fallback";

const contextStatus = (sourceStatus) => [
  "live", "partial", "fallback", "stale", "unavailable", "credential-required"
].includes(sourceStatus) ? sourceStatus : "unavailable";

const unavailableProvenance = (provider, endpoint, capturedAt, status = "unavailable") => ({
  provider, endpoint, status, fetchedAt: capturedAt, latestObservedAt: null, fallback: null
});

const emptySnapshot = (capturedAt) => ({
  generatedAt: capturedAt,
  lastSuccessAt: null,
  sourceStatus: "fallback",
  stations: [], warnings: [], marine: [], trains: [], rivers: [], radar: [], grid: null,
  airQuality: [], aurora: null, tides: [], bathingAlerts: [], iss: null, issTle: null,
  satellite: null, earthquakes: [], transit: [], transitStatus: "unavailable",
  sourceProvenance: {
    trains: unavailableProvenance("Irish Rail", "https://api.irishrail.ie/realtime/realtime.asmx/getCurrentTrainsXML", capturedAt),
    rivers: unavailableProvenance("OPW waterlevel.ie", "https://waterlevel.ie/geojson/latest/", capturedAt)
  },
  contextStatus: {
    marine: "unavailable", radar: "unavailable", grid: "unavailable", measuredAir: "unavailable",
    modelledAir: "unavailable", aurora: "unavailable", tides: "unavailable", bathing: "unavailable",
    satellite: "unavailable", earthquakes: "unavailable", iss: "unavailable", warnings: "unavailable"
  },
  summary: { warmest: null, wettest: null, windiest: null, reporting: null, runningTrains: null, riverStations: null },
  timeline: []
});

export const emptyHistoryPayload = (timestamp) => ({
  schemaVersion: 1,
  capturedAt: new Date(timestamp).toISOString(),
  resolutionMinutes: RAW_RESOLUTION_MINUTES,
  snapshot: null,
  movementSummary: { rail: null, transit: null },
  periodSummary: null,
  gaps: [{
    source: "history", scope: "collector", reason: "collector-gap",
    detail: "No lower-resolution snapshot was collected for this period."
  }]
});

const safeBody = async (loader, fallback) => {
  try {
    const value = await loader();
    if (value instanceof Response) {
      if (!value.ok) throw new Error(`loader-http-${value.status}`);
      return (await value.json()) ?? fallback;
    }
    return value ?? fallback;
  } catch {
    return fallback;
  }
};

export async function buildHistoryCapture({
  env,
  capturedAtMs,
  fetcher = fetch,
  loadLiving,
  loadTransit,
  scoped: scopedInput
}) {
  const capturedAt = new Date(capturedAtMs).toISOString();
  const [scoped, living, transit] = await Promise.all([
    scopedInput ?? collectScopedSources(fetcher, capturedAtMs),
    safeBody(() => loadLiving(capturedAtMs), {
      trains: [], rivers: [],
      sourceStatus: { trains: "unavailable", rivers: "unavailable" },
      sourceProvenance: {}
    }),
    safeBody(() => loadTransit(capturedAtMs), { transit: [], transitStatus: env.NTA_API_KEY ? "unavailable" : "credential-required" })
  ]);
  const observedAtOrBeforeCapture = (item) => {
    const timestamp = Date.parse(item?.observedAt ?? "");
    return Number.isFinite(timestamp) && timestamp <= capturedAtMs;
  };
  const railStatus = "unavailable";
  const railSummary = null;
  const transitVehicles = (Array.isArray(transit.transit) ? transit.transit : []).filter(observedAtOrBeforeCapture);
  const aggregateObservedAt = Date.parse(transit.latestObservedAt ?? "");
  const suppliedTransitAggregate = transit.aggregate && Number.isFinite(aggregateObservedAt) && aggregateObservedAt <= capturedAtMs
    ? transit.aggregate
    : null;
  const requestedTransitStatus = transit.transitStatus ?? "unavailable";
  const transitErrorCode = transit.errorCode ?? null;
  const transitStatus = suppliedTransitAggregate || transitVehicles.length
    ? requestedTransitStatus
    : requestedTransitStatus === "credential-required" ? "credential-required" : "unavailable";
  const transitSummary = suppliedTransitAggregate ?? summarizeTransit(transitVehicles, transitStatus, capturedAt);
  const rivers = (Array.isArray(living.rivers) ? living.rivers : []).filter(observedAtOrBeforeCapture);
  const requestedRiverStatus = living.sourceStatus?.rivers ?? "unavailable";
  const riverStatus = usable(requestedRiverStatus) && rivers.length ? requestedRiverStatus : "unavailable";
  const boundedProvenance = (provenance, fallback) => ({
    ...fallback,
    ...(provenance ?? {}),
    fetchedAt: (() => {
      const timestamp = Date.parse(provenance?.fetchedAt ?? "");
      return Number.isFinite(timestamp) && timestamp <= capturedAtMs
        ? new Date(timestamp).toISOString()
        : capturedAt;
    })(),
    status: fallback.status,
    latestObservedAt: fallback.latestObservedAt
  });
  const riverLatestObservedAt = rivers.map((river) => river.observedAt).sort().at(-1) ?? null;
  const sources = {
    ...scoped.sources,
    rivers: {
      status: riverStatus,
      fetchedAt: capturedAt,
      latestObservedAt: riverLatestObservedAt,
      itemCount: rivers.length,
      errorCode: riverStatus === "unavailable" ? "upstream-unavailable" : null,
      data: rivers
    },
    rail: {
      status: railStatus, fetchedAt: capturedAt,
      latestObservedAt: null,
      itemCount: null,
      errorCode: "not-retained",
      data: null
    },
    transit: {
      status: transitStatus, fetchedAt: capturedAt,
      latestObservedAt: suppliedTransitAggregate
        ? new Date(aggregateObservedAt).toISOString()
        : transitVehicles.map((vehicle) => vehicle.observedAt).sort().at(-1) ?? null,
      itemCount: transitSummary?.total ?? null,
      errorCode: transitStatus === "live" ? null : (transitErrorCode ?? transitStatus),
      data: transitSummary
    }
  };
  const weather = sources.weather?.data ?? { stations: [], timeline: [], summary: {} };
  const warnings = Array.isArray(sources.warnings?.data) ? sources.warnings.data : [];
  const snapshot = {
    ...emptySnapshot(capturedAt),
    lastSuccessAt: Object.values(sources).some((item) => usable(item.status)) ? capturedAt : null,
    sourceStatus: sources.weather?.status ?? "unavailable",
    stations: weather.stations ?? [],
    warnings,
    warningsStatus: contextStatus(sources.warnings?.status),
    marine: Array.isArray(sources.marine?.data) ? sources.marine.data : [],
    rivers,
    grid: sources.grid?.data ?? null,
    airQuality: Array.isArray(sources.air_modelled?.data) ? sources.air_modelled.data : [],
    tides: Array.isArray(sources.tides?.data) ? sources.tides.data : [],
    bathingAlerts: Array.isArray(sources.bathing?.data) ? sources.bathing.data : [],
    earthquakes: Array.isArray(sources.earthquakes?.data) ? sources.earthquakes.data : [],
    sourceProvenance: {
      trains: unavailableProvenance("Irish Rail", "https://api.irishrail.ie/realtime/realtime.asmx/getCurrentTrainsXML", capturedAt),
      rivers: boundedProvenance(living.sourceProvenance?.rivers, {
        ...unavailableProvenance("OPW waterlevel.ie", "https://waterlevel.ie/geojson/latest/", capturedAt, riverStatus),
        latestObservedAt: riverLatestObservedAt
      })
    },
    contextStatus: {
      marine: contextStatus(sources.marine?.status), radar: "unavailable", grid: contextStatus(sources.grid?.status),
      measuredAir: "unavailable", modelledAir: contextStatus(sources.air_modelled?.status), aurora: "unavailable",
      tides: contextStatus(sources.tides?.status), bathing: contextStatus(sources.bathing?.status),
      satellite: "unavailable", earthquakes: contextStatus(sources.earthquakes?.status), iss: "unavailable",
      warnings: contextStatus(sources.warnings?.status)
    },
    summary: {
      warmest: weather.summary?.warmest ?? null,
      wettest: weather.summary?.wettest ?? null,
      windiest: weather.summary?.windiest ?? null,
      reporting: usable(sources.weather?.status) ? weather.summary?.reporting ?? null : null,
      runningTrains: railSummary?.running ?? null,
      riverStations: usable(riverStatus) ? rivers.length : null
    },
    timeline: weather.timeline ?? []
  };
  const gaps = [
    ...scoped.gaps,
    ...(riverStatus === "live" || riverStatus === "fallback" ? [] : [{
      source: "rivers", scope: "provider", reason: riverStatus,
      detail: "River observations were unavailable or stale at capture time."
    }]),
    ...[{
      source: "rail", scope: "history-v1", reason: "not-retained",
      detail: "Irish Rail historical retention is disabled until an explicitly permitted collection path is implemented."
    }],
    {
      source: "transit", scope: "history-v1", reason: "summary-only",
      detail: "Only NTA route-level aggregate counts are retained; vehicle IDs, positions and labels are excluded."
    },
    ...(transitStatus === "live" ? [] : [{
      source: "transit", scope: "provider", reason: transitStatus,
      detail: transitStatus === "credential-required" ? "NTA credentials were unavailable at capture time." : "NTA transit was unavailable at capture time."
    }])
  ];
  return {
    sources,
    sourceStatus: statusMetadata(sources),
    payload: {
      schemaVersion: 1,
      capturedAt,
      resolutionMinutes: RAW_RESOLUTION_MINUTES,
      snapshot,
      movementSummary: { rail: railSummary, transit: transitSummary },
      gaps
    },
    gaps
  };
}

export async function captureHistory(env, scheduledTime, loaders) {
  if (!env.HISTORY_DB) return { skipped: true, reason: "missing-binding" };
  const bucketStartMs = rawBucketStart(scheduledTime);
  const startedAtMs = Date.now();
  const inserted = await env.HISTORY_DB.prepare(`
    INSERT INTO history_collection_runs (bucket_start_ms, started_at_ms, outcome)
    VALUES (?, ?, 'running')
    ON CONFLICT(bucket_start_ms) DO NOTHING
  `).bind(bucketStartMs, startedAtMs).run();
  let acquired = Number(inserted?.meta?.changes ?? inserted?.changes ?? 0) > 0;
  if (!acquired) {
    const reclaimed = await env.HISTORY_DB.prepare(`
      UPDATE history_collection_runs
      SET started_at_ms = ?, completed_at_ms = NULL, outcome = 'running', error_code = NULL
      WHERE bucket_start_ms = ?
        AND (outcome = 'failed' OR (outcome = 'running' AND started_at_ms < ?))
    `).bind(startedAtMs, bucketStartMs, startedAtMs - COLLECTION_LEASE_MS).run();
    acquired = Number(reclaimed?.meta?.changes ?? reclaimed?.changes ?? 0) > 0;
  }
  if (!acquired) return { skipped: true, reason: "duplicate-bucket", bucketStartMs };

  const existing = await env.HISTORY_DB.prepare(`
    SELECT content_sha256, gaps_json FROM history_snapshots
    WHERE resolution_minutes = ? AND bucket_start_ms = ?
  `).bind(RAW_RESOLUTION_MINUTES, bucketStartMs).first();
  if (existing) {
    const gaps = JSON.parse(existing.gaps_json);
    const outcome = gaps.some((item) => item.scope === "provider") ? "partial" : "complete";
    await env.HISTORY_DB.prepare(`
      UPDATE history_collection_runs SET completed_at_ms = ?, outcome = ?, error_code = NULL
      WHERE bucket_start_ms = ? AND started_at_ms = ? AND outcome = 'running'
    `).bind(Date.now(), outcome, bucketStartMs, startedAtMs).run();
    return { skipped: false, recovered: true, bucketStartMs, outcome, contentSha256: existing.content_sha256 };
  }
  try {
    const capture = await buildHistoryCapture({ env, capturedAtMs: bucketStartMs, ...loaders });
    const row = await encodeSnapshotRow({
      resolutionMinutes: RAW_RESOLUTION_MINUTES,
      bucketStartMs,
      periodEndMs: bucketStartMs + RAW_RESOLUTION_MINUTES * MINUTE_MS,
      collectedAtMs: Date.now(),
      payload: capture.payload,
      expectedSamples: 1,
      collectedSamples: 1,
      sourceStatus: capture.sourceStatus,
      gaps: capture.gaps
    });
    await writeSnapshot(env.HISTORY_DB, row);
    const outcome = capture.gaps.some((item) => item.scope === "provider") ? "partial" : "complete";
    await env.HISTORY_DB.prepare(`
      UPDATE history_collection_runs SET completed_at_ms = ?, outcome = ?, error_code = NULL
      WHERE bucket_start_ms = ? AND started_at_ms = ? AND outcome = 'running'
    `).bind(Date.now(), outcome, bucketStartMs, startedAtMs).run();
    return { skipped: false, bucketStartMs, outcome, contentSha256: row.contentSha256 };
  } catch (error) {
    await env.HISTORY_DB.prepare(`
      UPDATE history_collection_runs SET completed_at_ms = ?, outcome = 'failed', error_code = ?
      WHERE bucket_start_ms = ? AND started_at_ms = ? AND outcome = 'running'
    `).bind(Date.now(), "capture-failed", bucketStartMs, startedAtMs).run();
    throw error;
  }
}

export async function maintainHistory(env, scheduledTime) {
  if (!env.HISTORY_DB) return { skipped: true, reason: "missing-binding" };
  const hourEnd = hourBucketStart(scheduledTime);
  const hourStart = hourEnd - HOUR_MS;
  await rollupPeriod(env.HISTORY_DB, {
    fromResolutionMinutes: RAW_RESOLUTION_MINUTES,
    resolutionMinutes: HOUR_RESOLUTION_MINUTES,
    startMs: hourStart,
    endMs: hourEnd,
    expectedSamples: 4,
    sourceKeys: HISTORY_SOURCE_KEYS,
    emptyPayload: emptyHistoryPayload
  });
  if (isDublinHour(scheduledTime, 0)) {
    const day = previousDublinDayBounds(scheduledTime);
    await rollupPeriod(env.HISTORY_DB, {
      fromResolutionMinutes: HOUR_RESOLUTION_MINUTES,
      resolutionMinutes: DAY_RESOLUTION_MINUTES,
      startMs: day.start,
      endMs: day.end,
      expectedSamples: Math.round((day.end - day.start) / HOUR_MS),
      sourceKeys: HISTORY_SOURCE_KEYS,
      emptyPayload: emptyHistoryPayload,
      summaryOnly: true
    });
  }
  if (isDublinHour(scheduledTime, 3)) await pruneHistory(env.HISTORY_DB, scheduledTime);
  return { skipped: false, hourStart };
}

export async function handleHistoryRequest(request, env, now = Date.now()) {
  const url = new URL(request.url);
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response(JSON.stringify({ error: "Method not allowed." }), {
      status: 405,
      headers: { ...responseHeaders, "cache-control": "no-store", allow: "GET, HEAD" }
    });
  }
  if (!env.HISTORY_DB) {
    return json({ error: "Historical storage is not provisioned." }, 503);
  }
  if (url.pathname === "/api/history/range") {
    return json(await historyRange(env.HISTORY_DB), 200, "public, max-age=60, s-maxage=60");
  }
  const at = url.searchParams.get("at");
  const rfc3339 = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(?:Z|([+-])(\d{2}):(\d{2}))$/;
  const match = at?.match(rfc3339);
  const requestedAt = Date.parse(at ?? "");
  const calendarDate = match
    ? new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])))
    : null;
  const validCalendar = Boolean(match &&
    calendarDate?.getUTCFullYear() === Number(match[1]) &&
    calendarDate?.getUTCMonth() === Number(match[2]) - 1 &&
    calendarDate?.getUTCDate() === Number(match[3]) &&
    Number(match[4]) <= 23 && Number(match[5]) <= 59 && Number(match[6]) <= 59 &&
    (!match[7] || (Number(match[8]) <= 23 && Number(match[9]) <= 59)));
  if (!at || !validCalendar || !Number.isFinite(requestedAt) || requestedAt > now) {
    return json({ error: "at must be a valid RFC 3339 timestamp that is not in the future." }, 400);
  }
  return json(await resolveHistory(env.HISTORY_DB, requestedAt, now), 200, "public, max-age=60, s-maxage=300");
}
