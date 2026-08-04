import type { LiveSnapshot, StationReading, WeatherWarning } from "./types";
import {
  parseEirGridLocalTimestamp,
  parseIrelandLocalTimestamp,
  parseLatestObservations
} from "./latest-observations";
import {
  normalizeOfficialWeatherWarnings,
  normalizeRiverReadings
} from "../platform/river-source.js";
import { isWeatherObservationFresh, matchesWeatherStationIdentity, WEATHER_STATIONS } from "./weather-stations";
import { aggregateHourlyWeather } from "./weather-timeline.js";
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

type ProviderName = "weather" | "living" | "contexts" | "transit";

type ProviderRequest = {
  provider: ProviderName;
  previous: LiveSnapshot;
  controller: AbortController;
  signal: AbortSignal;
  generation: number;
  done: Promise<LiveSnapshot | undefined>;
  isCurrent: () => boolean;
  complete: (result: LiveSnapshot | undefined) => void;
};

const activeProviderRequests = new Map<ProviderName, ProviderRequest>();
const lastProviderResults = new Map<ProviderName, LiveSnapshot>();

const beginProviderRequest = (provider: ProviderName, previous: LiveSnapshot): ProviderRequest => {
  const prior = activeProviderRequests.get(provider);
  prior?.controller.abort();
  let resolveDone: (result: LiveSnapshot | undefined) => void = () => undefined;
  const done = new Promise<LiveSnapshot | undefined>((resolve) => {
    resolveDone = resolve;
  });
  const controller = new AbortController();
  const request: ProviderRequest = {
    provider,
    previous,
    controller,
    signal: controller.signal,
    generation: (prior?.generation ?? 0) + 1,
    done,
    isCurrent: () => activeProviderRequests.get(provider)?.generation === request.generation,
    complete: (result: LiveSnapshot | undefined) => {
      if (result) lastProviderResults.set(provider, result);
      resolveDone(result);
      if (activeProviderRequests.get(provider)?.generation === request.generation) {
        activeProviderRequests.delete(provider);
      }
    }
  };
  activeProviderRequests.set(provider, request);
  return request;
};

const latestProviderResult = async (request: ProviderRequest): Promise<LiveSnapshot> => {
  let current = activeProviderRequests.get(request.provider);
  while (current && current.generation !== request.generation) {
    const result = await current.done;
    const newer = activeProviderRequests.get(request.provider);
    if (!newer || newer.generation === request.generation) {
      return result ?? lastProviderResults.get(request.provider) ?? request.previous;
    }
    current = newer;
  }
  return lastProviderResults.get(request.provider) ?? request.previous;
};

const runProviderRefresh = async (
  provider: ProviderName,
  previous: LiveSnapshot,
  operation: (request: ProviderRequest) => Promise<LiveSnapshot>,
  fallback: () => LiveSnapshot
): Promise<LiveSnapshot> => {
  const request = beginProviderRequest(provider, previous);
  let result: LiveSnapshot | undefined;
  try {
    const next = await operation(request);
    if (!request.isCurrent()) return await latestProviderResult(request);
    result = next;
    return next;
  } catch {
    if (!request.isCurrent()) return await latestProviderResult(request);
    result = fallback();
    return result;
  } finally {
    request.complete(result);
  }
};

const fetchWithTimeout = async (
  url: string,
  init: RequestInit,
  timeoutMs: number,
  parentSignal: AbortSignal
) => {
  const controller = new AbortController();
  const abort = () => controller.abort();
  const timeout = window.setTimeout(abort, timeoutMs);
  parentSignal.addEventListener("abort", abort, { once: true });
  if (parentSignal.aborted) controller.abort();
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    window.clearTimeout(timeout);
    parentSignal.removeEventListener("abort", abort);
  }
};

const pause = (milliseconds: number, signal: AbortSignal) => new Promise<void>((resolve, reject) => {
  const abort = () => {
    window.clearTimeout(timeout);
    signal.removeEventListener("abort", abort);
    reject(new DOMException("Refresh superseded", "AbortError"));
  };
  const timeout = window.setTimeout(() => {
    signal.removeEventListener("abort", abort);
    resolve();
  }, milliseconds);
  if (signal.aborted) abort();
  else signal.addEventListener("abort", abort, { once: true });
});

