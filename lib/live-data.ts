import type { LiveSnapshot, StationReading, WeatherWarning } from "./types";

const STATIONS = [
  { id: "malin-head", endpoint: "malin-head", name: "Malin Head", latitude: 55.371, longitude: -7.339 },
  { id: "finner", endpoint: "finner", name: "Finner", latitude: 54.494, longitude: -8.243 },
  { id: "belmullet", endpoint: "belmullet", name: "Belmullet", latitude: 54.228, longitude: -10.007 },
  { id: "athenry", endpoint: "athenry", name: "Athenry", latitude: 53.289, longitude: -8.786 },
  { id: "dublin-airport", endpoint: "dublin-airport", name: "Dublin", latitude: 53.428, longitude: -6.241 },
  { id: "gurteen", endpoint: "gurteen", name: "Gurteen", latitude: 53.034, longitude: -8.005 },
  { id: "valentia", endpoint: "valentia", name: "Valentia", latitude: 51.938, longitude: -10.241 },
  { id: "cork-airport", endpoint: "cork-airport", name: "Cork", latitude: 51.847, longitude: -8.486 },
  { id: "johnstown-castle", endpoint: "johnstown-castle", name: "Wexford", latitude: 52.298, longitude: -6.497 }
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

async function fetchMarine() {
  try {
    const since = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const query =
      `station_id,longitude,latitude,time,WindSpeed,WaveHeight,SeaTemperature` +
      `&time>=${since}T00:00:00Z&orderByMax("station_id,time")`;
    const response = await fetch(
      `https://erddap.marine.ie/erddap/tabledap/IWBNetwork.json?${encodeURI(query)}`,
      { next: { revalidate: 900 }, signal: AbortSignal.timeout(8000) }
    );
    if (!response.ok) return [];
    const body = (await response.json()) as { table?: { rows?: unknown[][] } };
    return (body.table?.rows ?? []).map((row) => ({
      id: String(row[0]),
      longitude: Number(row[1]),
      latitude: Number(row[2]),
      observedAt: String(row[3]),
      windSpeedKnots: numberOrNull(row[4]),
      waveHeight: numberOrNull(row[5]),
      seaTemperature: numberOrNull(row[6])
    }));
  } catch {
    return [];
  }
}

export async function getLiveSnapshot(): Promise<LiveSnapshot> {
  const [stationResults, warnings, marine] = await Promise.all([
    Promise.all(STATIONS.map(fetchStation)),
    fetchWarnings(),
    fetchMarine()
  ]);
  const results = stationResults.filter((value): value is StationResult => value !== null);
  const stations = results.map((result) => result.reading);
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
    summary: {
      warmest: by("temperature"),
      wettest: by("rainfall"),
      windiest: by("windSpeed"),
      reporting: fresh.length
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
