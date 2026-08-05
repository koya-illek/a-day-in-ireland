import { aggregateHourlyWeather } from "../lib/weather-timeline.js";
import { publicRouteFromNtaRouteId } from "../lib/presentation.js";
import {
  latestEirGridValue,
  latestObservedAt,
  normalizeOfficialWeatherWarnings,
  normalizeProviderTimestamp,
  parseIrelandLocalTimestamp
} from "./river-source.js";
import { classifyTideTrend, irishGridToLonLat, tideQueryWindow } from "./server-entry.js";

export const HISTORY_SOURCE_KEYS = [
  "weather", "warnings", "marine", "rivers", "tides", "grid",
  "air_measured", "air_modelled", "bathing", "earthquakes",
  "rail", "transit", "radar", "satellite", "iss", "aurora"
];

const WEATHER_STATIONS = [
  { id: "malin-head", endpoint: "malin-head", providerName: "Malin Head", name: "Malin Head", latitude: 55.371, longitude: -7.339 },
  { id: "finner", endpoint: "finner", providerName: "Finner", name: "Finner", latitude: 54.494, longitude: -8.243 },
  { id: "belmullet", endpoint: "belmullet", providerName: "Belmullet", name: "Belmullet", latitude: 54.228, longitude: -10.007 },
  { id: "athenry", endpoint: "athenry", providerName: "Athenry", name: "Athenry", latitude: 53.289, longitude: -8.786 },
  { id: "dublin-airport", endpoint: "dublin", providerName: "Dublin Airport", name: "Dublin", latitude: 53.428, longitude: -6.241 },
  { id: "gurteen", endpoint: "gurteen", providerName: "Gurteen", name: "Gurteen", latitude: 53.034, longitude: -8.005 },
  { id: "valentia", endpoint: "valentia", providerName: "Valentia", name: "Valentia", latitude: 51.938, longitude: -10.241 },
  { id: "cork-airport", endpoint: "cork", providerName: "Cork", name: "Cork", latitude: 51.847, longitude: -8.486 },
  { id: "johnstown-castle", endpoint: "johnstown-castle", providerName: "Johnstown Castle", name: "Wexford", latitude: 52.298, longitude: -6.497 }
];

