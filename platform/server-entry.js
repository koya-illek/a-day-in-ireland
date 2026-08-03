import {
  RIVER_ENDPOINT,
  latestEirGridValue,
  latestObservedAt,
  makeRiverProvenance,
  normalizeRiverReadings,
  normalizeBathingAlerts,
  normalizeOfficialNotices,
  normalizeProviderTimestamp,
  parseRiverGeoJson
} from "./river-source.js";

const json = (body, status = 200, cacheSeconds = 60, staleSeconds = 0) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": status >= 400 || cacheSeconds <= 0
        ? "no-store"
        : `public, max-age=${cacheSeconds}, s-maxage=${cacheSeconds}${staleSeconds > 0 ? `, stale-while-revalidate=${staleSeconds}` : ""}`,
      "access-control-allow-origin": "*"
    }
  });

const value = (xml, name) =>
  (new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(xml)?.[1] ?? "")
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", "\"")
    .replaceAll("&#39;", "'")
    .trim();

export const fetchTrains = async () => {
  const response = await fetch(
    "https://api.irishrail.ie/realtime/realtime.asmx/getCurrentTrainsXML",
    { cf: { cacheEverything: true, cacheTtl: 60 } }
  );
  if (!response.ok) throw new Error(`Irish Rail returned ${response.status}`);
  const xml = await response.text();
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

export const normalizeWeatherWarnings = (rows, now = Date.now()) => normalizeOfficialNotices(rows, now).map((row) => ({
  level: String(row.level ?? "Advisory"),
  headline: String(row.headline ?? "Weather advisory"),
  description: String(row.description ?? ""),
  onset: normalizeProviderTimestamp(row.onset) ?? String(row.onset ?? ""),
  expiry: normalizeProviderTimestamp(row.expiry) ?? String(row.expiry ?? "")
}));

const fetchWarnings = async () => {
  const response = await fetch("https://www.met.ie/Open_Data/json/warning_IRELAND.json", {
    cf: { cacheEverything: true, cacheTtl: 300, cacheTtlByStatus: { "200-299": 300, "400-599": 0 } }
  });
  if (!response.ok) throw new Error(`Met Éireann warnings returned ${response.status}`);
  return normalizeWeatherWarnings(await response.json());
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
  const rendered = await response.text();
  const pre = /<pre[^>]*>([\s\S]*?)<\/pre>/i.exec(rendered)?.[1];
  const decoded = decodeHtml(pre ?? rendered);
  const normalized = decoded.startsWith("{\\\"") ? decoded.replaceAll("\\\"", "\"") : decoded;
  try {
    return JSON.parse(normalized);
  } catch (error) {
    throw new Error(`${error.message}; response starts ${JSON.stringify(normalized.slice(0, 240))}`);
  }
};

export const fetchRiversResult = async (env) => {
  const fetchedAt = new Date().toISOString();
  const response = await fetch(RIVER_ENDPOINT, {
    headers: {
      "accept": "application/json",
      "referer": "https://waterlevel.ie/",
      "user-agent": "A-Day-in-Ireland/2.0 (+https://day.illek.ie)"
    }
  });
  let body;
  let fallback = null;
  let status = "live";
  if (!response.ok) {
    const detail = (await response.text()).replace(/\s+/g, " ").slice(0, 240);
    if (env?.EDGE_RUNTIME === "cloudflare") {
      try {
        body = await fetchRiversThroughBrowser(env);
        fallback = "Cloudflare Browser Run";
      } catch (browserError) {
        throw new Error(`OPW returned ${response.status}: ${detail}; Browser Run fallback failed: ${browserError.message}`);
      }
    }
    if (!body) {
      const bridge = await fetch("https://a-day-in-ireland.koya-illek.chatgpt.site/api/living?source=opw-bridge", {
        cf: { cacheEverything: true, cacheTtl: 900 }
      });
      if (bridge.ok) {
        const bridged = await bridge.json();
        if (Array.isArray(bridged.rivers) && bridged.rivers.length) {
          const rivers = normalizeRiverReadings(bridged.rivers);
          if (rivers.length) {
            return {
              rivers,
              provenance: makeRiverProvenance({
                status: "fallback",
                fetchedAt,
                readings: rivers,
                fallback: "OpenAI-hosted river bridge"
              })
            };
          }
        }
      }
      throw new Error(`OPW returned ${response.status}: ${detail}; fallback unavailable`);
    }
  }
  body ??= await response.json();
  const rivers = parseRiverGeoJson(body);
  if (!rivers.length) throw new Error("OPW returned no fresh river gauges");
  return {
    rivers,
    provenance: makeRiverProvenance({ status, fetchedAt, readings: rivers, fallback })
  };
};

export const fetchRivers = async (env) => (await fetchRiversResult(env)).rivers;

const numeric = (value) => {
  const parsed = Number.parseFloat(String(value ?? ""));
  return Number.isFinite(parsed) ? parsed : null;
};

const freshEnough = (value, hours = 6) => {
  const timestamp = new Date(value).getTime();
  const age = Date.now() - timestamp;
  return Number.isFinite(timestamp) && age >= 0 && age < hours * 60 * 60 * 1000;
};

const fetchWeatherBuoys = async () => {
  const since = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const query = `station_id,longitude,latitude,time,WindSpeed,WaveHeight,WavePeriod,SeaTemperature&time>=${since}T00:00:00Z&orderByMax("station_id,time")`;
  const response = await fetch(
    `https://erddap.marine.ie/erddap/tabledap/IWBNetwork.json?${encodeURI(query)}`,
    { cf: { cacheEverything: true, cacheTtl: 900 } }
  );
  if (!response.ok) throw new Error(`Marine weather buoys returned ${response.status}`);
  const body = await response.json();
  return (body.table?.rows ?? []).map((row) => ({
    id: String(row[0]),
    name: `Offshore buoy ${String(row[0])}`,
    kind: "weather-buoy",
    longitude: Number(row[1]),
    latitude: Number(row[2]),
    observedAt: String(row[3]),
    windSpeedKnots: numeric(row[4]),
    waveHeight: numeric(row[5]),
    wavePeriod: numeric(row[6]),
    seaTemperature: numeric(row[7])
  })).filter((reading) => freshEnough(reading.observedAt));
};

const coastalSources = [
  {
    dataset: "smartbay_metbuoy",
    name: "SmartBay Met Buoy",
    variables: ["time", "latitude", "longitude", "wind_speed"],
    map: (row) => ({
      observedAt: String(row[0]), latitude: Number(row[1]), longitude: Number(row[2]),
      windSpeedKnots: numeric(row[3]) === null ? null : numeric(row[3]) * 1.94384,
      waveHeight: null, wavePeriod: null, seaTemperature: null
    })
  },
  {
    dataset: "sentinel_lehanagh",
    name: "Lehanagh Pool Observatory",
    variables: ["time", "latitude", "longitude", "Wind_Speed", "SBE_Temp_Avg"],
    map: (row) => ({
      observedAt: String(row[0]), latitude: Number(row[1]), longitude: Number(row[2]),
      windSpeedKnots: numeric(row[3]) === null ? null : numeric(row[3]) * 1.94384,
      waveHeight: null, wavePeriod: null, seaTemperature: numeric(row[4])
    })
  },
  {
    dataset: "compass_mace_head",
    name: "Mace Head Observatory",
    variables: ["time", "latitude", "longitude", "wind_speed", "sbe_temp_avg", "SignificantWaveHeight", "MeanWavePeriod_Tm02"],
    map: (row) => ({
      observedAt: String(row[0]), latitude: Number(row[1]), longitude: Number(row[2]),
      windSpeedKnots: numeric(row[3]) === null ? null : numeric(row[3]) * 1.94384,
      waveHeight: numeric(row[5]), wavePeriod: numeric(row[6]), seaTemperature: numeric(row[4])
    })
  }
];

const fetchCoastalBuoy = async (source) => {
  const query = `${source.variables.join(",")}&orderByMax("time")`;
  const response = await fetch(
    `https://erddap.marine.ie/erddap/tabledap/${source.dataset}.json?${encodeURI(query)}`,
    { cf: { cacheEverything: true, cacheTtl: 900 } }
  );
  if (!response.ok) throw new Error(`${source.name} returned ${response.status}`);
  const body = await response.json();
  const row = body.table?.rows?.[0];
  if (!row) return null;
  const reading = source.map(row);
  if (!freshEnough(reading.observedAt)) return null;
  return { id: source.dataset, name: source.name, kind: "coastal-observatory", ...reading };
};

const fetchMarine = async () => {
  const results = await Promise.allSettled([
    fetchWeatherBuoys(),
    ...coastalSources.map(fetchCoastalBuoy)
  ]);
  const weather = results[0].status === "fulfilled" ? results[0].value : [];
  const coastal = results.slice(1).flatMap((result) =>
    result.status === "fulfilled" && result.value ? [result.value] : []
  );
  if (!results.some((result) => result.status === "fulfilled")) {
    throw new Error("Marine Institute providers are unavailable");
  }
  return [...weather, ...coastal];
};

const parseRadarTime = (id) => {
  const match = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})$/.exec(id);
  return match
    ? `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:00Z`
    : new Date().toISOString();
};

