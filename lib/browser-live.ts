import type { LiveSnapshot, StationReading } from "./types";
import { parseLatestObservations } from "./latest-observations";
import {
  degreesLat,
  degreesLong,
  ecfToLookAngles,
  eciToEcf,
  eciToGeodetic,
  gstime,
  propagate,
  twoline2satrec
} from "satellite.js";

const STATIONS = [
  ["malin-head", "Malin Head", "Malin Head", 55.371, -7.339],
  ["finner", "Finner", "Finner Camp", 54.494, -8.243],
  ["belmullet", "Belmullet", "Belmullet", 54.228, -10.007],
  ["athenry", "Athenry", "Athenry", 53.289, -8.786],
  ["dublin-airport", "Dublin", "Dublin Airport", 53.428, -6.241],
  ["gurteen", "Gurteen", "Gurteen", 53.034, -8.005],
  ["valentia", "Valentia", "Valentia Observatory", 51.938, -10.241],
  ["cork-airport", "Cork", "Cork Airport", 51.847, -8.486],
  ["johnstown-castle", "Wexford", "Johnstown Castle", 52.298, -6.497]
] as const;

const numeric = (value: unknown) => {
  const parsed = Number.parseFloat(String(value ?? "").trim());
  return Number.isFinite(parsed) ? parsed : null;
};