const fetchWithRetry = async (url: string, timeoutMs: number, signal: AbortSignal) => {
  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const response = await fetchWithTimeout(url, {
        cache: "no-store",
      }, timeoutMs + attempt * 5_000, signal);
      if (response.ok || response.status < 500) return response;
      lastError = new Error(`${url} returned ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    if (attempt === 0) await pause(600, signal);
  }
  throw lastError instanceof Error ? lastError : new Error(`${url} could not be refreshed`);
};

const timestamp = parseIrelandLocalTimestamp;
const normalizeGridTimestamp = (value: unknown): string | null => {
  const text = String(value ?? "").trim();
  if (!text) return null;
  const local = parseEirGridLocalTimestamp(text);
  if (local) return local;
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
};

export const normalizeBrowserWarnings = (rows: unknown[], now = Date.now()): WeatherWarning[] =>
  normalizeOfficialWeatherWarnings(rows, now);

const normalizeBrowserBathingAlerts = (rows: unknown[], now = Date.now()): LiveSnapshot["bathingAlerts"] => rows.flatMap((item) => {
  if (!item || typeof item !== "object") return [];
  const alert = item as Record<string, unknown>;
  const startedAt = Date.parse(String(alert.startedAt ?? ""));
  const endsAt = Date.parse(String(alert.endsAt ?? ""));
  return Number.isFinite(startedAt) && startedAt <= now && (!Number.isFinite(endsAt) || endsAt > now)
    ? [item as LiveSnapshot["bathingAlerts"][number]]
    : [];
});

const emptyWeatherSnapshot = (previous: LiveSnapshot): LiveSnapshot => ({
  ...previous,
  generatedAt: new Date().toISOString(),
  sourceStatus: "fallback",
  stations: [],
  summary: {
    ...previous.summary,
    warmest: null,
    wettest: null,
    windiest: null,
    reporting: 0
  },
  timeline: []
});

export async function refreshWeather(previous: LiveSnapshot): Promise<LiveSnapshot> {
  return runProviderRefresh("weather", previous, async (request) => {
    const results = await Promise.all(
      WEATHER_STATIONS.map(async (station) => {
        try {
          const response = await fetchWithTimeout(
            `https://prodapi.metweb.ie/observations/${station.endpoint}/today`,
            { cache: "no-store" },
            7_000,
            request.signal
          );
          if (!response.ok) return null;
          const rows = (await response.json()) as Array<Record<string, unknown>>;
          const stationRows = rows.filter((row) => matchesWeatherStationIdentity(station, row.name));
          const latest = stationRows.at(-1);
          if (!latest) return null;
          const observedAt = timestamp(String(latest.date ?? ""), String(latest.reportTime ?? ""));
          const reading: StationReading = {
            id: station.id,
            name: station.name,
            latitude: station.latitude,
            longitude: station.longitude,
            temperature: numeric(latest.temperature),
            rainfall: numeric(latest.rainfall),
            windSpeed: numeric(latest.windSpeed),
            windDirection: String(latest.cardinalWindDirection ?? "").trim(),
            description: String(latest.weatherDescription ?? "Observation available"),
            observedAt,
            fresh: isWeatherObservationFresh(observedAt)
          };
          return {
            reading,
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
      })
    );
    const valid = results.filter((result): result is NonNullable<typeof result> => result !== null);
    let fallbackStations: StationReading[] = [];
    if (valid.length < WEATHER_STATIONS.length) {
      try {
        const response = await fetchWithTimeout(
          "https://www.met.ie/latest-reports/observations/download",
          { cache: "no-store" },
          7_000,
          request.signal
        );
        if (response.ok) {
          fallbackStations = parseLatestObservations(
            await response.text(),
            WEATHER_STATIONS
          );
        }
      } catch {
        // The fallback has no source timestamp, so it cannot keep old data live.
      }
    }
    if (!valid.length && !fallbackStations.length) return emptyWeatherSnapshot(previous);
    const validIds = new Set(valid.map((result) => result.reading.id));
    const stationCandidates = [
      ...valid.map((result) => result.reading),
      ...fallbackStations.filter((station) => !validIds.has(station.id))
    ];
    const stations = stationCandidates.filter((station) => station.fresh);
    const fresh = stations;
    const top = (field: "temperature" | "rainfall" | "windSpeed") =>
      [...fresh].filter((station) => station[field] !== null).sort((a, b) => (b[field] ?? -Infinity) - (a[field] ?? -Infinity))[0] ?? null;
    const timeline = aggregateHourlyWeather(valid.map(({ history }) => history));
    const now = Date.now();
    return {
      ...previous,
      generatedAt: new Date().toISOString(),
      sourceStatus: fresh.length >= 6 ? "live" : fresh.length > 0 ? "partial" : "fallback",
      stations,
      marine: previous.marine.filter((buoy) => {
        const timestamp = new Date(buoy.observedAt).getTime();
        return Number.isFinite(timestamp) && now - timestamp >= 0 && now - timestamp < 6 * 60 * 60 * 1000;
      }),
      summary: {
        ...previous.summary,
        warmest: top("temperature"),
        wettest: top("rainfall"),
        windiest: top("windSpeed"),
        reporting: fresh.length
      },
      timeline
    };
  }, () => emptyWeatherSnapshot(previous));
}

