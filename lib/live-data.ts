import type {
  AirQualityReading,
  AuroraReading,
  GridReading,
  LiveSnapshot,
  MarineReading,
  RadarFrame,
  RiverReading,
  StationReading,
  TrainPosition,
  WeatherWarning
} from "./types";
import { parseLatestObservations } from "./latest-observations";

const STATIONS = [
  { id: "malin-head", endpoint: "malin-head", csvName: "Malin Head", name: "Malin Head", latitude: 55.371, longitude: -7.339 },
  { id: "finner", endpoint: "finner", csvName: "Finner Camp", name: "Finner", latitude: 54.494, longitude: -8.243 },
  { id: "belmullet", endpoint: "belmullet", csvName: "Belmullet", name: "Belmullet", latitude: 54.228, longitude: -10.007 },
  { id: "athenry", endpoint: "athenry", csvName: "Athenry", name: "Athenry", latitude: 53.289, longitude: -8.786 },
  { id: "dublin-airport", endpoint: "dublin-airport", csvName: "Dublin Airport", name: "Dublin", latitude: 53.428, longitude: -6.241 },
  { id: "gurteen", endpoint: "gurteen", csvName: "Gurteen", name: "Gurteen", latitude: 53.034, longitude: -8.005 },
  { id: "valentia", endpoint: "valentia", csvName: "Valentia Observatory", name: "Valentia", latitude: 51.938, longitude: -10.241 },
  { id: "cork-airport", endpoint: "cork-airport", csvName: "Cork Airport", name: "Cork", latitude: 51.847, longitude: -8.486 },
  { id: "johnstown-castle", endpoint: "johnstown-castle", csvName: "Johnstown Castle", name: "Wexford", latitude: 52.298, longitude: -6.497 }
] as const;

const numberOrNull = (value: unknown): number | null => {
  const parsed = Number.parseFloat(String(value ?? "").trim());
  return Number.isFinite(parsed) ? parsed : null;
};

const irelandTimestamp = (date: string, time: string): string | null => {
  const match = /^(\d{2})-(\d{2})-(\d{4})$/.exec(date);
  if (!match || !time) return null;
  const [, day, month, year] = match;
  const parsed = new Date(`${year}-${month}-${day}T${time}:00`);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
};

type StationResult = {
  reading: StationReading;
  history: Array<{ time: string; temperature: number | null; rainfall: number; windSpeed: number | null }>;
};

async function fetchStation(station: (typeof STATIONS)[number]): Promise<StationResult | null> {
  try {
    const response = await fetch(
      `https://prodapi.metweb.ie/observations/${station.endpoint}/today`,
      { next: { revalidate: 300 }, signal: AbortSignal.timeout(7000) }
    );
    if (!response.ok) return null;
    const rows = (await response.json()) as Array<Record<string, unknown>>;
    const latest = rows.at(-1);
    if (!latest) return null;
    const observedAt = irelandTimestamp(String(latest.date ?? ""), String(latest.reportTime ?? ""));
    const age = observedAt ? Date.now() - new Date(observedAt).getTime() : Number.POSITIVE_INFINITY;
    return {
      reading: {
        id: station.id,
        name: station.name,
        latitude: station.latitude,
        longitude: station.longitude,
        temperature: numberOrNull(latest.temperature),
        rainfall: numberOrNull(latest.rainfall),
        windSpeed: numberOrNull(latest.windSpeed),
        windDirection: String(latest.cardinalWindDirection ?? "").trim(),
        description: String(latest.weatherDescription ?? "Observation available"),
        observedAt,
        fresh: age < 3 * 60 * 60 * 1000
      },
      history: rows.map((row) => ({
        time: String(row.reportTime ?? ""),
        temperature: numberOrNull(row.temperature),
        rainfall: numberOrNull(row.rainfall) ?? 0,
        windSpeed: numberOrNull(row.windSpeed)
      }))
    };
  } catch {
    return null;
  }
}

