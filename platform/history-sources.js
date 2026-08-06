import { aggregateHourlyWeather } from "../lib/weather-timeline.js";
import { publicRouteFromNtaRouteId } from "../lib/presentation.js";
import {
  buildEirGridReading,
  latestEirGridValue,
  latestObservedAt,
  normalizeOfficialWeatherWarnings,
  normalizeProviderTimestamp,
  parseIrelandLocalTimestamp,
  readBoundedJsonResponse
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

const fetchJson = async (fetcher, url, cacheTtl, maximumBytes = 512_000) => {
  const response = await fetcher(url, {
    cf: { cacheEverything: true, cacheTtl, cacheTtlByStatus: { "200-299": cacheTtl, "400-599": 0 } }
  });
  if (!response.ok) throw new Error(`upstream-http-${response.status}`);
  return (await readBoundedJsonResponse(response, "upstream", maximumBytes)).body;
};

const cleanErrorCode = (error) => {
  const message = String(error?.message ?? error ?? "");
  if (/upstream-http-\d{3}/.test(message)) return message.match(/upstream-http-\d{3}/)[0];
  if (/timeout|abort/i.test(message)) return "upstream-timeout";
  if (/upstream-body-too-large/.test(message)) return "upstream-body-too-large";
  if (/upstream-malformed-json/.test(message)) return "upstream-malformed";
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

const mapWithConcurrency = async (items, limit, operation) => {
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await operation(items[index], index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
};

const weatherTop = (stations, field) => [...stations]
  .filter((station) => station[field] !== null)
  .sort((first, second) => (second[field] ?? -Infinity) - (first[field] ?? -Infinity))[0] ?? null;

export async function collectWeather(fetcher, now) {
  const fetchedAt = new Date(now).toISOString();
  const results = await mapWithConcurrency(WEATHER_STATIONS, 3, async (definition) => {
    try {
      const rows = await fetchJson(fetcher, `https://prodapi.metweb.ie/observations/${definition.endpoint}/today`, 300);
      const stationRows = (Array.isArray(rows) ? rows : []).filter((row) =>
        String(row?.name ?? "").trim().toLocaleLowerCase("en-IE") === definition.providerName.toLocaleLowerCase("en-IE")
      ).map((row) => ({
        row,
        observedAt: parseIrelandLocalTimestamp(String(row.date ?? ""), String(row.reportTime ?? ""), now)
      })).filter((item) => {
        const timestamp = Date.parse(item.observedAt ?? "");
        return Number.isFinite(timestamp) && timestamp <= now;
      }).sort((first, second) => Date.parse(first.observedAt) - Date.parse(second.observedAt));
      const selected = stationRows.at(-1);
      const latest = selected?.row;
      if (!latest) return null;
      const observedAt = selected.observedAt;
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
        history: stationRows.map(({ row }) => ({
          time: String(row.reportTime ?? ""),
          temperature: numeric(row.temperature),
          rainfall: numeric(row.rainfall),
          windSpeed: numeric(row.windSpeed)
        }))
      };
    } catch {
      return null;
    }
  });
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

export async function collectWarnings(fetcher, now) {
  const fetchedAt = new Date(now).toISOString();
  return collect("warnings", async () => {
    const rows = await fetchJson(fetcher, "https://www.met.ie/Open_Data/json/warning_IRELAND.json", 300);
    let postCutoffUpdates = 0;
    const warnings = normalizeOfficialWeatherWarnings(rows, now).filter((warning) => {
      const issuedText = String(warning.issued ?? "").trim();
      const updatedText = String(warning.updated ?? "").trim();
      const issued = issuedText ? Date.parse(issuedText) : null;
      const updated = updatedText ? Date.parse(updatedText) : null;
      if (issued !== null && Number.isFinite(issued) && issued > now) return false;
      if ((issuedText && !Number.isFinite(issued)) ||
          (updatedText && (!Number.isFinite(updated) || updated > now))) {
        postCutoffUpdates += 1;
        return false;
      }
      return true;
    }).sort((a, b) => a.id.localeCompare(b.id));
    const status = postCutoffUpdates ? "partial" : "live";
    return {
      envelope: source({
        status,
        data: warnings,
        fetchedAt,
        latestObservedAt: latestObservedAt(warnings.map((item) => ({ observedAt: item.updated || item.issued }))),
        errorCode: postCutoffUpdates ? "post-cutoff-update" : null
      }),
      gaps: postCutoffUpdates ? [gap(
        "warnings",
        "post-cutoff-update",
        `${postCutoffUpdates} warning record${postCutoffUpdates === 1 ? " was" : "s were"} updated after the scheduled capture cutoff and omitted because the earlier version was unavailable.`
      )] : []
    };
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

const dublinDate = (now) => new Intl.DateTimeFormat("en-CA", {
  timeZone: "Europe/Dublin", year: "numeric", month: "2-digit", day: "2-digit"
}).format(new Date(now));

export const eirGridDublinHourWindow = (now) => {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Dublin", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", hourCycle: "h23"
  }).formatToParts(new Date(now)).map((part) => [part.type, part.value]));
  const prefix = `${parts.year}-${parts.month}-${parts.day}T${parts.hour}`;
  return { dateFrom: `${prefix}:00:00`, dateTo: `${prefix}:59:59` };
};

const fetchGridRows = async (fetcher, chartType, areas, now) => {
  const day = dublinDate(now);
  const hour = eirGridDublinHourWindow(now);
  const url = new URL("https://www.smartgriddashboard.com/api/chart/");
  url.search = new URLSearchParams({
    region: "ALL", chartType, dateRange: chartType === "frequency" ? "hour" : "day",
    dateFrom: chartType === "frequency" ? hour.dateFrom : day,
    dateTo: chartType === "frequency" ? hour.dateTo : day,
    areas
  }).toString();
  const body = await fetchJson(fetcher, url, chartType === "frequency" ? 60 : 300);
  return body.Rows ?? [];
};

const GRID_SHARDS = Object.freeze({
  demand: [["demand", "demandactual", "SYSTEM_DEMAND", "demand"]],
  generation: [["generation", "generationactual", "GEN_EXP", "generation"]],
  "wind-interconnection": [["wind", "windactual", "WIND_ACTUAL", "wind"], ["interconnection", "interconnection", "INTER_NET", "interconnection"]],
  carbon: [["co2", "co2intensity,co2emission", "CO2_INTENSITY", "carbonIntensity"], ["co2", "co2intensity,co2emission", "CO2_EMISSIONS", "carbonEmissions"]],
  frequency: [["frequency", "frequency", "SYS_FREQUENCY", "frequency"]]
});

export async function collectGridShard(fetcher, now, shard) {
  const definitions = GRID_SHARDS[shard];
  if (!definitions) throw new TypeError(`unknown-grid-shard:${shard}`);
  const fetched = new Map();
  const values = {};
  const errors = [];
  for (const [chartType, areas, metric, key] of definitions) {
    const requestKey = `${chartType}:${areas}`;
    try {
      if (!fetched.has(requestKey)) fetched.set(requestKey, fetchGridRows(fetcher, chartType, areas, now));
      values[key] = latestEirGridValue(await fetched.get(requestKey), metric, now);
      if (!values[key]) errors.push(key);
    } catch (error) {
      values[key] = null;
      errors.push(`${key}:${cleanErrorCode(error)}`);
    }
  }
  return { shard, values, errors };
}

export function mergeGridShards(shards, now) {
  const fetchedAt = new Date(now).toISOString();
  const values = Object.assign({}, ...shards.map((item) => item?.values ?? {}));
  const demand = values.demand;
  const generation = values.generation;
  const wind = values.wind;
  const intensity = values.carbonIntensity;
  const emissions = values.carbonEmissions;
  const frequency = values.frequency;
  const interconnector = values.interconnection;
  const reading = buildEirGridReading({
    demand, generation, wind, carbonIntensity: intensity, carbonEmissions: emissions,
    frequency, interconnection: interconnector
  });
  const missing = [
      ["demand", demand], ["generation", generation], ["wind", wind], ["carbon-intensity", intensity],
      ["carbon-emissions", emissions], ["frequency", frequency], ["interconnection", interconnector]
    ].filter(([, value]) => !value).map(([name]) => name);
  if (!reading) return {
      envelope: source({ status: "unavailable", data: null, fetchedAt, errorCode: "empty-success" }),
      gaps: [gap("grid", "empty-success", "EirGrid returned HTTP success with no usable current rows; values remain unknown.")]
    };
  return {
      envelope: source({
        status: missing.length ? "partial" : "live", data: reading, fetchedAt, latestObservedAt: reading.observedAt,
        errorCode: missing.length ? "partial-provider-response" : null
      }),
      gaps: missing.length ? [gap("grid", "partial-provider-response", `EirGrid omitted: ${missing.join(", ")}; missing values remain null.`)] : []
  };
}

export async function collectGrid(fetcher, now) {
  const shards = await Promise.all(Object.keys(GRID_SHARDS).map((shard) => collectGridShard(fetcher, now, shard)));
  return mergeGridShards(shards, now);
}

const AIR_LOCATIONS = [
  ["dublin-air", "Dublin", 53.35, -6.26], ["belfast-air", "Belfast", 54.60, -5.93],
  ["cork-air", "Cork", 51.90, -8.48], ["galway-air", "Galway", 53.27, -9.06],
  ["limerick-air", "Limerick", 52.66, -8.63], ["waterford-air", "Waterford", 52.26, -7.11],
  ["derry-air", "Derry", 55.00, -7.31]
];

export async function collectModelledAir(fetcher, now) {
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
      const observedAt = current?.time ? `${current.time}:00Z` : "";
      return fresh(observedAt, 12 * 60 * 60_000, now) ? [{
        id, name, latitude, longitude, observedAt,
        europeanAqi: numeric(current.european_aqi), pm25: numeric(current.pm2_5), pm10: numeric(current.pm10),
        nitrogenDioxide: numeric(current.nitrogen_dioxide), ozone: numeric(current.ozone), uvIndex: numeric(current.uv_index),
        grassPollen: numeric(current.grass_pollen), source: "modelled", stationClassification: null
      }] : [];
    });
    if (!readings.length) throw new Error("no-fresh-observations");
    const status = readings.length === AIR_LOCATIONS.length ? "live" : "partial";
    const missing = AIR_LOCATIONS.length - readings.length;
    return {
      envelope: source({
        status,
        data: readings,
        fetchedAt,
        latestObservedAt: latestObservedAt(readings),
        errorCode: missing ? "partial-provider-response" : null
      }),
      gaps: missing ? [gap(
        "air_modelled",
        "partial-provider-response",
        `${missing} of ${AIR_LOCATIONS.length} configured Open-Meteo locations had no fresh current reading.`
      )] : []
    };
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
    const surgeRows = (surges.table?.rows ?? []).filter((row) => {
      const observed = Date.parse(row?.[3]);
      return Number.isFinite(observed) && observed <= now;
    });
    const predictionRows = predictions.table?.rows ?? [];
    const distance = (a, b) => Math.hypot(Number(a[1]) - Number(b[1]), Number(a[2]) - Number(b[2]));
    const coordinateCell = (row) => [Math.floor(Number(row[1]) / .08), Math.floor(Number(row[2]) / .08)];
    const coordinateKey = (x, y) => `${x}:${y}`;
    const nearestByCoordinate = (rows) => {
      const index = new Map();
      for (const row of rows) {
        const [x, y] = coordinateCell(row);
        const key = coordinateKey(x, y);
        index.set(key, [...(index.get(key) ?? []), row]);
      }
      return index;
    };
    const nearby = (index, row) => {
      const [x, y] = coordinateCell(row);
      const candidates = [];
      for (let xOffset = -1; xOffset <= 1; xOffset += 1) {
        for (let yOffset = -1; yOffset <= 1; yOffset += 1) {
          candidates.push(...(index.get(coordinateKey(x + xOffset, y + yOffset)) ?? []));
        }
      }
      return candidates.filter((item) => distance(row, item) < .08);
    };
    const surgeIndex = nearestByCoordinate(surgeRows);
    const predictionIndex = nearestByCoordinate(predictionRows);
    const byStation = new Map();
    for (const row of levelRows) {
      const observed = Date.parse(row?.[3]);
      if (Number.isFinite(observed) && observed <= now) {
        byStation.set(String(row[0]), [...(byStation.get(String(row[0])) ?? []), row]);
      }
    }
    const readings = [...byStation.values()].flatMap((rows) => {
      rows.sort((a, b) => Date.parse(a[3]) - Date.parse(b[3]));
      const row = rows.at(-1);
      if (!fresh(row?.[3], 3 * 60 * 60_000, now)) return [];
      const localSurges = nearby(surgeIndex, row);
      const surge = localSurges.reduce((nearest, item) => !nearest || distance(row, item) < distance(row, nearest) ? item : nearest, null);
      const future = nearby(predictionIndex, row).filter((item) => Date.parse(item[3]) > now);
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

export async function collectBathing(fetcher, now, compactLocations = null) {
  const fetchedAt = new Date(now).toISOString();
  return collect("bathing", async () => {
    const alertsBody = await fetchJson(fetcher, "https://data.epa.ie/bw/api/v1/alerts?per_page=100", 900);
    let postCutoffUpdates = 0;
    const alerts = (Array.isArray(alertsBody?.list) ? alertsBody.list : []).filter((item) => {
      const started = Date.parse(normalizeProviderTimestamp(item.incident_start_date) ?? "");
      const ended = Date.parse(normalizeProviderTimestamp(item.incident_end_date) ?? "");
      const rawUpdated = String(item.last_updated ?? "").trim();
      const updated = rawUpdated ? Date.parse(normalizeProviderTimestamp(rawUpdated) ?? "") : null;
      if (!Number.isFinite(started) || started > now || (Number.isFinite(ended) && ended <= now)) return false;
      if (updated !== null && (!Number.isFinite(updated) || updated > now)) {
        postCutoffUpdates += 1;
        return false;
      }
      return true;
    });
    if (!alerts.length) {
      const status = postCutoffUpdates ? "partial" : "live";
      return {
        envelope: source({ status, data: [], fetchedAt, errorCode: postCutoffUpdates ? "post-cutoff-update" : null }),
        gaps: postCutoffUpdates ? [gap(
          "bathing",
          "post-cutoff-update",
          `${postCutoffUpdates} active bathing notice${postCutoffUpdates === 1 ? " was" : "s were"} updated after the scheduled capture cutoff and omitted because the earlier version was unavailable.`
        )] : []
      };
    }
    const indexState = compactLocations && compactLocations.index instanceof Map ? compactLocations : null;
    const locations = indexState
      ? indexState.index
      : compactLocations instanceof Map
        ? compactLocations
      : new Map(((await fetchJson(fetcher, "https://data.epa.ie/bw/api/v1/locations?per_page=500", 86_400, 1_000_000)).list ?? [])
        .map((item) => [String(item.beach_id), item]));
    const archived = alerts.flatMap((alert) => {
      const location = locations.get(String(alert.beach_id));
      const east = numeric(location?.easting);
      const north = numeric(location?.northing);
      const latitude = numeric(location?.latitude);
      const longitude = numeric(location?.longitude);
      if ((east === null || north === null) && (latitude === null || longitude === null)) return [];
      const coordinates = latitude !== null && longitude !== null
        ? { latitude, longitude }
        : irishGridToLonLat(east, north);
      return [{
      id: `bathing-${alert.incident_id}`,
      name: String(alert.beach_name ?? "Bathing location"),
      county: String(alert.county_name ?? ""),
      ...coordinates,
      restriction: String(alert.bathing_restriction_type ?? "Bathing alert"),
      description: String(alert.incident_description ?? ""),
      startedAt: normalizeProviderTimestamp(alert.incident_start_date) ?? "",
      endsAt: normalizeProviderTimestamp(alert.incident_end_date),
      updatedAt: normalizeProviderTimestamp(alert.last_updated) ?? "",
      noticeUrl: alert.bathing_notice_pdf ? String(alert.bathing_notice_pdf) : null
      }];
    }).sort((a, b) => a.id.localeCompare(b.id));
    const status = archived.length === alerts.length && (!indexState || indexState.status === "current") && !postCutoffUpdates
      ? "live"
      : "partial";
    const missing = alerts.length - archived.length;
    const indexGap = indexState && indexState.status !== "current"
      ? gap("bathing", `location-index-${indexState.status}`, `The compact bathing location index was ${indexState.status}; its coordinates were not treated as current.`, "provider")
      : null;
    return {
      envelope: source({ status, data: archived, fetchedAt, latestObservedAt: latestObservedAt(archived.map((item) => ({ observedAt: item.updatedAt || item.startedAt }))) }),
      gaps: status === "live" ? [] : [
        ...(postCutoffUpdates ? [gap(
          "bathing",
          "post-cutoff-update",
          `${postCutoffUpdates} active bathing notice${postCutoffUpdates === 1 ? " was" : "s were"} updated after the scheduled capture cutoff and omitted because the earlier version was unavailable.`
        )] : []),
        ...(indexGap ? [indexGap] : []),
        ...(missing ? [gap("bathing", "missing-location", `${missing} active bathing alerts had no current authoritative map location and were omitted.`, "provider")] : [])
      ]
    };
  }, fetchedAt);
}

export async function collectEarthquakes(fetcher, now) {
  const fetchedAt = new Date(now).toISOString();
  return collect("earthquakes", async () => {
    const url = new URL("https://earthquake.usgs.gov/fdsnws/event/1/query");
    url.search = new URLSearchParams({
      format: "geojson", starttime: new Date(now - 7 * 24 * 60 * 60_000).toISOString(),
      minlatitude: "49", maxlatitude: "57", minlongitude: "-13", maxlongitude: "-4", orderby: "time"
    }).toString();
    const body = await fetchJson(fetcher, url, 900);
    const validReadings = (Array.isArray(body.features) ? body.features : []).flatMap((feature) => {
      const [longitude, latitude, depthKm] = feature.geometry?.coordinates ?? [];
      const magnitude = numeric(feature.properties?.mag);
      const observed = Number(feature.properties?.time);
      return [longitude, latitude, depthKm, observed].every(Number.isFinite) && observed <= now && observed >= now - 7 * 24 * 60 * 60_000 && magnitude !== null ? [{
        id: String(feature.id), longitude, latitude, depthKm, magnitude,
        place: String(feature.properties?.place ?? "Near Ireland"),
        observedAt: new Date(observed).toISOString(), detailUrl: String(feature.properties?.url ?? "")
      }] : [];
    }).sort((first, second) =>
      Date.parse(second.observedAt) - Date.parse(first.observedAt) || first.id.localeCompare(second.id)
    );
    const truncated = validReadings.length > 30;
    const readings = validReadings.slice(0, 30).sort((a, b) => a.id.localeCompare(b.id));
    const status = truncated ? "partial" : "live";
    return {
      envelope: source({
        status,
        data: readings,
        fetchedAt,
        latestObservedAt: latestObservedAt(readings),
        errorCode: truncated ? "result-cap" : null
      }),
      gaps: truncated ? [gap(
        "earthquakes",
        "result-cap",
        `${validReadings.length} valid earthquake events matched the seven-day capture window; the newest 30 were retained.`
      )] : []
    };
  }, fetchedAt);
}

export const summarizeTransit = (vehicles, status, capturedAt) => {
  if (status !== "live" && status !== "partial") return null;
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
  return {
    status,
    capturedAt,
    total: (Array.isArray(trains) ? trains : []).length,
    running: (Array.isArray(trains) ? trains : []).filter((train) => train.status === "running").length,
    notStarted: (Array.isArray(trains) ? trains : []).filter((train) => train.status !== "running").length
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