const fetchRadar = async () => {
  const response = await fetch("https://gdal.met.ie/api/maps/radar", {
    cf: { cacheEverything: true, cacheTtl: 300 }
  });
  if (!response.ok) throw new Error(`Met Éireann radar returned ${response.status}`);
  const rows = await response.json();
  return rows.slice(-7).flatMap((row) => {
    const id = String(row.src ?? "");
    const modifiedTime = Number(row.modifiedTime);
    if (!/^\d{12}$/.test(id) || !Number.isFinite(modifiedTime)) return [];
    const server = String(row.server ?? "https://gdal.met.ie").replace(/\/$/, "");
    return [{
      id,
      observedAt: parseRadarTime(id),
      modifiedTime,
      tileTemplate: `${server}/api/maps/radar/${id}/{x}/{y}/{z}/${modifiedTime}`
    }];
  });
};

const fetchGridRows = async (chartType, areas) => {
  const day = new Date().toISOString().slice(0, 10);
  const url = new URL("https://www.smartgriddashboard.com/api/chart/");
  url.search = new URLSearchParams({
    region: "ALL", chartType, dateRange: chartType === "frequency" ? "hour" : "day", dateFrom: day, dateTo: day, areas
  }).toString();
  const response = await fetch(url, {
    cf: { cacheEverything: true, cacheTtl: chartType === "frequency" ? 60 : 300 }
  });
  if (!response.ok) throw new Error(`EirGrid ${chartType} returned ${response.status}`);
  return (await response.json()).Rows ?? [];
};