const numeric = (value) => {
  if (value === null || value === undefined || String(value).trim() === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const validTimestamp = (value) => {
  const timestamp = Date.parse(String(value ?? ""));
  return Number.isFinite(timestamp) ? timestamp : null;
};

const fresh = (value, maximumAgeMs, now) => {
  const timestamp = validTimestamp(value);
  const age = timestamp === null ? Number.NaN : now - timestamp;
  return Number.isFinite(age) && age >= 0 && age < maximumAgeMs;
};

const fetchJson = async (fetcher, url, cacheTtl) => {
  const response = await fetcher(url, {
    cf: { cacheEverything: true, cacheTtl, cacheTtlByStatus: { "200-299": cacheTtl, "400-599": 0 } }
  });
  if (!response.ok) throw new Error(`upstream-http-${response.status}`);
  return response.json();
};

const cleanErrorCode = (error) => {
  const message = String(error?.message ?? error ?? "");
  if (/upstream-http-\d{3}/.test(message)) return message.match(/upstream-http-\d{3}/)[0];
  if (/timeout|abort/i.test(message)) return "upstream-timeout";
  return "upstream-unavailable";
};

const gap = (source, reason, detail, scope = "provider") => ({ source, scope, reason, detail });

const source = ({ status, data, fetchedAt, latestObservedAt: observedAt = null, errorCode = null }) => ({
  status,
  fetchedAt,
  latestObservedAt: observedAt,
  itemCount: status === "unavailable" || status === "credential-required"
    ? null
    : Array.isArray(data) ? data.length : data ? 1 : 0,
  errorCode,
  data
});

const collect = async (name, operation, fetchedAt) => {
  try {
    return await operation();
  } catch (error) {
    const errorCode = cleanErrorCode(error);
    return {
      envelope: source({ status: "unavailable", data: null, fetchedAt, errorCode }),
      gaps: [gap(name, errorCode, `${name} was unavailable at capture time.`)]
    };
  }
};

const weatherTop = (stations, field) => [...stations]
  .filter((station) => station[field] !== null)
  .sort((first, second) => (second[field] ?? -Infinity) - (first[field] ?? -Infinity))[0] ?? null;

export async function collectWeather(fetcher, now) {
  const fetchedAt = new Date(now).toISOString();
  const results = await Promise.all(WEATHER_STATIONS.map(async (definition) => {
    try {
      const rows = await fetchJson(fetcher, `https://prodapi.metweb.ie/observations/${definition.endpoint}/today`, 300);
      const stationRows = (Array.isArray(rows) ? rows : []).filter((row) =>
        String(row?.name ?? "").trim().toLocaleLowerCase("en-IE") === definition.providerName.toLocaleLowerCase("en-IE")
      );
      const latest = stationRows.at(-1);
      if (!latest) return null;
      const observedAt = parseIrelandLocalTimestamp(String(latest.date ?? ""), String(latest.reportTime ?? ""));
      if (!fresh(observedAt, 3 * 60 * 60_000, now)) return null;
      return {
        reading: {
          id: definition.id,
          name: definition.name,
          latitude: definition.latitude,
          longitude: definition.longitude,
          temperature: numeric(latest.temperature),
          rainfall: numeric(latest.rainfall),
          windSpeed: numeric(latest.windSpeed),
          windDirection: String(latest.cardinalWindDirection ?? "").trim(),
          description: String(latest.weatherDescription ?? "Observation available"),
          observedAt,
          fresh: true
        },
        history: stationRows.map((row) => ({
          time: String(row.reportTime ?? ""),
          temperature: numeric(row.temperature),
          rainfall: numeric(row.rainfall),
          windSpeed: numeric(row.windSpeed)
        }))
      };
    } catch {
      return null;
    }
  }));
  const valid = results.filter(Boolean);
  const stations = valid.map((item) => item.reading).sort((a, b) => a.id.localeCompare(b.id));
  const status = stations.length === WEATHER_STATIONS.length ? "live" : stations.length ? "partial" : "unavailable";
  return {
    envelope: source({ status, data: {
      stations,
      timeline: aggregateHourlyWeather(valid.map((item) => item.history)),
      summary: {
        warmest: weatherTop(stations, "temperature"),
        wettest: weatherTop(stations, "rainfall"),
        windiest: weatherTop(stations, "windSpeed"),
        reporting: stations.length
      }
    }, fetchedAt, latestObservedAt: latestObservedAt(stations), errorCode: status === "unavailable" ? "no-fresh-observations" : null }),
    gaps: status === "live" ? [] : [gap("weather", status === "partial" ? "partial-provider-response" : "no-fresh-observations", `${stations.length} of ${WEATHER_STATIONS.length} configured stations supplied fresh observations.`)]
  };
}

async function collectWarnings(fetcher, now) {
  const fetchedAt = new Date(now).toISOString();
  return collect("warnings", async () => {
    const rows = await fetchJson(fetcher, "https://www.met.ie/Open_Data/json/warning_IRELAND.json", 300);
    const warnings = normalizeOfficialWeatherWarnings(rows, now).sort((a, b) => a.id.localeCompare(b.id));
    return { envelope: source({ status: "live", data: warnings, fetchedAt, latestObservedAt: latestObservedAt(warnings.map((item) => ({ observedAt: item.updated || item.issued }))) }), gaps: [] };
  }, fetchedAt);
}

export async function collectMarine(fetcher, now) {
  const fetchedAt = new Date(now).toISOString();
  return collect("marine", async () => {
    const since = new Date(now - 48 * 60 * 60_000).toISOString().slice(0, 10);
    const query = `station_id,longitude,latitude,time,WindSpeed,WaveHeight,WavePeriod,SeaTemperature&time>=${since}T00:00:00Z&orderByMax("station_id,time")`;
    const body = await fetchJson(fetcher, `https://erddap.marine.ie/erddap/tabledap/IWBNetwork.json?${encodeURI(query)}`, 900);
    const readings = (body.table?.rows ?? []).flatMap((row) => {
      const observedAt = String(row[3] ?? "");
      return fresh(observedAt, 6 * 60 * 60_000, now) ? [{
        id: String(row[0]), name: `Offshore buoy ${String(row[0])}`, kind: "weather-buoy",
        longitude: Number(row[1]), latitude: Number(row[2]), observedAt,
        windSpeedKnots: numeric(row[4]), waveHeight: numeric(row[5]),
        wavePeriod: numeric(row[6]), seaTemperature: numeric(row[7])
      }] : [];
    }).sort((a, b) => a.id.localeCompare(b.id));
    if (!readings.length) throw new Error("no-fresh-observations");
    return {
      envelope: source({ status: "partial", data: readings, fetchedAt, latestObservedAt: latestObservedAt(readings) }),
      gaps: [gap("marine", "partial-provider-coverage", "Offshore weather buoys are retained; coastal observatory feeds are not yet included in history v1.", "history-v1")]
    };
  }, fetchedAt);
}

const fetchGridRows = async (fetcher, chartType, areas, now) => {
  const day = new Date(now).toISOString().slice(0, 10);
  const url = new URL("https://www.smartgriddashboard.com/api/chart/");
  url.search = new URLSearchParams({
    region: "ALL", chartType, dateRange: chartType === "frequency" ? "hour" : "day", dateFrom: day, dateTo: day, areas
  }).toString();
  const body = await fetchJson(fetcher, url, chartType === "frequency" ? 60 : 300);
  return body.Rows ?? [];
};

async function collectGrid(fetcher, now) {
  const fetchedAt = new Date(now).toISOString();
  return collect("grid", async () => {
    const [demandRows, generationRows, windRows, carbonRows, frequencyRows, interconnectionRows] = await Promise.all([
      fetchGridRows(fetcher, "demand", "demandactual", now),
      fetchGridRows(fetcher, "generation", "generationactual", now),
      fetchGridRows(fetcher, "wind", "windactual", now),
      fetchGridRows(fetcher, "co2", "co2intensity,co2emission", now),
      fetchGridRows(fetcher, "frequency", "frequency", now),
      fetchGridRows(fetcher, "interconnection", "interconnection", now)
    ]);
    const demand = latestEirGridValue(demandRows, "SYSTEM_DEMAND", now);
    const generation = latestEirGridValue(generationRows, "GEN_EXP", now);
    const wind = latestEirGridValue(windRows, "WIND_ACTUAL", now);
    const intensity = latestEirGridValue(carbonRows, "CO2_INTENSITY", now);
    const emissions = latestEirGridValue(carbonRows, "CO2_EMISSIONS", now);
    const frequency = latestEirGridValue(frequencyRows, "SYS_FREQUENCY", now);
    const interconnector = latestEirGridValue(interconnectionRows, "INTER_NET", now);
    const observedAt = [demand, generation, wind, intensity, emissions, frequency, interconnector]
      .map((item) => item?.observedAt).filter(Boolean).sort().at(-1) ?? null;
    if (!observedAt) throw new Error("no-fresh-observations");
    const reading = {
      observedAt,
      demandMW: demand?.value ?? null,
      generationMW: generation?.value ?? null,
      windMW: wind?.value ?? null,
      windSharePercent: wind && demand && demand.value > 0 ? wind.value / demand.value * 100 : null,
      carbonIntensity: intensity?.value ?? null,
      carbonEmissions: emissions?.value ?? null,
      frequencyHz: frequency?.value ?? null,
      interconnectorMW: interconnector?.value ?? null
    };
    return { envelope: source({ status: "live", data: reading, fetchedAt, latestObservedAt: observedAt }), gaps: [] };
  }, fetchedAt);
}

const AIR_LOCATIONS = [
  ["dublin-air", "Dublin", 53.35, -6.26], ["belfast-air", "Belfast", 54.60, -5.93],
  ["cork-air", "Cork", 51.90, -8.48], ["galway-air", "Galway", 53.27, -9.06],
  ["limerick-air", "Limerick", 52.66, -8.63], ["waterford-air", "Waterford", 52.26, -7.11],
  ["derry-air", "Derry", 55.00, -7.31]
];

async function collectModelledAir(fetcher, now) {
  const fetchedAt = new Date(now).toISOString();
  return collect("air_modelled", async () => {
    const url = new URL("https://air-quality-api.open-meteo.com/v1/air-quality");
    url.search = new URLSearchParams({
      latitude: AIR_LOCATIONS.map((item) => item[2]).join(","), longitude: AIR_LOCATIONS.map((item) => item[3]).join(","),
      current: "european_aqi,pm2_5,pm10,nitrogen_dioxide,ozone,uv_index,grass_pollen", timezone: "GMT"
    }).toString();
    const bodies = await fetchJson(fetcher, url, 1800);
    const readings = AIR_LOCATIONS.flatMap(([id, name, latitude, longitude], index) => {
      const current = bodies[index]?.current;
      return current?.time ? [{
        id, name, latitude, longitude, observedAt: `${current.time}:00Z`,
        europeanAqi: numeric(current.european_aqi), pm25: numeric(current.pm2_5), pm10: numeric(current.pm10),
        nitrogenDioxide: numeric(current.nitrogen_dioxide), ozone: numeric(current.ozone), uvIndex: numeric(current.uv_index),
        grassPollen: numeric(current.grass_pollen), source: "modelled", stationClassification: null
      }] : [];
    });
    if (!readings.length) throw new Error("no-fresh-observations");
    return { envelope: source({ status: "live", data: readings, fetchedAt, latestObservedAt: latestObservedAt(readings) }), gaps: [] };
  }, fetchedAt);
}

export async function collectTides(fetcher, now) {
  const fetchedAt = new Date(now).toISOString();
  return collect("tides", async () => {
    const { since, until } = tideQueryWindow(now);
    const base = "https://erddap.marine.ie/erddap/tabledap/";
    const [levelsResult, surgesResult, predictionsResult] = await Promise.allSettled([
      fetchJson(fetcher, `${base}IrishNationalTideGaugeNetwork.json?${encodeURI(`station_id,longitude,latitude,time,Water_Level_OD_Malin&time>=${since}`)}`, 900),
      fetchJson(fetcher, `${base}imiSurgeObservationINTGN.json?${encodeURI(`stationID,longitude,latitude,time,sea_surface_elevation_due_to_tide,sea_surface_elevation_due_to_storm_surge&time>=${since}&orderByMax("stationID,time")`)}`, 900),
      fetchJson(fetcher, `${base}IMI_TidePrediction_HighLow.json?${encodeURI(`stationID,longitude,latitude,time,tide_time_category,Water_Level_ODMalin&time>=${since}&time<=${until}`)}`, 3600)
    ]);
    if (levelsResult.status === "rejected") throw levelsResult.reason;
    const auxiliaryGaps = [
      ...(surgesResult.status === "rejected" ? [gap(
        "tides",
        cleanErrorCode(surgesResult.reason),
        "Storm-surge comparison data was unavailable at capture time. Tide-gauge levels remain retained."
      )] : []),
      ...(predictionsResult.status === "rejected" ? [gap(
        "tides",
        cleanErrorCode(predictionsResult.reason),
        "High/low tide predictions were unavailable at capture time. Tide-gauge levels remain retained."
      )] : [])
    ];
    const levels = levelsResult.value;
    const surges = surgesResult.status === "fulfilled" ? surgesResult.value : { table: { rows: [] } };
    const predictions = predictionsResult.status === "fulfilled" ? predictionsResult.value : { table: { rows: [] } };
    const levelRows = levels.table?.rows ?? [];
    const surgeRows = surges.table?.rows ?? [];
    const predictionRows = predictions.table?.rows ?? [];
    const distance = (a, b) => Math.hypot(Number(a[1]) - Number(b[1]), Number(a[2]) - Number(b[2]));
    const byStation = new Map();
    for (const row of levelRows) byStation.set(String(row[0]), [...(byStation.get(String(row[0])) ?? []), row]);
    const readings = [...byStation.values()].flatMap((rows) => {
      rows.sort((a, b) => Date.parse(a[3]) - Date.parse(b[3]));
      const row = rows.at(-1);
      if (!fresh(row?.[3], 3 * 60 * 60_000, now)) return [];
      const surge = [...surgeRows].sort((a, b) => distance(row, a) - distance(row, b))[0];
      const future = predictionRows.filter((item) => distance(row, item) < .08 && Date.parse(item[3]) > now);
      const nextHigh = future.find((item) => item[4] === "HIGH");
      const nextLow = future.find((item) => item[4] === "LOW");
      return [{
        id: `tide-${String(row[0]).toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
        name: String(row[0]), longitude: Number(row[1]), latitude: Number(row[2]), observedAt: String(row[3]),
        waterLevel: numeric(row[4]), predictedLevel: surge && distance(row, surge) < .08 ? numeric(surge[4]) : null,
        surge: surge && distance(row, surge) < .08 ? numeric(surge[5]) : null,
        trend: classifyTideTrend(rows.map((sample) => ({ observedAt: sample[3], waterLevel: sample[4] }))),
        nextHighAt: nextHigh ? String(nextHigh[3]) : null, nextHighLevel: nextHigh ? numeric(nextHigh[5]) : null,
        nextLowAt: nextLow ? String(nextLow[3]) : null, nextLowLevel: nextLow ? numeric(nextLow[5]) : null
      }];
    }).sort((a, b) => a.id.localeCompare(b.id));
    if (!readings.length) throw new Error("no-fresh-observations");
    return {
      envelope: source({
        status: auxiliaryGaps.length ? "partial" : "live",
        data: readings,
        fetchedAt,
        latestObservedAt: latestObservedAt(readings),
        errorCode: auxiliaryGaps.length ? "partial-provider-coverage" : null
      }),
      gaps: auxiliaryGaps
    };
  }, fetchedAt);
}

export async function collectBathing(fetcher, now) {
  const fetchedAt = new Date(now).toISOString();
  return collect("bathing", async () => {
    const alertsBody = await fetchJson(fetcher, "https://data.epa.ie/bw/api/v1/alerts?per_page=100", 900);
    const alerts = (alertsBody.list ?? []).filter((item) => {
      const started = Date.parse(normalizeProviderTimestamp(item.incident_start_date) ?? "");
      const ended = Date.parse(normalizeProviderTimestamp(item.incident_end_date) ?? "");
      return Number.isFinite(started) && started <= now && (!Number.isFinite(ended) || ended > now);
    });
    if (!alerts.length) return { envelope: source({ status: "live", data: [], fetchedAt }), gaps: [] };
    const locationsBody = await fetchJson(fetcher, "https://data.epa.ie/bw/api/v1/locations?per_page=500", 86_400);
    const locations = new Map((locationsBody.list ?? []).map((item) => [item.beach_id, item]));
    const archived = alerts.flatMap((alert) => {
      const location = locations.get(alert.beach_id);
      const east = numeric(location?.easting);
      const north = numeric(location?.northing);
      if (east === null || north === null) return [];
      const coordinates = irishGridToLonLat(east, north);
      return [{
      id: `bathing-${alert.incident_id}`,
      name: String(alert.beach_name ?? "Bathing location"),
      county: String(alert.county_name ?? ""),
      ...coordinates,
      restriction: String(alert.bathing_restriction_type ?? "Bathing alert"),
      description: String(alert.incident_description ?? ""),
      startedAt: normalizeProviderTimestamp(alert.incident_start_date) ?? "",
      updatedAt: String(alert.last_updated ?? ""),
      noticeUrl: alert.bathing_notice_pdf ? String(alert.bathing_notice_pdf) : null
      }];
    }).sort((a, b) => a.id.localeCompare(b.id));
    const status = archived.length === alerts.length ? "live" : "partial";
    return {
      envelope: source({ status, data: archived, fetchedAt, latestObservedAt: latestObservedAt(archived.map((item) => ({ observedAt: item.updatedAt || item.startedAt }))) }),
      gaps: status === "live" ? [] : [gap("bathing", "missing-location", `${alerts.length - archived.length} active bathing alerts had no authoritative map location and were omitted.`, "provider")]
    };
  }, fetchedAt);
}

async function collectEarthquakes(fetcher, now) {
  const fetchedAt = new Date(now).toISOString();
  return collect("earthquakes", async () => {
    const url = new URL("https://earthquake.usgs.gov/fdsnws/event/1/query");
    url.search = new URLSearchParams({
      format: "geojson", starttime: new Date(now - 7 * 24 * 60 * 60_000).toISOString(),
      minlatitude: "49", maxlatitude: "57", minlongitude: "-13", maxlongitude: "-4", orderby: "time"
    }).toString();
    const body = await fetchJson(fetcher, url, 900);
    const readings = (body.features ?? []).slice(0, 30).flatMap((feature) => {
      const [longitude, latitude, depthKm] = feature.geometry?.coordinates ?? [];
      const magnitude = numeric(feature.properties?.mag);
      return [longitude, latitude, depthKm].every(Number.isFinite) && magnitude !== null ? [{
        id: String(feature.id), longitude, latitude, depthKm, magnitude,
        place: String(feature.properties?.place ?? "Near Ireland"),
        observedAt: new Date(Number(feature.properties?.time)).toISOString(), detailUrl: String(feature.properties?.url ?? "")
      }] : [];
    }).sort((a, b) => a.id.localeCompare(b.id));
    return { envelope: source({ status: "live", data: readings, fetchedAt, latestObservedAt: latestObservedAt(readings) }), gaps: [] };
  }, fetchedAt);
}

export const summarizeTransit = (vehicles, status, capturedAt) => {
  if (status !== "live") return null;
  const byRoute = new Map();
  let unmappedRouteVehicles = 0;
  for (const vehicle of Array.isArray(vehicles) ? vehicles : []) {
    const route = publicRouteFromNtaRouteId(vehicle.route);
    if (!route) unmappedRouteVehicles += 1;
    else byRoute.set(route, (byRoute.get(route) ?? 0) + 1);
  }
  return {
    status,
    capturedAt,
    total: (Array.isArray(vehicles) ? vehicles : []).length,
    vehicles: (Array.isArray(vehicles) ? vehicles : []).length,
    routes: byRoute.size,
    mappedRouteVehicles: [...byRoute.values()].reduce((sum, count) => sum + count, 0),
    unmappedRouteVehicles,
    byRoute: [...byRoute].map(([route, count]) => ({ route, count })).sort((a, b) => a.route.localeCompare(b.route)),
    attribution: {
      provider: "National Transport Authority",
      copyright: "© 2025 NTA",
      source: "NTA Developer Portal",
      license: "CC BY 4.0",
      adapted: true,
      changes: "Route identifiers were normalized and vehicle records were aggregated by A Day in Ireland.",
      disclaimer: "Provided as-is; NTA is not responsible for and does not endorse this service."
    }
  };
};

export const summarizeRail = (trains, status, capturedAt, includeRail) => {
  if (!includeRail) return null;
  if (status !== "live") return null;
  const byDirection = new Map();
  for (const train of Array.isArray(trains) ? trains : []) {
    const direction = String(train.direction ?? "Direction unavailable").replace(/[\u0000-\u001f\u007f]+/g, " ").trim();
    byDirection.set(direction, (byDirection.get(direction) ?? 0) + 1);
  }
  return {
    status,
    capturedAt,
    total: (Array.isArray(trains) ? trains : []).length,
    running: (Array.isArray(trains) ? trains : []).filter((train) => train.status === "running").length,
    notStarted: (Array.isArray(trains) ? trains : []).filter((train) => train.status !== "running").length,
    byDirection: [...byDirection].map(([direction, count]) => ({ direction, count })).sort((a, b) => a.direction.localeCompare(b.direction))
  };
};

const explicitUnavailable = (name, fetchedAt, reason, detail) => ({
  envelope: source({ status: "unavailable", data: null, fetchedAt, errorCode: reason }),
  gaps: [gap(name, reason, detail, "history-v1")]
});

export async function collectScopedSources(fetcher = fetch, now = Date.now()) {
  const fetchedAt = new Date(now).toISOString();
  const results = await Promise.all([
    collectWeather(fetcher, now),
    collectWarnings(fetcher, now),
    collectMarine(fetcher, now),
    collectTides(fetcher, now),
    collectGrid(fetcher, now),
    collectModelledAir(fetcher, now),
    collectBathing(fetcher, now),
    collectEarthquakes(fetcher, now)
  ]);
  const names = ["weather", "warnings", "marine", "tides", "grid", "air_modelled", "bathing", "earthquakes"];
  const sources = Object.fromEntries(results.map((result, index) => [names[index], result.envelope]));
  const gaps = results.flatMap((result) => result.gaps);
  for (const [name, reason, detail] of [
    ["air_measured", "not-collected", "Measured EEA air parsing is not retained until Cloudflare CPU use is proven."],
    ["radar", "imagery-not-retained", "Radar imagery is not archived in D1 history v1."],
    ["satellite", "imagery-not-retained", "Satellite imagery is not archived in D1 history v1."],
    ["iss", "not-retained", "ISS orbital predictions are not retained in history v1."],
    ["aurora", "not-retained", "Aurora forecasts are not retained in history v1."]
  ]) {
    const unavailable = explicitUnavailable(name, fetchedAt, reason, detail);
    sources[name] = unavailable.envelope;
    gaps.push(...unavailable.gaps);
  }
  return { sources, gaps };
}
