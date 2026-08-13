import {
  buildEirGridReading,
  latestEirGridValue,
  readBoundedJsonResponse
} from "./river-source.js";

export const EIRGRID_BODY_LIMIT = 256_000;
export const EIRGRID_HISTORY_BODY_LIMIT = 512_000;

export const numeric = (value) => {
  const parsed = Number.parseFloat(String(value ?? "").trim());
  return Number.isFinite(parsed) ? parsed : null;
};

export const haversineKm = (first, second) => {
  const radians = Math.PI / 180;
  const latitudeDelta = (second.latitude - first.latitude) * radians;
  const longitudeDelta = (second.longitude - first.longitude) * radians;
  const firstLatitude = first.latitude * radians;
  const secondLatitude = second.latitude * radians;
  const haversine =
    Math.sin(latitudeDelta / 2) ** 2 +
    Math.cos(firstLatitude) * Math.cos(secondLatitude) * Math.sin(longitudeDelta / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(haversine), Math.sqrt(1 - haversine));
};

export const addEstimatedSpeeds = (current, previous, options = {}) => {
  const maximumKmh = typeof options === "number" ? options : options.maximumKmh ?? 130;
  const maximumIntervalMinutes = typeof options === "number" ? 10 : options.maximumIntervalMinutes ?? 10;
  const clearUnusable = typeof options === "number" ? false : Boolean(options.clearUnusable);
  const unusable = (item) => clearUnusable ? { ...item, speedKmh: null, speedSource: null } : item;
  const previousById = new Map(previous.map((item) => [item.id, item]));
  return current.map((item) => {
    if (item.speedKmh != null) return { ...item, speedSource: item.speedSource ?? "reported" };
    const earlier = previousById.get(item.id);
    if (!earlier) return unusable(item);
    const elapsedHours =
      (new Date(item.observedAt).getTime() - new Date(earlier.observedAt).getTime()) / 3_600_000;
    if (!Number.isFinite(elapsedHours) || elapsedHours <= 0 || elapsedHours > maximumIntervalMinutes / 60) {
      return unusable(item);
    }
    const speedKmh = haversineKm(earlier, item) / elapsedHours;
    if (!Number.isFinite(speedKmh) || speedKmh > maximumKmh) return unusable(item);
    return { ...item, speedKmh, speedSource: "calculated" };
  });
};

export const webMercatorToLonLat = (x, y) => ({
  longitude: x / 6378137 * 180 / Math.PI,
  latitude: (2 * Math.atan(Math.exp(y / 6378137)) - Math.PI / 2) * 180 / Math.PI
});

export const eeaTimestamp = (value) => {
  const match = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/.exec(String(value));
  return match ? `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}Z` : "";
};

export const europeanAqiScore = ({ pm25, pm10, nitrogenDioxide, ozone }) => {
  const bands = [
    [pm25, [10, 20, 25, 50, 75]],
    [pm10, [20, 40, 50, 100, 150]],
    [nitrogenDioxide, [40, 90, 120, 230, 340]],
    [ozone, [50, 100, 130, 240, 380]]
  ];
  const scores = bands.flatMap(([reading, thresholds]) => {
    if (reading === null || reading === undefined || !Number.isFinite(reading)) return [];
    const index = thresholds.findIndex((threshold) => reading <= threshold);
    return [index < 0 ? 110 : [10, 30, 50, 70, 90][index]];
  });
  return scores.length ? Math.max(...scores) : null;
};

const IRELAND_PLACE_PREFIX = /^(Ireland|Dublin|Cork|Kerry|Galway|Limerick|Clare|Mayo|Donegal|Wicklow|Kildare|Louth|Sligo|Offaly|Carlow|Cavan|Roscommon|Waterford)\s+/i;

export const MEASURED_AIR_POLLUTANTS = Object.freeze([
  ["PM25", "pm25"],
  ["PM10", "pm10"],
  ["NO2", "nitrogenDioxide"],
  ["O3", "ozone"]
]);

export const measuredAirStamp = (now = Date.now()) => {
  const observed = new Date(now - 3 * 60 * 60 * 1000);
  return observed.toISOString().replace(/[-:T]/g, "").slice(0, 10) + "0000";
};

export const measuredAirUrl = (pollutant, stamp) =>
  `https://discomap.eea.europa.eu/Map/UTDViewerPRE/dataService/Hourly?polu=${pollutant}&dt=${stamp}`;