const fetchGrid = async () => {
  const [demandRows, generationRows, windRows, carbonRows, frequencyRows, interconnectionRows] =
    await Promise.all([
      fetchGridRows("demand", "demandactual"),
      fetchGridRows("generation", "generationactual"),
      fetchGridRows("wind", "windactual"),
      fetchGridRows("co2", "co2intensity,co2emission"),
      fetchGridRows("frequency", "frequency"),
      fetchGridRows("interconnection", "interconnection")
    ]);
  const now = Date.now();
  const demand = latestEirGridValue(demandRows, "SYSTEM_DEMAND", now);
  const generation = latestEirGridValue(generationRows, "GEN_EXP", now);
  const wind = latestEirGridValue(windRows, "WIND_ACTUAL", now);
  const intensity = latestEirGridValue(carbonRows, "CO2_INTENSITY", now);
  const emissions = latestEirGridValue(carbonRows, "CO2_EMISSIONS", now);
  const frequency = latestEirGridValue(frequencyRows, "SYS_FREQUENCY", now);
  const interconnector = latestEirGridValue(interconnectionRows, "INTER_NET", now);
  const timestamps = [demand, generation, wind, intensity, emissions, frequency, interconnector]
    .map((item) => item?.observedAt).filter(Boolean).sort();
  if (!timestamps.length) return null;
  return {
    observedAt: timestamps[0] ?? null,
    demandMW: demand?.value ?? null,
    generationMW: generation?.value ?? null,
    windMW: wind?.value ?? null,
    windSharePercent: wind && demand && demand.value > 0 ? wind.value / demand.value * 100 : null,
    carbonIntensity: intensity?.value ?? null,
    carbonEmissions: emissions?.value ?? null,
    frequencyHz: frequency?.value ?? null,
    interconnectorMW: interconnector?.value ?? null
  };
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

const fetchAirQuality = async () => {
  const url = new URL("https://air-quality-api.open-meteo.com/v1/air-quality");
  url.search = new URLSearchParams({
    latitude: airLocations.map((item) => item[2]).join(","),
    longitude: airLocations.map((item) => item[3]).join(","),
    current: "european_aqi,pm2_5,pm10,nitrogen_dioxide,ozone,uv_index,grass_pollen",
    timezone: "GMT"
  }).toString();
  const response = await fetch(url, { cf: { cacheEverything: true, cacheTtl: 1800 } });
  if (!response.ok) throw new Error(`Open-Meteo air quality returned ${response.status}`);
  const bodies = await response.json();
  return airLocations.flatMap(([id, name, latitude, longitude], index) => {
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
};

const webMercatorToLonLat = (x, y) => ({
  longitude: x / 6378137 * 180 / Math.PI,
  latitude: (2 * Math.atan(Math.exp(y / 6378137)) - Math.PI / 2) * 180 / Math.PI
});

const eeaTimestamp = (value) => {
  const match = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/.exec(String(value));
  return match ? `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}Z` : "";
};

const europeanAqiScore = ({ pm25, pm10, nitrogenDioxide, ozone }) => {
  const bands = [
    [pm25, [10, 20, 25, 50, 75]],
    [pm10, [20, 40, 50, 100, 150]],
    [nitrogenDioxide, [40, 90, 120, 230, 340]],
    [ozone, [50, 100, 130, 240, 380]]
  ];
  const scores = bands.flatMap(([reading, thresholds]) => {
    if (reading === null || !Number.isFinite(reading)) return [];
    const index = thresholds.findIndex((threshold) => reading <= threshold);
    return [index < 0 ? 110 : [10, 30, 50, 70, 90][index]];
  });
  return scores.length ? Math.max(...scores) : null;
};

const fetchMeasuredAirQuality = async () => {
  const observed = new Date(Date.now() - 3 * 60 * 60 * 1000);
  const stamp = observed.toISOString().replace(/[-:T]/g, "").slice(0, 10) + "0000";
  const pollutants = [
    ["PM25", "pm25"], ["PM10", "pm10"], ["NO2", "nitrogenDioxide"], ["O3", "ozone"]
  ];
  const results = await Promise.allSettled(pollutants.map(async ([pollutant, field]) => {
    const response = await fetch(
      `https://discomap.eea.europa.eu/Map/UTDViewerPRE/dataService/Hourly?polu=${pollutant}&dt=${stamp}`,
      { cf: { cacheEverything: true, cacheTtl: 1800 } }
    );
    if (!response.ok) throw new Error(`EEA ${pollutant} returned ${response.status}`);
    return [field, await response.text()];
  }));
  const responses = results.flatMap((result) => result.status === "fulfilled" ? [result.value] : []);
  if (!responses.length) {
    const reasons = results.flatMap((result) => result.status === "rejected" ? [String(result.reason)] : []);
    throw new Error(`EEA measured air unavailable: ${reasons.join("; ")}`);
  }
  const stations = new Map();
  for (const [field, csv] of responses) {
    for (const line of csv.split(/\r?\n/).slice(1)) {
      if (!line.startsWith("SPO.IE.")) continue;
      const columns = line.split(",");
      const value = numeric(columns[4]);
      const x = numeric(columns[11]);
      const y = numeric(columns[12]);
      if (value === null || x === null || y === null) continue;
      const id = columns[9];
      const location = webMercatorToLonLat(x, y);
      const current = stations.get(id) ?? {
        id: `measured-${id}`,
        name: columns[10].replace(/^(Ireland|Dublin|Cork|Kerry|Galway|Limerick|Clare|Mayo|Donegal|Wicklow|Kildare|Louth|Sligo|Offaly|Carlow|Cavan|Roscommon|Waterford)\s+/i, ""),
        ...location,
        observedAt: eeaTimestamp(columns[2]),
        europeanAqi: null,
        pm25: null,
        pm10: null,
        nitrogenDioxide: null,
        ozone: null,
        uvIndex: null,
        grassPollen: null,
        source: "measured",
        stationClassification: columns[6] || null
      };
      current[field] = value;
      stations.set(id, current);
    }
  }
  return [...stations.values()].map((station) => ({
    ...station,
    europeanAqi: europeanAqiScore(station)
  })).filter((station) =>
    station.latitude >= 51.2 && station.latitude <= 55.6 &&
    station.longitude >= -10.8 && station.longitude <= -5.2
  );
};

export const tideQueryWindow = (now = Date.now()) => {
  const bucketMilliseconds = 15 * 60 * 1000;
  const bucket = Math.floor(now / bucketMilliseconds) * bucketMilliseconds;
  return {
    since: new Date(bucket - 24 * 60 * 60 * 1000).toISOString().replace(/\.\d{3}Z$/, "Z"),
    until: new Date(bucket + 36 * 60 * 60 * 1000).toISOString().replace(/\.\d{3}Z$/, "Z")
  };
};

const fetchTides = async () => {
  const { since, until } = tideQueryWindow();
  const base = "https://erddap.marine.ie/erddap/tabledap/";
  const [levelsResponse, surgeResponse, predictionResponse] = await Promise.all([
    fetch(`${base}IrishNationalTideGaugeNetwork.json?${encodeURI(`station_id,longitude,latitude,time,Water_Level_OD_Malin&time>=${since}`)}`, { cf: { cacheEverything: true, cacheTtl: 900 } }),
    fetch(`${base}imiSurgeObservationINTGN.json?${encodeURI(`stationID,longitude,latitude,time,sea_surface_elevation_due_to_tide,sea_surface_elevation_due_to_storm_surge&time>=${since}&orderByMax("stationID,time")`)}`, { cf: { cacheEverything: true, cacheTtl: 900 } }),
    fetch(`${base}IMI_TidePrediction_HighLow.json?${encodeURI(`stationID,longitude,latitude,time,tide_time_category,Water_Level_ODMalin&time>=${since}&time<=${until}`)}`, { cf: { cacheEverything: true, cacheTtl: 3600 } })
  ]);
  if (!levelsResponse.ok) throw new Error(`Tide gauges returned ${levelsResponse.status}`);
  const levelRows = (await levelsResponse.json()).table?.rows ?? [];
  const surges = surgeResponse.ok ? (await surgeResponse.json()).table?.rows ?? [] : [];
  const predictions = predictionResponse.ok ? (await predictionResponse.json()).table?.rows ?? [] : [];
  const distance = (a, b) => Math.hypot(Number(a[1]) - Number(b[1]), Number(a[2]) - Number(b[2]));
  const now = Date.now();
  const stationRows = new Map();
  for (const row of levelRows) {
    const rows = stationRows.get(String(row[0])) ?? [];
    rows.push(row);
    stationRows.set(String(row[0]), rows);
  }
  return [...stationRows.values()].flatMap((rows) => {
    rows.sort((a, b) => new Date(a[3]) - new Date(b[3]));
    const row = rows.at(-1);
    const previous = rows.at(-2);
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
      trend: previous && numeric(previous[4]) !== null && numeric(row[4]) !== null
        ? numeric(row[4]) - numeric(previous[4]) > .005
          ? "rising"
          : numeric(row[4]) - numeric(previous[4]) < -.005
            ? "falling"
            : "steady"
        : "unknown",
      nextHighAt: nextHigh ? String(nextHigh[3]) : null,
      nextHighLevel: nextHigh ? numeric(nextHigh[5]) : null,
      nextLowAt: nextLow ? String(nextLow[3]) : null,
      nextLowLevel: nextLow ? numeric(nextLow[5]) : null
    }];
  });
};

const irishGridToLonLat = (east, north) => {
  const a = 6377340.189, b = 6356034.447, f0 = 1.000035;
  const lat0 = 53.5 * Math.PI / 180, lon0 = -8 * Math.PI / 180;
  const n0 = 250000, e0 = 200000;
  const e2 = 1 - (b * b) / (a * a);
  const n = (a - b) / (a + b);
  let lat = lat0, meridional = 0;
  do {
    lat = (north - n0 - meridional) / (a * f0) + lat;
    const ma = (1 + n + 5 / 4 * n ** 2 + 5 / 4 * n ** 3) * (lat - lat0);
    const mb = (3 * n + 3 * n ** 2 + 21 / 8 * n ** 3) * Math.sin(lat - lat0) * Math.cos(lat + lat0);
    const mc = (15 / 8 * n ** 2 + 15 / 8 * n ** 3) * Math.sin(2 * (lat - lat0)) * Math.cos(2 * (lat + lat0));
    const md = 35 / 24 * n ** 3 * Math.sin(3 * (lat - lat0)) * Math.cos(3 * (lat + lat0));
    meridional = b * f0 * (ma - mb + mc - md);
  } while (Math.abs(north - n0 - meridional) >= .00001);
  const sin = Math.sin(lat), cos = Math.cos(lat), tan = Math.tan(lat);
  const nu = a * f0 / Math.sqrt(1 - e2 * sin ** 2);
  const rho = a * f0 * (1 - e2) / (1 - e2 * sin ** 2) ** 1.5;
  const eta2 = nu / rho - 1;
  const d = east - e0;
  const vii = tan / (2 * rho * nu);
  const viii = tan / (24 * rho * nu ** 3) * (5 + 3 * tan ** 2 + eta2 - 9 * tan ** 2 * eta2);
  const ix = tan / (720 * rho * nu ** 5) * (61 + 90 * tan ** 2 + 45 * tan ** 4);
  const x = 1 / (cos * nu);
  const xi = 1 / (6 * cos * nu ** 3) * (nu / rho + 2 * tan ** 2);
  const xii = 1 / (120 * cos * nu ** 5) * (5 + 28 * tan ** 2 + 24 * tan ** 4);
  const xiia = 1 / (5040 * cos * nu ** 7) * (61 + 662 * tan ** 2 + 1320 * tan ** 4 + 720 * tan ** 6);
  return {
    latitude: (lat - vii * d ** 2 + viii * d ** 4 - ix * d ** 6) * 180 / Math.PI,
    longitude: (lon0 + x * d - xi * d ** 3 + xii * d ** 5 - xiia * d ** 7) * 180 / Math.PI
  };
};

const fetchBathingAlerts = async () => {
  const alertsResponse = await fetch("https://data.epa.ie/bw/api/v1/alerts?per_page=100", {
    cf: { cacheEverything: true, cacheTtl: 900 }
  });
  if (!alertsResponse.ok) throw new Error(`EPA bathing alerts returned ${alertsResponse.status}`);
  const alerts = normalizeBathingAlerts((await alertsResponse.json()).list ?? []);
  if (!alerts.length) return [];
  const locationsResponse = await fetch("https://data.epa.ie/bw/api/v1/locations?per_page=500", {
    cf: { cacheEverything: true, cacheTtl: 86400 }
  });
  if (!locationsResponse.ok) throw new Error(`EPA bathing locations returned ${locationsResponse.status}`);
  const locations = new Map(((await locationsResponse.json()).list ?? []).map((item) => [item.beach_id, item]));
  return alerts.flatMap((alert) => {
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
      noticeUrl: alert.bathing_notice_pdf ? String(alert.bathing_notice_pdf) : null
    }];
  });
};

