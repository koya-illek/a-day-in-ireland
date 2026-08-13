import type {
  AirQualityReading,
  BathingAlert,
  EarthquakeReading,
  LiveSnapshot,
  RiverReading,
  StationReading,
  TideReading,
  TrainPosition
} from "../lib/types";
import type { HistoryEnvelope } from "../lib/history";

export type Layer =
  | "weather"
  | "rain"
  | "wind"
  | "warnings"
  | "places"
  | "sea"
  | "trains"
  | "rivers"
  | "radar"
  | "grid"
  | "air"
  | "aurora"
  | "tides"
  | "bathing"
  | "iss"
  | "satellite"
  | "earthquakes"
  | "transit";

export type Selection =
  | { type: "station"; item: StationReading }
  | { type: "train"; item: TrainPosition }
  | { type: "river"; item: RiverReading }
  | { type: "buoy"; item: LiveSnapshot["marine"][number] }
  | { type: "air"; item: AirQualityReading }
  | { type: "tide"; item: TideReading }
  | { type: "bathing"; item: BathingAlert }
  | { type: "earthquake"; item: EarthquakeReading }
  | { type: "transit"; item: LiveSnapshot["transit"][number] };

export type MovementSelection = Extract<Selection, { type: "train" | "transit" }>;
export type MapSelection =
  | Selection
  | { type: "movement-stack"; items: MovementSelection[]; index: number };

export type MovementStack = {
  key: string;
  x: number;
  y: number;
  items: MovementSelection[];
};

export const movementItemIdentity = (item: MovementSelection) => `${item.type}:${item.item.id}`;
export const movementMarkerId = (identity: string) => `movement:${identity}`;
export const MOVEMENT_DRILL_THRESHOLD = 12;
export const MOVEMENT_PAGE_SIZE = 12;

export type ContextFocus =
  | "weather"
  | "wind"
  | "trains"
  | "rivers"
  | "sea"
  | "warnings"
  | "radar"
  | "grid"
  | "air"
  | "aurora"
  | "tides"
  | "bathing"
  | "iss"
  | "satellite"
  | "earthquakes"
  | "transit";

export type Place = {
  id: string;
  name: string;
  lon: number;
  lat: number;
};

export type Preset = "weather" | "movement" | "water" | "all" | "custom";

export type LayerDefinition = readonly [Layer, string, string];

export type LayerGroup = {
  id: string;
  label: string;
  detail: string;
  layers: LayerDefinition[];
};

export type ConnectionStatus = "online" | "offline";

export type TimeMode = "now" | "past";

export type ExperienceSection = "map" | "notices" | "briefing" | "day";

export type HistoryLoadState = {
  status: "idle" | "loading" | "ready" | "gap" | "error";
  requestedAt: string | null;
  envelope: HistoryEnvelope | null;
  error: string | null;
};

export type HistoryComparisonState = {
  status: "idle" | "loading" | "ready" | "error";
  envelope: HistoryEnvelope | null;
  error: string | null;
};

export type NearbyReading<T> = {
  item: T;
  distanceKm: number;
};

export const formatTime = (date: Date) => Number.isFinite(date.getTime())
  ? new Intl.DateTimeFormat("en-IE", {
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
      timeZone: "Europe/Dublin"
    }).format(date)
  : "Unavailable";

export const orderedTideEvents = (tide: TideReading) => [
  { label: "Next high", at: tide.nextHighAt, level: tide.nextHighLevel, fallbackOrder: 0 },
  { label: "Next low", at: tide.nextLowAt, level: tide.nextLowLevel, fallbackOrder: 1 }
].sort((first, second) => {
  const firstTime = first.at ? Date.parse(first.at) : Number.POSITIVE_INFINITY;
  const secondTime = second.at ? Date.parse(second.at) : Number.POSITIVE_INFINITY;
  const safeFirstTime = Number.isFinite(firstTime) ? firstTime : Number.POSITIVE_INFINITY;
  const safeSecondTime = Number.isFinite(secondTime) ? secondTime : Number.POSITIVE_INFINITY;
  return safeFirstTime !== safeSecondTime
    ? safeFirstTime - safeSecondTime
    : first.fallbackOrder - second.fallbackOrder;
});

export const provenanceLabel = (status: "live" | "partial" | "stale" | "fallback" | "unavailable") =>
  ({ live: "live", partial: "partial", stale: "cached", fallback: "fallback", unavailable: "unavailable" })[status];

export const formatDate = (date: Date) =>
  new Intl.DateTimeFormat("en-IE", {
    weekday: "long",
    day: "numeric",
    month: "long",
    timeZone: "Europe/Dublin"
  }).format(date);

export const formatDistance = (value: number) => value < 10 ? `${value.toFixed(1)} km away` : `${Math.round(value)} km away`;

export function formatAge(value: string | null | undefined, now: Date) {
  if (!value) return "unknown age";
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return "unknown age";
  const ageMinutes = Math.max(0, Math.round((now.getTime() - timestamp) / 60_000));
  if (ageMinutes < 1) return "just now";
  if (ageMinutes < 60) return `${ageMinutes}m ago`;
  const ageHours = Math.round(ageMinutes / 60);
  return `${ageHours}h ago`;
}

export function statusText(status: "live" | "partial" | "stale" | "fallback" | "unavailable") {
  return status === "stale" ? "cached" : status;
}

export const aqiLabel = (value: number | null) => {
  if (value === null) return "Unavailable";
  if (value <= 20) return "Good";
  if (value <= 40) return "Fair";
  if (value <= 60) return "Moderate";
  if (value <= 80) return "Poor";
  if (value <= 100) return "Very poor";
  return "Extremely poor";
};
