import type {
  LiveSnapshot,
  RiverReading,
  StationReading,
  TrafficCounter,
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
      .map((match) => {
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
          observedAt
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

async function fetchTraffic(): Promise<TrafficCounter[]> {
  try {
    const headers = {
      "content-type": "application/x-www-form-urlencoded",
      "x-requested-with": "XMLHttpRequest",
      "origin": "https://trafficdata.tii.ie",
      "referer": "https://trafficdata.tii.ie/publicmultinodemap.asp"
    };
    const sitesBody = new URLSearchParams();
    sitesBody.set("array", "0");
    sitesBody.set("hasLocation", "1");
    sitesBody.set("isPed", "0");
    ["id", "location", "name", "description", "parameters"].forEach((field) =>
      sitesBody.append("fields[]", field)
    );
    const aadtBody = new URLSearchParams({
      isSignedOff: "1",
      latestYear: "1",
      "siteCriteria[group]": "NRA"
    });
    const [sitesResponse, aadtResponse] = await Promise.all([
      fetch("https://trafficdata.tii.ie/dataserver/public/sites", {
        method: "POST",
        headers,
        body: sitesBody,
        next: { revalidate: 21_600 },
        signal: AbortSignal.timeout(9000)
      }),
      fetch("https://trafficdata.tii.ie/dataserver/public/aadt", {
        method: "POST",
        headers,
        body: aadtBody,
        next: { revalidate: 21_600 },
        signal: AbortSignal.timeout(9000)
      })
    ]);
    if (!sitesResponse.ok || !aadtResponse.ok) return [];
    const sites = (await sitesResponse.json()) as { data?: Record<string, Record<string, unknown>> };
    const aadts = (await aadtResponse.json()) as { data?: Record<string, number> };
    const counters = Object.values(sites.data ?? {}).flatMap((site) => {
      const location = site.location as { lat?: number; lng?: number } | undefined;
      const parameters = site.parameters as Record<string, string> | undefined;
      const averageDailyTraffic = aadts.data?.[String(site.id)];
      if (
        !location ||
        !Number.isFinite(location.lat) ||
        !Number.isFinite(location.lng) ||
        !Number.isFinite(averageDailyTraffic) ||
        parameters?.state === "4"
      ) return [];
      return [{
        id: String(site.id),
        name: String(site.name ?? "Traffic counter"),
        description: String(site.description ?? ""),
        latitude: location.lat as number,
        longitude: location.lng as number,
        averageDailyTraffic: averageDailyTraffic as number,
        category: String(parameters?.category ?? "National road")
      } satisfies TrafficCounter];
    });

    const cells = new Map<string, TrafficCounter>();
    for (const counter of counters) {
      const key = `${Math.round(counter.longitude * 5)}:${Math.round(counter.latitude * 6)}`;
      const current = cells.get(key);
      if (!current || counter.averageDailyTraffic > current.averageDailyTraffic) cells.set(key, counter);
    }
    return [...cells.values()]
      .sort((a, b) => b.averageDailyTraffic - a.averageDailyTraffic)
      .slice(0, 90);
  } catch {
    return [];
  }
}

export async function getLiveSnapshot(): Promise<LiveSnapshot> {
  const [stationResults, fallbackStations, warnings, marine, trains, rivers, traffic] = await Promise.all([
    Promise.all(STATIONS.map(fetchStation)),
    fetchLatestStationFallback(),
    fetchWarnings(),
    fetchMarine(),
    fetchTrains(),
    fetchRivers(),
    fetchTraffic()
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
    traffic,
    summary: {
      warmest: by("temperature"),
      wettest: by("rainfall"),
      windiest: by("windSpeed"),
      reporting: fresh.length,
      runningTrains: trains.filter((train) => train.status === "running").length,
      riverStations: rivers.length,
      busiestRoad: [...traffic].sort((a, b) => b.averageDailyTraffic - a.averageDailyTraffic)[0] ?? null
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
