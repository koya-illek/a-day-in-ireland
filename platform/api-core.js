import {
  RIVER_ENDPOINT,
  buildLivingPayload,
  makeRiverProvenance,
  normalizeRiverReadings,
  normalizeBathingAlerts,
  normalizeOfficialWeatherWarnings,
  normalizeProviderTimestamp,
  parseRiverGeoJson,
  readBoundedJsonResponse,
  readBoundedTextResponse
} from "./river-source.js";
import { dublinDateKey, fetchMetForecast, fetchSolarDay } from "./sky-source.js";
import {
  classifyTideTrend,
  COASTAL_MARINE_SOURCES,
  fetchGrid,
  irishGridToLonLat,
  MEASURED_AIR_POLLUTANTS,
  measuredAirStamp,
  measuredAirUrl,
  numeric,
  normalizeRadarFrames,
  parseCoastalObservatoryRow,
  parseMeasuredAirStations,
  parseWeatherBuoyRows,
  providerHttpsUrl,
  tideQueryWindow,
  weatherBuoyQuery
} from "./live-normalize.js";

// One shared Worker API core serves both deployment targets: the Cloudflare
// production adapter (platform/cloudflare-entry.js) and the alternate hosting
// adapter (platform/server-entry.js). Provider acquisition, the context
// refresh state machine, and the whole HTTP contract live here exactly once;
// adapters contribute only their bindings (coordinators, assets, history) and
// their static-serving behaviour.

export const COORDINATOR_RAW_BODY_LIMIT = 900_000;

// ---------------------------------------------------------------------------
// Shared HTTP contract: every API response carries JSON content type, CORS,
// noindex, and an explicit cache posture.
// ---------------------------------------------------------------------------

const respondApiJson = (body, { status = 200, cacheControl = "no-store", headers = {} } = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      ...headers,
      "content-type": "application/json; charset=utf-8",
      "cache-control": cacheControl,
      "access-control-allow-origin": "*",
      "x-robots-tag": "noindex, nofollow"
    }
  });

const METHOD_HEADERS = {
  allow: "GET, HEAD, OPTIONS",
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, HEAD, OPTIONS",
  "access-control-allow-headers": "content-type",
  "x-robots-tag": "noindex, nofollow"
};

export const methodResponse = (request) => {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: METHOD_HEADERS });
  return respondApiJson({ error: "Method not allowed" }, { status: 405, headers: { allow: METHOD_HEADERS.allow } });
};

export const apiErrorResponse = (message) => respondApiJson({ error: message }, { status: 503 });

const unknownApiResponse = () => respondApiJson({ error: "Not found." }, { status: 404 });

const LIVING_LIVE_CACHE = "public, max-age=15, s-maxage=15";
const LIVING_PARTIAL_CACHE = "public, max-age=15, s-maxage=15, stale-while-revalidate=0";

// ---------------------------------------------------------------------------
// Provider acquisition
// ---------------------------------------------------------------------------

const value = (xml, name) =>
  (new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(xml)?.[1] ?? "")
    // &amp; last: decoding it first would turn escaped literal text such as
    // "&amp;lt;" into markup characters instead of the intended "&lt;".
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", "\"")
    .replaceAll("&#39;", "'")
    .replaceAll("&amp;", "&")
    .trim();

export const fetchTrains = async () => {
  const response = await fetch(
    "https://api.irishrail.ie/realtime/realtime.asmx/getCurrentTrainsXML",
    { cf: { cacheEverything: true, cacheTtl: 60 } }
  );
  if (!response.ok) throw new Error(`Irish Rail returned ${response.status}`);
  const xml = await readBoundedTextResponse(response, "irish-rail", COORDINATOR_RAW_BODY_LIMIT);
  // Irish Rail's realtime XML does not include a per-train observation clock.
  // Stamp last-seen-at-refresh so stale detection measures fetch cadence, not GPS age.
  const observedAt = new Date().toISOString();
  return [...xml.matchAll(/<objTrainPositions>([\s\S]*?)<\/objTrainPositions>/g)]
    .map((match) => {
      const latitude = Number.parseFloat(value(match[1], "TrainLatitude"));
      const longitude = Number.parseFloat(value(match[1], "TrainLongitude"));
      if (
        !Number.isFinite(latitude) ||
        !Number.isFinite(longitude) ||
        latitude < 51.2 ||
        latitude > 55.6 ||
        longitude < -10.8 ||
        longitude > -5.2
      ) return null;
      return {
        id: value(match[1], "TrainCode"),
        latitude,
        longitude,
        status: value(match[1], "TrainStatus") === "R" ? "running" : "not-started",
        direction: value(match[1], "Direction"),
        message: value(match[1], "PublicMessage").replaceAll("\\n", " · "),
        observedAt,
        speedKmh: null,
        speedSource: null
      };
    })
    .filter(Boolean);
};

let trainsInFlight = null;
// Coalesces concurrent Irish Rail refreshes within one isolate so a burst of
// cold requests cannot multiply upstream calls.
export const dedupedFetchTrains = () => {
  if (!trainsInFlight) {
    trainsInFlight = fetchTrains().finally(() => { trainsInFlight = null; });
  }
  return trainsInFlight;
};

export const normalizeWeatherWarnings = (rows, now = Date.now()) => normalizeOfficialWeatherWarnings(rows, now);

const fetchWarnings = async () => {
  const response = await fetch("https://www.met.ie/Open_Data/json/warning_IRELAND.json", {
    cf: { cacheEverything: true, cacheTtl: 300, cacheTtlByStatus: { "200-299": 300, "400-599": 0 } }
  });
  if (!response.ok) throw new Error(`Met Éireann warnings returned ${response.status}`);
  return normalizeWeatherWarnings((await readBoundedJsonResponse(response, "met-warnings", 512_000)).body);
};

const decodeHtml = (value) => value
  .replaceAll("&quot;", "\"")
  .replaceAll("&#39;", "'")
  .replaceAll("&#x27;", "'")
  .replaceAll("&lt;", "<")
  .replaceAll("&gt;", ">")
  .replaceAll("&amp;", "&");

const fetchRiversThroughBrowser = async (env) => {
  if (!env?.BROWSER?.quickAction) throw new Error("Browser Run binding unavailable");
  const response = await env.BROWSER.quickAction("content", {
    url: RIVER_ENDPOINT,
    gotoOptions: { waitUntil: "domcontentloaded", timeout: 30_000 },
    rejectResourceTypes: ["image", "stylesheet", "font", "media"]
  });
  if (!response.ok) throw new Error(`Browser Run returned ${response.status}`);
  const rendered = await readBoundedTextResponse(response, "opw-browser", COORDINATOR_RAW_BODY_LIMIT);
  const pre = /<pre[^>]*>([\s\S]*?)<\/pre>/i.exec(rendered)?.[1];
  const decoded = decodeHtml(pre ?? rendered);
  const normalized = decoded.startsWith("{\\\"") ? decoded.replaceAll("\\\"", "\"") : decoded;
  try {
    return JSON.parse(normalized);
  } catch (error) {
    throw new Error(`${error.message}; response starts ${JSON.stringify(normalized.slice(0, 240))}`);
  }
};

