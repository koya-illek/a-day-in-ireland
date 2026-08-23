import type { LiveSnapshot, StationReading, WeatherWarning } from "./types";
import {
  parseEirGridLocalTimestamp,
  parseIrelandLocalTimestamp
} from "./latest-observations";
import {
  normalizeOfficialWeatherWarnings,
  normalizeRiverReadings
} from "../platform/river-source.js";
import {
  acceptClientForecast,
  acceptClientSolar
} from "../platform/sky-source.js";
import {
  addEstimatedSpeeds,
  MEASURED_AIR_POLLUTANTS,
  measuredAirStamp,
  measuredAirUrl,
  numeric,
  parseMeasuredAirStations
} from "../platform/live-normalize.js";
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

const DAY_MS = 24 * 60 * 60 * 1000;
let transitDestinationsPromise: Promise<Record<string, string>> | null = null;

const loadTransitDestinations = () => {
  if (!transitDestinationsPromise) {
    transitDestinationsPromise = fetch("/data/transit-destinations.manifest.json", { cache: "force-cache" })
      .then(async (manifestResponse) => {
        if (!manifestResponse.ok) throw new Error(`Transit destinations manifest returned ${manifestResponse.status}`);
        const manifest = await manifestResponse.json() as { assetPath?: string };
        const assetPath = typeof manifest.assetPath === "string" && manifest.assetPath.startsWith("/data/")
          ? manifest.assetPath
          : "/data/transit-destinations.json";
        const response = await fetch(assetPath, { cache: "force-cache" });
        if (!response.ok) throw new Error(`Transit destinations returned ${response.status}`);
        return response.json() as Promise<Record<string, string>>;
      })
      .catch((error) => {
        // Clear the memo so a later enrichment tick can retry instead of
        // caching this failure for the rest of the page.
        transitDestinationsPromise = null;
        throw error;
      });
  }
  return transitDestinationsPromise;
};

export async function enrichTransitDestinations<T extends { tripId?: string; destination?: string }>(vehicles: T[]): Promise<T[]> {
  if (!vehicles.some((vehicle) => vehicle.tripId && !vehicle.destination)) return vehicles;
  let destinations: Record<string, string> = {};
  try {
    destinations = await loadTransitDestinations();
  } catch {
    destinations = {};
  }
  return applyTransitDestinations(vehicles, destinations);
}

// Applies a resolved schedule dictionary onto whichever vehicle array is
// current. Enrichment is asynchronous: by the time it resolves, a newer poll
// may have replaced the captured array, so callers merge by trip id instead of
// committing stale positions.
export function applyTransitDestinations<T extends { tripId?: string; destination?: string }>(
  vehicles: T[],
  destinations: Record<string, string>
): T[] {
  return vehicles.map((vehicle) => ({
    ...vehicle,
    destination: vehicle.tripId && Object.hasOwn(destinations, vehicle.tripId)
      ? destinations[vehicle.tripId]
      : vehicle.destination
  }));
}

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
  return addEstimatedSpeeds(current, previous, { ...options, clearUnusable: true });
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
let nextProviderGeneration = 0;