const fetchSatellite = async () => {
  const date = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  return {
    observedAt: `${date}T13:30:00Z`,
    label: "VIIRS true colour · previous-day archive frame",
    tileTemplate: `https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/VIIRS_SNPP_CorrectedReflectance_TrueColor/default/${date}/GoogleMapsCompatible_Level9/{z}/{y}/{x}.jpg`
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
  const body = await response.json();
  return (body.features ?? []).slice(0, 30).flatMap((feature) => {
    const [longitude, latitude, depthKm] = feature.geometry?.coordinates ?? [];
    const magnitude = numeric(feature.properties?.mag);
    if (![longitude, latitude, depthKm].every(Number.isFinite) || magnitude === null) return [];
    return [{
      id: String(feature.id), longitude, latitude, depthKm, magnitude,
      place: String(feature.properties?.place ?? "Near Ireland"),
      observedAt: new Date(Number(feature.properties?.time)).toISOString(),
      detailUrl: String(feature.properties?.url ?? "")
    }];
  });
};

const fetchIssTle = async () => {
  const response = await fetch(
    "https://celestrak.org/NORAD/elements/gp.php?CATNR=25544&FORMAT=TLE",
    { cf: { cacheEverything: true, cacheTtl: 21600 } }
  );
  if (!response.ok) throw new Error(`CelesTrak returned ${response.status}`);
  const lines = (await response.text()).trim().split(/\r?\n/);
  if (lines.length < 3) throw new Error("CelesTrak returned an invalid ISS element set");
  return { line1: lines.at(-2), line2: lines.at(-1), observedAt: new Date().toISOString() };
};

export const fetchTransit = async (env) => {
  if (!env.NTA_API_KEY) return { vehicles: [], status: "credential-required" };
  const response = await fetch("https://api.nationaltransport.ie/gtfsr/v2/Vehicles?format=json", {
    headers: { "x-api-key": env.NTA_API_KEY },
    // NTA permits each token to call the GTFS-R API at most once per 60 seconds.
    cf: {
      cacheEverything: true,
      cacheTtl: 60,
      cacheTtlByStatus: { "200-299": 60, "400-599": 0 }
    }
  });
  if (!response.ok) throw new Error(`NTA vehicles returned ${response.status}`);
  const body = await response.json();
  const entities = body.entity ?? body.Entity ?? body.entities ?? [];
  const vehicles = entities.flatMap((entity) => {
    const vehicle = entity.vehicle ?? entity.Vehicle ?? entity;
    const position = vehicle.position ?? vehicle.Position;
    const latitude = numeric(position?.latitude ?? position?.Latitude);
    const longitude = numeric(position?.longitude ?? position?.Longitude);
    if (latitude === null || longitude === null || latitude < 51.2 || latitude > 55.6 || longitude < -10.8 || longitude > -5.2) return [];
    const timestamp = numeric(vehicle.timestamp ?? vehicle.Timestamp);
    if (timestamp === null) return [];
    const observedAt = new Date(timestamp * 1000);
    const age = Date.now() - observedAt.getTime();
    if (!Number.isFinite(observedAt.getTime()) || age < 0 || age >= 30 * 60_000) return [];
    return [{
      id: String(vehicle.vehicle?.id ?? vehicle.vehicle?.label ?? entity.id ?? crypto.randomUUID()),
      latitude, longitude,
      route: String(vehicle.trip?.routeId ?? vehicle.trip?.route_id ?? ""),
      label: String(vehicle.vehicle?.label ?? vehicle.vehicle?.id ?? "Public transport"),
      bearing: numeric(position?.bearing ?? position?.Bearing),
      speedKmh: numeric(position?.speed ?? position?.Speed) === null ? null : numeric(position?.speed ?? position?.Speed) * 3.6,
      speedSource: numeric(position?.speed ?? position?.Speed) === null ? null : "reported",
      observedAt: observedAt.toISOString()
    }];
  }).slice(0, 1200);
  return { vehicles, status: vehicles.length ? "live" : "unavailable" };
};

const fetchAurora = async () => {
  const [auroraResponse, kpResponse] = await Promise.all([
    fetch("https://services.swpc.noaa.gov/json/ovation_aurora_latest.json", {
      cf: { cacheEverything: true, cacheTtl: 900 }
    }),
    fetch("https://services.swpc.noaa.gov/json/planetary_k_index_1m.json", {
      cf: { cacheEverything: true, cacheTtl: 300 }
    })
  ]);
  if (!auroraResponse.ok) throw new Error(`NOAA aurora returned ${auroraResponse.status}`);
  const body = await auroraResponse.json();
  const probabilities = (body.coordinates ?? [])
    .filter((point) => point[0] >= 349 && point[0] <= 355 && point[1] >= 51 && point[1] <= 56)
    .map((point) => Number(point[2])).filter(Number.isFinite);
  if (!probabilities.length) return null;
  let kpIndex = null;
  if (kpResponse.ok) {
    const rows = await kpResponse.json();
    kpIndex = numeric(rows.at(-1)?.estimated_kp);
  }
  return {
    observedAt: String(body["Observation Time"] ?? ""),
    forecastAt: String(body["Forecast Time"] ?? ""),
    probability: Math.max(...probabilities),
    kpIndex
  };
};

const livingLayers = async (env) => {
  const [trains, rivers] = await Promise.allSettled([
    fetchTrains(),
    fetchRiversResult(env)
  ]);
  if (trains.status === "rejected") console.error("Irish Rail refresh failed", trains.reason);
  if (rivers.status === "rejected") console.error("OPW river refresh failed", rivers.reason);
  return json({
    generatedAt: new Date().toISOString(),
    trains: trains.status === "fulfilled" ? trains.value : [],
    rivers: rivers.status === "fulfilled" ? rivers.value.rivers : [],
    sourceStatus: {
      trains: trains.status === "fulfilled" && trains.value.length ? "live" : "unavailable",
      rivers: rivers.status === "fulfilled" ? rivers.value.provenance.status : "unavailable"
    },
    sourceProvenance: {
      trains: {
        provider: "Irish Rail",
        endpoint: "https://api.irishrail.ie/realtime/realtime.asmx/getCurrentTrainsXML",
        status: trains.status === "fulfilled" && trains.value.length ? "live" : "unavailable",
        fetchedAt: new Date().toISOString(),
        latestObservedAt: trains.status === "fulfilled" ? latestObservedAt(trains.value) : null,
        fallback: null
      },
      rivers: rivers.status === "fulfilled"
        ? rivers.value.provenance
        : makeRiverProvenance({ status: "unavailable" })
    }
  });
};

const currentContexts = async (env) => {
  const measuredAirAtEdge = env.EDGE_RUNTIME !== "cloudflare";
  const [
    marine, radar, grid, modelledAir, measuredAir, aurora, tides,
    bathingAlerts, satellite, earthquakes, issTle, warnings
  ] = await Promise.allSettled([
    fetchMarine(),
    fetchRadar(),
    fetchGrid(),
    fetchAirQuality(),
    measuredAirAtEdge ? fetchMeasuredAirQuality() : Promise.resolve([]),
    fetchAurora(),
    fetchTides(),
    fetchBathingAlerts(),
    fetchSatellite(),
    fetchEarthquakes(),
    fetchIssTle(),
    fetchWarnings()
  ]);
  for (const [name, result] of Object.entries({
    marine, radar, grid, modelledAir, measuredAir, aurora, tides,
    bathingAlerts, satellite, earthquakes, issTle, warnings
  })) {
    if (result.status === "rejected") console.error(`${name} context refresh failed`, result.reason);
  }
  const modelled = modelledAir.status === "fulfilled" ? modelledAir.value : [];
  const measured = measuredAir.status === "fulfilled" ? measuredAir.value : [];
  const contextStatus = {
    marine: marine.status === "fulfilled" ? "live" : "unavailable",
    measuredAir: measuredAirAtEdge && measuredAir.status === "fulfilled" ? "live" : "unavailable",
    tides: tides.status === "fulfilled" ? "live" : "unavailable",
    bathing: bathingAlerts.status === "fulfilled" ? "live" : "unavailable",
    satellite: satellite.status === "fulfilled" ? "fallback" : "unavailable",
    earthquakes: earthquakes.status === "fulfilled" ? "live" : "unavailable",
    iss: issTle.status === "fulfilled" ? "live" : "unavailable",
    warnings: warnings.status === "fulfilled" ? "live" : "unavailable"
  };
  return json({
    generatedAt: new Date().toISOString(),
    marine: marine.status === "fulfilled" ? marine.value : [],
    radar: radar.status === "fulfilled" ? radar.value : [],
    grid: grid.status === "fulfilled" ? grid.value : null,
    airQuality: [...measured, ...modelled],
    aurora: aurora.status === "fulfilled" ? aurora.value : null,
    tides: tides.status === "fulfilled" ? tides.value : [],
    bathingAlerts: bathingAlerts.status === "fulfilled" ? bathingAlerts.value : [],
    warnings: warnings.status === "fulfilled" ? warnings.value : [],
    warningsStatus: warnings.status === "fulfilled" ? "live" : "unavailable",
    satellite: satellite.status === "fulfilled" ? satellite.value : null,
    earthquakes: earthquakes.status === "fulfilled" ? earthquakes.value : [],
    issTle: issTle.status === "fulfilled" ? issTle.value : null,
    contextStatus
  }, 200, Object.values(contextStatus).includes("unavailable") ? 0 : 60, 0);
};

const transitContext = async (env) => {
  try {
    const result = await fetchTransit(env);
    return json({
      generatedAt: new Date().toISOString(),
      transit: result.vehicles,
      transitStatus: result.status
    }, 200, result.status === "live" ? 15 : 0, 0);
  } catch (error) {
    console.error("NTA transit refresh failed", error);
    return json({
      generatedAt: new Date().toISOString(),
      transit: [],
      transitStatus: env.NTA_API_KEY ? "unavailable" : "credential-required"
    }, 200, 0, 0);
  }
};

const worker = {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/api/living") {
      try {
        return await livingLayers(env);
      } catch (error) {
        console.error("Living layers failed", error);
        return json({ error: "Live layers are temporarily unavailable." }, 503);
      }
    }
    if (url.pathname === "/api/contexts") {
      try {
        return await currentContexts(env);
      } catch (error) {
        console.error("Current contexts failed", error);
        return json({ error: "Current island contexts are temporarily unavailable." }, 503);
      }
    }
    if (url.pathname === "/api/transit") return transitContext(env);

    const response = await env.ASSETS.fetch(request);
    if (response.status !== 404) return response;
    if (url.pathname.includes(".")) return response;
    url.pathname = "/index.html";
    return env.ASSETS.fetch(new Request(url, request));
  }
};

export default worker;