const distanceKm = (
  first: { latitude: number; longitude: number },
  second: { latitude: number; longitude: number }
) => {
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

export function addCalculatedSpeeds<
  T extends {
    id: string;
    latitude: number;
    longitude: number;
    observedAt: string;
    speedKmh?: number | null;
    speedSource?: "reported" | "calculated" | null;
  }
>(
  current: T[],
  previous: T[],
  options: { maximumKmh: number; maximumIntervalMinutes: number }
): T[] {
  const previousById = new Map(previous.map((item) => [item.id, item]));
  return current.map((item) => {
    if (item.speedKmh !== null && item.speedKmh !== undefined) {
      return { ...item, speedSource: item.speedSource ?? "reported" };
    }
    const earlier = previousById.get(item.id);
    if (!earlier) return { ...item, speedKmh: null, speedSource: null };
    const elapsedHours =
      (new Date(item.observedAt).getTime() - new Date(earlier.observedAt).getTime()) / 3_600_000;
    if (
      !Number.isFinite(elapsedHours) ||
      elapsedHours <= 0 ||
      elapsedHours > options.maximumIntervalMinutes / 60
    ) {
      return { ...item, speedKmh: null, speedSource: null };
    }
    const calculated = distanceKm(earlier, item) / elapsedHours;
    if (!Number.isFinite(calculated) || calculated > options.maximumKmh) {
      return { ...item, speedKmh: null, speedSource: null };
    }
    return { ...item, speedKmh: calculated, speedSource: "calculated" };
  });
}

const fetchWithRetry = async (url: string, timeoutMs: number) => {
  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const response = await fetch(url, {
        cache: "no-store",
        signal: AbortSignal.timeout(timeoutMs + attempt * 5_000)
      });
      if (response.ok || response.status < 500) return response;
      lastError = new Error(`${url} returned ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    if (attempt === 0) await new Promise((resolve) => window.setTimeout(resolve, 600));
  }
  throw lastError instanceof Error ? lastError : new Error(`${url} could not be refreshed`);
};

function timestamp(date: string, time: string) {
  const match = /^(\d{2})-(\d{2})-(\d{4})$/.exec(date);
  if (!match) return null;
  const value = new Date(`${match[3]}-${match[2]}-${match[1]}T${time}:00`);
  return Number.isNaN(value.getTime()) ? null : value.toISOString();
}

export async function refreshWeather(previous: LiveSnapshot): Promise<LiveSnapshot> {
  const results = await Promise.all(
    STATIONS.map(async ([endpoint, name, , latitude, longitude]) => {
      try {
        const response = await fetch(`https://prodapi.metweb.ie/observations/${endpoint}/today`, {
          cache: "no-store",
          signal: AbortSignal.timeout(7000)
        });
        if (!response.ok) return null;
        const rows = (await response.json()) as Array<Record<string, unknown>>;
        const latest = rows.at(-1);
        if (!latest) return null;
        const observedAt = timestamp(String(latest.date ?? ""), String(latest.reportTime ?? ""));
        const reading: StationReading = {
          id: endpoint,
          name,
          latitude,
          longitude,
          temperature: numeric(latest.temperature),
          rainfall: numeric(latest.rainfall),
          windSpeed: numeric(latest.windSpeed),
          windDirection: String(latest.cardinalWindDirection ?? "").trim(),
          description: String(latest.weatherDescription ?? "Observation available"),
          observedAt,
          fresh: observedAt ? Date.now() - new Date(observedAt).getTime() < 3 * 60 * 60 * 1000 : false
        };
        return {
          reading,
          history: rows.map((row) => ({
            time: String(row.reportTime ?? ""),
            temperature: numeric(row.temperature),
            rainfall: numeric(row.rainfall) ?? 0,
            windSpeed: numeric(row.windSpeed)
          }))
        };
      } catch {
        return null;
      }
    })
  );
  const valid = results.filter((result): result is NonNullable<typeof result> => result !== null);
  let fallbackStations: StationReading[] = [];
  if (valid.length < STATIONS.length) {
    try {
      const response = await fetch("https://www.met.ie/latest-reports/observations/download", {
        cache: "no-store",
        signal: AbortSignal.timeout(7000)
      });
      if (response.ok) {
        fallbackStations = parseLatestObservations(
          await response.text(),
          STATIONS.map(([id, name, csvName, latitude, longitude]) => ({
            id, name, csvName, latitude, longitude
          }))
        );
      }
    } catch {
      // Keep the previous snapshot if both official observation feeds are unavailable.
    }
  }
  if (!valid.length && !fallbackStations.length) return { ...previous, sourceStatus: "fallback" };
  const validIds = new Set(valid.map((result) => result.reading.id));
  const stations = [
    ...valid.map((result) => result.reading),
    ...fallbackStations.filter((station) => !validIds.has(station.id))
  ];
  const fresh = stations.filter((station) => station.fresh);
  const top = (field: "temperature" | "rainfall" | "windSpeed") =>
    [...fresh].filter((station) => station[field] !== null).sort((a, b) => (b[field] ?? -Infinity) - (a[field] ?? -Infinity))[0] ?? null;
  const buckets = new Map<string, { temp: number[]; rain: number; wind: number[] }>();
  valid.forEach(({ history }) => history.forEach((point) => {
    const bucket = buckets.get(point.time) ?? { temp: [], rain: 0, wind: [] };
    if (point.temperature !== null) bucket.temp.push(point.temperature);
    if (point.windSpeed !== null) bucket.wind.push(point.windSpeed);
    bucket.rain += point.rainfall;
    buckets.set(point.time, bucket);
  }));
  const now = Date.now();
  return {
    ...previous,
    generatedAt: new Date().toISOString(),
    sourceStatus: fresh.length >= 6 ? "live" : "partial",
    stations,
    warnings: previous.warnings.filter((warning) => new Date(warning.expiry).getTime() > now),
    marine: previous.marine.filter((buoy) => now - new Date(buoy.observedAt).getTime() < 6 * 60 * 60 * 1000),
    summary: {
      ...previous.summary,
      warmest: top("temperature"),
      wettest: top("rainfall"),
      windiest: top("windSpeed"),
      reporting: fresh.length
    },
    timeline: [...buckets].map(([time, values]) => ({
      time,
      temperature: values.temp.length ? values.temp.reduce((a, b) => a + b, 0) / values.temp.length : null,
      rainfall: values.rain,
      windSpeed: values.wind.length ? values.wind.reduce((a, b) => a + b, 0) / values.wind.length : null
    }))
  };
}

export async function refreshLivingLayers(previous: LiveSnapshot): Promise<LiveSnapshot> {
  try {
    const response = await fetchWithRetry("/api/living", 10_000);
    if (!response.ok) return previous;
    const next = (await response.json()) as Pick<LiveSnapshot, "trains" | "rivers"> & {
      generatedAt: string;
      sourceStatus?: {
        trains: "live" | "unavailable";
        rivers: "live" | "unavailable";
      };
    };
    if (!Array.isArray(next.trains) || !Array.isArray(next.rivers)) {
      return previous;
    }
    const now = Date.now();
    const trains = next.sourceStatus?.trains === "unavailable"
      ? previous.trains
      : addCalculatedSpeeds(next.trains, previous.trains, {
          maximumKmh: 200,
          maximumIntervalMinutes: 15
        });
    const rivers = (next.sourceStatus?.rivers === "unavailable" ? previous.rivers : next.rivers)
      .filter((river) => now - new Date(river.observedAt).getTime() < 3 * 60 * 60 * 1000);
    return {
      ...previous,
      trains,
      rivers,
      summary: {
        ...previous.summary,
        runningTrains: trains.filter((train) => train.status === "running").length,
        riverStations: rivers.length
      }
    };
  } catch {
    return previous;
  }
}