export const parseMeasuredAirStations = (responses) => {
  const stations = new Map();
  for (const [field, csv] of responses) {
    for (const line of String(csv).split(/\r?\n/).slice(1)) {
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
        name: String(columns[10] ?? "").replace(IRELAND_PLACE_PREFIX, ""),
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

export const irishGridToLonLat = (east, north) => {
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

const parseRadarTime = (id) => {
  const match = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})$/.exec(id);
  return match
    ? `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:00Z`
    : new Date().toISOString();
};

export const normalizeRadarFrames = (rows) => (Array.isArray(rows) ? rows : []).slice(-7).flatMap((row) => {
  const id = String(row?.src ?? "");
  const modifiedTime = Number(row?.modifiedTime);
  let server;
  try {
    server = new URL(String(row?.server ?? "https://gdal.met.ie"));
  } catch {
    return [];
  }
  if (
    !/^\d{12}$/.test(id) ||
    !Number.isFinite(modifiedTime) ||
    server.protocol !== "https:" ||
    server.hostname !== "gdal.met.ie"
  ) return [];
  return [{
    id,
    observedAt: parseRadarTime(id),
    modifiedTime,
    provider: "Met Éireann",
    tileTemplate: `${server.origin}/api/maps/radar/${id}/{x}/{y}/{z}/${modifiedTime}`
  }];
});

export const eirGridDublinHourWindow = (now = Date.now()) => {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Dublin", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", hourCycle: "h23"
  }).formatToParts(new Date(now)).map((part) => [part.type, part.value]));
  const prefix = `${parts.year}-${parts.month}-${parts.day}T${parts.hour}`;
  return {
    dateFrom: `${prefix}:00:00`,
    dateTo: `${prefix}:59:59`
  };
};

export const eirGridChartUrl = (chartType, areas, now = Date.now()) => {
  const hour = eirGridDublinHourWindow(now);
  const day = hour.dateFrom.slice(0, 10);
  const url = new URL("https://www.smartgriddashboard.com/api/chart/");
  url.search = new URLSearchParams({
    region: "ALL",
    chartType,
    dateRange: chartType === "frequency" ? "hour" : "day",
    dateFrom: chartType === "frequency" ? hour.dateFrom : day,
    dateTo: chartType === "frequency" ? hour.dateTo : day,
    areas
  }).toString();
  return url;
};

const defaultGridRequestInit = (chartType) => ({
  cf: { cacheEverything: true, cacheTtl: chartType === "frequency" ? 60 : 300 }
});

export const fetchGridRows = async (
  chartType,
  areas,
  fetcher = fetch,
  now = Date.now(),
  {
    maximumBytes = EIRGRID_BODY_LIMIT,
    requestInit = defaultGridRequestInit
  } = {}
) => {
  const url = eirGridChartUrl(chartType, areas, now);
  const response = await fetcher(url, requestInit(chartType));
  if (!response.ok) throw new Error(`EirGrid ${chartType} returned ${response.status}`);
  const bounded = await readBoundedJsonResponse(response, `eirgrid-${chartType}`, maximumBytes);
  return bounded.body?.Rows ?? [];
};

export const fetchGrid = async (fetcher = fetch, now = Date.now(), options = {}) => {
  const settled = await Promise.allSettled([
    fetchGridRows("demand", "demandactual", fetcher, now, options),
    fetchGridRows("generation", "generationactual", fetcher, now, options),
    fetchGridRows("wind", "windactual", fetcher, now, options),
    fetchGridRows("co2", "co2intensity,co2emission", fetcher, now, options),
    fetchGridRows("frequency", "frequency", fetcher, now, options),
    fetchGridRows("interconnection", "interconnection", fetcher, now, options)
  ]);
  const rows = (index) => settled[index].status === "fulfilled" ? settled[index].value : [];
  const [demandRows, generationRows, windRows, carbonRows, frequencyRows, interconnectionRows] = [0, 1, 2, 3, 4, 5].map(rows);
  const demand = latestEirGridValue(demandRows, "SYSTEM_DEMAND", now);
  const generation = latestEirGridValue(generationRows, "GEN_EXP", now);
  const wind = latestEirGridValue(windRows, "WIND_ACTUAL", now);
  const intensity = latestEirGridValue(carbonRows, "CO2_INTENSITY", now);
  const emissions = latestEirGridValue(carbonRows, "CO2_EMISSIONS", now);
  const frequency = latestEirGridValue(frequencyRows, "SYS_FREQUENCY", now);
  const interconnector = latestEirGridValue(interconnectionRows, "INTER_NET", now);
  const reading = buildEirGridReading({
    demand, generation, wind, carbonIntensity: intensity, carbonEmissions: emissions,
    frequency, interconnection: interconnector
  });
  if (!reading) return { reading: null, status: "unavailable" };
  const metricCount = [demand, generation, wind, intensity, emissions, frequency, interconnector].filter(Boolean).length;
  return { reading, status: metricCount === 7 ? "live" : "partial" };
};