export const acquireRiverRaw = async (env, fetcher = fetch) => {
  const fetchedAt = new Date().toISOString();
  const response = await fetcher(RIVER_ENDPOINT, {
    headers: {
      "accept": "application/json", "referer": "https://waterlevel.ie/",
      "user-agent": "A-Day-in-Ireland/2.0 (+https://day.illek.ie)"
    }
  });
  if (response.ok) {
    const bounded = await readBoundedJsonResponse(response, "opw", COORDINATOR_RAW_BODY_LIMIT);
    const features = Array.isArray(bounded.body?.features) ? bounded.body.features : [];
    return {
      ...bounded,
      body: features.length ? { ...bounded.body, features: features.slice(0, 1200) } : bounded.body,
      sourceFeatureCount: features.length,
      truncated: features.length > 1200,
      fetchedAt, status: features.length > 1200 ? "partial" : "live", fallback: null
    };
  }
  let detail;
  try {
    detail = (await readBoundedTextResponse(response, "opw-error", 32_000)).replace(/\s+/g, " ").slice(0, 240);
  } catch (error) {
    detail = String(error?.message ?? "OPW error response was unreadable");
  }
  if (env?.EDGE_RUNTIME === "cloudflare") {
    // Temporary fetch path: waterlevel.ie currently rejects ordinary Worker HTTPS.
    // Browser Run is not a second dataset; provenance stays labelled fallback.
    try {
      const body = await fetchRiversThroughBrowser(env);
      const features = Array.isArray(body?.features) ? body.features : [];
      return { body: features.length ? { ...body, features: features.slice(0, 1200) } : body,
        bodyBytes: null, sourceFeatureCount: features.length, truncated: features.length > 1200,
        fetchedAt, status: features.length > 1200 ? "partial" : "fallback", fallback: "Cloudflare Browser Run" };
    }
    catch (browserError) { throw new Error(`OPW returned ${response.status}: ${detail}; Browser Run fallback failed: ${browserError.message}`); }
  }
  // The hosted river bridge is an operator-configured fallback for the
  // non-Cloudflare adapter only. It stays disabled unless a valid HTTPS
  // bridge URL is explicitly provided, so no third-party host is embedded
  // in source, and every failure keeps the same diagnosable message shape.
  let bridgeUrl = null;
  if (typeof env?.RIVER_BRIDGE_URL === "string") {
    try {
      const parsed = new URL(env.RIVER_BRIDGE_URL);
      // Userinfo in a configured fetch target is always a mistake here; the
      // plain fetcher would never use such credentials.
      if (parsed.protocol === "https:" && parsed.hostname && !parsed.username && !parsed.password) {
        bridgeUrl = parsed.toString();
      }
    } catch {
      bridgeUrl = null;
    }
  }
  const fallbackUnavailable = () => new Error(`OPW returned ${response.status}: ${detail}; fallback unavailable`);
  if (!bridgeUrl) throw fallbackUnavailable();
  try {
    const bridge = await fetcher(bridgeUrl, {
      cf: { cacheEverything: true, cacheTtl: 900 }
    });
    if (bridge.ok) {
      const bounded = await readBoundedJsonResponse(bridge, "opw-bridge", COORDINATOR_RAW_BODY_LIMIT);
      if (Array.isArray(bounded.body?.rivers)) return {
        body: { normalizedRivers: bounded.body.rivers.slice(0, 1200) }, bodyBytes: bounded.bodyBytes,
        sourceFeatureCount: bounded.body.rivers.length, truncated: bounded.body.rivers.length > 1200,
        fetchedAt, status: bounded.body.rivers.length > 1200 ? "partial" : "fallback", fallback: "Configured river bridge"
      };
      throw new Error("configured river bridge returned no rivers array");
    }
    throw new Error(`configured river bridge returned ${bridge.status}`);
  } catch (bridgeError) {
    const cause = String(bridgeError?.message ?? bridgeError).slice(0, 240);
    throw new Error(`OPW returned ${response.status}: ${detail}; fallback unavailable (${cause})`);
  }
};

export const normalizeRiverRaw = (raw, captureNow = Date.now()) => {
  if (Array.isArray(raw?.body?.normalizedRivers)) {
    return normalizeRiverReadings(raw.body.normalizedRivers, captureNow);
  }
  return parseRiverGeoJson(raw?.body, captureNow);
};

export const fetchRiversResult = async (env, fetcher = fetch, captureNow = Date.now()) => {
  const raw = await acquireRiverRaw(env, fetcher);
  const rivers = normalizeRiverRaw(raw, captureNow);
  if (!rivers.length) throw new Error("OPW returned no fresh river gauges");
  return {
    rivers,
    provenance: makeRiverProvenance({ status: raw.status, fetchedAt: raw.fetchedAt, readings: rivers, fallback: raw.fallback })
  };
};

export const fetchRivers = async (env) => (await fetchRiversResult(env)).rivers;


const freshEnough = (value, hours = 6) => {
  const timestamp = new Date(value).getTime();
  const age = Date.now() - timestamp;
  return Number.isFinite(timestamp) && age >= 0 && age < hours * 60 * 60 * 1000;
};

const fetchWeatherBuoys = async () => {
  const response = await fetch(weatherBuoyQuery().url, { cf: { cacheEverything: true, cacheTtl: 900 } });
  if (!response.ok) throw new Error(`Marine weather buoys returned ${response.status}`);
  const body = (await readBoundedJsonResponse(response, "marine-weather-buoys", 512_000)).body;
  return parseWeatherBuoyRows(body.table?.rows);
};

const fetchCoastalBuoy = async (source) => {
  const query = `${source.variables.join(",")}&orderByMax("time")`;
  const response = await fetch(
    `https://erddap.marine.ie/erddap/tabledap/${source.dataset}.json?${encodeURI(query)}`,
    { cf: { cacheEverything: true, cacheTtl: 900 } }
  );
  if (!response.ok) throw new Error(`${source.name} returned ${response.status}`);
  const body = (await readBoundedJsonResponse(response, "marine-coastal", 512_000)).body;
  return parseCoastalObservatoryRow(source, body.table?.rows?.[0]);
};

export const fetchMarine = async () => {
  const results = await Promise.allSettled([
    fetchWeatherBuoys(),
    ...COASTAL_MARINE_SOURCES.map(fetchCoastalBuoy)
  ]);
  const weather = results[0].status === "fulfilled" ? results[0].value : [];
  const coastal = results.slice(1).flatMap((result) =>
    result.status === "fulfilled" && result.value ? [result.value] : []
  );
  const readings = [...weather, ...coastal];
  const completeCoverage = results.every((result) => result.status === "fulfilled") &&
    weather.length > 0 && coastal.length === COASTAL_MARINE_SOURCES.length;
  return {
    readings,
    status: readings.length ? completeCoverage ? "live" : "partial" : "unavailable"
  };
};


const fetchRadar = async () => {
  const response = await fetch("https://gdal.met.ie/api/maps/radar", {
    cf: { cacheEverything: true, cacheTtl: 300 }
  });
  if (!response.ok) throw new Error(`Met Éireann radar returned ${response.status}`);
  return normalizeRadarFrames((await readBoundedJsonResponse(response, "met-radar", 512_000)).body);
};