async function fetchWarnings(): Promise<WeatherWarning[]> {
  try {
    const response = await fetch("https://www.met.ie/Open_Data/json/warning_IRELAND.json", {
      next: { revalidate: 300 },
      signal: AbortSignal.timeout(7000)
    });
    if (!response.ok) return [];
    const rows = (await response.json()) as Array<Record<string, unknown>>;
    const now = Date.now();
    return rows
      .filter((row) => new Date(String(row.expiry)).getTime() > now)
      .map((row) => ({
        level: String(row.level ?? "Advisory"),
        headline: String(row.headline ?? "Weather advisory"),
        description: String(row.description ?? ""),
        onset: String(row.onset ?? ""),
        expiry: String(row.expiry ?? "")
      }));
  } catch {
    return [];
  }
}

async function fetchLatestStationFallback(): Promise<StationReading[]> {
  try {
    const response = await fetch("https://www.met.ie/latest-reports/observations/download", {
      next: { revalidate: 300 },
      signal: AbortSignal.timeout(7000)
    });
    if (!response.ok) return [];
    return parseLatestObservations(await response.text(), STATIONS);
  } catch {
    return [];
  }
}

const freshEnough = (value: string, hours = 6) =>
  Date.now() - new Date(value).getTime() < hours * 60 * 60 * 1000;

async function fetchWeatherBuoys(): Promise<MarineReading[]> {
  try {
    const since = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const query =
      `station_id,longitude,latitude,time,WindSpeed,WaveHeight,WavePeriod,SeaTemperature` +
      `&time>=${since}T00:00:00Z&orderByMax("station_id,time")`;
    const response = await fetch(
      `https://erddap.marine.ie/erddap/tabledap/IWBNetwork.json?${encodeURI(query)}`,
      { next: { revalidate: 900 }, signal: AbortSignal.timeout(8000) }
    );
    if (!response.ok) return [];
    const body = (await response.json()) as { table?: { rows?: unknown[][] } };
    return (body.table?.rows ?? []).map((row) => ({
      id: String(row[0]),
      name: `Offshore buoy ${String(row[0])}`,
      kind: "weather-buoy" as const,
      longitude: Number(row[1]),
      latitude: Number(row[2]),
      observedAt: String(row[3]),
      windSpeedKnots: numberOrNull(row[4]),
      waveHeight: numberOrNull(row[5]),
      wavePeriod: numberOrNull(row[6]),
      seaTemperature: numberOrNull(row[7])
    })).filter((reading) => freshEnough(reading.observedAt));
  } catch {
    return [];
  }
}

type CoastalSource = {
  dataset: string;
  name: string;
  variables: string[];
  map: (row: unknown[]) => Omit<MarineReading, "id" | "name" | "kind">;
};

const COASTAL_SOURCES: CoastalSource[] = [
  {
    dataset: "smartbay_metbuoy",
    name: "SmartBay Met Buoy",
    variables: ["time", "latitude", "longitude", "wind_speed"],
    map: (row) => ({
      observedAt: String(row[0]),
      latitude: Number(row[1]),
      longitude: Number(row[2]),
      windSpeedKnots: numberOrNull(row[3]) === null ? null : (numberOrNull(row[3]) as number) * 1.94384,
      waveHeight: null,
      wavePeriod: null,
      seaTemperature: null
    })
  },
  {
    dataset: "sentinel_lehanagh",
    name: "Lehanagh Pool Observatory",
    variables: ["time", "latitude", "longitude", "Wind_Speed", "SBE_Temp_Avg"],
    map: (row) => ({
      observedAt: String(row[0]),
      latitude: Number(row[1]),
      longitude: Number(row[2]),
      windSpeedKnots: numberOrNull(row[3]) === null ? null : (numberOrNull(row[3]) as number) * 1.94384,
      waveHeight: null,
      wavePeriod: null,
      seaTemperature: numberOrNull(row[4])
    })
  },
  {
    dataset: "compass_mace_head",
    name: "Mace Head Observatory",
    variables: ["time", "latitude", "longitude", "wind_speed", "sbe_temp_avg", "SignificantWaveHeight", "MeanWavePeriod_Tm02"],
    map: (row) => ({
      observedAt: String(row[0]),
      latitude: Number(row[1]),
      longitude: Number(row[2]),
      windSpeedKnots: numberOrNull(row[3]) === null ? null : (numberOrNull(row[3]) as number) * 1.94384,
      seaTemperature: numberOrNull(row[4]),
      waveHeight: numberOrNull(row[5]),
      wavePeriod: numberOrNull(row[6])
    })
  }
];