export async function refreshCurrentContexts(previous: LiveSnapshot): Promise<LiveSnapshot> {
  try {
    const response = await fetchWithRetry("/api/contexts", 15_000);
    const next = (response.ok ? await response.json() : {}) as Partial<
      Pick<
        LiveSnapshot,
        "marine" | "radar" | "grid" | "airQuality" | "aurora" | "tides" |
        "bathingAlerts" | "issTle" | "satellite" | "earthquakes" | "contextStatus"
      >
    >;
    const iss = next.issTle ? predictIss(next.issTle.line1, next.issTle.line2) : previous.iss;
    let airQuality = Array.isArray(next.airQuality) ? next.airQuality : previous.airQuality;
    let contextStatus = next.contextStatus && typeof next.contextStatus === "object"
      ? next.contextStatus
      : previous.contextStatus;
    if (
      window.location.hostname !== "127.0.0.1" &&
      window.location.hostname !== "localhost" &&
      !airQuality.some((reading) => reading.source === "measured")
    ) {
      const measured = await fetchMeasuredAirFallback();
      if (measured.length) {
        airQuality = [...measured, ...airQuality.filter((reading) => reading.source !== "measured")];
        contextStatus = { ...contextStatus, measuredAir: "live" };
      } else {
        const retainedMeasured = previous.airQuality.filter((reading) =>
          reading.source === "measured" &&
          Date.now() - new Date(reading.observedAt).getTime() < 6 * 60 * 60_000
        );
        airQuality = [...retainedMeasured, ...airQuality.filter((reading) => reading.source !== "measured")];
      }
    }
    const contextUnavailable = (name: keyof LiveSnapshot["contextStatus"]) =>
      contextStatus[name] === "unavailable";
    return {
      ...previous,
      marine: Array.isArray(next.marine) && next.marine.length ? next.marine : previous.marine,
      radar: Array.isArray(next.radar) && next.radar.length ? next.radar : previous.radar,
      grid: next.grid && typeof next.grid === "object" ? next.grid : previous.grid,
      airQuality,
      aurora: next.aurora && typeof next.aurora === "object" ? next.aurora : previous.aurora,
      tides: !contextUnavailable("tides") && Array.isArray(next.tides) ? next.tides : previous.tides,
      bathingAlerts: !contextUnavailable("bathing") && Array.isArray(next.bathingAlerts)
        ? next.bathingAlerts
        : previous.bathingAlerts,
      iss: contextUnavailable("iss") ? previous.iss : iss,
      issTle: !contextUnavailable("iss") && (next.issTle === null || typeof next.issTle === "object")
        ? next.issTle
        : previous.issTle,
      satellite: !contextUnavailable("satellite") && next.satellite && typeof next.satellite === "object"
        ? next.satellite
        : previous.satellite,
      earthquakes: !contextUnavailable("earthquakes") && Array.isArray(next.earthquakes)
        ? next.earthquakes
        : previous.earthquakes,
      contextStatus
    };
  } catch {
    return previous;
  }
}

export async function refreshTransit(previous: LiveSnapshot): Promise<LiveSnapshot> {
  try {
    const response = await fetchWithRetry("/api/transit", 15_000);
    if (!response.ok) return previous;
    const next = (await response.json()) as Partial<
      Pick<LiveSnapshot, "transit" | "transitStatus">
    >;
    const transitStatus = next.transitStatus ?? previous.transitStatus;
    if (transitStatus !== "live" || !Array.isArray(next.transit)) {
      return { ...previous, transitStatus };
    }
    return {
      ...previous,
      transit: addCalculatedSpeeds(next.transit, previous.transit, {
        maximumKmh: 130,
        maximumIntervalMinutes: 10
      }),
      transitStatus
    };
  } catch {
    return previous;
  }
}

const eeaTimestamp = (value: string) => {
  const match = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/.exec(value);
  return match ? `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}Z` : "";
};

const webMercatorToLonLat = (x: number, y: number) => ({
  longitude: x / 6378137 * 180 / Math.PI,
  latitude: (2 * Math.atan(Math.exp(y / 6378137)) - Math.PI / 2) * 180 / Math.PI
});

const measuredAqi = (reading: Pick<LiveSnapshot["airQuality"][number], "pm25" | "pm10" | "nitrogenDioxide" | "ozone">) => {
  const bands: Array<[number | null, number[]]> = [
    [reading.pm25, [10, 20, 25, 50, 75]],
    [reading.pm10, [20, 40, 50, 100, 150]],
    [reading.nitrogenDioxide, [40, 90, 120, 230, 340]],
    [reading.ozone, [50, 100, 130, 240, 380]]
  ];
  const scores = bands.flatMap(([value, thresholds]) => {
    if (value === null) return [];
    const index = thresholds.findIndex((threshold) => value <= threshold);
    return [index < 0 ? 110 : [10, 30, 50, 70, 90][index]];
  });
  return scores.length ? Math.max(...scores) : null;
};

