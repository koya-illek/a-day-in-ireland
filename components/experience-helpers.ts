"use client";

import { geoMercator } from "d3-geo";
import type { LiveSnapshot, TrainPosition } from "../lib/types";
import { getActivityGuidance } from "../lib/activity-guidance";
import { WEATHER_OBSERVATION_MAX_AGE_MS } from "../lib/weather-stations";
import { type HistoryGap } from "../lib/history";
import {
  type ContextFocus,
  type NearbyReading,
  type Place,
  type ExperienceSection
} from "./experience-model";
import { type ProjectedPoint } from "../lib/map-density";

export const compareStableIds = (first: string, second: string) =>
  first < second ? -1 : first > second ? 1 : 0;

// Context panels keep rendering retained values when a source degrades to
// stale; only true absence withholds data. The panels word the caveat.
export const retainedContextStatuses: ReadonlySet<LiveSnapshot["contextStatus"][keyof LiveSnapshot["contextStatus"]]> = new Set(["live", "partial", "fallback", "stale"]);

export const latestObservedTimestamp = (items: Array<{ observedAt: string | null }>) => items.length
  ? items.reduce((latest, item) => {
      const ts = Date.parse(item.observedAt ?? "");
      return Number.isFinite(ts) && ts > latest ? ts : latest;
    }, 0)
  : 0;

export type MovementRecord = TrainPosition | LiveSnapshot["transit"][number];

export const stablePayloadValue = (value: unknown) => {
  if (typeof value === "number") {
    if (Number.isNaN(value)) return "number:NaN";
    if (Object.is(value, -0)) return "number:-0";
  }
  return `${typeof value}:${String(value)}`;
};

export function stableMovementPayload(item: MovementRecord) {
  const fields = "route" in item
    ? [
        "transit", item.id, item.latitude, item.longitude, item.route, item.label,
        item.bearing, item.speedKmh, item.speedSource, item.observedAt
      ]
    : [
        "train", item.id, item.latitude, item.longitude, item.status, item.direction,
        item.message, item.observedAt, item.speedKmh, item.speedSource
      ];
  return JSON.stringify(fields.map(stablePayloadValue));
}

export function preferMovementRecord<T extends MovementRecord>(first: T, second: T) {
  const firstObservedAt = Date.parse(first.observedAt);
  const secondObservedAt = Date.parse(second.observedAt);
  const firstTimestampValid = Number.isFinite(firstObservedAt);
  const secondTimestampValid = Number.isFinite(secondObservedAt);

  if (firstTimestampValid !== secondTimestampValid) return firstTimestampValid ? first : second;
  if (firstTimestampValid && secondTimestampValid && firstObservedAt !== secondObservedAt) {
    return firstObservedAt > secondObservedAt ? first : second;
  }

  return compareStableIds(stableMovementPayload(first), stableMovementPayload(second)) <= 0
    ? first
    : second;
}

export function deduplicateMovementRecords<T extends MovementRecord>(records: readonly T[]) {
  const byId = new Map<string, T>();
  for (const record of records) {
    const current = byId.get(record.id);
    byId.set(record.id, current ? preferMovementRecord(current, record) : record);
  }
  return [...byId.values()].sort((first, second) => compareStableIds(first.id, second.id));
}

export const EXPERIENCE_SECTIONS: { id: string; key: ExperienceSection; label: string; detail: string; }[] = [
  { id: "live-map", key: "map", label: "Map", detail: "Living island view" },
  { id: "official-notices", key: "notices", label: "Notices", detail: "Official warnings" },
  { id: "what-matters-now", key: "briefing", label: "Briefing", detail: "National signals" },
  { id: "day-so-far", key: "day", label: "Day so far", detail: "Weather timeline" }
];

export const readStoredPlace = () => {
  try {
    return window.localStorage.getItem("a-day-in-ireland.place");
  } catch {
    return null;
  }
};

export const storePlace = (placeId: string) => {
  try {
    window.localStorage.setItem("a-day-in-ireland.place", placeId);
  } catch {
    // URL state remains available when browser storage is blocked.
  }
};

