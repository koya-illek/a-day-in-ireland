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
    const response = await fetch("/api/living", {
      cache: "no-store",
      signal: AbortSignal.timeout(10_000)
    });
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
    const trains = next.sourceStatus?.trains === "unavailable" ? previous.trains : next.trains;
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
    const response = await fetch("/api/contexts", {
      cache: "no-store",
      signal: AbortSignal.timeout(15_000)
    });
    if (!response.ok) return previous;
    const next = (await response.json()) as Partial<
      Pick<
        LiveSnapshot,
        "marine" | "radar" | "grid" | "airQuality" | "aurora" | "tides" |
        "bathingAlerts" | "issTle" | "satellite" | "earthquakes" | "transit" | "transitStatus"
        | "contextStatus"
      >
    >;
    const iss = next.issTle ? predictIss(next.issTle.line1, next.issTle.line2) : previous.iss;
    return {
      ...previous,
      marine: Array.isArray(next.marine) ? next.marine : previous.marine,
      radar: Array.isArray(next.radar) ? next.radar : previous.radar,
      grid: next.grid === null || typeof next.grid === "object" ? next.grid : previous.grid,
      airQuality: Array.isArray(next.airQuality) ? next.airQuality : previous.airQuality,
      aurora: next.aurora === null || typeof next.aurora === "object" ? next.aurora : previous.aurora,
      tides: Array.isArray(next.tides) ? next.tides : previous.tides,
      bathingAlerts: Array.isArray(next.bathingAlerts) ? next.bathingAlerts : previous.bathingAlerts,
      iss,
      issTle: next.issTle === null || typeof next.issTle === "object" ? next.issTle : previous.issTle,
      satellite: next.satellite === null || typeof next.satellite === "object" ? next.satellite : previous.satellite,
      earthquakes: Array.isArray(next.earthquakes) ? next.earthquakes : previous.earthquakes,
      transit: Array.isArray(next.transit) ? next.transit : previous.transit,
      transitStatus: next.transitStatus ?? previous.transitStatus,
      contextStatus: next.contextStatus && typeof next.contextStatus === "object"
        ? next.contextStatus
        : previous.contextStatus
    };
  } catch {
    return previous;
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