const beginProviderRequest = (provider: ProviderName, previous: LiveSnapshot): ProviderRequest => {
  const prior = activeProviderRequests.get(provider);
  prior?.controller.abort();
  let resolveDone: (result: LiveSnapshot | undefined) => void = () => undefined;
  const done = new Promise<LiveSnapshot | undefined>((resolve) => {
    resolveDone = resolve;
  });
  const controller = new AbortController();
  // A module-scoped counter keeps generations unique even after a completed
  // request removes its tracking entry; reused numbers could let a slow
  // superseded request pass isCurrent() against the newer one.
  const request: ProviderRequest = {
    provider,
    previous,
    controller,
    signal: controller.signal,
    generation: ++nextProviderGeneration,
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
const hasExplicitTimeZone = (text: string) => /(?:z|[+-]\d{2}:?\d{2})$/i.test(text);
const normalizeGridTimestamp = (value: unknown): string | null => {
  const text = String(value ?? "").trim();
  if (!text) return null;
  const local = parseEirGridLocalTimestamp(text);
  if (local) return local;
  // Only strings carrying their own zone offset are unambiguous; anything
  // else would be interpreted in the viewer's timezone and mislabel the data.
  const parsed = hasExplicitTimeZone(text) ? Date.parse(text) : Number.NaN;
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
};

export const normalizeBrowserWarnings = (rows: unknown[], now = Date.now()): WeatherWarning[] =>
  normalizeOfficialWeatherWarnings(rows, now);

const BATHING_ALERT_MAXIMUM_WITHOUT_END_MS = 48 * 60 * 60 * 1000;

const normalizeBrowserBathingAlerts = (rows: unknown[], now = Date.now()): LiveSnapshot["bathingAlerts"] => rows.flatMap((item) => {
  if (!item || typeof item !== "object") return [];
  const alert = item as Record<string, unknown>;
  // Rows without an identity cannot merge or dedupe downstream, and rows
  // without an update time cannot age honestly.
  if (typeof alert.id !== "string" || !alert.id.trim()) return [];
  if (typeof alert.updatedAt !== "string" || !Number.isFinite(Date.parse(alert.updatedAt))) return [];
  // Defense in depth at the browser trust boundary: coordinates, display
  // strings and notice links are placed on the map verbatim once validated,
  // so they must be shape-checked here even though the Worker normalizes
  // them upstream.
  if (typeof alert.name !== "string" || typeof alert.restriction !== "string") return [];
  const latitude = Number(alert.latitude);
  const longitude = Number(alert.longitude);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return [];
  if (latitude < 51.2 || latitude > 55.6 || longitude < -10.8 || longitude > -5.2) return [];
  const noticeUrl = alert.noticeUrl;
  if (noticeUrl !== null && noticeUrl !== undefined && noticeUrl !== "" &&
    (typeof noticeUrl !== "string" || !noticeUrl.startsWith("https://"))) return [];
  const startedAt = Date.parse(String(alert.startedAt ?? ""));
  const endsAt = Date.parse(String(alert.endsAt ?? ""));
  // The server derives ends from the provider's expected duration; this
  // browser-side bound only stops a malformed end-less row living forever.
  const expiresAt = Number.isFinite(endsAt)
    ? endsAt
    : startedAt + BATHING_ALERT_MAXIMUM_WITHOUT_END_MS;
  return Number.isFinite(startedAt) && startedAt <= now && expiresAt > now
    ? [item as LiveSnapshot["bathingAlerts"][number]]
    : [];
});

/**
 * Merge bathing alerts by ID, keeping the version with the newer `updatedAt`
 * timestamp. This prevents a delayed upstream response (older observations)
 * from overwriting newer data already in the snapshot.
 */
const mergeBathingAlerts = (
  incoming: LiveSnapshot["bathingAlerts"],
  retained: LiveSnapshot["bathingAlerts"]
): LiveSnapshot["bathingAlerts"] => {
  const retainedByKey = new Map(retained.map((alert) => [alert.id, alert]));
  const result = new Map<string, LiveSnapshot["bathingAlerts"][number]>();
  for (const alert of incoming) {
    result.set(alert.id, alert);
  }
  for (const [id, alert] of retainedByKey) {
    const existing = result.get(id);
    if (!existing) {
      result.set(id, alert);
      continue;
    }
    const existingUpdated = Date.parse(existing.updatedAt ?? existing.startedAt ?? "");
    const retainedUpdated = Date.parse(alert.updatedAt ?? alert.startedAt ?? "");
    // Keep the newer observation; only replace if retained is strictly newer
    if (Number.isFinite(retainedUpdated) && (!Number.isFinite(existingUpdated) || retainedUpdated > existingUpdated)) {
      result.set(id, alert);
    }
  }
  return [...result.values()].sort((a, b) => a.id.localeCompare(b.id));
};

const isRecent = (value: string | null | undefined, maximumAgeMs: number, now = Date.now()) => {
  const timestamp = Date.parse(value ?? "");
  const age = now - timestamp;
  return Number.isFinite(timestamp) && age >= 0 && age < maximumAgeMs;
};

const latestSuccess = (previous: LiveSnapshot, candidate: string | null | undefined) => {
  const previousTimestamp = Date.parse(previous.lastSuccessAt ?? "");
  const candidateTimestamp = Date.parse(candidate ?? "");
  if (!Number.isFinite(candidateTimestamp)) return previous.lastSuccessAt ?? null;
  if (!Number.isFinite(previousTimestamp) || candidateTimestamp > previousTimestamp) {
    return new Date(candidateTimestamp).toISOString();
  }
  return previous.lastSuccessAt ?? null;
};

export const retainLastGoodWeather = (previous: LiveSnapshot, now = Date.now()): LiveSnapshot => {
  const stations = previous.stations.filter((station) => isRecent(station.observedAt, 6 * 60 * 60_000, now));
  if (!stations.length) {
    return {
      ...previous,
      generatedAt: new Date(now).toISOString(),
      sourceStatus: "unavailable",
      stations: [],
      summary: {
        ...previous.summary,
        warmest: null,
        wettest: null,
        windiest: null,
        reporting: 0
      },
      timeline: []
    };
  }
  const stationIds = new Set(stations.map((station) => station.id));
  const retained = (reading: StationReading | null) => reading && stationIds.has(reading.id) ? reading : null;
  return {
    ...previous,
    generatedAt: new Date(now).toISOString(),
    sourceStatus: "stale",
    stations,
    summary: {
      ...previous.summary,
      warmest: retained(previous.summary.warmest),
      wettest: retained(previous.summary.wettest),
      windiest: retained(previous.summary.windiest),
      reporting: stations.length
    }
  };
};

export async function refreshWeather(previous: LiveSnapshot): Promise<LiveSnapshot> {
  return runProviderRefresh("weather", previous, async (request) => {
    const captureNow = Date.now();
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
          const stationRows = rows.filter((row) => matchesWeatherStationIdentity(station, row.name))
            .map((row) => ({ row, observedAt: timestamp(String(row.date ?? ""), String(row.reportTime ?? ""), captureNow) }))
            .filter((item) => {
              const observed = Date.parse(item.observedAt ?? "");
              return Number.isFinite(observed) && observed <= captureNow;
            })
            .sort((first, second) => Date.parse(first.observedAt ?? "") - Date.parse(second.observedAt ?? ""));
          const latest = stationRows.at(-1);
          if (!latest) return null;
          const observedAt = latest.observedAt;
          const reading: StationReading = {
            id: station.id,
            name: station.name,
            latitude: station.latitude,
            longitude: station.longitude,
            temperature: numeric(latest.row.temperature),
            rainfall: numeric(latest.row.rainfall),
            windSpeed: numeric(latest.row.windSpeed),
            windDirection: String(latest.row.cardinalWindDirection ?? "").trim(),
            description: String(latest.row.weatherDescription ?? "Observation available"),
            observedAt,
            fresh: isWeatherObservationFresh(observedAt, captureNow)
          };
          return {
            reading,
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
      })
    );
    const valid = results.filter((result): result is NonNullable<typeof result> => result !== null);
    // No CSV fallback here: met.ie's bulk download carries no per-reading
    // timestamp, so its rows could never pass freshness honestly.
    if (!valid.length) return retainLastGoodWeather(previous);
    const stations = valid.map((result) => result.reading).filter((station) => station.fresh);
    const fresh = stations;
    if (!fresh.length) return retainLastGoodWeather(previous);
    const top = (field: "temperature" | "rainfall" | "windSpeed") =>
      [...fresh].filter((station) => station[field] !== null).sort((a, b) => (b[field] ?? -Infinity) - (a[field] ?? -Infinity))[0] ?? null;
    // The hourly chart intentionally aggregates every parsed station's recent
    // history (freshness gates the latest reading shown on the map, not the
    // within-window history a station already reported).
    const timeline = aggregateHourlyWeather(valid.map(({ history }) => history));
    const now = Date.now();
    const generatedAt = new Date().toISOString();
    return {
      ...previous,
      generatedAt,
      lastSuccessAt: latestSuccess(previous, generatedAt),
      // fresh.length > 0 is guaranteed by the early return above.
      sourceStatus: fresh.length >= 6 ? "live" : "partial",
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
  }, () => retainLastGoodWeather(previous));
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

const cachedProvenance = (
  previous: LiveSnapshot,
  provider: "trains" | "rivers",
  latestObservedAt: string | null,
  now: number
) => ({
  ...(previous.sourceProvenance?.[provider] ?? unavailableProvenance(previous, provider)),
  status: "stale" as const,
  fetchedAt: new Date(now).toISOString(),
  latestObservedAt,
  fallback: "Last successful browser snapshot"
});

export const retainLastGoodLiving = (previous: LiveSnapshot, now = Date.now()): LiveSnapshot => {
  const trains = previous.trains.filter((train) => isRecent(train.observedAt, 30 * 60_000, now));
  const rivers = normalizeRiverReadings(previous.rivers, now);
  const latest = <T extends { observedAt: string }>(items: T[]) => items
    .map((item) => item.observedAt)
    .sort((first, second) => Date.parse(first) - Date.parse(second))
    .at(-1) ?? null;
  return {
    ...previous,
    trains,
    rivers,
    sourceProvenance: {
      trains: trains.length
        ? cachedProvenance(previous, "trains", latest(trains), now)
        : unavailableProvenance(previous, "trains"),
      rivers: rivers.length
        ? cachedProvenance(previous, "rivers", latest(rivers), now)
        : unavailableProvenance(previous, "rivers")
    },
    summary: {
      ...previous.summary,
      runningTrains: trains.filter((train) => train.status === "running").length,
      riverStations: rivers.length
    }
  };
};

export const retainLastGoodContexts = (previous: LiveSnapshot, now = Date.now()): LiveSnapshot => {
  const marine = previous.marine.filter((reading) => isRecent(reading.observedAt, 6 * 60 * 60_000, now));
  const radar = previous.radar.filter((frame) => isRecent(frame.observedAt, 30 * 60_000, now));
  const grid = previous.grid && isRecent(previous.grid.observedAt, 30 * 60_000, now) ? previous.grid : null;
  const measuredAir = previous.airQuality.filter((reading) =>
    reading.source === "measured" && isRecent(reading.observedAt, 12 * 60 * 60_000, now)
  );
  const modelledAir = previous.airQuality.filter((reading) =>
    reading.source === "modelled" && isRecent(reading.observedAt, 12 * 60 * 60_000, now)
  );
  const aurora = previous.aurora && isRecent(previous.aurora.forecastAt, 2 * 60 * 60_000, now)
    ? previous.aurora
    : null;
  const tides = previous.tides.filter((reading) => isRecent(reading.observedAt, 3 * 60 * 60_000, now));
  const bathingAlerts = normalizeBrowserBathingAlerts(previous.bathingAlerts, now);
  const satellite = previous.satellite && isRecent(previous.satellite.observedAt, 30 * DAY_MS, now)
    ? previous.satellite
    : null;
  const earthquakes = previous.earthquakes.filter((reading) => isRecent(reading.observedAt, 7 * DAY_MS, now));
  const issTle = previous.issTle && isRecent(previous.issTle.observedAt, 24 * 60 * 60_000, now)
    ? previous.issTle
    : null;
  const warnings = normalizeBrowserWarnings(previous.warnings, now);
  const currentDublinDate = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Dublin", year: "numeric", month: "2-digit", day: "2-digit"
  }).format(new Date(now));
  const solar = previous.solar?.date === currentDublinDate ? previous.solar : null;
  const forecast = previous.forecast && isRecent(previous.forecast.issued, 36 * 60 * 60_000, now)
    ? previous.forecast
    : null;
  const staleOrUnavailable = (hasLastGood: boolean) => hasLastGood ? "stale" as const : "unavailable" as const;
  return {
    ...previous,
    warnings,
    marine,
    radar,
    grid,
    airQuality: [...measuredAir, ...modelledAir],
    aurora,
    tides,
    bathingAlerts,
    iss: issTle ? previous.iss : null,
    issTle,
    satellite,
    earthquakes,
    contextStatus: {
      marine: staleOrUnavailable(marine.length > 0),
      radar: staleOrUnavailable(radar.length > 0),
      grid: staleOrUnavailable(Boolean(grid)),
      measuredAir: staleOrUnavailable(measuredAir.length > 0),
      modelledAir: staleOrUnavailable(modelledAir.length > 0),
      aurora: staleOrUnavailable(Boolean(aurora)),
      tides: staleOrUnavailable(tides.length > 0),
      bathing: staleOrUnavailable(bathingAlerts.length > 0),
      satellite: staleOrUnavailable(Boolean(satellite)),
      earthquakes: staleOrUnavailable(earthquakes.length > 0),
      iss: staleOrUnavailable(Boolean(issTle && previous.iss)),
      warnings: staleOrUnavailable(warnings.length > 0),
      solar: staleOrUnavailable(Boolean(solar)),
      forecast: staleOrUnavailable(Boolean(forecast))
    },
    solar,
    forecast
  };
};

