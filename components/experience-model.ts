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

const IRELAND_TIME_ZONE = "Europe/Dublin";

export const irelandClockParts = (date: Date) => {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-IE", {
      weekday: "long",
      day: "numeric",
      month: "long",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
      timeZone: IRELAND_TIME_ZONE
    }).formatToParts(date).flatMap((part) => part.type === "literal" ? [] : [[part.type, part.value]])
  );
  const hour = Number.parseInt(String(parts.hour ?? "0"), 10) % 24;
  return {
    weekday: String(parts.weekday ?? ""),
    day: String(parts.day ?? ""),
    month: String(parts.month ?? ""),
    hour,
    minute: String(parts.minute ?? "00").padStart(2, "0"),
    clock: `${String(hour).padStart(2, "0")}:${String(parts.minute ?? "00").padStart(2, "0")}`
  };
};

export const irelandEditorialMoment = (date: Date) => {
  if (!Number.isFinite(date.getTime())) return "Irish time is unavailable.";
  const { weekday, day, month, hour, clock } = irelandClockParts(date);
  const period = hour < 6
    ? "Before dawn"
    : hour < 12
      ? "Morning"
      : hour < 17
        ? "Afternoon"
        : hour < 21
          ? "Evening"
          : "Night";
  return `${weekday} ${day} ${month}, ${clock} Irish time. ${period} across Ireland.`;
};

export const NEARBY_RADIUS_KM = {
  weather: 50,
  river: 30,
  air: 60
} as const;

export const formatCount = (value: number) => new Intl.NumberFormat("en-IE").format(value);

export const pluralise = (value: number, singular: string, plural = `${singular}s`) =>
  value === 1 ? singular : plural;

export function weatherNarrative(snapshot: LiveSnapshot) {
  const currentWeather = snapshot.sourceStatus === "live" || snapshot.sourceStatus === "partial";
  const warm = snapshot.summary.warmest;
  const rain = snapshot.summary.wettest;
  return !currentWeather
    ? snapshot.sourceStatus === "stale"
      ? "The most recent weather snapshot is cached, so current national conditions are not stated."
      : "Current weather observations are unavailable."
    : !warm && !rain
    ? "Current weather observations are unavailable."
    : rain && (rain.rainfall ?? 0) > 0
    ? `Rain is being observed around ${rain.name}. ${warm?.name ?? "The warmest station"} is ${warm?.temperature ?? "Unavailable"}°.`
    : `${warm?.name ?? "The warmest station"} is ${warm?.temperature ?? "Unavailable"}°, and none of the reporting stations have measured rain.`;
}

export function buildHeroSentences(options: {
  timeMode: TimeMode;
  historyStatus: HistoryLoadState["status"];
  isDailyHistorySummary: boolean;
  historyResolutionLabel: string;
  now: Date;
  isConnectingWithoutSnapshot: boolean;
  servicesRefreshing: boolean;
  serviceDisplayState: "connecting" | "refreshing" | "offline" | "cached" | "stale" | "unavailable" | "degraded" | "live";
  lastSuccessLabel: string;
  liveLeadFact: string;
  weatherNotableCurrent: boolean;
  windiestStation: { name: string; windSpeed: number | null } | null;
  weatherDisplayStatus: "live" | "partial" | "stale" | "fallback" | "unavailable";
}) {
  const heroSentence = options.timeMode === "past"
    ? options.historyStatus === "loading"
      ? "Loading stored observations for the selected time…"
      : options.historyStatus === "error"
        ? "Historical conditions could not be loaded. Live data is not substituted."
        : options.historyStatus === "gap"
          ? "No stored record exists at or before the selected time."
          : `${irelandEditorialMoment(options.now)} ${options.isDailyHistorySummary
            ? `This stored ${options.historyResolutionLabel} keeps summary values and recorded gaps, not a reconstructed point map.`
            : "This is the stored record for the selected time."}`
    : options.isConnectingWithoutSnapshot
      ? "Connecting to live observations across the island…"
      : options.servicesRefreshing
        ? "Loading fresh observations across the island…"
        : options.serviceDisplayState === "offline"
          ? `Offline. Showing the last saved observations where available; last success ${options.lastSuccessLabel}.`
          : options.serviceDisplayState === "cached"
            ? `A refresh failed. Cached observations are labelled and last succeeded ${options.lastSuccessLabel}.`
            : options.serviceDisplayState === "unavailable"
              ? "Live services are unavailable, so national conditions cannot be assessed."
              : `${irelandEditorialMoment(options.now)} ${options.liveLeadFact}`;
  const heroSecondary = options.timeMode === "past"
    ? `Stored observations from ${options.lastSuccessLabel}. They are separated from live feeds and keep provider timestamps and recorded gaps.`
    : options.weatherNotableCurrent && options.windiestStation?.windSpeed != null
      ? `Strongest observed wind ${options.windiestStation.windSpeed} km/h at ${options.windiestStation.name}.`
      : options.weatherDisplayStatus === "stale"
        ? "Weather observations are cached and kept separate from the live story."
        : "Weather observations are currently unavailable, so they are not used to frame the first impression.";
  return { heroSentence, heroSecondary };
}