async function fetchCoastalBuoy(source: CoastalSource): Promise<MarineReading | null> {
  try {
    const query = `${source.variables.join(",")}&orderByMax("time")`;
    const response = await fetch(
      `https://erddap.marine.ie/erddap/tabledap/${source.dataset}.json?${encodeURI(query)}`,
      { next: { revalidate: 900 }, signal: AbortSignal.timeout(8000) }
    );
    if (!response.ok) return null;
    const body = (await response.json()) as { table?: { rows?: unknown[][] } };
    const row = body.table?.rows?.[0];
    if (!row) return null;
    const reading = source.map(row);
    if (!freshEnough(reading.observedAt)) return null;
    return {
      id: source.dataset,
      name: source.name,
      kind: "coastal-observatory",
      ...reading
    };
  } catch {
    return null;
  }
}

async function fetchMarine(): Promise<MarineReading[]> {
  const [weather, ...coastal] = await Promise.all([
    fetchWeatherBuoys(),
    ...COASTAL_SOURCES.map(fetchCoastalBuoy)
  ]);
  return [...weather, ...coastal.filter((reading): reading is MarineReading => reading !== null)];
}

const parseRadarTime = (id: string) => {
  const match = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})$/.exec(id);
  return match
    ? `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:00Z`
    : new Date().toISOString();
};

async function fetchRadar(): Promise<RadarFrame[]> {
  try {
    const response = await fetch("https://gdal.met.ie/api/maps/radar", {
      next: { revalidate: 300 },
      signal: AbortSignal.timeout(7000)
    });
    if (!response.ok) return [];
    const rows = (await response.json()) as Array<{ src?: unknown; modifiedTime?: unknown; server?: unknown }>;
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
  } catch {
    return [];
  }
}

const EIRGRID_MONTHS: Record<string, string> = {
  Jan: "01", Feb: "02", Mar: "03", Apr: "04", May: "05", Jun: "06",
  Jul: "07", Aug: "08", Sep: "09", Oct: "10", Nov: "11", Dec: "12"
};

const eirGridTimestamp = (value: string) => {
  const match = /^(\d{2})-([A-Za-z]{3})-(\d{4}) (\d{2}:\d{2}:\d{2})$/.exec(value);
  return match && EIRGRID_MONTHS[match[2]]
    ? `${match[3]}-${EIRGRID_MONTHS[match[2]]}-${match[1]}T${match[4]}Z`
    : null;
};

type GridRow = { EffectiveTime?: unknown; FieldName?: unknown; Value?: unknown };

async function fetchGridRows(chartType: string, areas: string): Promise<GridRow[]> {
  const day = new Date().toISOString().slice(0, 10);
  const url = new URL("https://www.smartgriddashboard.com/api/chart/");
  url.search = new URLSearchParams({
    region: "ALL",
    chartType,
    dateRange: chartType === "frequency" ? "hour" : "day",
    dateFrom: day,
    dateTo: day,
    areas
  }).toString();
  const response = await fetch(url, {
    next: { revalidate: chartType === "frequency" ? 60 : 300 },
    signal: AbortSignal.timeout(8000)
  });
  if (!response.ok) throw new Error(`EirGrid ${chartType} returned ${response.status}`);
  const body = (await response.json()) as { Rows?: GridRow[] };
  return body.Rows ?? [];
}

const latestGridValue = (rows: GridRow[], field: string) => {
  const row = [...rows].reverse().find(
    (item) =>
      String(item.FieldName) === field &&
      item.Value !== null &&
      item.Value !== undefined &&
      item.Value !== "" &&
      Number.isFinite(Number(item.Value))
  );
  return row ? { value: Number(row.Value), observedAt: eirGridTimestamp(String(row.EffectiveTime)) } : null;
};