export async function refreshLivingLayers(previous: LiveSnapshot): Promise<LiveSnapshot> {
  return runProviderRefresh("living", previous, async (request) => {
    const response = await fetchWithRetry("/api/living", 10_000, request.signal);
    if (!response.ok) throw new Error(`Live layers returned ${response.status}`);
    const next = await response.json() as Partial<Pick<LiveSnapshot, "generatedAt" | "trains" | "rivers" | "sourceProvenance">> & {
      sourceStatus?: {
        trains?: "live" | "unavailable";
        rivers?: "live" | "partial" | "stale" | "fallback" | "unavailable";
      };
    };
    if (!Array.isArray(next.trains) || !Array.isArray(next.rivers)) throw new Error("Live layers response is incomplete");
    const retained = retainLastGoodLiving(previous);
    const trainsLive = next.sourceStatus?.trains !== "unavailable" && next.trains.length > 0;
    // Same freshness gate the transit path applies to parseable stamps: a
    // regression serving hour-old positions must not render as current.
    // Unparseable stamps stay visible because the UI can flag their time
    // as unavailable instead of silently hiding services.
    const incomingTrains = trainsLive
      ? addCalculatedSpeeds(
          next.trains.filter((train) => {
            const observedMs = Date.parse(train.observedAt);
            return !Number.isFinite(observedMs) || isRecent(train.observedAt, 30 * 60_000);
          }),
          previous.trains,
          {
            maximumKmh: 200,
            maximumIntervalMinutes: 15
          }
        )
      : [];
    const trains = incomingTrains.length ? incomingTrains : retained.trains;
    const riversStatus = next.sourceStatus?.rivers;
    const incomingRivers = riversStatus === "unavailable"
      ? []
      : normalizeRiverReadings(next.rivers, Date.now());
    const rivers = incomingRivers.length ? incomingRivers : retained.rivers;
    const refreshedAt = next.generatedAt ?? new Date().toISOString();
    const sourceProvenance = {
      trains: incomingTrains.length
        ? next.sourceProvenance?.trains ?? {
            ...unavailableProvenance(previous, "trains"),
            status: "live" as const,
            fetchedAt: refreshedAt,
            latestObservedAt: incomingTrains.map((train) => train.observedAt).sort().at(-1) ?? null
          }
        : retained.sourceProvenance!.trains,
      rivers: incomingRivers.length
        ? next.sourceProvenance?.rivers ?? {
            ...unavailableProvenance(previous, "rivers"),
            status: riversStatus === "fallback" ? "fallback" as const
              : riversStatus === "partial" ? "partial" as const
                : riversStatus === "stale" ? "stale" as const : "live" as const,
            fetchedAt: refreshedAt,
            latestObservedAt: incomingRivers.map((river) => river.observedAt).sort().at(-1) ?? null
          }
        : retained.sourceProvenance!.rivers
    };
    const hasProviderSuccess = incomingTrains.length > 0 ||
      (incomingRivers.length > 0 && riversStatus !== "stale");
    return {
      ...previous,
      trains,
      rivers,
      sourceProvenance,
      lastSuccessAt: hasProviderSuccess ? latestSuccess(previous, refreshedAt) : previous.lastSuccessAt,
      summary: {
        ...previous.summary,
        runningTrains: trains.filter((train) => train.status === "running").length,
        riverStations: rivers.length
      }
    };
  }, () => retainLastGoodLiving(previous));
}