async function fetchMeasuredAirFallback(): Promise<LiveSnapshot["airQuality"]> {
  try {
    const observed = new Date(Date.now() - 3 * 60 * 60 * 1000);
    const stamp = observed.toISOString().replace(/[-:T]/g, "").slice(0, 10) + "0000";
    const pollutants = [
      ["PM25", "pm25"], ["PM10", "pm10"], ["NO2", "nitrogenDioxide"], ["O3", "ozone"]
    ] as const;
    const results = await Promise.allSettled(pollutants.map(async ([pollutant, field]) => {
      const response = await fetch(
        `https://discomap.eea.europa.eu/Map/UTDViewerPRE/dataService/Hourly?polu=${pollutant}&dt=${stamp}`,
        { signal: AbortSignal.timeout(9000) }
      );
      if (!response.ok) throw new Error(String(response.status));
      return [field, await response.text()] as const;
    }));
    const stations = new Map<string, LiveSnapshot["airQuality"][number]>();
    for (const result of results) {
      if (result.status !== "fulfilled") continue;
      const [field, csv] = result.value;
      for (const line of csv.split(/\r?\n/).slice(1)) {
        if (!line.startsWith("SPO.IE.")) continue;
        const columns = line.split(",");
        const pollutantValue = numeric(columns[4]);
        const x = numeric(columns[11]);
        const y = numeric(columns[12]);
        if (pollutantValue === null || x === null || y === null) continue;
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
        current[field] = pollutantValue;
        stations.set(id, current);
      }
    }
    return [...stations.values()].map((station) => ({
      ...station,
      europeanAqi: measuredAqi(station)
    })).filter((station) =>
      station.latitude >= 51.2 && station.latitude <= 55.6 &&
      station.longitude >= -10.8 && station.longitude <= -5.2
    );
  } catch {
    return [];
  }
}

const compassDirection = (azimuth: number) => {
  const points = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
  return points[Math.round((azimuth * 180 / Math.PI) / 45) % 8];
};

function predictIss(line1: string, line2: string): LiveSnapshot["iss"] {
  try {
    const satrec = twoline2satrec(line1, line2);
    const observer = {
      longitude: -8 * Math.PI / 180,
      latitude: 53.4 * Math.PI / 180,
      height: .05
    };
    const now = new Date();
    const currentPosition = propagate(satrec, now)?.position;
    if (!currentPosition || typeof currentPosition === "boolean") return null;
    const currentGeo = eciToGeodetic(currentPosition, gstime(now));
    const passes: NonNullable<LiveSnapshot["iss"]>["passes"] = [];
    let active: { startsAt: Date; peaksAt: Date; maxElevation: number; azimuth: number } | null = null;
    for (let offset = 0; offset <= 48 * 60 * 60 * 1000; offset += 30_000) {
      const time = new Date(now.getTime() + offset);
      const position = propagate(satrec, time)?.position;
      if (!position || typeof position === "boolean") continue;
      const look = ecfToLookAngles(observer, eciToEcf(position, gstime(time)));
      const elevation = look.elevation * 180 / Math.PI;
      if (elevation >= 10) {
        if (!active) active = { startsAt: time, peaksAt: time, maxElevation: elevation, azimuth: look.azimuth };
        if (elevation > active.maxElevation) {
          active.maxElevation = elevation;
          active.peaksAt = time;
        }
      } else if (active) {
        const localHour = Number(new Intl.DateTimeFormat("en-IE", {
          hour: "2-digit", hour12: false, timeZone: "Europe/Dublin"
        }).format(active.peaksAt)) % 24;
        passes.push({
          startsAt: active.startsAt.toISOString(),
          peaksAt: active.peaksAt.toISOString(),
          endsAt: time.toISOString(),
          maxElevation: active.maxElevation,
          visible: localHour >= 21 || localHour < 6,
          direction: compassDirection(active.azimuth)
        });
        active = null;
        if (passes.length >= 5) break;
      }
    }
    return {
      observedAt: now.toISOString(),
      latitude: degreesLat(currentGeo.latitude),
      longitude: degreesLong(currentGeo.longitude),
      altitudeKm: currentGeo.height,
      passes
    };
  } catch {
    return null;
  }
}