const airLocations = [
  ["dublin-air", "Dublin", 53.35, -6.26],
  ["belfast-air", "Belfast", 54.60, -5.93],
  ["cork-air", "Cork", 51.90, -8.48],
  ["galway-air", "Galway", 53.27, -9.06],
  ["limerick-air", "Limerick", 52.66, -8.63],
  ["waterford-air", "Waterford", 52.26, -7.11],
  ["derry-air", "Derry", 55.00, -7.31]
];

export const fetchAirQuality = async () => {
  const url = new URL("https://air-quality-api.open-meteo.com/v1/air-quality");
  url.search = new URLSearchParams({
    latitude: airLocations.map((item) => item[2]).join(","),
    longitude: airLocations.map((item) => item[3]).join(","),
    current: "european_aqi,pm2_5,pm10,nitrogen_dioxide,ozone,uv_index,grass_pollen",
    timezone: "GMT"
  }).toString();
  const response = await fetch(url, { cf: { cacheEverything: true, cacheTtl: 1800 } });
  if (!response.ok) throw new Error(`Open-Meteo air quality returned ${response.status}`);
  const bodies = (await readBoundedJsonResponse(response, "open-meteo-air", 256_000)).body;
  const readings = airLocations.flatMap(([id, name, latitude, longitude], index) => {
    const current = bodies[index]?.current;
    if (!current?.time) return [];
    return [{
      id, name, latitude, longitude, observedAt: `${current.time}:00Z`,
      europeanAqi: numeric(current.european_aqi), pm25: numeric(current.pm2_5),
      pm10: numeric(current.pm10), nitrogenDioxide: numeric(current.nitrogen_dioxide),
      ozone: numeric(current.ozone), uvIndex: numeric(current.uv_index),
      grassPollen: numeric(current.grass_pollen), source: "modelled",
      stationClassification: null
    }];
  });
  return {
    readings,
    status: readings.length === airLocations.length ? "live" : readings.length ? "partial" : "unavailable"
  };
};


const fetchMeasuredAirQuality = async () => {
  const stamp = measuredAirStamp();
  const results = await Promise.allSettled(MEASURED_AIR_POLLUTANTS.map(async ([pollutant, field]) => {
    const response = await fetch(measuredAirUrl(pollutant, stamp), {
      cf: { cacheEverything: true, cacheTtl: 1800 }
    });
    if (!response.ok) throw new Error(`EEA ${pollutant} returned ${response.status}`);
    return [field, await readBoundedTextResponse(response, `eea-${pollutant}`, 512_000)];
  }));
  const responses = results.flatMap((result) => result.status === "fulfilled" ? [result.value] : []);
  if (!responses.length) {
    const reasons = results.flatMap((result) => result.status === "rejected" ? [String(result.reason)] : []);
    throw new Error(`EEA measured air unavailable: ${reasons.join("; ")}`);
  }
  return parseMeasuredAirStations(responses);
};