async function fetchGrid(): Promise<GridReading | null> {
  try {
    const [demandRows, generationRows, windRows, carbonRows, frequencyRows, interconnectionRows] =
      await Promise.all([
        fetchGridRows("demand", "demandactual"),
        fetchGridRows("generation", "generationactual"),
        fetchGridRows("wind", "windactual"),
        fetchGridRows("co2", "co2intensity,co2emission"),
        fetchGridRows("frequency", "frequency"),
        fetchGridRows("interconnection", "interconnection")
      ]);
    const demand = latestGridValue(demandRows, "SYSTEM_DEMAND");
    const generation = latestGridValue(generationRows, "GEN_EXP");
    const wind = latestGridValue(windRows, "WIND_ACTUAL");
    const intensity = latestGridValue(carbonRows, "CO2_INTENSITY");
    const emissions = latestGridValue(carbonRows, "CO2_EMISSIONS");
    const frequency = latestGridValue(frequencyRows, "SYS_FREQUENCY");
    const interconnector = latestGridValue(interconnectionRows, "INTER_NET");
    const timestamps = [demand, generation, wind, intensity, emissions, frequency, interconnector]
      .map((item) => item?.observedAt)
      .filter((value): value is string => Boolean(value))
      .sort();
    if (!timestamps.length) return null;
    return {
      observedAt: timestamps[0] ?? null,
      demandMW: demand?.value ?? null,
      generationMW: generation?.value ?? null,
      windMW: wind?.value ?? null,
      windSharePercent: wind && demand && demand.value > 0 ? (wind.value / demand.value) * 100 : null,
      carbonIntensity: intensity?.value ?? null,
      carbonEmissions: emissions?.value ?? null,
      frequencyHz: frequency?.value ?? null,
      interconnectorMW: interconnector?.value ?? null
    };
  } catch {
    return null;
  }
}

const AIR_LOCATIONS = [
  { id: "dublin-air", name: "Dublin", latitude: 53.35, longitude: -6.26 },
  { id: "belfast-air", name: "Belfast", latitude: 54.60, longitude: -5.93 },
  { id: "cork-air", name: "Cork", latitude: 51.90, longitude: -8.48 },
  { id: "galway-air", name: "Galway", latitude: 53.27, longitude: -9.06 },
  { id: "limerick-air", name: "Limerick", latitude: 52.66, longitude: -8.63 },
  { id: "waterford-air", name: "Waterford", latitude: 52.26, longitude: -7.11 },
  { id: "derry-air", name: "Derry", latitude: 55.00, longitude: -7.31 }
];

async function fetchAirQuality(): Promise<AirQualityReading[]> {
  try {
    const url = new URL("https://air-quality-api.open-meteo.com/v1/air-quality");
    url.search = new URLSearchParams({
      latitude: AIR_LOCATIONS.map((item) => item.latitude).join(","),
      longitude: AIR_LOCATIONS.map((item) => item.longitude).join(","),
      current: "european_aqi,pm2_5,pm10,nitrogen_dioxide,ozone,uv_index,grass_pollen",
      timezone: "GMT"
    }).toString();
    const response = await fetch(url, {
      next: { revalidate: 1800 },
      signal: AbortSignal.timeout(8000)
    });
    if (!response.ok) return [];
    const bodies = await response.json() as Array<{ current?: Record<string, unknown> }>;
    return AIR_LOCATIONS.flatMap((place, index) => {
      const current = bodies[index]?.current;
      if (!current?.time) return [];
      return [{
        ...place,
        observedAt: `${String(current.time)}:00Z`,
        europeanAqi: numberOrNull(current.european_aqi),
        pm25: numberOrNull(current.pm2_5),
        pm10: numberOrNull(current.pm10),
        nitrogenDioxide: numberOrNull(current.nitrogen_dioxide),
        ozone: numberOrNull(current.ozone),
        uvIndex: numberOrNull(current.uv_index),
        grassPollen: numberOrNull(current.grass_pollen),
        source: "modelled" as const,
        stationClassification: null
      }];
    });
  } catch {
    return [];
  }
}