export const tideQueryWindow = (now = Date.now()) => {
  const bucketMilliseconds = 15 * 60 * 1000;
  const bucket = Math.floor(now / bucketMilliseconds) * bucketMilliseconds;
  return {
    since: new Date(bucket - 45 * 60 * 1000).toISOString().replace(/\.\d{3}Z$/, "Z"),
    until: new Date(bucket + 36 * 60 * 60 * 1000).toISOString().replace(/\.\d{3}Z$/, "Z")
  };
};

const TIDE_TREND_WINDOW_MS = 30 * 60 * 1000;
const TIDE_TREND_CHANGE_THRESHOLD_METRES = .01;

export const weatherBuoyQuery = (now = Date.now()) => {
  const since = new Date(now - 48 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const query = `station_id,longitude,latitude,time,WindSpeed,WaveHeight,WavePeriod,SeaTemperature&time>=${since}T00:00:00Z&orderByMax("station_id,time")`;
  return {
    since,
    query,
    url: `https://erddap.marine.ie/erddap/tabledap/IWBNetwork.json?${encodeURI(query)}`
  };
};

export const parseWeatherBuoyRows = (rows, now = Date.now(), maxAgeMs = 6 * 60 * 60 * 1000) =>
  (Array.isArray(rows) ? rows : []).flatMap((row) => {
    const observedAt = String(row[3] ?? "");
    const timestamp = Date.parse(observedAt);
    const age = now - timestamp;
    if (!Number.isFinite(timestamp) || age < 0 || age >= maxAgeMs) return [];
    return [{
      id: String(row[0]),
      name: `Offshore buoy ${String(row[0])}`,
      kind: "weather-buoy",
      longitude: Number(row[1]),
      latitude: Number(row[2]),
      observedAt,
      windSpeedKnots: numeric(row[4]),
      waveHeight: numeric(row[5]),
      wavePeriod: numeric(row[6]),
      seaTemperature: numeric(row[7])
    }];
  });

export const COASTAL_MARINE_SOURCES = Object.freeze([
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
]);

export const parseCoastalObservatoryRow = (source, row, now = Date.now(), maxAgeMs = 6 * 60 * 60 * 1000) => {
  if (!row) return null;
  const reading = source.map(row);
  const timestamp = Date.parse(reading.observedAt);
  const age = now - timestamp;
  if (!Number.isFinite(timestamp) || age < 0 || age >= maxAgeMs) return null;
  return { id: source.dataset, name: source.name, kind: "coastal-observatory", ...reading };
};

export const classifyTideTrend = (samples) => {
  const valid = samples.flatMap((sample) => {
    const observedAt = new Date(sample.observedAt).getTime();
    const waterLevel = numeric(sample.waterLevel);
    return Number.isFinite(observedAt) && waterLevel !== null
      ? [{ observedAt, waterLevel }]
      : [];
  }).sort((first, second) => first.observedAt - second.observedAt);
  if (valid.length < 3) return "unknown";

  const latestAt = valid.at(-1).observedAt;
  const recent = valid.filter((sample) => sample.observedAt >= latestAt - TIDE_TREND_WINDOW_MS);
  if (recent.length < 3) return "unknown";

  const origin = recent[0].observedAt;
  const points = recent.map((sample) => ({
    minutes: (sample.observedAt - origin) / 60_000,
    waterLevel: sample.waterLevel
  }));
  const meanMinutes = points.reduce((sum, point) => sum + point.minutes, 0) / points.length;
  const meanLevel = points.reduce((sum, point) => sum + point.waterLevel, 0) / points.length;
  const variance = points.reduce((sum, point) => sum + (point.minutes - meanMinutes) ** 2, 0);
  if (variance === 0) return "unknown";

  const covariance = points.reduce(
    (sum, point) => sum + (point.minutes - meanMinutes) * (point.waterLevel - meanLevel),
    0
  );
  const estimatedChange = covariance / variance * points.at(-1).minutes;
  if (estimatedChange > TIDE_TREND_CHANGE_THRESHOLD_METRES) return "rising";
  if (estimatedChange < -TIDE_TREND_CHANGE_THRESHOLD_METRES) return "falling";
  return "steady";
};