export async function refreshCurrentContexts(previous: LiveSnapshot): Promise<LiveSnapshot> {
  return runProviderRefresh("contexts", previous, async (request) => {
    const response = await fetchWithRetry("/api/contexts", 15_000, request.signal);
    if (!response.ok) throw new Error(`Current contexts returned ${response.status}`);
    const next = await response.json() as Partial<Pick<
      LiveSnapshot,
      "generatedAt" | "marine" | "radar" | "grid" | "airQuality" | "aurora" | "tides" |
      "bathingAlerts" | "issTle" | "satellite" | "earthquakes" | "contextStatus" |
      "contextProvenance" | "solar" | "forecast"
    >> & {
      warnings?: unknown;
      warningsStatus?: LiveSnapshot["contextStatus"]["warnings"];
    };
    const now = Date.now();
    const retained = retainLastGoodContexts(previous, now);
    const statedStatus = next.contextStatus && typeof next.contextStatus === "object"
      ? next.contextStatus
      : {} as Partial<LiveSnapshot["contextStatus"]>;
    // Status inference only applies while the response carries a context
    // status map at all. If the whole field is missing (contract drift or a
    // pre-status cached edge response), inferring "live" from delivered
    // payloads would present unlabelled data as fully current; those sources
    // fall back to retained evidence instead.
    const statusMapPresent = Boolean(next.contextStatus && typeof next.contextStatus === "object");
    const statusFor = (
      name: keyof LiveSnapshot["contextStatus"],
      validPayload: boolean,
      inferWhenMissing = false
    ): LiveSnapshot["contextStatus"][typeof name] => {
      const status = statedStatus[name];
      if (validPayload && ["live", "partial", "fallback", "stale", "credential-required"].includes(status ?? "")) return status!;
      if (validPayload && status === undefined && inferWhenMissing && statusMapPresent) return "live";
      return "unavailable";
    };
    const incomingAirQuality = Array.isArray(next.airQuality) ? next.airQuality : [];
    let measuredAirStatus = statusFor(
      "measuredAir",
      incomingAirQuality.some((reading) => reading.source === "measured"),
      true
    );
    const modelledAirStatus = statusFor(
      "modelledAir",
      incomingAirQuality.some((reading) => reading.source === "modelled"),
      true
    );
    let incomingMeasuredAir = measuredAirStatus === "unavailable"
      ? []
      : incomingAirQuality.filter((reading) => reading.source === "measured");
    const incomingModelledAir = modelledAirStatus === "unavailable"
      ? []
      : incomingAirQuality.filter((reading) => reading.source === "modelled");
    if (
      window.location.hostname !== "127.0.0.1" &&
      window.location.hostname !== "localhost" &&
      !incomingMeasuredAir.length
    ) {
      const measured = await fetchMeasuredAirFallback(request.signal);
      if (measured.length) {
        incomingMeasuredAir = measured;
        measuredAirStatus = "fallback";
      }
    }
    const warningStatus: LiveSnapshot["contextStatus"]["warnings"] = Array.isArray(next.warnings) &&
      ["live", "partial", "fallback", "stale", "credential-required"].includes(next.warningsStatus ?? "")
      ? next.warningsStatus! : "unavailable";
    const incomingWarnings = warningStatus !== "unavailable" && warningStatus !== "credential-required"
      ? normalizeBrowserWarnings(next.warnings as unknown[], now)
      : [];
    const bathingStatus = statusFor("bathing", Array.isArray(next.bathingAlerts));
    const incomingBathingAlerts = bathingStatus === "unavailable" || !Array.isArray(next.bathingAlerts)
      ? []
      : normalizeBrowserBathingAlerts(next.bathingAlerts, now);
    const incomingGrid = next.grid && typeof next.grid === "object"
      ? { ...next.grid, observedAt: normalizeGridTimestamp(next.grid.observedAt) }
      : null;
    const incomingSolar = acceptClientSolar(next.solar, now);
    const incomingForecast = acceptClientForecast(next.forecast, now);
    const marineStatus = statusFor("marine", Array.isArray(next.marine));
    const radarStatus = statusFor("radar", Array.isArray(next.radar) && next.radar.length > 0, true);
    // A grid reading whose timestamp could not be normalized must not be
    // presented as live data with no observation time.
    const gridStatus = statusFor("grid", Boolean(incomingGrid && incomingGrid.observedAt), true);
    const auroraStatus = statusFor("aurora", Boolean(next.aurora && typeof next.aurora === "object"), true);
    const tidesStatus = statusFor("tides", Array.isArray(next.tides));
    const satelliteStatus = statusFor("satellite", Boolean(next.satellite && typeof next.satellite === "object"), true);
    const earthquakeStatus = statusFor("earthquakes", Array.isArray(next.earthquakes));
    const solarStatus = statusFor("solar", Boolean(incomingSolar), true);
    // Warnings and the national forecast are independent upstreams with their
    // own server-side state; a degraded warnings feed must not discard a
    // validated forecast.
    const forecastStatus = statusFor("forecast", Boolean(incomingForecast), true);
    const useIncoming = (status: LiveSnapshot["contextStatus"][keyof LiveSnapshot["contextStatus"]]) =>
      status !== "unavailable" && status !== "credential-required";
    // A delivered element set that fails local orbit propagation must not stay
    // labelled live with a null prediction; the propagation result decides
    // whether the ISS source stays usable in this response.
    const incomingIssPrediction = useIncoming(statusFor("iss", Boolean(next.issTle && typeof next.issTle === "object"))) && next.issTle
      ? predictIss(next.issTle.line1, next.issTle.line2)
      : null;
    const issStatus = incomingIssPrediction ? statusFor("iss", true) : "unavailable";
    const contextStatus: LiveSnapshot["contextStatus"] = {
      marine: useIncoming(marineStatus) ? marineStatus : retained.contextStatus.marine,
      radar: useIncoming(radarStatus) ? radarStatus : retained.contextStatus.radar,
      grid: useIncoming(gridStatus) ? gridStatus : retained.contextStatus.grid,
      measuredAir: useIncoming(measuredAirStatus) ? measuredAirStatus : retained.contextStatus.measuredAir,
      modelledAir: useIncoming(modelledAirStatus) ? modelledAirStatus : retained.contextStatus.modelledAir,
      aurora: useIncoming(auroraStatus) ? auroraStatus : retained.contextStatus.aurora,
      tides: useIncoming(tidesStatus) ? tidesStatus : retained.contextStatus.tides,
      bathing: useIncoming(bathingStatus) ? bathingStatus : retained.contextStatus.bathing,
      satellite: useIncoming(satelliteStatus) ? satelliteStatus : retained.contextStatus.satellite,
      earthquakes: useIncoming(earthquakeStatus) ? earthquakeStatus : retained.contextStatus.earthquakes,
      iss: useIncoming(issStatus) ? issStatus : retained.contextStatus.iss,
      warnings: useIncoming(warningStatus) ? warningStatus : retained.contextStatus.warnings,
      solar: useIncoming(solarStatus) ? solarStatus : retained.contextStatus.solar,
      forecast: useIncoming(forecastStatus) ? forecastStatus : retained.contextStatus.forecast
    };
    const refreshedAt = next.generatedAt ?? new Date(now).toISOString();
    const hasProviderSuccess = Object.values(contextStatus).some((status) => status === "live" || status === "fallback");
    return {
      ...previous,
      lastSuccessAt: hasProviderSuccess ? latestSuccess(previous, refreshedAt) : previous.lastSuccessAt,
      warnings: useIncoming(warningStatus) ? incomingWarnings : retained.warnings,
      marine: useIncoming(marineStatus) ? next.marine! : retained.marine,
      radar: useIncoming(radarStatus) ? next.radar! : retained.radar,
      grid: useIncoming(gridStatus) ? incomingGrid : retained.grid,
      airQuality: [
        ...(useIncoming(measuredAirStatus) ? incomingMeasuredAir : retained.airQuality.filter((reading) => reading.source === "measured")),
        ...(useIncoming(modelledAirStatus) ? incomingModelledAir : retained.airQuality.filter((reading) => reading.source === "modelled"))
      ],
      aurora: useIncoming(auroraStatus) ? next.aurora! : retained.aurora,
      tides: useIncoming(tidesStatus) ? next.tides! : retained.tides,
      // A fully live EPA response is authoritative, including its empty
      // all-clear state: merging retained ids back would resurrect lifted
      // advisories for up to two days. The merge-back only protects against
      // degraded tiers (partial/stale/fallback) where the provider list may
      // genuinely be incomplete.
      bathingAlerts: useIncoming(bathingStatus)
        ? bathingStatus === "live"
          ? incomingBathingAlerts
          : mergeBathingAlerts(incomingBathingAlerts, retained.bathingAlerts)
        : retained.bathingAlerts,
      iss: incomingIssPrediction ?? retained.iss,
      issTle: incomingIssPrediction && next.issTle ? next.issTle : retained.issTle,
      satellite: useIncoming(satelliteStatus) ? next.satellite! : retained.satellite,
      earthquakes: useIncoming(earthquakeStatus) ? next.earthquakes! : retained.earthquakes,
      solar: useIncoming(solarStatus) ? incomingSolar : retained.solar,
      forecast: useIncoming(forecastStatus) ? incomingForecast : retained.forecast,
      contextStatus,
      // A degraded response without a provenance map must not erase the
      // previous refresh's provenance; the retained metadata still truthfully
      // describes when that evidence was fetched.
      contextProvenance: next.contextProvenance ?? previous.contextProvenance
    };
  }, () => retainLastGoodContexts(previous));
}