export const fetchTides = async () => {
  const { since, until } = tideQueryWindow();
  const base = "https://erddap.marine.ie/erddap/tabledap/";
  const [levelsResult, surgeResult, predictionResult] = await Promise.allSettled([
    fetch(`${base}IrishNationalTideGaugeNetwork.json?${encodeURI(`station_id,longitude,latitude,time,Water_Level_OD_Malin&time>=${since}`)}`, { cf: { cacheEverything: true, cacheTtl: 900 } }),
    fetch(`${base}imiSurgeObservationINTGN.json?${encodeURI(`stationID,longitude,latitude,time,sea_surface_elevation_due_to_tide,sea_surface_elevation_due_to_storm_surge&time>=${since}&orderByMax("stationID,time")`)}`, { cf: { cacheEverything: true, cacheTtl: 900 } }),
    fetch(`${base}IMI_TidePrediction_HighLow.json?${encodeURI(`stationID,longitude,latitude,time,tide_time_category,Water_Level_ODMalin&time>=${since}&time<=${until}`)}`, { cf: { cacheEverything: true, cacheTtl: 3600 } })
  ]);
  if (levelsResult.status === "rejected") throw levelsResult.reason;
  const levelsResponse = levelsResult.value;
  const surgeResponse = surgeResult.status === "fulfilled" ? surgeResult.value : null;
  const predictionResponse = predictionResult.status === "fulfilled" ? predictionResult.value : null;
  if (!levelsResponse.ok) throw new Error(`Tide gauges returned ${levelsResponse.status}`);
  const levelRows = (await readBoundedJsonResponse(levelsResponse, "tide-levels", 512_000)).body.table?.rows ?? [];
  const surges = surgeResponse?.ok ? (await readBoundedJsonResponse(surgeResponse, "tide-surge", 512_000)).body.table?.rows ?? [] : [];
  const predictions = predictionResponse?.ok ? (await readBoundedJsonResponse(predictionResponse, "tide-predictions", 512_000)).body.table?.rows ?? [] : [];
  const distance = (a, b) => Math.hypot(Number(a[1]) - Number(b[1]), Number(a[2]) - Number(b[2]));
  const now = Date.now();
  const stationRows = new Map();
  for (const row of levelRows) {
    const rows = stationRows.get(String(row[0])) ?? [];
    rows.push(row);
    stationRows.set(String(row[0]), rows);
  }
  const readings = [...stationRows.values()].flatMap((rows) => {
    rows.sort((a, b) => new Date(a[3]) - new Date(b[3]));
    const row = rows.at(-1);
    const observedAt = String(row[3]);
    if (!freshEnough(observedAt, 3)) return [];
    const surge = [...surges].sort((a, b) => distance(row, a) - distance(row, b))[0];
    const nearby = predictions.filter((item) => distance(row, item) < .08);
    const future = nearby.filter((item) => new Date(item[3]).getTime() > now);
    const nextHigh = future.find((item) => item[4] === "HIGH");
    const nextLow = future.find((item) => item[4] === "LOW");
    const predictedLevel = surge && distance(row, surge) < .08 ? numeric(surge[4]) : null;
    const surgeLevel = surge && distance(row, surge) < .08 ? numeric(surge[5]) : null;
    return [{
      id: `tide-${String(row[0]).toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
      name: String(row[0]),
      longitude: Number(row[1]),
      latitude: Number(row[2]),
      observedAt,
      waterLevel: numeric(row[4]),
      predictedLevel,
      surge: surgeLevel,
      trend: classifyTideTrend(rows.map((sample) => ({
        observedAt: sample[3],
        waterLevel: sample[4]
      }))),
      nextHighAt: nextHigh ? String(nextHigh[3]) : null,
      nextHighLevel: nextHigh ? numeric(nextHigh[5]) : null,
      nextLowAt: nextLow ? String(nextLow[3]) : null,
      nextLowLevel: nextLow ? numeric(nextLow[5]) : null
    }];
  });
  return {
    readings,
    status: readings.length
      ? surgeResponse?.ok && predictionResponse?.ok ? "live" : "partial"
      : "unavailable"
  };
};


export const fetchBathingAlerts = async () => {
  const alertsResponse = await fetch("https://data.epa.ie/bw/api/v1/alerts?per_page=100", {
    cf: { cacheEverything: true, cacheTtl: 900 }
  });
  if (!alertsResponse.ok) throw new Error(`EPA bathing alerts returned ${alertsResponse.status}`);
  const alerts = normalizeBathingAlerts((await readBoundedJsonResponse(alertsResponse, "epa-bathing-alerts", 512_000)).body.list ?? []);
  if (!alerts.length) return { alerts: [], status: "live" };
  const locationsResponse = await fetch("https://data.epa.ie/bw/api/v1/locations?per_page=500", {
    cf: { cacheEverything: true, cacheTtl: 86400 }
  });
  if (!locationsResponse.ok) throw new Error(`EPA bathing locations returned ${locationsResponse.status}`);
  const locations = new Map(((await readBoundedJsonResponse(locationsResponse, "epa-bathing-locations", 1_000_000)).body.list ?? []).map((item) => [item.beach_id, item]));
  const archived = alerts.flatMap((alert) => {
    const location = locations.get(alert.beach_id);
    const east = numeric(location?.easting);
    const north = numeric(location?.northing);
    if (east === null || north === null) return [];
    const startedAt = normalizeProviderTimestamp(alert.incident_start_date) ?? "";
    const explicitEnd = normalizeProviderTimestamp(alert.incident_end_date);
    const expectedDuration = numeric(alert.incident_expected_duration);
    // Optional response metadata: older consumers ignore endsAt; browser refresh uses it to age cached alerts.
    const endsAt = explicitEnd ?? (
      startedAt && expectedDuration !== null && expectedDuration > 0
        ? new Date(Date.parse(startedAt) + expectedDuration * 86_400_000).toISOString()
        : null
    );
    return [{
      id: `bathing-${alert.incident_id}`,
      name: String(alert.beach_name),
      county: String(alert.county_name ?? ""),
      ...irishGridToLonLat(east, north),
      restriction: String(alert.bathing_restriction_type ?? "Bathing alert"),
      description: String(alert.incident_description ?? ""),
      startedAt,
      endsAt,
      updatedAt: String(alert.last_updated ?? ""),
      noticeUrl: providerHttpsUrl(alert.bathing_notice_pdf)
    }];
  });
  return {
    alerts: archived,
    status: archived.length === alerts.length ? "live" : "partial"
  };
};

const DAY_MS = 24 * 60 * 60 * 1000;
const SATELLITE_LAYER = "VIIRS_SNPP_CorrectedReflectance_TrueColor";
const SATELLITE_MATRIX_SET = "GoogleMapsCompatible_Level9";
const SATELLITE_PROBE_TILES = [
  [30, 20], [31, 21]
];
const SATELLITE_DOMAINS_URL =
  `https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/1.0.0/${SATELLITE_LAYER}/default/${SATELLITE_MATRIX_SET}/all/all.xml`;
const SATELLITE_SUCCESS_CACHE_MS = 6 * 60 * 60 * 1000;
const SATELLITE_FAILURE_CACHE_MS = 30 * 60 * 1000;

export const satelliteTileTemplate = (date) =>
  `https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/${SATELLITE_LAYER}/default/${date}/${SATELLITE_MATRIX_SET}/{z}/{y}/{x}.jpeg`;

const dateOnly = (timestamp) => new Date(timestamp).toISOString().slice(0, 10);

export const probeSatelliteDate = async (date, fetcher = fetch) => {
  const template = satelliteTileTemplate(date);
  const probes = await Promise.all(SATELLITE_PROBE_TILES.map(async ([x, y]) => {
    const url = template
      .replace("{z}", "6")
      .replace("{y}", String(y))
      .replace("{x}", String(x));
    try {
      const response = await fetcher(url, {
        method: "HEAD",
        cf: { cacheEverything: true, cacheTtl: 21600 }
      });
      const actualDate = response.headers.get("layer-time-actual");
      return response.ok &&
        response.headers.get("content-type")?.toLowerCase().startsWith("image/jpeg") === true &&
        (!actualDate || actualDate.startsWith(date));
    } catch {
      return false;
    }
  }));
  return probes.every(Boolean);
};

const latestDomainDate = (xml, notAfter) => {
  const candidates = [...String(xml).matchAll(
    /\b(\d{4}-\d{2}-\d{2})(?:\/(\d{4}-\d{2}-\d{2})\/P1D)?\b/g
  )].flatMap((match) => {
    const startDate = match[1];
    const endDate = match[2];
    if (startDate > notAfter) return [];
    if (!endDate) return [startDate];
    return [endDate < notAfter ? endDate : notAfter];
  }).sort();
  return candidates.at(-1) ?? null;
};

export const resolveSatelliteAvailability = async ({
  now = Date.now(),
  fetcher = (...args) => fetch(...args)
} = {}) => {
  const today = dateOnly(now);
  const fallbackDate = dateOnly(now - DAY_MS);
  try {
    const domains = await fetcher(SATELLITE_DOMAINS_URL, {
      cf: { cacheEverything: true, cacheTtl: 300 }
    });
    if (!domains.ok) throw new Error(`NASA GIBS Domains returned ${domains.status}`);
    const advertisedDate = latestDomainDate(await readBoundedTextResponse(domains, "nasa-gibs-domains", 262_144), today);
    return {
      advertisedDate,
      startDate: advertisedDate ?? fallbackDate,
      cacheKey: `${today}|${advertisedDate ?? "metadata-unavailable"}`
    };
  } catch {
    return {
      advertisedDate: null,
      startDate: fallbackDate,
      cacheKey: `${today}|metadata-unavailable`
    };
  }
};

export const findLatestSatelliteFrame = async ({
  now = Date.now(),
  fetcher = fetch,
  maximumLookbackDays = 5,
  startDate
} = {}) => {
  const availability = typeof startDate === "string"
    ? { startDate }
    : await resolveSatelliteAvailability({ now, fetcher });
  const firstDate = availability.startDate;

  const firstTimestamp = Date.parse(`${firstDate}T00:00:00Z`);
  for (let offset = 0; offset <= maximumLookbackDays; offset += 1) {
    const date = dateOnly(firstTimestamp - offset * DAY_MS);
    if (!await probeSatelliteDate(date, fetcher)) continue;
    return {
      observedAt: `${date}T00:00:00Z`,
      label: "VIIRS true colour · verified NASA archive frame",
      tileTemplate: satelliteTileTemplate(date)
    };
  }
  throw new Error("NASA GIBS has no verified Ireland satellite frame in the recent archive");
};

export const createSatelliteAvailabilityResolver = ({
  clock = () => Date.now(),
  fetcher = (...args) => fetch(...args),
  resolveAvailability = resolveSatelliteAvailability,
  discoverFrame = findLatestSatelliteFrame,
  maximumLookbackDays = 5,
  successCacheMs = SATELLITE_SUCCESS_CACHE_MS,
  failureCacheMs = SATELLITE_FAILURE_CACHE_MS
} = {}) => {
  let latestGeneration = 0;
  const cache = {
    key: null,
    checkedAt: 0,
    outcome: "empty",
    frame: null
  };

  return async () => {
    // Allocate before the first await so request start order, not upstream
    // response order, decides which completion is allowed to publish.
    const generation = ++latestGeneration;
    const now = clock();
    const availability = await resolveAvailability({ now, fetcher });
    const cacheAge = now - cache.checkedAt;
    const cacheIsCurrent = cache.key === availability.cacheKey && cacheAge >= 0;
    if (cacheIsCurrent && cache.outcome === "success" && cacheAge < successCacheMs) {
      return cache.frame;
    }
    if (cacheIsCurrent && cache.outcome === "failure" && cacheAge < failureCacheMs) {
      throw new Error("NASA GIBS satellite availability is in a recent failed state");
    }

    try {
      const frame = await discoverFrame({
        now,
        fetcher,
        maximumLookbackDays,
        startDate: availability.startDate
      });
      if (generation === latestGeneration) {
        cache.key = availability.cacheKey;
        cache.checkedAt = now;
        cache.outcome = "success";
        cache.frame = frame;
      }
      return frame;
    } catch (error) {
      if (generation === latestGeneration) {
        cache.key = availability.cacheKey;
        cache.checkedAt = now;
        cache.outcome = "failure";
        cache.frame = null;
      }
      throw error;
    }
  };
};

const fetchEarthquakes = async () => {
  const start = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const url = new URL("https://earthquake.usgs.gov/fdsnws/event/1/query");
  url.search = new URLSearchParams({
    format: "geojson", starttime: start, minlatitude: "49", maxlatitude: "57",
    minlongitude: "-13", maxlongitude: "-4", orderby: "time"
  }).toString();
  const response = await fetch(url, { cf: { cacheEverything: true, cacheTtl: 900 } });
  if (!response.ok) throw new Error(`USGS earthquakes returned ${response.status}`);
  const body = (await readBoundedJsonResponse(response, "usgs-earthquakes", 512_000)).body;
  return (body.features ?? []).slice(0, 30).flatMap((feature) => {
    const [longitude, latitude, depthKm] = feature.geometry?.coordinates ?? [];
    const magnitude = numeric(feature.properties?.mag);
    if (![longitude, latitude, depthKm].every(Number.isFinite) || magnitude === null) return [];
    return [{
      id: String(feature.id), longitude, latitude, depthKm, magnitude,
      place: String(feature.properties?.place ?? "Near Ireland"),
      observedAt: new Date(Number(feature.properties?.time)).toISOString(),
      detailUrl: providerHttpsUrl(feature.properties?.url) ?? ""
    }];
  });
};

const fetchIssTle = async () => {
  const response = await fetch(
    "https://celestrak.org/NORAD/elements/gp.php?CATNR=25544&FORMAT=TLE",
    { cf: { cacheEverything: true, cacheTtl: 21600 } }
  );
  if (!response.ok) throw new Error(`CelesTrak returned ${response.status}`);
  const lines = (await readBoundedTextResponse(response, "celestrak", 32_000)).trim().split(/\r?\n/);
  if (lines.length < 3) throw new Error("CelesTrak returned an invalid ISS element set");
  return { line1: lines.at(-2), line2: lines.at(-1), observedAt: new Date().toISOString() };
};

export const acquireTransitRaw = async (env, fetcher = fetch) => {
  if (!env.NTA_API_KEY) return { vehicles: [], status: "credential-required" };
  const response = await fetcher("https://api.nationaltransport.ie/gtfsr/v2/Vehicles?format=json", {
    headers: { "x-api-key": env.NTA_API_KEY },
    // NTA permits each token to call the GTFS-R API at most once per 60 seconds.
    cf: {
      cacheEverything: true,
      cacheTtl: 60,
      cacheTtlByStatus: { "200-299": 60, "400-599": 0 }
    }
  });
  if (!response.ok) throw new Error(`NTA vehicles returned ${response.status}`);
  const bounded = await readBoundedJsonResponse(response, "nta", COORDINATOR_RAW_BODY_LIMIT);
  const entities = bounded.body.entity ?? bounded.body.Entity ?? bounded.body.entities ?? [];
  const sourceEntityCount = Array.isArray(entities) ? entities.length : 0;
  return {
    entities: Array.isArray(entities) ? entities.slice(0, 1200) : [],
    status: sourceEntityCount > 1200 ? "partial" : "acquired",
    sourceEntityCount,
    truncated: sourceEntityCount > 1200,
    bodyBytes: bounded.bodyBytes,
    acquiredAt: Date.now()
  };
};

export const normalizeTransitEntities = (entities, now = Date.now()) => (Array.isArray(entities) ? entities : []).flatMap((entity) => {
    const vehicle = entity.vehicle ?? entity.Vehicle ?? entity;
    const position = vehicle.position ?? vehicle.Position;
    const latitude = numeric(position?.latitude ?? position?.Latitude);
    const longitude = numeric(position?.longitude ?? position?.Longitude);
    if (latitude === null || longitude === null || latitude < 51.2 || latitude > 55.6 || longitude < -10.8 || longitude > -5.2) return [];
    const timestamp = numeric(vehicle.timestamp ?? vehicle.Timestamp);
    if (timestamp === null) return [];
    const observedAt = new Date(timestamp * 1000);
    const age = now - observedAt.getTime();
    if (!Number.isFinite(observedAt.getTime()) || age < 0 || age >= 30 * 60_000) return [];
    const stableFallbackId = () => {
      const seed = JSON.stringify([
        entity.id ?? null, vehicle.trip?.tripId ?? vehicle.trip?.trip_id ?? null,
        vehicle.trip?.routeId ?? vehicle.trip?.route_id ?? null, timestamp, latitude, longitude
      ]);
      let hash = 2166136261;
      for (let index = 0; index < seed.length; index += 1) {
        hash ^= seed.charCodeAt(index);
        hash = Math.imul(hash, 16777619);
      }
      return `nta-${(hash >>> 0).toString(16).padStart(8, "0")}`;
    };
    return [{
      id: String(vehicle.vehicle?.id ?? vehicle.vehicle?.label ?? entity.id ?? stableFallbackId()),
      latitude, longitude,
      tripId: String(vehicle.trip?.tripId ?? vehicle.trip?.trip_id ?? ""),
      route: String(vehicle.trip?.routeId ?? vehicle.trip?.route_id ?? ""),
      label: String(vehicle.vehicle?.label ?? vehicle.vehicle?.id ?? "Public transport"),
      bearing: numeric(position?.bearing ?? position?.Bearing),
      speedKmh: numeric(position?.speed ?? position?.Speed) === null ? null : numeric(position?.speed ?? position?.Speed) * 3.6,
      speedSource: numeric(position?.speed ?? position?.Speed) === null ? null : "reported",
      observedAt: observedAt.toISOString()
    }];
  }).slice(0, 1200);

export const fetchTransit = async (env, fetcher = fetch, captureNow = Date.now()) => {
  const raw = await acquireTransitRaw(env, fetcher);
  if (raw.status === "credential-required") return raw;
  const vehicles = normalizeTransitEntities(raw.entities, captureNow);
  if (!vehicles.length) return { vehicles: [], status: "unavailable" };
  return raw.truncated
    ? { vehicles, status: "partial", truncated: true, sourceEntityCount: raw.sourceEntityCount }
    : { vehicles, status: "live" };
};

// Exported for tests, which pin the Kp auxiliary-feed degradation contract.
export const fetchAurora = async () => {
  const [auroraResponse, kpResponse] = await Promise.all([
    fetch("https://services.swpc.noaa.gov/json/ovation_aurora_latest.json", {
      cf: { cacheEverything: true, cacheTtl: 900 }
    }),
    fetch("https://services.swpc.noaa.gov/json/planetary_k_index_1m.json", {
      cf: { cacheEverything: true, cacheTtl: 300 }
    })
  ]);
  if (!auroraResponse.ok) throw new Error(`NOAA aurora returned ${auroraResponse.status}`);
  const body = (await readBoundedJsonResponse(auroraResponse, "noaa-aurora", 900_000)).body;
  const probabilities = (body.coordinates ?? [])
    .filter((point) => point[0] >= 349 && point[0] <= 355 && point[1] >= 51 && point[1] <= 56)
    .map((point) => Number(point[2])).filter(Number.isFinite);
  if (!probabilities.length) return null;
  let kpIndex = null;
  // The Kp feed is auxiliary context for a reading we already hold. A
  // malformed or non-array body degrades to "no Kp index" instead of
  // discarding valid aurora probabilities and tripping the circuit breaker.
  if (kpResponse.ok) {
    try {
      const rows = (await readBoundedJsonResponse(kpResponse, "noaa-kp", 128_000)).body;
      kpIndex = numeric(Array.isArray(rows) ? rows.at(-1)?.estimated_kp : null);
    } catch (error) {
      console.error("NOAA Kp feed was unreadable; aurora probabilities remain retained", error);
    }
  }
  return {
    observedAt: String(body["Observation Time"] ?? ""),
    forecastAt: String(body["Forecast Time"] ?? ""),
    probability: Math.max(...probabilities),
    kpIndex
  };
};

// ---------------------------------------------------------------------------
// /api/living: one payload builder, one cache-tier matrix, parameterised
// loaders so each adapter contributes its own rail/river wiring.
// ---------------------------------------------------------------------------

// River statuses that carry readings; only "unavailable" means an empty feed.
// Without this, Irish Rail outages would push usable river data into the
// no-store tier and turn every client poll into origin work.
const riverUsable = (status) => status === "live" || status === "partial" || status === "stale" || status === "fallback";

export const livingResponse = async ({ loadTrains, loadRivers }) => {
  const [trains, rivers] = await Promise.allSettled([loadTrains(), loadRivers()]);
  if (trains.status === "rejected") console.error("Irish Rail refresh failed", trains.reason);
  if (rivers.status === "rejected") console.error("OPW river refresh failed", rivers.reason);
  const riverResult = rivers.status === "fulfilled" && rivers.value
    ? rivers.value
    : { rivers: [], status: "unavailable", provenance: null };
  const trainsLive = trains.status === "fulfilled" && trains.value.length > 0;
  const riversUsable = riverUsable(riverResult.status) &&
    Array.isArray(riverResult.rivers) && riverResult.rivers.length > 0;
  const allLive = trainsLive && riverResult.status === "live";
  const anyUsable = trainsLive || riversUsable;
  return respondApiJson(buildLivingPayload({
    trains: trains.status === "fulfilled" ? trains.value : [],
    rivers: Array.isArray(riverResult.rivers) ? riverResult.rivers : [],
    riverProvenance: riverResult.provenance ?? null,
    riverStatus: riverResult.status ?? "unavailable"
  }), { cacheControl: allLive ? LIVING_LIVE_CACHE : anyUsable ? LIVING_PARTIAL_CACHE : "no-store" });
};

// ---------------------------------------------------------------------------
// Context refresh state machine: per-source TTL, deterministic jitter,
// in-flight coalescing, circuit backoff, stale-if-error windows, generation
// ordering against out-of-order writes.
// ---------------------------------------------------------------------------

export const CONTEXT_SOURCE_POLICIES = Object.freeze({
  marine: { ttlMs: 15 * 60_000, jitterMs: 45_000, staleIfErrorMs: 60 * 60_000, circuitBaseMs: 60_000 },
  radar: { ttlMs: 5 * 60_000, jitterMs: 20_000, staleIfErrorMs: 30 * 60_000, circuitBaseMs: 30_000 },
  grid: { ttlMs: 5 * 60_000, jitterMs: 30_000, staleIfErrorMs: 45 * 60_000, circuitBaseMs: 60_000 },
  measuredAir: { ttlMs: 30 * 60_000, jitterMs: 90_000, staleIfErrorMs: 2 * 60 * 60_000, circuitBaseMs: 60_000 },
  modelledAir: { ttlMs: 30 * 60_000, jitterMs: 90_000, staleIfErrorMs: 2 * 60 * 60_000, circuitBaseMs: 60_000 },
  aurora: { ttlMs: 15 * 60_000, jitterMs: 45_000, staleIfErrorMs: 60 * 60_000, circuitBaseMs: 60_000 },
  tides: { ttlMs: 15 * 60_000, jitterMs: 45_000, staleIfErrorMs: 2 * 60 * 60_000, circuitBaseMs: 60_000 },
  bathingAlerts: { ttlMs: 15 * 60_000, jitterMs: 45_000, staleIfErrorMs: 2 * 60 * 60_000, circuitBaseMs: 60_000 },
  // Satellite discovery costs up to 13 subrequests per miss (one domains
  // fetch plus six lookback days × two probe tiles), so concurrent cold
  // contexts must share one in-flight refresh like every other source.
  satellite: { ttlMs: 6 * 60 * 60_000, jitterMs: 15 * 60_000, staleIfErrorMs: 24 * 60 * 60_000, circuitBaseMs: 5 * 60_000 },
  earthquakes: { ttlMs: 15 * 60_000, jitterMs: 45_000, staleIfErrorMs: 2 * 60 * 60_000, circuitBaseMs: 60_000 },
  issTle: { ttlMs: 6 * 60 * 60_000, jitterMs: 15 * 60_000, staleIfErrorMs: 24 * 60 * 60_000, circuitBaseMs: 5 * 60_000 },
  warnings: { ttlMs: 5 * 60_000, jitterMs: 30_000, staleIfErrorMs: 60 * 60_000, circuitBaseMs: 60_000 },
  solar: { ttlMs: 60 * 60_000, jitterMs: 5 * 60_000, staleIfErrorMs: 24 * 60 * 60_000, circuitBaseMs: 5 * 60_000 },
  forecast: { ttlMs: 15 * 60_000, jitterMs: 45_000, staleIfErrorMs: 6 * 60 * 60_000, circuitBaseMs: 60_000 }
});

const contextSourceCache = new Map();
let contextFetcherIdentity = null;
// The satellite resolver keeps its own success/failure cache, so it must be
// rebuilt together with the context cache whenever the fetch identity swaps
// (a new runtime isolate, or a test installing its own fetch stub).
let fetchSatelliteResolver = createSatelliteAvailabilityResolver();

export const resetContextRefreshState = () => {
  contextSourceCache.clear();
  contextFetcherIdentity = globalThis.fetch;
  fetchSatelliteResolver = createSatelliteAvailabilityResolver();
};

const ensureContextFetcherIdentity = () => {
  if (contextFetcherIdentity !== globalThis.fetch) {
    contextSourceCache.clear();
    contextFetcherIdentity = globalThis.fetch;
    fetchSatelliteResolver = createSatelliteAvailabilityResolver();
  }
};

const sourceJitter = (name, refreshCount, maximum) => maximum > 0
  ? ((name.length * 997 + refreshCount * 379) % maximum)
  : 0;

const sourceMetadata = (state, status, now, errorCode = null) => ({
  status,
  fetchedAt: state.fetchedAt ? new Date(state.fetchedAt).toISOString() : null,
  lastSuccessAt: state.lastSuccessAt ? new Date(state.lastSuccessAt).toISOString() : null,
  ageSeconds: state.lastSuccessAt ? Math.max(0, Math.floor((now - state.lastSuccessAt) / 1000)) : null,
  staleSince: state.staleSince ? new Date(state.staleSince).toISOString() : null,
  errorCode
});

const staleSource = (state, definition, now, errorCode) => {
  const age = state.lastSuccessAt ? now - state.lastSuccessAt : Number.POSITIVE_INFINITY;
  if (state.value !== undefined && age >= 0 && age <= definition.policy.staleIfErrorMs) {
    state.staleSince ??= now;
    return { value: state.value, status: "stale", metadata: sourceMetadata(state, "stale", now, errorCode) };
  }
  return {
    value: definition.empty(),
    status: "unavailable",
    metadata: sourceMetadata(state, "unavailable", now, errorCode)
  };
};

const refreshContextSource = async (name, definition, now = Date.now()) => {
  const state = contextSourceCache.get(name) ?? {
    value: undefined,
    status: "unavailable",
    fetchedAt: 0,
    lastSuccessAt: 0,
    staleSince: 0,
    expiresAt: 0,
    circuitOpenUntil: 0,
    failures: 0,
    refreshCount: 0,
    latestGeneration: 0,
    inFlight: null
  };
  contextSourceCache.set(name, state);
  // A per-source freshness predicate lets day-keyed sources (solar) refuse a
  // cached value whose calendar day has rolled over even while the TTL is
  // still running; the normal refresh path then replaces it.
  if (state.value !== undefined && now >= state.lastSuccessAt && now < state.expiresAt &&
      (!definition.stillFresh || definition.stillFresh(state.value, now))) {
    return { value: state.value, status: state.status, metadata: sourceMetadata(state, state.status, now) };
  }
  if (state.circuitOpenUntil > now) return staleSource(state, definition, now, "source-circuit-open");
  if (state.inFlight && definition.policy.shareInFlight !== false) return state.inFlight;

  const generation = state.latestGeneration + 1;
  state.latestGeneration = generation;
  const refresh = (async () => {
    try {
      const value = await definition.load();
      const status = definition.status(value);
      if (generation === state.latestGeneration) {
        state.value = value;
        state.status = status;
        state.fetchedAt = now;
        state.lastSuccessAt = now;
        state.staleSince = 0;
        state.failures = 0;
        state.circuitOpenUntil = 0;
        state.refreshCount += 1;
        state.expiresAt = now + definition.policy.ttlMs + sourceJitter(name, state.refreshCount, definition.policy.jitterMs);
      }
      return { value, status, metadata: sourceMetadata({ ...state, value, status, fetchedAt: now, lastSuccessAt: now }, status, now) };
    } catch (error) {
      if (generation === state.latestGeneration) {
        state.failures = Math.min(8, state.failures + 1);
        state.circuitOpenUntil = now + Math.min(
          10 * 60_000,
          definition.policy.circuitBaseMs * (2 ** (state.failures - 1))
        );
      }
      const errorCode = `${name}-refresh-failed`;
      console.error(`${name} context refresh failed`, error);
      return staleSource(state, definition, now, errorCode);
    }
  })();
  if (definition.policy.shareInFlight !== false) state.inFlight = refresh;
  try {
    return await refresh;
  } finally {
    if (state.inFlight === refresh) state.inFlight = null;
  }
};

// Exported for tests, which pin the per-source freshness predicates (such as
// the solar day rollover).
export const contextDefinitions = (env, now) => ({
  marine: {
    load: fetchMarine,
    empty: () => ({ readings: [], status: "unavailable" }),
    status: (value) => value?.status ?? "unavailable"
  },
  radar: {
    load: fetchRadar,
    empty: () => [],
    status: (value) => Array.isArray(value) && value.length ? "live" : "unavailable"
  },
  grid: {
    load: fetchGrid,
    empty: () => ({ reading: null, status: "unavailable" }),
    status: (value) => value?.status ?? "unavailable"
  },
  measuredAir: {
    load: env.EDGE_RUNTIME === "cloudflare" ? async () => [] : fetchMeasuredAirQuality,
    empty: () => [],
    status: (value) => value?.length ? "live" : "unavailable"
  },
  modelledAir: {
    load: fetchAirQuality,
    empty: () => ({ readings: [], status: "unavailable" }),
    status: (value) => value?.status ?? "unavailable"
  },
  aurora: {
    load: fetchAurora,
    empty: () => null,
    status: (value) => value ? "live" : "unavailable"
  },
  tides: {
    load: fetchTides,
    empty: () => ({ readings: [], status: "unavailable" }),
    status: (value) => value?.status ?? "unavailable"
  },
  bathingAlerts: {
    load: fetchBathingAlerts,
    empty: () => ({ alerts: [], status: "unavailable" }),
    status: (value) => value?.status ?? "unavailable"
  },
  satellite: {
    load: () => fetchSatelliteResolver(),
    empty: () => null,
    status: (value) => value ? "fallback" : "unavailable"
  },
  earthquakes: {
    load: fetchEarthquakes,
    empty: () => [],
    status: () => "live"
  },
  issTle: {
    load: fetchIssTle,
    empty: () => null,
    status: (value) => value ? "live" : "unavailable"
  },
  warnings: {
    load: fetchWarnings,
    empty: () => [],
    status: () => "live"
  },
  solar: {
    load: () => fetchSolarDay({ now }),
    empty: () => ({ reading: null, status: "unavailable" }),
    status: (value) => value?.status ?? "unavailable",
    // The reading is keyed to one Dublin day. A refresh initiated before
    // midnight used to keep serving yesterday's sunrise and sunset for up to
    // the TTL plus jitter past midnight; refuse cached values whose day has
    // rolled over so the next refresh resolves today.
    stillFresh: (value, at) => value?.reading?.date === dublinDateKey(at)
  },
  forecast: {
    load: () => fetchMetForecast({ now }),
    empty: () => ({ forecast: null, status: "unavailable" }),
    status: (value) => value?.status ?? "unavailable"
  }
});

export const currentContexts = async (env) => {
  ensureContextFetcherIdentity();
  const now = Date.now();
  const definitions = contextDefinitions(env, now);
  const sourceEntries = await Promise.all(Object.entries(definitions).map(async ([name, definition]) => [
    name,
    await refreshContextSource(name, { ...definition, policy: CONTEXT_SOURCE_POLICIES[name] }, now)
  ]));
  const sources = Object.fromEntries(sourceEntries);
  const modelled = sources.modelledAir.value?.readings ?? [];
  const measured = sources.measuredAir.value ?? [];
  const publicName = (name) => name === "bathingAlerts" ? "bathing" : name === "issTle" ? "iss" : name === "forecast" ? "forecast" : name;
  const contextStatus = Object.fromEntries(Object.entries(sources).map(([name, source]) => [publicName(name), source.status]));
  const contextProvenance = Object.fromEntries(Object.entries(sources).map(([name, source]) => [publicName(name), source.metadata]));
  const cacheable = Object.values(contextStatus).some((status) => status !== "unavailable");
  return respondApiJson({
    generatedAt: new Date(now).toISOString(),
    marine: sources.marine.value?.readings ?? [],
    radar: sources.radar.value ?? [],
    grid: sources.grid.value?.reading ?? null,
    airQuality: [...measured, ...modelled],
    aurora: sources.aurora.value ?? null,
    tides: sources.tides.value?.readings ?? [],
    bathingAlerts: sources.bathingAlerts.value?.alerts ?? [],
    warnings: sources.warnings.value ?? [],
    warningsStatus: sources.warnings.status,
    solar: sources.solar.value?.reading ?? null,
    forecast: sources.forecast.value?.forecast ?? null,
    satellite: sources.satellite.value ?? null,
    earthquakes: sources.earthquakes.value ?? [],
    issTle: sources.issTle.value ?? null,
    contextStatus,
    contextProvenance
  }, { cacheControl: cacheable
    ? "public, max-age=30, s-maxage=30, stale-while-revalidate=120"
    : "no-store" });
};

// ---------------------------------------------------------------------------
// /api/transit: coordinator-preferred resolution with one shared response
// tier matrix, used by both adapters and by the NTA Durable Object.
// ---------------------------------------------------------------------------

const transitUsable = (status) => status === "live" || status === "partial";

export const transitResponse = ({ vehicles, status }) => {
  const usable = transitUsable(status);
  return respondApiJson({
    generatedAt: new Date().toISOString(),
    transit: usable ? vehicles : [],
    transitStatus: status
  }, { cacheControl: status === "live"
    ? "public, max-age=15, s-maxage=60, stale-while-revalidate=0"
    : usable
      ? "public, max-age=15, s-maxage=15, stale-while-revalidate=0"
      : "no-store" });
};

export const resolveTransit = async (env) => {
  // Prefer the shared coordinator when wired so every adapter honours the
  // same 65-second NTA token-budget floor instead of fetching upstream
  // directly. The direct fetch remains for adapters without DO bindings.
  if (env.NTA_FEED?.getByName) {
    const response = await env.NTA_FEED.getByName("all-island-vehicles").fetch("https://internal/transit");
    if (!response.ok) throw new Error(`transit-coordinator-http-${response.status}`);
    const coordinated = await response.json();
    return {
      vehicles: Array.isArray(coordinated.transit) ? coordinated.transit : [],
      status: coordinated.transitStatus ?? "unavailable"
    };
  }
  return fetchTransit(env);
};

export const transitApiRoute = async (env) => {
  try {
    return transitResponse(await resolveTransit(env));
  } catch (error) {
    console.error("NTA transit refresh failed", error);
    return apiErrorResponse("Live transport positions are temporarily unavailable.");
  }
};

export const contextsApiRoute = async (env) => {
  try {
    return await currentContexts(env);
  } catch (error) {
    console.error("Current contexts failed", error);
    return apiErrorResponse("Current island contexts are temporarily unavailable.");
  }
};

// ---------------------------------------------------------------------------
// Health and central dispatch
// ---------------------------------------------------------------------------

// Build provenance ships with the static assets (written by
// scripts/write-build-provenance.mjs on every build). Reading it through the
// assets binding keeps health reporting truthful on every adapter; no deploy
// path provides BUILD_* vars. Each adapter creates its own loader so memo
// state never leaks across hosting targets, with a short retry window after
// failed reads so a transient asset hiccup can heal.
const PROVENANCE_RETRY_MS = 5 * 60_000;
export const createProvenanceLoader = () => {
  let cache = null;
  return async (env) => {
    const now = Date.now();
    if (cache && (cache.value || now - cache.at < PROVENANCE_RETRY_MS)) {
      return cache.value;
    }
    let value = null;
    try {
      if (env?.ASSETS) {
        const response = await env.ASSETS.fetch(new Request("https://assets.local/build-provenance.json"));
        if (response.ok) {
          const parsed = await response.json();
          if (parsed && typeof parsed === "object") value = parsed;
        }
      }
    } catch (error) {
      console.error("Build provenance was unreadable", error);
    }
    cache = { at: now, value };
    return value;
  };
};

export const healthResponse = (env, provenance = null) => {
  // The provenance file records local builds as "not-deployed"; surfacing that
  // label from a deployed Worker would be misleading, so it degrades.
  const fileDeploymentId = typeof provenance?.deploymentId === "string" && provenance.deploymentId !== "not-deployed"
    ? provenance.deploymentId
    : null;
  return respondApiJson({
    status: "ok",
    service: "a-day-in-ireland",
    runtime: env?.EDGE_RUNTIME === "cloudflare" ? "cloudflare-worker" : env?.EDGE_RUNTIME ?? "local-worker",
    build: {
      commitSha: env.BUILD_COMMIT_SHA ?? provenance?.source?.commitSha ?? "unknown",
      builtAt: env.BUILD_TIMESTAMP ?? provenance?.builtAt ?? "unknown",
      configSha256: env.BUILD_CONFIG_SHA256 ?? provenance?.source?.configSha256 ?? "unknown",
      transitDataSha256: env.BUILD_DATA_SHA256 ?? provenance?.generatedData?.sha256 ?? "unknown",
      deploymentId: env.DEPLOYMENT_ID ?? fileDeploymentId ?? "unknown"
    },
    storage: {
      historyDb: Boolean(env.HISTORY_DB),
      ntaCoordinator: Boolean(env.NTA_FEED),
      riverCoordinator: Boolean(env.RIVER_FEED)
    }
  });
};

// Central API dispatcher shared by every adapter. Any "/api/" path gets the
// method boundary first; unknown API paths answer as JSON with the shared
// error contract, never as an asset 404 or an HTML SPA fallback that would
// soft-200 an API surface. Returns undefined for non-API paths so each
// adapter applies its own static-serving behaviour.
export const handleApiRequest = async (request, env, adapters) => {
  const url = new URL(request.url);
  if (!url.pathname.startsWith("/api/")) return undefined;
  if (request.method !== "GET" && request.method !== "HEAD" && request.method !== "OPTIONS") {
    return methodResponse(request);
  }
  if (request.method === "OPTIONS") return methodResponse(request);
  switch (url.pathname) {
    case "/api/health":
      return adapters.health ? adapters.health(env) : healthResponse(env);
    case "/api/living":
      try {
        return await adapters.living(env);
      } catch (error) {
        console.error("Living layers failed", error);
        return apiErrorResponse("Live layers are temporarily unavailable.");
      }
    case "/api/contexts":
      return contextsApiRoute(env);
    case "/api/transit":
      return transitApiRoute(env);
    case "/api/history":
    case "/api/history/range":
      if (!adapters.history) return unknownApiResponse();
      try {
        return await adapters.history(request, env);
      } catch (error) {
        console.error("History request failed", error);
        return apiErrorResponse("Stored history is temporarily unavailable.");
      }
    default:
      return unknownApiResponse();
  }
};