const unavailableProvenance = (previous: LiveSnapshot, provider: "trains" | "rivers") => ({
  ...(previous.sourceProvenance?.[provider] ?? {
    provider: provider === "trains" ? "Irish Rail" : "OPW waterlevel.ie",
    endpoint: provider === "trains"
      ? "https://api.irishrail.ie/realtime/realtime.asmx/getCurrentTrainsXML"
      : "https://waterlevel.ie/geojson/latest/",
    fetchedAt: new Date().toISOString(),
    latestObservedAt: null,
    fallback: null
  }),
  status: "unavailable" as const,
  fetchedAt: new Date().toISOString(),
  latestObservedAt: null,
  fallback: null
});

const emptyLivingSnapshot = (previous: LiveSnapshot): LiveSnapshot => ({
  ...previous,
  trains: [],
  rivers: [],
  sourceProvenance: {
    trains: unavailableProvenance(previous, "trains"),
    rivers: unavailableProvenance(previous, "rivers")
  },
  summary: {
    ...previous.summary,
    runningTrains: 0,
    riverStations: 0
  }
});

const emptyContextStatus = (): LiveSnapshot["contextStatus"] => ({
  marine: "unavailable",
  measuredAir: "unavailable",
  tides: "unavailable",
  bathing: "unavailable",
  satellite: "unavailable",
  earthquakes: "unavailable",
  iss: "unavailable",
  warnings: "unavailable"
});

const emptyContextsSnapshot = (previous: LiveSnapshot): LiveSnapshot => ({
  ...previous,
  warnings: [],
  marine: [],
  radar: [],
  grid: null,
  airQuality: [],
  aurora: null,
  tides: [],
  bathingAlerts: [],
  iss: null,
  issTle: null,
  satellite: null,
  earthquakes: [],
  contextStatus: emptyContextStatus()
});

export async function refreshLivingLayers(previous: LiveSnapshot): Promise<LiveSnapshot> {
  return runProviderRefresh("living", previous, async (request) => {
    const response = await fetchWithRetry("/api/living", 10_000, request.signal);
    if (!response.ok) throw new Error(`Live layers returned ${response.status}`);
    const next = await response.json() as Partial<Pick<LiveSnapshot, "trains" | "rivers" | "sourceProvenance">> & {
      sourceStatus?: {
        trains?: "live" | "unavailable";
        rivers?: "live" | "stale" | "fallback" | "unavailable";
      };
    };
    if (!Array.isArray(next.trains) || !Array.isArray(next.rivers)) throw new Error("Live layers response is incomplete");
    const trainsLive = next.sourceStatus?.trains !== "unavailable" && next.trains.length > 0;
    const trains = trainsLive
      ? addCalculatedSpeeds(next.trains, previous.trains, {
          maximumKmh: 200,
          maximumIntervalMinutes: 15
        })
      : [];
    const riversStatus = next.sourceStatus?.rivers;
    const rivers = riversStatus === "unavailable"
      ? []
      : normalizeRiverReadings(next.rivers, Date.now());
    const sourceProvenance = next.sourceProvenance
      ? {
          ...next.sourceProvenance,
          trains: trains.length ? next.sourceProvenance.trains ?? unavailableProvenance(previous, "trains") : unavailableProvenance(previous, "trains"),
          rivers: rivers.length ? next.sourceProvenance.rivers ?? unavailableProvenance(previous, "rivers") : unavailableProvenance(previous, "rivers")
        }
      : {
          trains: trains.length ? previous.sourceProvenance?.trains ?? unavailableProvenance(previous, "trains") : unavailableProvenance(previous, "trains"),
          rivers: rivers.length ? previous.sourceProvenance?.rivers ?? unavailableProvenance(previous, "rivers") : unavailableProvenance(previous, "rivers")
        };
    return {
      ...previous,
      trains,
      rivers,
      sourceProvenance,
      summary: {
        ...previous.summary,
        runningTrains: trains.filter((train) => train.status === "running").length,
        riverStations: rivers.length
      }
    };
  }, () => emptyLivingSnapshot(previous));
}