export const retainLastGoodTransit = (previous: LiveSnapshot, now = Date.now()): LiveSnapshot => {
  const transit = previous.transit.filter((vehicle) => isRecent(vehicle.observedAt, 30 * 60_000, now));
  return {
    ...previous,
    transit,
    transitStatus: transit.length ? "stale" : "unavailable"
  };
};

export async function refreshTransit(previous: LiveSnapshot): Promise<LiveSnapshot> {
  return runProviderRefresh("transit", previous, async (request) => {
    const response = await fetchWithRetry("/api/transit", 15_000, request.signal);
    if (!response.ok) throw new Error(`Transit returned ${response.status}`);
    const next = await response.json() as Partial<Pick<LiveSnapshot, "generatedAt" | "transit" | "transitStatus">>;
    if ((next.transitStatus !== "live" && next.transitStatus !== "partial") || !Array.isArray(next.transit) || !next.transit.length) {
      const retained = retainLastGoodTransit(previous);
      return retained.transit.length
        ? retained
        : {
            ...retained,
            transitStatus: next.transitStatus === "credential-required" ? "credential-required" : "unavailable"
          };
    }
    const previousDestinations = new Map(previous.transit
      .filter((vehicle) => vehicle.tripId && vehicle.destination)
      .map((vehicle) => [vehicle.tripId!, vehicle.destination!]));
    const transit = next.transit.filter((vehicle) => {
      const observedAt = Date.parse(vehicle.observedAt);
      const age = Date.now() - observedAt;
      return Number.isFinite(observedAt) && age >= 0 && age < 30 * 60_000;
    }).map((vehicle) => ({
      ...vehicle,
      destination: vehicle.tripId ? previousDestinations.get(vehicle.tripId) : undefined
    }));
    if (!transit.length) return retainLastGoodTransit(previous);
    const refreshedAt = next.generatedAt ?? new Date().toISOString();
    return {
      ...previous,
      transit: addCalculatedSpeeds(transit, previous.transit, {
        maximumKmh: 130,
        maximumIntervalMinutes: 10
      }),
      transitStatus: next.transitStatus,
      lastSuccessAt: latestSuccess(previous, refreshedAt)
    };
  }, () => retainLastGoodTransit(previous));
}