export const irelandHour = (date: Date) =>
  Number.parseInt(
    new Intl.DateTimeFormat("en-IE", {
      hour: "2-digit",
      hour12: false,
      timeZone: "Europe/Dublin"
    }).format(date),
    10
  ) % 24;

export const irelandDayPhase = (date: Date) => {
  const hour = irelandHour(date);
  if (hour < 6 || hour >= 21) return "night";
  if (hour < 9) return "dawn";
  if (hour < 17) return "day";
  return "dusk";
};

export function solarProgress(now: Date) {
  const hour = irelandHour(now) + now.getUTCMinutes() / 60;
  return Math.max(0, Math.min(1, (hour - 5) / 17));
}

export function authoritativeSolarProgress(solar: NonNullable<LiveSnapshot["solar"]> | null, now: Date) {
  const sunrise = Date.parse(solar?.sunrise ?? "");
  const sunset = Date.parse(solar?.sunset ?? "");
  if (!Number.isFinite(sunrise) || !Number.isFinite(sunset) || sunset <= sunrise) return solarProgress(now);
  return Math.max(0, Math.min(1, (now.getTime() - sunrise) / (sunset - sunrise)));
}

export function authoritativeDayPhase(solar: NonNullable<LiveSnapshot["solar"]> | null, now: Date) {
  if (!solar) return irelandDayPhase(now);
  const timestamp = now.getTime();
  const firstLight = Date.parse(solar.firstLight ?? "");
  const blueMorning = Date.parse(solar.blueHourMorning ?? "");
  const dawn = Date.parse(solar.dawn ?? "");
  const sunrise = Date.parse(solar.sunrise ?? "");
  const goldenMorning = Date.parse(solar.goldenHourMorning ?? "");
  const goldenEvening = Date.parse(solar.goldenHourEvening ?? "");
  const sunset = Date.parse(solar.sunset ?? "");
  const blueEvening = Date.parse(solar.blueHourEvening ?? "");
  const dusk = Date.parse(solar.dusk ?? "");
  const lastLight = Date.parse(solar.lastLight ?? "");
  if (Number.isFinite(lastLight) && timestamp >= lastLight) return "night";
  if (Number.isFinite(firstLight) && timestamp < firstLight) return "night";
  if (Number.isFinite(blueMorning) && timestamp < blueMorning &&
      (!Number.isFinite(firstLight) || timestamp >= firstLight)) return "blue";
  if (Number.isFinite(dawn) && timestamp < dawn) return "blue";
  const morningGoldenEnd = Number.isFinite(sunrise) ? sunrise : dawn;
  if (Number.isFinite(goldenMorning) && timestamp >= goldenMorning &&
      Number.isFinite(morningGoldenEnd) && timestamp < morningGoldenEnd) return "golden";
  if (Number.isFinite(sunrise) && timestamp < sunrise) return "dawn";
  const eveningGoldenEnd = Number.isFinite(sunset) ? sunset : blueEvening;
  if (Number.isFinite(goldenEvening) && timestamp >= goldenEvening &&
      Number.isFinite(eveningGoldenEnd) && timestamp < eveningGoldenEnd) return "golden";
  if (Number.isFinite(sunset) && timestamp >= sunset) {
    if (Number.isFinite(blueEvening) && timestamp >= blueEvening &&
        (!Number.isFinite(dusk) || timestamp < dusk)) return "blue";
    if (Number.isFinite(dusk) && timestamp < dusk) return "dusk";
    if (Number.isFinite(lastLight) && timestamp < lastLight) return "dusk";
    return "night";
  }
  if (Number.isFinite(dusk) && timestamp >= dusk) return "dusk";
  return "day";
}

export function distanceKm(first: Pick<Place, "lat" | "lon">, second: Pick<Place, "lat" | "lon">) {
  const radians = Math.PI / 180;
  const latitudeDelta = (second.lat - first.lat) * radians;
  const longitudeDelta = (second.lon - first.lon) * radians;
  const firstLatitude = first.lat * radians;
  const secondLatitude = second.lat * radians;
  const haversine =
    Math.sin(latitudeDelta / 2) ** 2 +
    Math.cos(firstLatitude) * Math.cos(secondLatitude) * Math.sin(longitudeDelta / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(haversine), Math.sqrt(1 - haversine));
}