async function fetchAurora(): Promise<AuroraReading | null> {
  try {
    const [auroraResponse, kpResponse] = await Promise.all([
      fetch("https://services.swpc.noaa.gov/json/ovation_aurora_latest.json", {
        next: { revalidate: 900 },
        signal: AbortSignal.timeout(9000)
      }),
      fetch("https://services.swpc.noaa.gov/json/planetary_k_index_1m.json", {
        next: { revalidate: 300 },
        signal: AbortSignal.timeout(7000)
      })
    ]);
    if (!auroraResponse.ok) return null;
    const body = await auroraResponse.json() as {
      "Observation Time"?: unknown;
      "Forecast Time"?: unknown;
      coordinates?: unknown[][];
    };
    const probabilities = (body.coordinates ?? [])
      .filter((point) => {
        const longitude = Number(point[0]);
        const latitude = Number(point[1]);
        return longitude >= 349 && longitude <= 355 && latitude >= 51 && latitude <= 56;
      })
      .map((point) => Number(point[2]))
      .filter(Number.isFinite);
    if (!probabilities.length) return null;
    let kpIndex: number | null = null;
    if (kpResponse.ok) {
      const kpRows = await kpResponse.json() as Array<{ estimated_kp?: unknown }>;
      kpIndex = numberOrNull(kpRows.at(-1)?.estimated_kp);
    }
    return {
      observedAt: String(body["Observation Time"] ?? ""),
      forecastAt: String(body["Forecast Time"] ?? ""),
      probability: Math.max(...probabilities),
      kpIndex
    };
  } catch {
    return null;
  }
}

const textValue = (xml: string, name: string) => {
  const match = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(xml);
  return (match?.[1] ?? "")
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", "\"")
    .replaceAll("&#39;", "'")
    .trim();
};

async function fetchTrains(): Promise<TrainPosition[]> {
  try {
    const response = await fetch(
      "https://api.irishrail.ie/realtime/realtime.asmx/getCurrentTrainsXML",
      { next: { revalidate: 60 }, signal: AbortSignal.timeout(7000) }
    );
    if (!response.ok) return [];
    const xml = await response.text();
    const observedAt = new Date().toISOString();
    return [...xml.matchAll(/<objTrainPositions>([\s\S]*?)<\/objTrainPositions>/g)]
      .map<TrainPosition | null>((match) => {
        const latitude = numberOrNull(textValue(match[1], "TrainLatitude"));
        const longitude = numberOrNull(textValue(match[1], "TrainLongitude"));
        if (
          latitude === null ||
          longitude === null ||
          latitude < 51.2 ||
          latitude > 55.6 ||
          longitude < -10.8 ||
          longitude > -5.2
        ) return null;
        return {
          id: textValue(match[1], "TrainCode"),
          latitude,
          longitude,
          status: textValue(match[1], "TrainStatus") === "R" ? "running" as const : "not-started" as const,
          direction: textValue(match[1], "Direction"),
          message: textValue(match[1], "PublicMessage").replaceAll("\\n", " · "),
          observedAt,
          speedKmh: null,
          speedSource: null
        };
      })
      .filter((train): train is TrainPosition => train !== null);
  } catch {
    return [];
  }
}