async function fetchMeasuredAirFallback(parentSignal?: AbortSignal): Promise<LiveSnapshot["airQuality"]> {
  try {
    const signal = parentSignal ?? new AbortController().signal;
    const stamp = measuredAirStamp();
    const results = await Promise.allSettled(MEASURED_AIR_POLLUTANTS.map(async ([pollutant, field]) => {
      const response = await fetchWithTimeout(
        measuredAirUrl(pollutant, stamp),
        {},
        9_000,
        signal
      );
      if (!response.ok) throw new Error(String(response.status));
      return [field, await response.text()] as const;
    }));
    const responses = results.flatMap((result) => result.status === "fulfilled" ? [result.value] : []);
    return parseMeasuredAirStations(responses);
  } catch {
    return [];
  }
}

const compassDirection = (azimuth: number) => {
  const points = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
  return points[Math.round((azimuth * 180 / Math.PI) / 45) % 8];
};

type IssPassList = NonNullable<LiveSnapshot["iss"]>["passes"];

const issDublinHourFormatter = new Intl.DateTimeFormat("en-IE", {
  hour: "2-digit", hour12: false, timeZone: "Europe/Dublin"
});

let issPassScan: { key: string; scannedAtMs: number; passes: IssPassList } | null = null;

const scanIssPasses = (
  satrec: ReturnType<typeof twoline2satrec>,
  observer: { longitude: number; latitude: number; height: number },
  from: Date
): IssPassList => {
  const passes: IssPassList = [];
  let active: { startsAt: Date; peaksAt: Date; maxElevation: number; azimuth: number } | null = null;
  for (let offset = 0; offset <= 48 * 60 * 60 * 1000; offset += 30_000) {
    const time = new Date(from.getTime() + offset);
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
      const localHour = Number(issDublinHourFormatter.format(active.peaksAt)) % 24;
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
  return passes;
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
    // Pass windows depend only on the element set, so run the 48-hour scan once
    // per TLE and keep serving it until every listed pass has ended.
    const key = `${line1}\n${line2}`;
    const scanUsable = issPassScan &&
      issPassScan.key === key &&
      now.getTime() - issPassScan.scannedAtMs < 24 * 60 * 60_000 &&
      issPassScan.passes.some((pass) => Date.parse(pass.endsAt) > now.getTime());
    if (!scanUsable) {
      issPassScan = { key, scannedAtMs: now.getTime(), passes: scanIssPasses(satrec, observer, now) };
    }
    return {
      observedAt: now.toISOString(),
      latitude: degreesLat(currentGeo.latitude),
      longitude: degreesLong(currentGeo.longitude),
      altitudeKm: currentGeo.height,
      passes: issPassScan!.passes.filter((pass) => Date.parse(pass.endsAt) > now.getTime())
    };
  } catch {
    return null;
  }
}