export function nearestReadingWithinRadius<T extends { latitude: number; longitude: number }>(
  items: T[],
  place: Place,
  radiusKm: number
): NearbyReading<T> | null {
  const nearest = items
    .map((item) => ({
      item,
      distanceKm: distanceKm({ lat: item.latitude, lon: item.longitude }, place)
    }))
    .sort((first, second) => first.distanceKm - second.distanceKm)[0] ?? null;
  return nearest && nearest.distanceKm <= radiusKm ? nearest : null;
}

export function projectReadings<T extends { latitude: number; longitude: number }>(
  items: readonly T[],
  projection: ReturnType<typeof geoMercator>,
  keyFor: (item: T) => string,
  priorityFor: (item: T) => number = () => 0
): ProjectedPoint<T>[] {
  return items.flatMap((item) => {
    const point = projection([item.longitude, item.latitude]);
    return point ? [{
      key: keyFor(item),
      x: point[0],
      y: point[1],
      item,
      priority: priorityFor(item)
    }] : [];
  });
}


export const ACTIVITY_STATUS_LABELS: Record<ReturnType<typeof getActivityGuidance>[number]["status"], string> = {
  "live-observations": "Live observations",
  "relevant-notice": "Relevant notice",
  "localized-notice": "Localised notice",
  "limited-context": "Limited context",
  "live-coverage": "Live coverage",
  "no-current-signal": "No current signal",
  unavailable: "Unavailable"
};


export const newestTimestamp = (first: string | null | undefined, second: string | null | undefined) => {
  const firstTime = Date.parse(first ?? "");
  const secondTime = Date.parse(second ?? "");
  if (!Number.isFinite(secondTime)) return first ?? null;
  if (!Number.isFinite(firstTime) || secondTime > firstTime) return new Date(secondTime).toISOString();
  return first ?? null;
};

export const STALE_THRESHOLDS = {
  weather: WEATHER_OBSERVATION_MAX_AGE_MS,
  transit: 3 * 60_000,
  rivers: 3 * 60 * 60_000,
  marine: 6 * 60 * 60_000,
  grid: 5 * 60_000,
} as const;

export function isDataStale(observedAt: string | null | undefined, maxAgeMs: number, now: number) {
  if (!observedAt) return true;
  const timestamp = Date.parse(observedAt);
  if (!Number.isFinite(timestamp)) return true;
  const age = now - timestamp;
  return age < 0 || age > maxAgeMs;
}

export const availableCount = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value >= 0
  ? value
  : null;

export const HISTORY_FOCUS_TOKENS: Record<ContextFocus, string[]> = {
  weather: ["weather", "met éireann"],
  wind: ["weather", "wind", "met éireann"],
  trains: ["rail", "train", "iarnród"],
  rivers: ["river", "opw"],
  sea: ["marine", "sea", "buoy"],
  warnings: ["warning", "notice", "met éireann"],
  radar: ["radar"],
  grid: ["grid", "eirgrid"],
  air: ["air", "eea", "cams"],
  aurora: ["aurora", "noaa"],
  tides: ["tide", "marine institute"],
  bathing: ["bathing", "beach"],
  iss: ["iss", "celestrak"],
  satellite: ["satellite", "nasa", "gibs"],
  earthquakes: ["earthquake", "usgs", "seismic"],
  transit: ["transit", "nta", "tfi", "vehicle"]
};

export const historyGapForFocus = (gaps: HistoryGap[], focus: ContextFocus) => {
  const tokens = HISTORY_FOCUS_TOKENS[focus];
  return gaps.find((gap) => {
    const text = `${gap.source} ${gap.scope} ${gap.detail}`.toLocaleLowerCase("en-IE");
    return tokens.some((token) => text.includes(token));
  }) ?? null;
};