async function fetchRivers(): Promise<RiverReading[]> {
  try {
    const response = await fetch("https://waterlevel.ie/geojson/latest/", {
      next: { revalidate: 900 },
      signal: AbortSignal.timeout(9000)
    });
    if (!response.ok) return [];
    const body = (await response.json()) as {
      features?: Array<{
        properties?: Record<string, unknown>;
        geometry?: { coordinates?: number[] };
      }>;
    };
    const readings = (body.features ?? [])
      .filter((item) => item.properties?.sensor_ref === "0001")
      .map((item) => {
        const [longitude, latitude] = item.geometry?.coordinates ?? [];
        const level = numberOrNull(item.properties?.value);
        const observedAt = String(item.properties?.datetime ?? "");
        const stationNumber = Number.parseInt(String(item.properties?.station_ref ?? ""), 10);
        if (
          !Number.isFinite(latitude) ||
          !Number.isFinite(longitude) ||
          level === null ||
          !observedAt ||
          stationNumber > 41000
        ) return null;
        return {
          id: String(item.properties?.station_ref ?? ""),
          name: String(item.properties?.station_name ?? "River gauge"),
          latitude,
          longitude,
          level,
          observedAt,
          fresh: Date.now() - new Date(observedAt).getTime() < 3 * 60 * 60 * 1000
        };
      })
      .filter((reading): reading is RiverReading => reading !== null && reading.fresh);

    const cells = new Map<string, RiverReading>();
    for (const reading of readings) {
      const key = `${Math.round(reading.longitude * 4)}:${Math.round(reading.latitude * 5)}`;
      const current = cells.get(key);
      if (!current || new Date(reading.observedAt) > new Date(current.observedAt)) cells.set(key, reading);
    }
    return [...cells.values()].slice(0, 90);
  } catch {
    return [];
  }
}

export async function getLiveSnapshot(): Promise<LiveSnapshot> {
  const [
    stationResults,
    fallbackStations,
    warnings,
    marine,
    trains,
    rivers,
    radar,
    grid,
    airQuality,
    aurora
  ] = await Promise.all([
    Promise.all(STATIONS.map(fetchStation)),
    fetchLatestStationFallback(),
    fetchWarnings(),
    fetchMarine(),
    fetchTrains(),
    fetchRivers(),
    fetchRadar(),
    fetchGrid(),
    fetchAirQuality(),
    fetchAurora()
  ]);
  const results = stationResults.filter((value): value is StationResult => value !== null);
  const resultIds = new Set(results.map((result) => result.reading.id));
  const stations = [
    ...results.map((result) => result.reading),
    ...fallbackStations.filter((station) => !resultIds.has(station.id))
  ];
  const fresh = stations.filter((station) => station.fresh);
  const by = (field: "temperature" | "rainfall" | "windSpeed") =>
    [...fresh]
      .filter((station) => station[field] !== null)
      .sort((a, b) => (b[field] ?? -Infinity) - (a[field] ?? -Infinity))[0] ?? null;

  const timelineByTime = new Map<string, { temperatures: number[]; rainfall: number; winds: number[] }>();
  for (const result of results) {
    for (const point of result.history) {
      const bucket = timelineByTime.get(point.time) ?? { temperatures: [], rainfall: 0, winds: [] };
      if (point.temperature !== null) bucket.temperatures.push(point.temperature);
      if (point.windSpeed !== null) bucket.winds.push(point.windSpeed);
      bucket.rainfall += point.rainfall;
      timelineByTime.set(point.time, bucket);
    }
  }

  return {
    generatedAt: new Date().toISOString(),
    sourceStatus: fresh.length >= 6 ? "live" : fresh.length > 0 ? "partial" : "fallback",
    stations,
    warnings,
    marine,
    trains,
    rivers,
    radar,
    grid,
    airQuality,
    aurora,
    tides: [],
    bathingAlerts: [],
    iss: null,
    issTle: null,
    satellite: null,
    earthquakes: [],
    transit: [],
    transitStatus: "credential-required",
    contextStatus: {
      measuredAir: "unavailable",
      tides: "unavailable",
      bathing: "unavailable",
      satellite: "unavailable",
      earthquakes: "unavailable",
      iss: "unavailable"
    },
    summary: {
      warmest: by("temperature"),
      wettest: by("rainfall"),
      windiest: by("windSpeed"),
      reporting: fresh.length,
      runningTrains: trains.filter((train) => train.status === "running").length,
      riverStations: rivers.length
    },
    timeline: [...timelineByTime.entries()].map(([time, values]) => ({
      time,
      temperature: values.temperatures.length
        ? values.temperatures.reduce((sum, value) => sum + value, 0) / values.temperatures.length
        : null,
      rainfall: values.rainfall,
      windSpeed: values.winds.length
        ? values.winds.reduce((sum, value) => sum + value, 0) / values.winds.length
        : null
    }))
  };
}
