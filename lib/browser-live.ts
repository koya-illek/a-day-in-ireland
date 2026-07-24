import type { LiveSnapshot, StationReading } from "./types";

const STATIONS = [
  ["malin-head", "Malin Head", 55.371, -7.339],
  ["finner", "Finner", 54.494, -8.243],
  ["belmullet", "Belmullet", 54.228, -10.007],
  ["athenry", "Athenry", 53.289, -8.786],
  ["dublin-airport", "Dublin", 53.428, -6.241],
  ["gurteen", "Gurteen", 53.034, -8.005],
  ["valentia", "Valentia", 51.938, -10.241],
  ["cork-airport", "Cork", 51.847, -8.486],
  ["johnstown-castle", "Wexford", 52.298, -6.497]
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
    STATIONS.map(async ([endpoint, name, latitude, longitude]) => {
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
  if (!valid.length) return { ...previous, sourceStatus: "fallback" };
  const stations = valid.map((result) => result.reading);
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
    marine: previous.marine.filter((buoy) => now - new Date(buoy.observedAt).getTime() < 3 * 60 * 60 * 1000),
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
    const next = (await response.json()) as Pick<LiveSnapshot, "trains" | "rivers" | "traffic"> & {
      generatedAt: string;
    };
    if (!Array.isArray(next.trains) || !Array.isArray(next.rivers) || !Array.isArray(next.traffic)) {
      return previous;
    }
    return {
      ...previous,
      trains: next.trains,
      rivers: next.rivers,
      traffic: next.traffic,
      summary: {
        ...previous.summary,
        runningTrains: next.trains.filter((train) => train.status === "running").length,
        riverStations: next.rivers.filter((river) => river.fresh).length,
        busiestRoad: [...next.traffic].sort(
          (a, b) => b.averageDailyTraffic - a.averageDailyTraffic
        )[0] ?? null
      }
    };
  } catch {
    return previous;
  }
}