export type HeroFactDraft = {
  key: string;
  family: string;
  label: string;
  value: string;
  detail: string;
  action: "notices" | "weather" | "wind";
};

export function buildHeroFacts(options: {
  warningsUnavailable: boolean;
  activeNoticeCount: number;
  upcomingNoticeCount: number;
  weatherNotableCurrent: boolean;
  warmestStation: { name: string; temperature: number | null } | null;
  wettestStation: { name: string; rainfall: number | null } | null;
  windiestStation: { name: string; windSpeed: number | null } | null;
}): HeroFactDraft[] {
  return [
    !options.warningsUnavailable
      ? {
          key: "warnings",
          family: "notices",
          label: options.activeNoticeCount > 0 ? "official notices" : options.upcomingNoticeCount > 0 ? "notice outlook" : "official notices",
          value: options.activeNoticeCount > 0
            ? formatCount(options.activeNoticeCount)
            : options.upcomingNoticeCount > 0
              ? formatCount(options.upcomingNoticeCount)
              : "Clear",
          detail: options.activeNoticeCount > 0
            ? `${options.activeNoticeCount === 1 ? "Notice" : "Notices"} now in effect`
            : options.upcomingNoticeCount > 0
              ? `${options.upcomingNoticeCount === 1 ? "Notice" : "Notices"} due later`
              : "No current or upcoming notices",
          action: "notices" as const
        }
      : null,
    options.weatherNotableCurrent && options.warmestStation?.temperature != null
      ? {
          key: "temperature",
          family: "weather",
          label: "temperature",
          value: `${options.warmestStation.temperature}°`,
          detail: `Warmest at ${options.warmestStation.name}`,
          action: "weather" as const
        }
      : null,
    options.weatherNotableCurrent
      ? options.wettestStation && (options.wettestStation.rainfall ?? 0) > 0
        ? {
            key: "rain",
            family: "weather",
            label: "rain",
            value: `${options.wettestStation.rainfall?.toFixed(1)} mm`,
            detail: `Observed around ${options.wettestStation.name}`,
            action: "weather" as const
          }
        : {
            key: "rain",
            family: "weather",
            label: "rain",
            value: "None",
            detail: "No rain measured at reporting stations",
            action: "weather" as const
          }
      : null,
    options.weatherNotableCurrent && options.windiestStation?.windSpeed != null
      ? {
          key: "wind",
          family: "weather",
          label: "wind",
          value: `${options.windiestStation.windSpeed} km/h`,
          detail: `Strongest at ${options.windiestStation.name}`,
          action: "wind" as const
        }
      : null
  ].filter((fact): fact is HeroFactDraft => fact !== null);
}

export const formatTime = (date: Date) => Number.isFinite(date.getTime())
  ? irelandClockParts(date).clock
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