export async function refreshCurrentContexts(previous: LiveSnapshot): Promise<LiveSnapshot> {
  return runProviderRefresh("contexts", previous, async (request) => {
    const response = await fetchWithRetry("/api/contexts", 15_000, request.signal);
    if (!response.ok) throw new Error(`Current contexts returned ${response.status}`);
    const next = await response.json() as Partial<Pick<
      LiveSnapshot,
      "marine" | "radar" | "grid" | "airQuality" | "aurora" | "tides" |
      "bathingAlerts" | "issTle" | "satellite" | "earthquakes" | "contextStatus"
    >> & {
      warnings?: unknown;
      warningsStatus?: "live" | "unavailable";
    };
    const contextStatus: LiveSnapshot["contextStatus"] = {
      ...previous.contextStatus,
      ...(next.contextStatus && typeof next.contextStatus === "object" ? next.contextStatus : {})
    };
    const contextUnavailable = (name: keyof LiveSnapshot["contextStatus"]) => contextStatus[name] === "unavailable";
    const now = Date.now();
    let airQuality = contextUnavailable("measuredAir")
      ? (Array.isArray(next.airQuality) ? next.airQuality.filter((reading) => reading.source !== "measured") : [])
      : (Array.isArray(next.airQuality) ? next.airQuality : []);
    if (
      window.location.hostname !== "127.0.0.1" &&
      window.location.hostname !== "localhost" &&
      !airQuality.some((reading) => reading.source === "measured")
    ) {
      const measured = await fetchMeasuredAirFallback(request.signal);
      if (measured.length) {
        airQuality = [...measured, ...airQuality.filter((reading) => reading.source !== "measured")];
        contextStatus.measuredAir = "fallback";
      }
    }
    const warningStatus = next.warningsStatus === "unavailable" || !Array.isArray(next.warnings) ? "unavailable" : "live";
    const warnings = warningStatus === "live"
      ? normalizeBrowserWarnings(next.warnings as unknown[], now)
      : [];
    contextStatus.warnings = warningStatus;
    const bathingAlerts = contextUnavailable("bathing") || !Array.isArray(next.bathingAlerts)
      ? []
      : normalizeBrowserBathingAlerts(next.bathingAlerts, now);
    const grid = next.grid && typeof next.grid === "object"
      ? { ...next.grid, observedAt: normalizeGridTimestamp(next.grid.observedAt) }
      : null;
    return {
      ...previous,
      warnings,
      marine: Array.isArray(next.marine) ? next.marine : [],
      radar: Array.isArray(next.radar) ? next.radar : [],
      grid,
      airQuality,
      aurora: next.aurora && typeof next.aurora === "object" ? next.aurora : null,
      tides: contextUnavailable("tides") || !Array.isArray(next.tides) ? [] : next.tides,
      bathingAlerts,
      iss: contextUnavailable("iss") || !next.issTle ? null : predictIss(next.issTle.line1, next.issTle.line2),
      issTle: contextUnavailable("iss") || !(next.issTle === null || typeof next.issTle === "object") ? null : next.issTle,
      satellite: contextUnavailable("satellite") || !next.satellite || typeof next.satellite !== "object" ? null : next.satellite,
      earthquakes: contextUnavailable("earthquakes") || !Array.isArray(next.earthquakes) ? [] : next.earthquakes,
      contextStatus
    };
  }, () => emptyContextsSnapshot(previous));
}

export async function refreshTransit(previous: LiveSnapshot): Promise<LiveSnapshot> {
  return runProviderRefresh("transit", previous, async (request) => {
    const response = await fetchWithRetry("/api/transit", 15_000, request.signal);
    if (!response.ok) throw new Error(`Transit returned ${response.status}`);
    const next = await response.json() as Partial<Pick<LiveSnapshot, "transit" | "transitStatus">>;
    if (next.transitStatus !== "live" || !Array.isArray(next.transit) || !next.transit.length) {
      return { ...previous, transit: [], transitStatus: next.transitStatus === "credential-required" ? "credential-required" : "unavailable" };
    }
    const transit = next.transit.filter((vehicle) => {
      const observedAt = Date.parse(vehicle.observedAt);
      const age = Date.now() - observedAt;
      return Number.isFinite(observedAt) && age >= 0 && age < 30 * 60_000;
    });
    if (!transit.length) return { ...previous, transit: [], transitStatus: "unavailable" };
    return {
      ...previous,
      transit: addCalculatedSpeeds(transit, previous.transit, {
        maximumKmh: 130,
        maximumIntervalMinutes: 10
      }),
      transitStatus: "live"
    };
  }, () => ({ ...previous, transit: [], transitStatus: "unavailable" }));
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

async function fetchMeasuredAirFallback(parentSignal?: AbortSignal): Promise<LiveSnapshot["airQuality"]> {
  try {
    const signal = parentSignal ?? new AbortController().signal;
    const observed = new Date(Date.now() - 3 * 60 * 60 * 1000);
    const stamp = observed.toISOString().replace(/[-:T]/g, "").slice(0, 10) + "0000";
    const pollutants = [
      ["PM25", "pm25"], ["PM10", "pm10"], ["NO2", "nitrogenDioxide"], ["O3", "ozone"]
    ] as const;
    const results = await Promise.allSettled(pollutants.map(async ([pollutant, field]) => {
      const response = await fetchWithTimeout(
        `https://discomap.eea.europa.eu/Map/UTDViewerPRE/dataService/Hourly?polu=${pollutant}&dt=${stamp}`,
        {},
        9_000,
        signal
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
