"use client";

import {
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type FocusEvent as ReactFocusEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type WheelEvent as ReactWheelEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState
} from "react";
import { createPortal } from "react-dom";
import Link from "next/link";
import { geoMercator, geoPath } from "d3-geo";
import islandBoundary from "../public/map/island.json";
import majorRoads from "../public/map/major-roads.json";
import type {
  AirQualityReading,
  LiveSnapshot,
  TrainPosition
} from "../lib/types";
import { getSelectedSourceAssessment, getServiceDisplayState } from "../lib/data-state";
import { refreshCurrentContexts, refreshLivingLayers, refreshTransit, refreshWeather } from "../lib/browser-live";
import { getActivityGuidance, type ActivityId, type GuidancePlace } from "../lib/activity-guidance";
import { humaniseWarningRegions, transitPresentation } from "../lib/presentation.js";
import { sortOfficialWeatherWarnings, warningTiming } from "../platform/river-source.js";
import { ForecastStrip, SkyLightStrip } from "./SkyBriefing";
import {
  DEFAULT_PLACE_ID,
  parseViewState,
  serializeViewState
} from "../lib/view-state";
import {
  clusterProjectedPoints,
  selectDeclutteredPoints,
  type MapViewport,
  type ProjectedPoint
} from "../lib/map-density";
import { WEATHER_OBSERVATION_MAX_AGE_MS } from "../lib/weather-stations";
import {
  canonicalHistoryAt,
  fetchHistoryRange,
  fetchHistorySnapshot,
  formatIrelandHistoryTime,
  isUsableHistoryEnvelope,
  type HistoryGap,
  type HistoryRange
} from "../lib/history";

import {
  type ConnectionStatus,
  type ContextFocus,
  type ExperienceSection,
  type HistoryComparisonState,
  type HistoryLoadState,
  type Layer,
  type LayerGroup,
  type MapSelection,
  type MovementSelection,
  type MovementStack,
  type NearbyReading,
  type Place,
  type Preset,
  type Selection,
  type TimeMode,
  MOVEMENT_DRILL_THRESHOLD,
  aqiLabel,
  formatAge,
  formatDate,
  formatDistance,
  formatTime,
  movementItemIdentity,
  movementMarkerId,
  statusText
} from "./experience-model";
import {
  MapMarker,
  RadarTiles,
  SatelliteTiles,
  StationMarker,
  createRadarTileStatusRecord,
  IRELAND_RADAR_TILES,
  windDirectionDegrees,
  type MarkerInteraction,
  type RadarPresentationState,
  type RadarTileStatus,
  type RadarTileStatusReporter
} from "./MapLayers";
import { AuroraPanel, DetailCard, GridPanel, IssPanel } from "./MapPanels";
import { HistoryControls, historyResolutionLabel } from "./HistoryControls";
import { ExplorePanel } from "./ExplorePanel";

const compareStableIds = (first: string, second: string) =>
  first < second ? -1 : first > second ? 1 : 0;

type MovementRecord = TrainPosition | LiveSnapshot["transit"][number];

const stablePayloadValue = (value: unknown) => {
  if (typeof value === "number") {
    if (Number.isNaN(value)) return "number:NaN";
    if (Object.is(value, -0)) return "number:-0";
  }
  return `${typeof value}:${String(value)}`;
};

function stableMovementPayload(item: MovementRecord) {
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

function preferMovementRecord<T extends MovementRecord>(first: T, second: T) {
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

function deduplicateMovementRecords<T extends MovementRecord>(records: readonly T[]) {
  const byId = new Map<string, T>();
  for (const record of records) {
    const current = byId.get(record.id);
    byId.set(record.id, current ? preferMovementRecord(current, record) : record);
  }
  return [...byId.values()].sort((first, second) => compareStableIds(first.id, second.id));
}

const PLACES = [
  { id: "dublin", name: "Dublin", lon: -6.2603, lat: 53.3498 },
  { id: "belfast", name: "Belfast", lon: -5.9301, lat: 54.5973 },
  { id: "cork", name: "Cork", lon: -8.4756, lat: 51.8985 },
  { id: "galway", name: "Galway", lon: -9.0568, lat: 53.2707 },
  { id: "limerick", name: "Limerick", lon: -8.6267, lat: 52.6638 },
  { id: "waterford", name: "Waterford", lon: -7.1119, lat: 52.2593 },
  { id: "derry", name: "Derry", lon: -7.309, lat: 54.9966 }
] satisfies Place[];

const PLACE_OPTIONS: Place[] = [
  { id: "island", name: "Ireland", lon: -8.05, lat: 53.45 },
  ...PLACES
];

const EXPERIENCE_SECTIONS: { id: string; key: ExperienceSection; label: string; detail: string; }[] = [
  { id: "live-map", key: "map", label: "Map", detail: "Living island view" },
  { id: "official-notices", key: "notices", label: "Notices", detail: "Official warnings" },
  { id: "what-matters-now", key: "briefing", label: "Briefing", detail: "National signals" },
  { id: "day-so-far", key: "day", label: "Day so far", detail: "Weather timeline" }
];

const readStoredPlace = () => {
  try {
    return window.localStorage.getItem("a-day-in-ireland.place");
  } catch {
    return null;
  }
};

const storePlace = (placeId: string) => {
  try {
    window.localStorage.setItem("a-day-in-ireland.place", placeId);
  } catch {
    // URL state remains available when browser storage is blocked.
  }
};

const PRESET_LAYERS: Record<Exclude<Preset, "custom">, Layer[]> = {
  weather: ["weather", "rain", "wind", "warnings", "places"],
  movement: ["trains", "transit", "places"],
  water: ["rain", "rivers", "sea", "tides", "bathing", "warnings", "places"],
  all: [
    "weather", "rain", "wind", "warnings", "places", "sea", "trains", "rivers",
    "radar", "grid", "air", "aurora", "tides", "bathing", "iss", "satellite",
    "earthquakes", "transit"
  ]
};

const NEARBY_RADIUS_KM = {
  weather: 50,
  river: 30,
  air: 60
} as const;

const LAYER_GROUPS: LayerGroup[] = [
  {
    id: "weather",
    label: "Weather & official notices",
    detail: "Conditions, rain and Met Éireann notices",
    layers: [
      ["weather", "Weather stations", "Temperature and current conditions"],
      ["rain", "Observed rain", "Measured recent rainfall around stations"],
      ["wind", "Observed wind", "Met Éireann direction and speed in km/h"],
      ["warnings", "Met Éireann notices", "Current official Met Éireann warnings and advisories"],
      ["radar", "Rainfall radar", "Met Éireann precipitation tiles, checked when the layer is displayed"]
    ]
  },
  {
    id: "movement",
    label: "Movement",
    detail: "Rail and public transport positions",
    layers: [
      ["trains", "Moving trains", "Current Iarnród Éireann train positions"],
      ["transit", "Public transport", "TFI live bus, Luas and other vehicle positions when API access is configured"]
    ]
  },
  {
    id: "water",
    label: "Water & coast",
    detail: "Gauges, sea conditions and bathing alerts",
    layers: [
      ["rivers", "River levels", "Latest fresh OPW readings; stale gauges expire automatically"],
      ["sea", "Sea conditions", "Near-real-time Marine Institute buoys and coastal observatories"],
      ["tides", "Tides & surge", "Fresh gauges, predicted high and low water, and surge anomaly"],
      ["bathing", "Bathing alerts", "Current EPA restrictions and pollution advisories only"]
    ]
  },
  {
    id: "air-sky-earth",
    label: "Air, sky & earth",
    detail: "Exposure, space imagery and detected events",
    layers: [
      ["air", "Air & exposure", "EEA monitoring stations plus regional CAMS model estimates"],
      ["aurora", "Aurora probability", "NOAA OVATION overhead probability guidance"],
      ["iss", "ISS passes", "Current orbit and locally calculated passes over Ireland"],
      ["satellite", "Satellite image", "NASA VIIRS previous-day archive frame; not a live camera"],
      ["earthquakes", "Earthquakes", "USGS detections around Ireland during the past seven days"]
    ]
  },
  {
    id: "across-ireland",
    label: "Across Ireland",
    detail: "Whole-island operational context",
    layers: [
      ["grid", "Electricity grid", "Current all-island EirGrid demand, wind, carbon and frequency"]
    ]
  },
  {
    id: "places",
    label: "Places",
    detail: "Major towns and cities for map orientation",
    layers: [
      ["places", "Places", "Major towns and cities"]
    ]
  }
];


const formatCount = (value: number) => new Intl.NumberFormat("en-IE").format(value);

const pluralise = (value: number, singular: string, plural = `${singular}s`) =>
  value === 1 ? singular : plural;

const irelandHour = (date: Date) =>
  Number.parseInt(
    new Intl.DateTimeFormat("en-IE", {
      hour: "2-digit",
      hour12: false,
      timeZone: "Europe/Dublin"
    }).format(date),
    10
  ) % 24;

const irelandDayPhase = (date: Date) => {
  const hour = irelandHour(date);
  if (hour < 6 || hour >= 21) return "night";
  if (hour < 9) return "dawn";
  if (hour < 17) return "day";
  return "dusk";
};

const irelandEditorialMoment = (date: Date) => {
  const hour = irelandHour(date);
  const weekday = new Intl.DateTimeFormat("en-IE", {
    weekday: "long",
    timeZone: "Europe/Dublin"
  }).format(date);
  const period = hour < 6
    ? "before dawn"
    : hour < 12
      ? "morning"
      : hour < 17
        ? "afternoon"
        : hour < 21
          ? "evening"
          : "night";
  return `${weekday} ${period} across Ireland.`;
};

const joinClauses = (clauses: string[]) => {
  if (clauses.length === 0) return "";
  if (clauses.length === 1) return clauses[0]!;
  if (clauses.length === 2) return `${clauses[0]} and ${clauses[1]}`;
  return `${clauses.slice(0, -1).join(", ")}, and ${clauses.at(-1)}`;
};

function solarProgress(now: Date) {
  const hour = irelandHour(now) + now.getUTCMinutes() / 60;
  return Math.max(0, Math.min(1, (hour - 5) / 17));
}

function authoritativeSolarProgress(solar: NonNullable<LiveSnapshot["solar"]> | null, now: Date) {
  const sunrise = Date.parse(solar?.sunrise ?? "");
  const sunset = Date.parse(solar?.sunset ?? "");
  if (!Number.isFinite(sunrise) || !Number.isFinite(sunset) || sunset <= sunrise) return solarProgress(now);
  return Math.max(0, Math.min(1, (now.getTime() - sunrise) / (sunset - sunrise)));
}

function authoritativeDayPhase(solar: NonNullable<LiveSnapshot["solar"]> | null, now: Date) {
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

function weatherNarrative(snapshot: LiveSnapshot) {
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
    ? `Rain is being observed around ${rain.name}, while ${warm?.name ?? "the warmest station"} reports ${warm?.temperature ?? "—"}°.`
    : `${warm?.name ?? "The warmest station"} is reporting ${warm?.temperature ?? "—"}°; no recent rain is represented among the reporting stations.`;
}

function distanceKm(first: Pick<Place, "lat" | "lon">, second: Pick<Place, "lat" | "lon">) {
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

function nearestReadingWithinRadius<T extends { latitude: number; longitude: number }>(
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

function projectReadings<T extends { latitude: number; longitude: number }>(
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


const ACTIVITY_STATUS_LABELS: Record<ReturnType<typeof getActivityGuidance>[number]["status"], string> = {
  "live-observations": "Live observations",
  "relevant-notice": "Relevant notice",
  "localized-notice": "Localized notice",
  "limited-context": "Limited context",
  "live-coverage": "Live coverage",
  "no-current-signal": "No current signal",
  unavailable: "Unavailable"
};


const newestTimestamp = (first: string | null | undefined, second: string | null | undefined) => {
  const firstTime = Date.parse(first ?? "");
  const secondTime = Date.parse(second ?? "");
  if (!Number.isFinite(secondTime)) return first ?? null;
  if (!Number.isFinite(firstTime) || secondTime > firstTime) return new Date(secondTime).toISOString();
  return first ?? null;
};

const warningScopeText = (warning: LiveSnapshot["warnings"][number]) =>
  humaniseWarningRegions(warning.regions);

const OFFICIAL_WARNING_URL = "https://www.met.ie/warnings-today.html";

const formatWarningDate = (value: string) => {
  const date = new Date(value);
  return Number.isFinite(date.getTime())
    ? date.toLocaleString("en-IE", {
      weekday: "short",
      day: "numeric",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
      timeZone: "Europe/Dublin"
    })
    : "time unavailable";
};


const STALE_THRESHOLDS = {
  weather: WEATHER_OBSERVATION_MAX_AGE_MS,
  transit: 3 * 60_000,
  rivers: 3 * 60 * 60_000,
  marine: 6 * 60 * 60_000,
  grid: 5 * 60_000,
} as const;

function isDataStale(observedAt: string | null | undefined, maxAgeMs: number, now: number) {
  if (!observedAt) return true;
  const timestamp = Date.parse(observedAt);
  if (!Number.isFinite(timestamp)) return true;
  const age = now - timestamp;
  return age < 0 || age > maxAgeMs;
}

function formatLocalObservation(
  provider: string,
  item: { name: string; observedAt: string | null },
  distanceKm: number,
  now: Date,
  historical = false
) {
  const timing = historical
    ? item.observedAt
      ? `observed ${formatIrelandHistoryTime(item.observedAt)}`
      : "observation time unavailable"
    : formatAge(item.observedAt, now);
  return `${provider} · ${item.name} · ${formatDistance(distanceKm)} · ${timing}`;
}



const availableCount = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value >= 0
  ? value
  : null;

const HISTORY_FOCUS_TOKENS: Record<ContextFocus, string[]> = {
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

const historyGapForFocus = (gaps: HistoryGap[], focus: ContextFocus) => {
  const tokens = HISTORY_FOCUS_TOKENS[focus];
  return gaps.find((gap) => {
    const text = `${gap.source} ${gap.scope} ${gap.detail}`.toLocaleLowerCase("en-IE");
    return tokens.some((token) => text.includes(token));
  }) ?? null;
};


export default function IrelandExperience({ initialSnapshot }: { initialSnapshot: LiveSnapshot }) {
  const [liveSnapshot, setLiveSnapshot] = useState(() => initialSnapshot);
  const [wallClockNow, setWallClockNow] = useState(() => new Date(initialSnapshot.generatedAt));
  const [timeMode, setTimeMode] = useState<TimeMode>("now");
  const [historyRange, setHistoryRange] = useState<HistoryRange | null>(null);
  const [historyState, setHistoryState] = useState<HistoryLoadState>({
    status: "idle",
    requestedAt: null,
    envelope: null,
    error: null
  });
  const [historyComparison, setHistoryComparison] = useState<HistoryComparisonState>({
    status: "idle",
    envelope: null,
    error: null
  });
  const [layers, setLayers] = useState<Set<Layer>>(
    () => new Set(["weather", "rain", "wind", "warnings", "places"])
  );
  const [activeMarkerId, setActiveMarkerId] = useState<string | null>(null);
  const [markerAnnouncement, setMarkerAnnouncement] = useState("");
  const [selected, setSelected] = useState<MapSelection | null>(null);
  const [panelOpen, setPanelOpen] = useState(false);
  const [activePreset, setActivePreset] = useState<Preset>("weather");
  const [servicesRefreshing, setServicesRefreshing] = useState(() => initialSnapshot.stations.length === 0);
  const [initialRefreshComplete, setInitialRefreshComplete] = useState(() => initialSnapshot.lastSuccessAt !== null);
  const [showAllNotables, setShowAllNotables] = useState(false);
  const [mapNotice, setMapNotice] = useState<{ title: string; detail: string; focus?: ContextFocus } | null>(null);
  const [radarFrameIndex, setRadarFrameIndex] = useState(() => Math.max(0, initialSnapshot.radar.length - 1));
  const [radarPlaying, setRadarPlaying] = useState(false);
  const [radarTileState, setRadarTileState] = useState<{
    frameKey: string;
    tiles: Record<string, RadarTileStatus>;
  } | null>(null);
  const [prefersReducedMotion, setPrefersReducedMotion] = useState(() =>
    typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
  const [mapView, setMapView] = useState({ scale: 1, x: 0, y: 0 });
  const [shareStatus, setShareStatus] = useState<"idle" | "copied">("idle");
  const [selectedPlaceId, setSelectedPlaceId] = useState(DEFAULT_PLACE_ID);
  const [ephemeralPlace, setEphemeralPlace] = useState<Place | null>(null);
  const [placeMessage, setPlaceMessage] = useState("");
  const [activeSection, setActiveSection] = useState<ExperienceSection>("map");
  const [viewHydrated, setViewHydrated] = useState(false);
  const [timelineSelection, setTimelineSelection] = useState<string | null>(null);
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>("online");
  const [mapDimensions, setMapDimensions] = useState({ width: 1000, height: 900 });
  const [mapFeedback, setMapFeedback] = useState("");
  const [lastCheckedAt, setLastCheckedAt] = useState(() => new Date(initialSnapshot.generatedAt));
  const liveSnapshotRef = useRef(initialSnapshot);
  const refreshAllRef = useRef<() => Promise<void>>(async () => undefined);
  const historyRequestRef = useRef<AbortController | null>(null);
  const historyRequestGenerationRef = useRef(0);
  const comparisonRequestRef = useRef<AbortController | null>(null);
  const initialHistoryAtRef = useRef<string | null>(typeof window === "undefined"
    ? null
    : canonicalHistoryAt(new URLSearchParams(window.location.search).get("at")));
  const activeRadarFrameKeyRef = useRef<string | null>(null);
  const mapRef = useRef<SVGSVGElement | null>(null);
  const mapSectionRef = useRef<HTMLElement | null>(null);
  const pendingMapAnchorRef = useRef<number | null>(null);
  const mapDocumentTopRef = useRef<number | null>(null);
  const markerOpenerRef = useRef<SVGElement | null>(null);
  const focusedMarkerRef = useRef<{ id: string; element: SVGGElement } | null>(null);
  const mapPointersRef = useRef(new Map<number, { x: number; y: number }>());
  const mapGestureRef = useRef<{ center: { x: number; y: number }; distance: number } | null>(null);
  const mapPointerOriginRef = useRef<{ x: number; y: number } | null>(null);
  const mapDidPanRef = useRef(false);
  const panelOpenerRef = useRef<HTMLButtonElement | null>(null);
  const experienceRef = useRef<HTMLElement | null>(null);
  const snapshot = timeMode === "past"
    ? historyState.envelope?.snapshot ?? initialSnapshot
    : liveSnapshot;
  const reportingCount = availableCount(snapshot.summary.reporting);
  const runningTrainCount = availableCount(snapshot.summary.runningTrains);
  const riverStationCount = availableCount(snapshot.summary.riverStations);
  const referenceTime = timeMode === "past" && historyState.envelope?.resolvedAt
    ? new Date(historyState.envelope.resolvedAt)
    : wallClockNow;
  const now = referenceTime;
  const historyGaps = timeMode === "past" ? historyState.envelope?.gaps ?? [] : [];
  const isDailyHistorySummary = timeMode === "past" && (historyState.envelope?.resolutionMinutes ?? 0) >= 1440;
  const radarHistoryGap = timeMode === "past" ? historyGapForFocus(historyGaps, "radar") : null;
  const satelliteHistoryGap = timeMode === "past" ? historyGapForFocus(historyGaps, "satellite") : null;
  const historicalSnapshotReadable = timeMode === "past" && historyState.status === "ready" && Boolean(historyState.envelope?.snapshot);
  const snapshotReadable = timeMode === "past"
    ? historicalSnapshotReadable && !isDailyHistorySummary
    : connectionStatus === "online";

  const loadHistoryAt = useCallback(async (at: string) => {
    const canonical = canonicalHistoryAt(at);
    if (!canonical) {
      setHistoryState((current) => ({ ...current, status: "error", error: "The requested time is invalid." }));
      return;
    }
    historyRequestRef.current?.abort();
    const controller = new AbortController();
    historyRequestRef.current = controller;
    const generation = ++historyRequestGenerationRef.current;
    setHistoryState((current) => ({
      status: "loading",
      requestedAt: canonical,
      envelope: current.envelope,
      error: null
    }));
    setHistoryComparison({ status: "idle", envelope: null, error: null });
    setSelected(null);
    setRadarPlaying(false);
    setTimelineSelection(null);
    try {
      const envelope = await fetchHistorySnapshot(canonical, controller.signal);
      if (generation !== historyRequestGenerationRef.current) return;
      setHistoryRange((current) => ({
        availableFrom: envelope.availableFrom ?? current?.availableFrom ?? null,
        availableTo: envelope.availableTo ?? current?.availableTo ?? null,
        resolutionMinutes: current?.resolutionMinutes ?? envelope.resolutionMinutes,
        snapshotCount: envelope.snapshotCount ?? current?.snapshotCount ?? null,
        resolutions: current?.resolutions ?? envelope.resolutions
      }));
      setHistoryState({
        status: isUsableHistoryEnvelope(envelope) ? "ready" : "gap",
        requestedAt: canonical,
        envelope,
        error: null
      });
      setRadarFrameIndex(Math.max(0, (envelope.snapshot?.radar.length ?? 0) - 1));
    } catch (error) {
      if (controller.signal.aborted || generation !== historyRequestGenerationRef.current) return;
      setHistoryState((current) => ({
        ...current,
        status: "error",
        requestedAt: canonical,
        error: error instanceof Error ? error.message : "History service unavailable"
      }));
    }
  }, []);

  const enterPast = useCallback(async () => {
    setTimeMode("past");
    setHistoryComparison({ status: "idle", envelope: null, error: null });
    if (historyState.envelope?.resolvedAt) {
      setHistoryState((current) => ({ ...current, status: isUsableHistoryEnvelope(current.envelope) ? "ready" : "gap" }));
      return;
    }
    let range = historyRange;
    if (!range) {
      historyRequestRef.current?.abort();
      const controller = new AbortController();
      historyRequestRef.current = controller;
      setHistoryState({ status: "loading", requestedAt: null, envelope: null, error: null });
      try {
        range = await fetchHistoryRange(controller.signal);
        setHistoryRange(range);
      } catch (error) {
        if (controller.signal.aborted) return;
        setHistoryState({
          status: "error",
          requestedAt: null,
          envelope: null,
          error: error instanceof Error ? error.message : "History range unavailable"
        });
        return;
      }
    }
    if (range.availableTo) await loadHistoryAt(range.availableTo);
    else setHistoryState({ status: "gap", requestedAt: null, envelope: null, error: null });
  }, [historyRange, historyState.envelope, loadHistoryAt]);

  const returnToNow = useCallback(() => {
    historyRequestRef.current?.abort();
    comparisonRequestRef.current?.abort();
    historyRequestGenerationRef.current += 1;
    initialHistoryAtRef.current = null;
    setTimeMode("now");
    setHistoryComparison({ status: "idle", envelope: null, error: null });
    setSelected(null);
    setRadarPlaying(false);
    setTimelineSelection(null);
  }, []);

  const compareHistoryWithNow = useCallback(async () => {
    if (historyState.status !== "ready") return;
    const latestStoredAt = historyRange?.availableTo;
    if (!latestStoredAt) {
      setHistoryComparison({ status: "error", envelope: null, error: "No latest stored record is available." });
      return;
    }
    comparisonRequestRef.current?.abort();
    const controller = new AbortController();
    comparisonRequestRef.current = controller;
    setHistoryComparison((current) => ({ ...current, status: "loading", error: null }));
    try {
      const envelope = await fetchHistorySnapshot(latestStoredAt, controller.signal);
      if (controller.signal.aborted) return;
      setHistoryComparison({
        status: isUsableHistoryEnvelope(envelope) ? "ready" : "error",
        envelope,
        error: isUsableHistoryEnvelope(envelope) ? null : "No latest stored record is available."
      });
    } catch (error) {
      if (controller.signal.aborted) return;
      setHistoryComparison({
        status: "error",
        envelope: null,
        error: error instanceof Error ? error.message : "Comparison service unavailable"
      });
    }
  }, [historyRange?.availableTo, historyState.status]);

  useEffect(() => {
    const mediaQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
    const updateMotionPreference = () => setPrefersReducedMotion(mediaQuery.matches);
    updateMotionPreference();
    mediaQuery.addEventListener("change", updateMotionPreference);
    return () => mediaQuery.removeEventListener("change", updateMotionPreference);
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => {
      if (!entry) return;
      const width = Math.max(1, Math.round(entry.contentRect.width));
      const height = Math.max(1, Math.round(entry.contentRect.height));
      setMapDimensions((current) => current.width === width && current.height === height
        ? current
        : { width, height }
      );
    });
    observer.observe(map);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const updateConnectionStatus = () => setConnectionStatus(navigator.onLine ? "online" : "offline");
    updateConnectionStatus();
    window.addEventListener("online", updateConnectionStatus);
    window.addEventListener("offline", updateConnectionStatus);
    return () => {
      window.removeEventListener("online", updateConnectionStatus);
      window.removeEventListener("offline", updateConnectionStatus);
    };
  }, []);

  useEffect(() => {
    const clearMarkerFocusIntent = (event: FocusEvent) => {
      const target = event.target;
      if (!(target instanceof Element) || !target.closest("[data-map-marker]")) {
        focusedMarkerRef.current = null;
      }
    };
    document.addEventListener("focusin", clearMarkerFocusIntent);
    return () => document.removeEventListener("focusin", clearMarkerFocusIntent);
  }, []);

  useEffect(() => {
    if (prefersReducedMotion) setRadarPlaying(false);
  }, [prefersReducedMotion]);

  useEffect(() => {
    const clock = window.setInterval(() => setWallClockNow(new Date()), 1000);
    return () => window.clearInterval(clock);
  }, []);

  useEffect(() => {
    if (timeMode === "past" || initialHistoryAtRef.current) {
      refreshAllRef.current = async () => undefined;
      setServicesRefreshing(false);
      return;
    }
    let active = true;
    const commit = (merge: (current: LiveSnapshot) => LiveSnapshot) => {
      if (!active) return;
      setLiveSnapshot((current) => {
        const next = merge(current);
        liveSnapshotRef.current = next;
        return next;
      });
    };
    const update = async () => {
      const next = await refreshWeather(liveSnapshotRef.current);
      commit((current) => ({
        ...current,
        generatedAt: next.generatedAt,
        lastSuccessAt: newestTimestamp(current.lastSuccessAt, next.lastSuccessAt),
        sourceStatus: next.sourceStatus,
        stations: next.stations,
        timeline: next.timeline,
        summary: {
          ...current.summary,
          warmest: next.summary.warmest,
          wettest: next.summary.wettest,
          windiest: next.summary.windiest,
          reporting: next.summary.reporting
        }
      }));
    };
    const updateLivingLayers = async () => {
      const next = await refreshLivingLayers(liveSnapshotRef.current);
      commit((current) => ({
        ...current,
        trains: next.trains,
        rivers: next.rivers,
        lastSuccessAt: newestTimestamp(current.lastSuccessAt, next.lastSuccessAt),
        sourceProvenance: next.sourceProvenance ?? current.sourceProvenance,
        summary: {
          ...current.summary,
          runningTrains: next.summary.runningTrains,
          riverStations: next.summary.riverStations
        }
      }));
    };
    const updateCurrentContexts = async () => {
      const next = await refreshCurrentContexts(liveSnapshotRef.current);
      commit((current) => ({
        ...current,
        lastSuccessAt: newestTimestamp(current.lastSuccessAt, next.lastSuccessAt),
        marine: next.marine,
        radar: next.radar,
        grid: next.grid,
        airQuality: next.airQuality,
        aurora: next.aurora,
        tides: next.tides,
        bathingAlerts: next.bathingAlerts,
        iss: next.iss,
        issTle: next.issTle,
        satellite: next.satellite,
        earthquakes: next.earthquakes,
        solar: next.solar,
        forecast: next.forecast,
        contextStatus: next.contextStatus,
        warnings: next.warnings
      }));
      if (active) setRadarFrameIndex(Math.max(0, next.radar.length - 1));
    };
    const updateTransit = async () => {
      const next = await refreshTransit(liveSnapshotRef.current);
      commit((current) => ({
        ...current,
        lastSuccessAt: newestTimestamp(current.lastSuccessAt, next.lastSuccessAt),
        transit: next.transit,
        transitStatus: next.transitStatus
      }));
    };
    const refreshAll = async () => {
      setServicesRefreshing(true);
      try {
        if (navigator.onLine) {
          await Promise.allSettled([update(), updateLivingLayers(), updateCurrentContexts(), updateTransit()]);
        }
      } finally {
        setInitialRefreshComplete(true);
        setLastCheckedAt(new Date());
        setServicesRefreshing(false);
      }
    };
    refreshAllRef.current = refreshAll;
    void refreshAll();
    const recoveryRefresh = window.setTimeout(() => {
      const current = liveSnapshotRef.current;
      const missingCoreService =
        current.stations.length === 0 ||
        current.rivers.length === 0 ||
        current.marine.length === 0 ||
        current.radar.length === 0 ||
        current.transitStatus !== "live";
      if (missingCoreService) {
        void refreshAll();
      }
    }, 20_000);
    const refresh = window.setInterval(() => void update(), 5 * 60_000);
    const livingRefresh = window.setInterval(() => void updateLivingLayers(), 60_000);
    const contextRefresh = window.setInterval(() => void updateCurrentContexts(), 5 * 60_000);
    const transitRefresh = window.setInterval(() => void updateTransit(), 65_000);
    return () => {
      active = false;
      window.clearInterval(refresh);
      window.clearInterval(livingRefresh);
      window.clearInterval(contextRefresh);
      window.clearInterval(transitRefresh);
      window.clearTimeout(recoveryRefresh);
      refreshAllRef.current = async () => undefined;
    };
  }, [timeMode]);

  useEffect(() => () => {
    historyRequestRef.current?.abort();
    comparisonRequestRef.current?.abort();
  }, []);

  useEffect(() => {
    setShowAllNotables(false);
  }, [layers]);

  useEffect(() => {
    const experience = experienceRef.current;
    if (!experience || !selected) return;
    experience.setAttribute("inert", "");
    return () => experience.removeAttribute("inert");
  }, [selected]);

  useEffect(() => {
    const sourceIsCurrent = (selection: Selection) => {
      if (!snapshotReadable) return false;
      if (selection.type === "station") return snapshot.sourceStatus === "live" || snapshot.sourceStatus === "partial";
      if (selection.type === "train") return snapshot.sourceProvenance?.trains.status === "live";
      if (selection.type === "river") return snapshot.sourceProvenance?.rivers.status === "live" || snapshot.sourceProvenance?.rivers.status === "partial" || snapshot.sourceProvenance?.rivers.status === "fallback";
      if (selection.type === "buoy") return snapshot.contextStatus.marine === "live";
      if (selection.type === "air") return selection.item.source === "measured"
        ? snapshot.contextStatus.measuredAir === "live" || snapshot.contextStatus.measuredAir === "fallback"
        : snapshot.contextStatus.modelledAir === "live" || snapshot.contextStatus.modelledAir === "fallback";
      if (selection.type === "tide") return snapshot.contextStatus.tides === "live" || snapshot.contextStatus.tides === "fallback";
      if (selection.type === "bathing") return snapshot.contextStatus.bathing === "live" || snapshot.contextStatus.bathing === "fallback";
      if (selection.type === "earthquake") return snapshot.contextStatus.earthquakes === "live" || snapshot.contextStatus.earthquakes === "fallback";
      return snapshot.transitStatus === "live";
    };
    setSelected((current) => {
      if (!current) return current;
      const currentItems = current.type === "movement-stack" ? current.items : [current];
      return currentItems.every(sourceIsCurrent) ? current : null;
    });
  }, [snapshot.contextStatus, snapshot.sourceProvenance, snapshot.sourceStatus, snapshot.transitStatus, snapshotReadable]);

  const projection = useMemo(
    () => geoMercator().center([-8.05, 53.45]).scale(5350).translate([500, 462]),
    []
  );
  const islandPaths = useMemo(() => {
    const path = geoPath(projection);
    return [path(islandBoundary.features[0] as never) ?? ""];
  }, [projection]);
  const roadPaths = useMemo(() => {
    const path = geoPath(projection);
    return majorRoads.features.map((road) => ({
      path: path(road as never) ?? "",
      roadClass: road.properties.class,
      ref: road.properties.ref
    }));
  }, [projection]);
  const mapViewport = useMemo<MapViewport>(() => ({
    ...mapView,
    width: mapDimensions.width,
    height: mapDimensions.height
  }), [mapDimensions.height, mapDimensions.width, mapView]);
  const isDenseView = (activePreset === "all" || activePreset === "water" || layers.size >= 8) && mapView.scale < 2.4;
  const sourceAirQuality = useMemo(() => {
    if (!snapshotReadable) return [];
    const measured = snapshot.contextStatus.measuredAir === "live" || snapshot.contextStatus.measuredAir === "fallback"
      ? snapshot.airQuality.filter((reading) => reading.source === "measured")
      : [];
    const cells = new Map<string, AirQualityReading>();
    for (const reading of measured) {
      const key = `${Math.round(reading.longitude * 3)}:${Math.round(reading.latitude * 3)}`;
      const current = cells.get(key);
      if (!current || (reading.europeanAqi ?? -1) > (current.europeanAqi ?? -1)) cells.set(key, reading);
    }
    const modelled = snapshot.contextStatus.modelledAir === "live" || snapshot.contextStatus.modelledAir === "fallback"
      ? snapshot.airQuality.filter((reading) =>
          reading.source === "modelled" &&
          !measured.some((station) => Math.hypot(station.longitude - reading.longitude, station.latitude - reading.latitude) < .42)
        )
      : [];
    return [...cells.values(), ...modelled];
  }, [snapshot.airQuality, snapshot.contextStatus.measuredAir, snapshot.contextStatus.modelledAir, snapshotReadable]);
  const displayedStations = useMemo(() => selectDeclutteredPoints(
    projectReadings(
      snapshotReadable && (snapshot.sourceStatus === "live" || snapshot.sourceStatus === "partial")
        ? snapshot.stations.filter((station) => layers.has("weather") || station.windSpeed !== null)
        : [],
      projection,
      (station) => `station:${station.id}`,
      (station) => (station.rainfall ?? 0) > 0 ? 20 : 0
    ),
    mapViewport,
    isDenseView ? (activePreset === "all" ? 38 : 30) : 0,
    activeMarkerId
  ).map(({ item }) => item), [activeMarkerId, activePreset, isDenseView, layers, mapViewport, projection, snapshot.sourceStatus, snapshot.stations, snapshotReadable]);
  const displayedRivers = useMemo(() => selectDeclutteredPoints(
    projectReadings(
      snapshotReadable && (snapshot.sourceProvenance?.rivers.status === "live" || snapshot.sourceProvenance?.rivers.status === "partial" || snapshot.sourceProvenance?.rivers.status === "fallback")
        ? snapshot.rivers
        : [],
      projection,
      (river) => `river:${river.id}`
    ),
    mapViewport,
    isDenseView ? (activePreset === "all" ? 42 : 32) : 0,
    activeMarkerId
  ).map(({ item }) => item), [activeMarkerId, activePreset, isDenseView, mapViewport, projection, snapshot.rivers, snapshot.sourceProvenance?.rivers.status, snapshotReadable]);
  const displayedMarine = useMemo(() => selectDeclutteredPoints(
    projectReadings(
      snapshotReadable && snapshot.contextStatus.marine === "live" ? snapshot.marine : [],
      projection,
      (reading) => `buoy:${reading.id}`,
      (reading) => reading.kind === "weather-buoy" ? 10 : 0
    ),
    mapViewport,
    isDenseView ? 40 : 0,
    activeMarkerId
  ).map(({ item }) => item), [activeMarkerId, isDenseView, mapViewport, projection, snapshot.contextStatus.marine, snapshot.marine, snapshotReadable]);
  const displayedTides = useMemo(() => selectDeclutteredPoints(
    projectReadings(
      snapshotReadable && (snapshot.contextStatus.tides === "live" || snapshot.contextStatus.tides === "fallback") ? snapshot.tides : [],
      projection,
      (tide) => `tide:${tide.id}`,
      (tide) => tide.surge !== null && Math.abs(tide.surge) >= .2 ? 80 : 20
    ),
    mapViewport,
    isDenseView ? 38 : 0,
    activeMarkerId
  ).map(({ item }) => item), [activeMarkerId, isDenseView, mapViewport, projection, snapshot.contextStatus.tides, snapshot.tides, snapshotReadable]);
  const displayedBathingAlerts = useMemo(() => selectDeclutteredPoints(
    projectReadings(
      snapshotReadable && (snapshot.contextStatus.bathing === "live" || snapshot.contextStatus.bathing === "fallback") ? snapshot.bathingAlerts : [],
      projection,
      (alert) => `bathing:${alert.id}`,
      () => 100
    ),
    mapViewport,
    0,
    activeMarkerId
  ).map(({ item }) => item), [activeMarkerId, mapViewport, projection, snapshot.bathingAlerts, snapshot.contextStatus.bathing, snapshotReadable]);
  const bathingMarkerPoints = useMemo(() => {
    const groups = new Map<string, Array<{ id: string; x: number; y: number }>>();
    for (const alert of displayedBathingAlerts) {
      const point = projection([alert.longitude, alert.latitude]);
      if (!point) continue;
      const key = `${point[0].toFixed(4)}:${point[1].toFixed(4)}`;
      const group = groups.get(key) ?? [];
      group.push({ id: alert.id, x: point[0], y: point[1] });
      groups.set(key, group);
    }

    const positions = new Map<string, { x: number; y: number }>();
    const xUnitsPerPixel = 1000 / (Math.max(1, mapDimensions.width) * Math.max(1, mapView.scale));
    const yUnitsPerPixel = 900 / (Math.max(1, mapDimensions.height) * Math.max(1, mapView.scale));
    for (const group of groups.values()) {
      group.sort((first, second) => compareStableIds(first.id, second.id));
      if (group.length === 1) {
        const item = group[0]!;
        positions.set(item.id, { x: item.x, y: item.y });
        continue;
      }
      const columns = Math.ceil(Math.sqrt(group.length));
      const rows = Math.ceil(group.length / columns);
      group.forEach((item, index) => {
        const column = index % columns;
        const row = Math.floor(index / columns);
        positions.set(item.id, {
          x: item.x + (column - (columns - 1) / 2) * 44 * xUnitsPerPixel,
          y: item.y + (row - (rows - 1) / 2) * 44 * yUnitsPerPixel
        });
      });
    }
    return positions;
  }, [displayedBathingAlerts, mapDimensions.height, mapDimensions.width, mapView.scale, projection]);
  const displayedAirQuality = useMemo(() => selectDeclutteredPoints(
    projectReadings(sourceAirQuality, projection, (reading) => `air:${reading.id}`, (reading) => reading.source === "measured" ? 60 : 10),
    mapViewport,
    isDenseView ? 40 : 0,
    activeMarkerId
  ).map(({ item }) => item), [activeMarkerId, isDenseView, mapViewport, projection, sourceAirQuality]);
  const displayedEarthquakes = useMemo(() => selectDeclutteredPoints(
    projectReadings(
      snapshotReadable && (snapshot.contextStatus.earthquakes === "live" || snapshot.contextStatus.earthquakes === "fallback") ? snapshot.earthquakes : [],
      projection,
      (reading) => `earthquake:${reading.id}`,
      (reading) => reading.magnitude * 10
    ),
    mapViewport,
    isDenseView ? 40 : 0,
    activeMarkerId
  ).map(({ item }) => item), [activeMarkerId, isDenseView, mapViewport, projection, snapshot.contextStatus.earthquakes, snapshot.earthquakes, snapshotReadable]);
  const movementStacks = useMemo<MovementStack[]>(() => {
    const points: ProjectedPoint<MovementSelection>[] = [];

    if (timeMode !== "past" && snapshotReadable && layers.has("trains") && snapshot.sourceProvenance?.trains.status === "live") {
      const orderedTrains = deduplicateMovementRecords(snapshot.trains);
      for (const train of orderedTrains) {
        const point = projection([train.longitude, train.latitude]);
        if (point) {
          points.push({
            key: `train:${train.id}`,
            x: point[0],
            y: point[1],
            item: { type: "train", item: train },
            priority: 20
          });
        }
      }
    }
    if (timeMode !== "past" && snapshotReadable && layers.has("transit") && snapshot.transitStatus === "live") {
      for (const vehicle of deduplicateMovementRecords(snapshot.transit)) {
        const point = projection([vehicle.longitude, vehicle.latitude]);
        if (!point) continue;
        points.push({
          key: `transit:${vehicle.id}`,
          x: point[0],
          y: point[1],
          item: { type: "transit", item: vehicle },
          priority: 10
        });
      }
    }
    const focusedMovementIdentity = activeMarkerId?.startsWith("movement:")
      ? activeMarkerId.slice("movement:".length)
      : null;
    const clusterRadius = mapDimensions.width < 600
      ? 64
      : mapDimensions.width < 900
        ? 54
        : 44;
    return clusterProjectedPoints(
      points,
      mapViewport,
      clusterRadius + (activePreset === "all" ? 8 : 0),
      focusedMovementIdentity
    ).map((cluster) => {
      const items = cluster.items.map((point) => point.item);
      const trainPoint = cluster.items.find((point) => point.item.type === "train");
      return {
        key: movementMarkerId(cluster.key),
        x: trainPoint?.x ?? cluster.x,
        y: trainPoint?.y ?? cluster.y,
        items
      };
    });
  }, [activeMarkerId, activePreset, layers, mapDimensions.width, mapViewport, projection, snapshot.sourceProvenance?.trains.status, snapshot.trains, snapshot.transit, snapshot.transitStatus, snapshotReadable, timeMode]);
  const markerIds = useMemo(() => {
    const ids: string[] = [];

    if (layers.has("rivers")) {
      displayedRivers.forEach((river) => ids.push(`river:${river.id}`));
    }
    if (layers.has("sea")) {
      displayedMarine.forEach((marineSite) => ids.push(`buoy:${marineSite.id}`));
    }
    if (layers.has("tides")) {
      displayedTides.forEach((tide) => ids.push(`tide:${tide.id}`));
    }
    if (layers.has("bathing")) {
      displayedBathingAlerts.forEach((alert) => ids.push(`bathing:${alert.id}`));
    }
    if (layers.has("weather") || layers.has("wind")) {
      displayedStations.forEach((station) => ids.push(`station:${station.id}`));
    }
    if (layers.has("air")) {
      displayedAirQuality.forEach((reading) => ids.push(`air:${reading.id}`));
    }
    if (layers.has("trains") || layers.has("transit")) {
      movementStacks.forEach((stack) => ids.push(stack.key));
    }
    if (layers.has("earthquakes")) {
      displayedEarthquakes.forEach((earthquake) => ids.push(`earthquake:${earthquake.id}`));
    }
    return ids;
  }, [displayedAirQuality, displayedBathingAlerts, displayedEarthquakes, displayedMarine, displayedRivers, displayedStations, displayedTides, layers, movementStacks]);
  const rovingMarkerId = activeMarkerId && markerIds.includes(activeMarkerId)
    ? activeMarkerId
    : markerIds[0] ?? null;
  const rawPointMarkerCount =
    (snapshotReadable && layers.has("rivers") && (snapshot.sourceProvenance?.rivers.status === "live" || snapshot.sourceProvenance?.rivers.status === "partial" || snapshot.sourceProvenance?.rivers.status === "fallback") ? snapshot.rivers.length : 0) +
    (snapshotReadable && layers.has("sea") && snapshot.contextStatus.marine === "live" ? snapshot.marine.length : 0) +
    (snapshotReadable && layers.has("tides") && (snapshot.contextStatus.tides === "live" || snapshot.contextStatus.tides === "fallback") ? snapshot.tides.length : 0) +
    (snapshotReadable && layers.has("bathing") && (snapshot.contextStatus.bathing === "live" || snapshot.contextStatus.bathing === "fallback") ? snapshot.bathingAlerts.length : 0) +
    (snapshotReadable && (snapshot.sourceStatus === "live" || snapshot.sourceStatus === "partial") && (layers.has("weather") || layers.has("wind")) ? snapshot.stations.filter((station) => layers.has("weather") || station.windSpeed !== null).length : 0) +
    (layers.has("air") ? sourceAirQuality.length : 0) +
    (timeMode !== "past" && snapshotReadable && layers.has("trains") && snapshot.sourceProvenance?.trains.status === "live" ? deduplicateMovementRecords(snapshot.trains).length : 0) +
    (timeMode !== "past" && snapshotReadable && layers.has("transit") && snapshot.transitStatus === "live" ? deduplicateMovementRecords(snapshot.transit).length : 0) +
    (snapshotReadable && layers.has("earthquakes") && (snapshot.contextStatus.earthquakes === "live" || snapshot.contextStatus.earthquakes === "fallback") ? snapshot.earthquakes.length : 0);
  const visibleLayerGroups = LAYER_GROUPS;
  const activeLegendGroups = useMemo(() => visibleLayerGroups.map((group) => ({
    id: group.id,
    label: group.label,
    layers: group.layers.filter(([id]) => layers.has(id)).map(([, label]) => label)
  })).filter((group) => group.layers.length > 0), [layers, visibleLayerGroups]);
  const densitySummary = markerIds.length < rawPointMarkerCount
    ? `${markerIds.length} grouped markers represent ${rawPointMarkerCount} point observations at this zoom. Zoom in to reveal more.`
    : `${markerIds.length} point marker${markerIds.length === 1 ? "" : "s"} visible at this zoom.`;

  useLayoutEffect(() => {
    const focusedMarker = focusedMarkerRef.current;
    if (!focusedMarker || !markerIds.includes(focusedMarker.id)) return;

    const activeElement = document.activeElement;
    if (activeElement instanceof Element && activeElement.isConnected && activeElement.closest("[data-map-marker]")) return;
    if (activeElement && activeElement !== document.body && activeElement !== document.documentElement) return;

    const replacement = [...(mapRef.current?.querySelectorAll<SVGGElement>("[data-map-marker]") ?? [])]
      .find((candidate) => candidate.getAttribute("data-marker-id") === focusedMarker.id);
    if (!replacement || replacement === focusedMarker.element || !replacement.isConnected) return;
    replacement.focus({ preventScroll: true });
  }, [markerIds]);

  useEffect(() => {
    setActiveMarkerId((current) => current && markerIds.includes(current) ? current : markerIds[0] ?? null);
  }, [markerIds]);

  useEffect(() => {
    if (typeof IntersectionObserver === "undefined") return;
    const sections = EXPERIENCE_SECTIONS
      .map((section) => {
        const element = document.getElementById(section.id);
        return element ? { key: section.key, element } : null;
      })
      .filter((section): section is { key: ExperienceSection; element: HTMLElement } => section !== null);
    if (!sections.length) return;

    const observer = new IntersectionObserver((entries) => {
      const visible = entries
        .filter((entry) => entry.isIntersecting)
        .sort((first, second) => second.intersectionRatio - first.intersectionRatio)[0];
      if (!visible) return;
      const active = sections.find((section) => section.element === visible.target);
      if (active) setActiveSection(active.key);
    }, {
      rootMargin: "-18% 0px -52% 0px",
      threshold: [0.2, 0.45, 0.7]
    });

    sections.forEach((section) => observer.observe(section.element));
    return () => observer.disconnect();
  }, []);

  const weatherNarrativeDetail = weatherNarrative(snapshot);
  const currentSolar = snapshot.contextStatus.solar === "live" ? snapshot.solar : null;
  const daylight = authoritativeSolarProgress(currentSolar, now);
  const sunX = 880 - daylight * 760;
  const sunY = 145 - Math.sin(daylight * Math.PI) * 105;
  const currentHour = irelandHour(now);
  const dayPhase = authoritativeDayPhase(currentSolar, now);
  const isNight = currentSolar
    ? dayPhase === "night"
    : currentHour < 6 || currentHour >= 21;
  const selectedPlace = ephemeralPlace ?? PLACE_OPTIONS.find((place) => place.id === selectedPlaceId) ?? PLACE_OPTIONS[0]!;
  const selectedPlaceIsEphemeral = selectedPlace.id === "nearby";
  const selectedPlacePoint = selectedPlace.id === "island"
    ? null
    : projection([selectedPlace.lon, selectedPlace.lat]);
  const localStation = selectedPlace.id === "island"
    ? null
    : nearestReadingWithinRadius(
        snapshotReadable && (snapshot.sourceStatus === "live" || snapshot.sourceStatus === "partial")
          ? snapshot.stations.filter((station) => station.fresh)
          : [],
        selectedPlace,
        selectedPlaceIsEphemeral ? Number.POSITIVE_INFINITY : NEARBY_RADIUS_KM.weather
      );
  const localRiver = selectedPlace.id === "island"
    ? null
    : nearestReadingWithinRadius(
        snapshotReadable && (snapshot.sourceProvenance?.rivers.status === "live" || snapshot.sourceProvenance?.rivers.status === "partial" || snapshot.sourceProvenance?.rivers.status === "fallback")
          ? snapshot.rivers.filter((river) => river.fresh)
          : [],
        selectedPlace,
        selectedPlaceIsEphemeral ? Number.POSITIVE_INFINITY : NEARBY_RADIUS_KM.river
      );
  const localAir = selectedPlace.id === "island"
    ? null
    : nearestReadingWithinRadius(
        (snapshotReadable && (snapshot.contextStatus.measuredAir === "live" || snapshot.contextStatus.measuredAir === "fallback") ? snapshot.airQuality : [])
          .filter((reading) => reading.source === "measured")
          .sort((first, second) => Date.parse(second.observedAt) - Date.parse(first.observedAt)),
        selectedPlace,
        selectedPlaceIsEphemeral ? Number.POSITIVE_INFINITY : NEARBY_RADIUS_KM.air
      ) ?? nearestReadingWithinRadius(
        (snapshotReadable && (snapshot.contextStatus.modelledAir === "live" || snapshot.contextStatus.modelledAir === "fallback") ? snapshot.airQuality : [])
          .filter((reading) => reading.source === "modelled")
          .sort((first, second) => Date.parse(second.observedAt) - Date.parse(first.observedAt)),
        selectedPlace,
        selectedPlaceIsEphemeral ? Number.POSITIVE_INFINITY : NEARBY_RADIUS_KM.air
      );
  const warningsUnavailable = !snapshotReadable || snapshot.contextStatus.warnings !== "live";
  const guidancePlace: GuidancePlace = {
    id: selectedPlace.id,
    name: selectedPlace.name,
    latitude: selectedPlace.lat,
    longitude: selectedPlace.lon
  };
  const activityGuidance = getActivityGuidance(snapshot, now, guidancePlace);
  const selectedTimelinePoint = snapshot.timeline.find((point) => point.time === timelineSelection) ?? null;
  const timelineTemperatures = snapshot.timeline
    .map((point) => point.temperature)
    .filter((value): value is number => value !== null && Number.isFinite(value));
  const timelineTemperatureMin = timelineTemperatures.length
    ? Math.floor(Math.min(...timelineTemperatures) - 1)
    : 0;
  const timelineTemperatureMax = timelineTemperatures.length
    ? Math.ceil(Math.max(...timelineTemperatures) + 1)
    : 20;
  const timelineTemperatureRange = Math.max(1, timelineTemperatureMax - timelineTemperatureMin);
  const timelineRainValues = snapshot.timeline
    .map((point) => point.rainfall)
    .filter((value): value is number => value !== null && Number.isFinite(value));
  const timelineRainMax = Math.max(1, ...timelineRainValues);
  const visibleWarnings = warningsUnavailable ? [] : sortOfficialWeatherWarnings(snapshot.warnings, now.getTime());
  const currentWarnings = visibleWarnings.filter((warning) => warningTiming(warning, now.getTime()) === "active");
  const activeWarning = currentWarnings[0] ?? null;
  const unusualTide = snapshot.tides
    .filter((tide) => tide.surge !== null)
    .sort((a, b) => Math.abs(b.surge ?? 0) - Math.abs(a.surge ?? 0))[0] ?? null;
  const largestEarthquake = [...snapshot.earthquakes].sort((a, b) => b.magnitude - a.magnitude)[0] ?? null;
  const visibleIssPass = snapshot.iss?.passes.find((pass) => pass.visible) ?? null;
  const showRainNotable = layers.has("rain");
  const showBathingNotables = layers.has("bathing");
  const showTideNotable = layers.has("tides");
  const showEarthquakeNotable = layers.has("earthquakes");
  const showIssNotable = layers.has("iss");
  const latestWeatherObs = snapshot.stations.length
    ? snapshot.stations.reduce((latest, station) => {
        const ts = Date.parse(station.observedAt ?? "");
        return Number.isFinite(ts) && ts > latest ? ts : latest;
      }, 0)
    : 0;
  const latestTrainObs = snapshot.trains.length
    ? snapshot.trains.reduce((latest, train) => {
        const ts = Date.parse(train.observedAt);
        return Number.isFinite(ts) && ts > latest ? ts : latest;
      }, 0)
    : 0;
  const latestRiverObs = snapshot.rivers.length
    ? snapshot.rivers.reduce((latest, river) => {
        const ts = Date.parse(river.observedAt);
        return Number.isFinite(ts) && ts > latest ? ts : latest;
      }, 0)
    : 0;
  const weatherStale = isDataStale(
    latestWeatherObs > 0 ? new Date(latestWeatherObs).toISOString() : null,
    STALE_THRESHOLDS.weather,
    now.getTime()
  );
  const transitStale = isDataStale(
    latestTrainObs > 0 ? new Date(latestTrainObs).toISOString() : null,
    STALE_THRESHOLDS.transit,
    now.getTime()
  );
  const riverDataStale = isDataStale(
    latestRiverObs > 0 ? new Date(latestRiverObs).toISOString() : null,
    STALE_THRESHOLDS.rivers,
    now.getTime()
  );
  const networkOnline = connectionStatus === "online";
  const online = snapshotReadable;
  const radarLayerActive = layers.has("radar");
  const radarFrames = timeMode !== "past" && online && !radarHistoryGap && snapshot.contextStatus.radar === "live" ? snapshot.radar : [];
  const radarFrame = radarFrames[Math.min(radarFrameIndex, Math.max(0, radarFrames.length - 1))] ?? null;
  const radarFrameKey = radarFrame ? `${radarFrame.id}:${radarFrame.modifiedTime}` : null;
  activeRadarFrameKeyRef.current = radarLayerActive ? radarFrameKey : null;
  const reportRadarTileStatus = useCallback<RadarTileStatusReporter>((frameKey, tileKey, status) => {
    if (frameKey !== activeRadarFrameKeyRef.current) return;
    setRadarTileState((current) => {
      const tiles = current?.frameKey === frameKey ? current.tiles : createRadarTileStatusRecord();
      if (current?.frameKey === frameKey && tiles[tileKey] === status) return current;
      return { frameKey, tiles: { ...tiles, [tileKey]: status } };
    });
  }, []);
  useEffect(() => {
    setRadarTileState(radarLayerActive && radarFrameKey
      ? { frameKey: radarFrameKey, tiles: createRadarTileStatusRecord() }
      : null);
  }, [radarFrameKey, radarLayerActive]);
  const radarTileStatuses = radarFrameKey && radarTileState?.frameKey === radarFrameKey
    ? Object.values(radarTileState.tiles)
    : [];
  const radarReadyCount = radarTileStatuses.filter((status) => status === "ready").length;
  const radarUnavailableCount = radarTileStatuses.filter((status) => status === "unavailable").length;
  const radarTileCount = IRELAND_RADAR_TILES.length;
  const radarPresentationState: RadarPresentationState = !online
    ? "unavailable"
    : snapshot.contextStatus.radar === "stale" && snapshot.radar.length
      ? "cached"
      : !radarFrame
        ? "unavailable"
        : !radarLayerActive
          ? "unchecked"
          : radarReadyCount === radarTileCount
            ? "live"
            : radarUnavailableCount === radarTileCount
              ? "unavailable"
              : radarReadyCount + radarUnavailableCount === radarTileCount && radarReadyCount > 0
                ? "partial"
                : "loading";
  useEffect(() => {
    if (!radarPlaying || prefersReducedMotion || !radarLayerActive || radarFrames.length < 2) return;
    if (radarPresentationState === "partial" || radarPresentationState === "unavailable" || radarPresentationState === "cached") {
      setRadarPlaying(false);
      return;
    }
    if (radarPresentationState !== "live") return;
    const animation = window.setInterval(() => {
      setRadarFrameIndex((index) => (index + 1) % radarFrames.length);
    }, 850);
    return () => window.clearInterval(animation);
  }, [prefersReducedMotion, radarFrames.length, radarLayerActive, radarPlaying, radarPresentationState]);
  const trainsLive = online && snapshot.sourceProvenance?.trains.status === "live";
  const trainsCached = snapshot.sourceProvenance?.trains.status === "stale" || (!online && snapshot.sourceProvenance?.trains.status === "live" && snapshot.trains.length > 0);
  const riversLive = online && snapshot.sourceProvenance?.rivers.status === "live";
  const riversPartial = online && snapshot.sourceProvenance?.rivers.status === "partial" && snapshot.rivers.length > 0;
  const riversCached = snapshot.sourceProvenance?.rivers.status === "stale" || (!online && (snapshot.sourceProvenance?.rivers.status === "live" || snapshot.sourceProvenance?.rivers.status === "fallback" || snapshot.sourceProvenance?.rivers.status === "partial") && snapshot.rivers.length > 0);
  const riversFallback = online && snapshot.sourceProvenance?.rivers.status === "fallback";
  const riversAvailable = riversLive || riversPartial || riversCached || riversFallback;
  const weatherNotableCurrent = online && (snapshot.sourceStatus === "live" || snapshot.sourceStatus === "partial") && !weatherStale;
  const railNotableCurrent = trainsLive && !transitStale;
  const gridNotableCurrent = online && snapshot.contextStatus.grid === "live";
  const gridSnapshotDisplayable = Boolean(
    snapshot.grid && (gridNotableCurrent || snapshot.contextStatus.grid === "stale" || !online)
  );
  const gridWindShare = gridSnapshotDisplayable ? snapshot.grid?.windSharePercent ?? null : null;
  const bathingNotableCurrent = online && snapshot.contextStatus.bathing === "live";
  const tideNotableCurrent = online && snapshot.contextStatus.tides === "live";
  const earthquakeNotableCurrent = online && snapshot.contextStatus.earthquakes === "live";
  const issNotableCurrent = online && snapshot.contextStatus.iss === "live";
  const hasVisibleNotable =
    Boolean(showRainNotable && weatherNotableCurrent && snapshot.summary.wettest && (snapshot.summary.wettest.rainfall ?? 0) > 0.5) ||
    Boolean(showBathingNotables && bathingNotableCurrent && snapshot.bathingAlerts.length) ||
    Boolean(showTideNotable && tideNotableCurrent && unusualTide && Math.abs(unusualTide.surge ?? 0) >= .15) ||
    Boolean(showEarthquakeNotable && earthquakeNotableCurrent && largestEarthquake) ||
    Boolean(showIssNotable && issNotableCurrent && visibleIssPass);
  const notableItemCount =
    (showRainNotable && weatherNotableCurrent && snapshot.summary.wettest && (snapshot.summary.wettest.rainfall ?? 0) > 0.5 ? 1 : 0) +
    (showBathingNotables && bathingNotableCurrent ? snapshot.bathingAlerts.length : 0) +
    (showTideNotable && tideNotableCurrent && unusualTide && Math.abs(unusualTide.surge ?? 0) >= .15 ? 1 : 0) +
    (showEarthquakeNotable && earthquakeNotableCurrent && largestEarthquake ? 1 : 0) +
    (showIssNotable && issNotableCurrent && visibleIssPass ? 1 : 0);
  const assessmentSnapshot = radarLayerActive && radarPresentationState !== "live"
    ? { ...snapshot, contextStatus: { ...snapshot.contextStatus, radar: "unavailable" as const } }
    : snapshot;
  const assessedSources = getSelectedSourceAssessment(assessmentSnapshot, layers, now.getTime());
  const selectedSourceAssessment = timeMode === "past" && !online
    ? {
        assessedSourceCount: 0,
        fullyAssessed: false,
        unavailableSources: [...new Set(historyGaps.map((gap) => gap.source))]
      }
    : online ? assessedSources : {
        ...assessedSources,
        fullyAssessed: false,
        unavailableSources: ["offline connection", ...assessedSources.unavailableSources]
      };
  const weatherBuoyCount = snapshot.marine.filter((reading) => reading.kind === "weather-buoy").length;
  const coastalObservatoryCount = snapshot.marine.length - weatherBuoyCount;
  const serviceDisplayState = timeMode === "past"
    ? historyState.status === "loading" || historyState.status === "idle"
      ? "connecting"
      : historyState.status === "ready"
        ? "cached"
        : "unavailable"
    : getServiceDisplayState(snapshot, {
        initialRefreshComplete,
        refreshing: servicesRefreshing,
        online: networkOnline,
        now: now.getTime()
      });
  const isConnectingWithoutSnapshot = timeMode === "past"
    ? historyState.status === "loading" && !historyState.envelope?.snapshot
    : serviceDisplayState === "connecting";
  const weatherDisplayStatus = online ? snapshot.sourceStatus : snapshot.stations.length ? "stale" : "unavailable";
  const trainDisplayStatus = online ? snapshot.sourceProvenance?.trains.status ?? "unavailable" : snapshot.trains.length ? "stale" : "unavailable";
  const riverDisplayStatus = online ? snapshot.sourceProvenance?.rivers.status ?? "unavailable" : snapshot.rivers.length ? "stale" : "unavailable";
  const lastSuccessLabel = timeMode === "past" && historyState.envelope?.resolvedAt
    ? formatIrelandHistoryTime(historyState.envelope.resolvedAt)
    : snapshot.lastSuccessAt ? formatAge(snapshot.lastSuccessAt, now) : "not yet";
  const connectionLabel = timeMode === "past"
    ? historyState.status === "loading"
      ? "Loading stored conditions"
      : historyState.status === "ready"
        ? "Stored historical snapshot"
        : "Historical snapshot unavailable"
    : ({
    connecting: "Connecting to live services",
    refreshing: "Loading live updates",
    offline: snapshot.lastSuccessAt ? "Offline · saved snapshot" : "Offline · no saved snapshot",
    cached: "Online · cached data shown",
    stale: "Online · observations stale",
    unavailable: "Online · services unavailable",
    degraded: "Online · partial service",
    live: "Online · live"
      } as const)[serviceDisplayState];
  const radarAvailabilityNotice = radarPresentationState === "live"
    ? {
        title: "Rainfall radar",
        detail: `${snapshot.radar.length} Met Éireann ${snapshot.radar.length === 1 ? "frame is" : "frames are"} available; all ${radarTileCount} Ireland tiles loaded for the displayed frame.`
      }
    : radarPresentationState === "partial"
      ? {
          title: "Partial rainfall radar coverage",
          detail: `${radarReadyCount} of ${radarTileCount} Ireland tiles loaded for this frame. Displayed imagery is incomplete, so precipitation in the missing areas cannot be assessed.`
        }
      : radarPresentationState === "loading"
        ? {
            title: "Loading rainfall radar tiles",
            detail: `${radarReadyCount} of ${radarTileCount} Ireland tiles have loaded; ${radarUnavailableCount} failed while the remaining tiles settle. No complete precipitation view is claimed yet.`
          }
        : radarPresentationState === "cached"
          ? {
              title: "Cached rainfall radar",
              detail: `${snapshot.radar.length} cached frame${snapshot.radar.length === 1 ? " is" : "s are"} retained from the last successful refresh; current precipitation imagery is unavailable.`
            }
          : radarPresentationState === "unchecked"
            ? {
                title: "Rainfall radar not loaded",
                detail: "Frame metadata is available, but the Ireland image tiles have not been requested in this view."
              }
            : {
                title: "Rainfall radar unavailable",
                detail: radarFrame && radarUnavailableCount === radarTileCount
                  ? `Frame metadata was available, but none of the ${radarTileCount} Ireland tiles loaded. Current precipitation imagery cannot be assessed.`
                  : "Met Éireann radar imagery is unavailable, so current precipitation cannot be assessed."
              };
  const displayedMapNotice = timeMode === "past" && mapNotice
    ? (() => {
        const gap = mapNotice.focus ? historyGapForFocus(historyGaps, mapNotice.focus) : null;
        return gap
          ? { title: `${gap.source} unavailable in this record`, detail: gap.detail, focus: mapNotice.focus }
          : {
              title: isDailyHistorySummary ? "Point map unavailable for this daily summary" : "Stored conditions at the selected time",
              detail: isDailyHistorySummary
                ? "Daily retention preserves summary values and coverage gaps, not a reconstructed point-by-point map."
                : "This layer uses only values retained in the selected historical record. Missing detail is not replaced with newer observations.",
              focus: mapNotice.focus
            };
      })()
    : mapNotice?.focus === "radar"
      ? online
        ? { ...radarAvailabilityNotice, focus: "radar" as const }
        : {
            title: "Offline · radar not current",
            detail: `Radar tiles cannot be refreshed while offline. Last successful refresh ${lastSuccessLabel}; saved metadata is not presented as current precipitation imagery.`,
            focus: "radar" as const
          }
      : mapNotice;
  const radarTimelineText = radarPresentationState === "live"
    ? `Observed precipitation · all ${radarTileCount} Ireland tiles loaded`
    : radarPresentationState === "partial"
      ? `Partial radar coverage · ${radarReadyCount} of ${radarTileCount} Ireland tiles loaded`
      : radarPresentationState === "loading"
        ? `Loading radar tiles · ${radarReadyCount} of ${radarTileCount} loaded`
        : radarPresentationState === "cached"
          ? "Cached radar metadata · current imagery unavailable"
        : radarFrame && radarUnavailableCount === radarTileCount
          ? `Radar tiles unavailable · 0 of ${radarTileCount} Ireland tiles loaded · current precipitation cannot be assessed`
          : "Radar tiles unavailable · current precipitation cannot be assessed";
  const radarFrameValueText = radarFrame
    ? radarPresentationState === "live"
      ? `Radar imagery loaded for ${formatTime(new Date(radarFrame.observedAt))}`
      : radarPresentationState === "partial"
        ? `Partial radar imagery for ${formatTime(new Date(radarFrame.observedAt))}; ${radarReadyCount} of ${radarTileCount} tiles loaded`
        : radarPresentationState === "loading"
          ? `Radar tiles loading for ${formatTime(new Date(radarFrame.observedAt))}`
          : `Radar imagery unavailable for ${formatTime(new Date(radarFrame.observedAt))}`
    : "Radar frame unavailable";
  const activeNoticeCount = currentWarnings.length;
  const upcomingNoticeCount = Math.max(0, visibleWarnings.length - activeNoticeCount);
  const liveSignals = [
    activeNoticeCount > 0
      ? `${formatCount(activeNoticeCount)} official ${pluralise(activeNoticeCount, "notice")} ${activeNoticeCount === 1 ? "is" : "are"} in effect`
      : upcomingNoticeCount > 0
        ? `${formatCount(upcomingNoticeCount)} official ${pluralise(upcomingNoticeCount, "notice")} ${upcomingNoticeCount === 1 ? "is" : "are"} due later`
        : null,
    railNotableCurrent && runningTrainCount !== null
      ? runningTrainCount === 1
        ? "1 train shares a live position"
        : `${formatCount(runningTrainCount)} trains share live positions`
      : null,
    riversLive && !riverDataStale && riverStationCount !== null
      ? `${formatCount(riverStationCount)} ${pluralise(riverStationCount, "river gauge")} ${riverStationCount === 1 ? "is" : "are"} reporting`
      : riversPartial
        ? `${formatCount(snapshot.rivers.length)} river readings are available with partial coverage`
        : null,
    online && snapshot.contextStatus.marine === "live" && snapshot.marine.length > 0
      ? `${formatCount(snapshot.marine.length)} ${pluralise(snapshot.marine.length, "marine site")} ${snapshot.marine.length === 1 ? "is" : "are"} reporting`
      : null,
    gridNotableCurrent && gridWindShare !== null
      ? `wind supplies ${gridWindShare.toFixed(0)}% of all-island demand`
      : null
  ].filter((signal): signal is string => Boolean(signal));
  const heroSentence = timeMode === "past"
    ? historyState.status === "loading"
      ? "Loading stored observations for the selected time…"
      : historyState.status === "error"
        ? "Historical conditions could not be loaded. Live data is not substituted."
        : historyState.status === "gap"
          ? "No stored record exists at or before the selected time. Missing history remains missing."
          : `${irelandEditorialMoment(now)} ${isDailyHistorySummary
            ? `This stored ${historyResolutionLabel(historyState.envelope?.resolutionMinutes ?? 1440)} preserves summary values and explicit gaps rather than a reconstructed point map.`
            : "Stored observations are separated from live feeds and keep provider timestamps and recorded gaps."}`
    : isConnectingWithoutSnapshot
      ? "Connecting to live observations across the island…"
      : servicesRefreshing
        ? "Loading fresh observations across the island…"
        : serviceDisplayState === "offline"
          ? `Offline. Showing the last saved observations where available; last success ${lastSuccessLabel}.`
          : serviceDisplayState === "cached"
            ? `A refresh failed. Cached observations are labelled and last succeeded ${lastSuccessLabel}.`
            : serviceDisplayState === "unavailable"
              ? "Live services are unavailable, so national conditions cannot be assessed."
              : `${irelandEditorialMoment(now)} ${liveSignals.length ? `${joinClauses(liveSignals.slice(0, 3))}.` : weatherNarrativeDetail}`;
  const heroSecondary = timeMode === "past"
    ? `Stored observations from ${lastSuccessLabel}.`
    : weatherNotableCurrent
      ? weatherNarrativeDetail
      : weatherDisplayStatus === "stale"
        ? "Weather observations are cached and kept separate from the live story."
        : "Weather observations are currently unavailable, so they are not used to frame the first impression.";
  const heroFacts = [
    !warningsUnavailable
      ? {
          key: "warnings",
          family: "notices",
          label: activeNoticeCount > 0 ? "official notices" : upcomingNoticeCount > 0 ? "notice outlook" : "official notices",
          value: activeNoticeCount > 0
            ? formatCount(activeNoticeCount)
            : upcomingNoticeCount > 0
              ? formatCount(upcomingNoticeCount)
              : "Clear",
          detail: activeNoticeCount > 0
            ? `${activeNoticeCount === 1 ? "Notice" : "Notices"} now in effect`
            : upcomingNoticeCount > 0
              ? `${upcomingNoticeCount === 1 ? "Notice" : "Notices"} due later`
              : "No current or upcoming notices",
          onClick: () => document.getElementById("official-notices")?.scrollIntoView({ behavior: prefersReducedMotion ? "auto" : "smooth", block: "start" })
        }
      : null,
    railNotableCurrent && runningTrainCount !== null
      ? {
          key: "trains",
          family: "movement",
          label: "rail positions",
          value: formatCount(runningTrainCount),
          detail: runningTrainCount === 1 ? "1 train sharing a live position" : `${formatCount(runningTrainCount)} trains sharing live positions`,
          onClick: () => focusContext("trains")
        }
      : null,
    riversAvailable && (riverStationCount ?? snapshot.rivers.length) > 0
      ? {
          key: "rivers",
          family: "water",
          label: "river gauges",
          value: formatCount(riverStationCount ?? snapshot.rivers.length),
          detail: riversLive && !riverDataStale
            ? "Fresh river readings across the island"
            : riversPartial
              ? "Recent readings with partial coverage"
              : riversFallback
                ? "Labelled fallback coverage"
                : "Saved river context",
          onClick: () => focusContext("rivers")
        }
      : null,
    gridWindShare !== null
      ? {
          key: "grid",
          family: "energy",
          label: "wind share",
          value: `${gridWindShare.toFixed(0)}%`,
          detail: gridNotableCurrent ? "All-island demand met by wind" : "Saved grid snapshot",
          onClick: () => focusContext("grid")
        }
      : null,
    online && snapshot.contextStatus.marine === "live" && snapshot.marine.length > 0
      ? {
          key: "marine",
          family: "sea",
          label: "marine sites",
          value: formatCount(snapshot.marine.length),
          detail: "Weather buoys and coastal observatories reporting",
          onClick: () => focusContext("sea")
        }
      : null,
    weatherNotableCurrent && reportingCount !== null
      ? {
          key: "weather",
          family: "weather",
          label: "weather stations",
          value: formatCount(reportingCount),
          detail: snapshot.summary.warmest
            ? `${snapshot.summary.warmest.temperature}° at ${snapshot.summary.warmest.name}`
            : "Fresh observations across the island",
          onClick: () => focusContext("weather")
        }
      : null
  ].filter((fact): fact is {
    key: string;
    family: string;
    label: string;
    value: string;
    detail: string;
    onClick: () => void;
  } => fact !== null).slice(0, 4);
  const mapAnchorLayoutKey = [
    activePreset,
    [...layers].sort().join(","),
    heroSentence,
    heroSecondary,
    heroFacts.map((fact) => `${fact.key}:${fact.value}:${fact.detail}`).join("|")
  ].join("::");
  const constrainMapView = useCallback((scale: number, x: number, y: number) => {
    const nextScale = Math.min(4, Math.max(1, scale));
    return {
      scale: nextScale,
      x: Math.min(0, Math.max(1000 * (1 - nextScale), x)),
      y: Math.min(0, Math.max(900 * (1 - nextScale), y))
    };
  }, []);
  const zoomMapAround = useCallback((factor: number, point = { x: 500, y: 450 }) => {
    setMapView((current) => {
      const scale = Math.min(4, Math.max(1, current.scale * factor));
      const ratio = scale / current.scale;
      return constrainMapView(
        scale,
        point.x - (point.x - current.x) * ratio,
        point.y - (point.y - current.y) * ratio
      );
    });
  }, [constrainMapView]);
  const activateMovementStack = useCallback((stack: MovementStack) => {
    setActiveMarkerId(stack.key);
    if (stack.items.length > MOVEMENT_DRILL_THRESHOLD && mapView.scale < 4) {
      setMapView((current) => {
        const scale = Math.min(4, Math.max(current.scale + 1, current.scale * 2));
        return constrainMapView(scale, 500 - stack.x * scale, 450 - stack.y * scale);
      });
      setSelected(null);
      setMapFeedback(`Zoomed in on ${stack.items.length} transport positions. Select a cluster again to drill down or open the result list.`);
      setMarkerAnnouncement(`${stack.items.length} transport positions; map zoomed in.`);
      return;
    }
    markerOpenerRef.current = [...(mapRef.current?.querySelectorAll<SVGElement>("[data-map-marker]") ?? [])]
      .find((candidate) => candidate.getAttribute("data-marker-id") === stack.key) ?? markerOpenerRef.current;
    setSelected({ type: "movement-stack", items: stack.items, index: 0 });
  }, [constrainMapView, mapView.scale]);
  const mapPointFromClient = useCallback((clientX: number, clientY: number) => {
    const bounds = mapRef.current?.getBoundingClientRect();
    if (!bounds) return { x: 500, y: 450 };
    return {
      x: (clientX - bounds.left) * 1000 / bounds.width,
      y: (clientY - bounds.top) * 900 / bounds.height
    };
  }, []);
  const handleMarkerFocus = useCallback((markerId: string, label: string, event: ReactFocusEvent<SVGGElement>) => {
    const index = markerIds.indexOf(markerId);
    if (index < 0) return;
    focusedMarkerRef.current = { id: markerId, element: event.currentTarget };
    setActiveMarkerId(markerId);
    setMarkerAnnouncement(`${label}, item ${index + 1} of ${markerIds.length}`);
  }, [markerIds]);
  const focusMarker = useCallback((markerId: string) => {
    const marker = [...(mapRef.current?.querySelectorAll<SVGGElement>("[data-map-marker]") ?? [])]
      .find((candidate) => candidate.getAttribute("data-marker-id") === markerId);
    if (!marker) return;
    setActiveMarkerId(markerId);
    marker.focus();
  }, []);
  const handleMarkerKeyDown = useCallback((
    event: ReactKeyboardEvent<SVGGElement>,
    markerId: string,
    onActivate: () => void
  ) => {
    const index = markerIds.indexOf(markerId);
    if (index < 0) return;
    let destinationIndex: number | null = null;
    if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
      destinationIndex = (index - 1 + markerIds.length) % markerIds.length;
    } else if (event.key === "ArrowRight" || event.key === "ArrowDown") {
      destinationIndex = (index + 1) % markerIds.length;
    } else if (event.key === "Home") {
      destinationIndex = 0;
    } else if (event.key === "End") {
      destinationIndex = markerIds.length - 1;
    }
    if (destinationIndex !== null) {
      event.preventDefault();
      const destination = markerIds[destinationIndex];
      if (destination) focusMarker(destination);
      return;
    }
    if (event.key === "Enter" || event.key === " " || event.key === "Spacebar" || event.key === "Space") {
      event.preventDefault();
      markerOpenerRef.current = event.currentTarget;
      onActivate();
    }
  }, [focusMarker, markerIds]);
  const markerInteraction = useCallback((
    markerId: string,
    ariaLabel: string,
    onActivate: () => void
  ): MarkerInteraction => ({
    markerId,
    ariaLabel,
    tabIndex: rovingMarkerId === markerId ? 0 : -1,
    onFocus: (event) => handleMarkerFocus(markerId, ariaLabel, event),
    onKeyDown: (event) => handleMarkerKeyDown(event, markerId, onActivate),
    onKeyUp: (event) => {
      if (event.key === " " || event.key === "Spacebar" || event.key === "Space") event.preventDefault();
    },
    onPointerActivate: (element) => { markerOpenerRef.current = element; }
  }), [handleMarkerFocus, handleMarkerKeyDown, rovingMarkerId]);
  const mapGesture = useCallback(() => {
    const points = [...mapPointersRef.current.values()];
    if (!points.length) return null;
    const center = points.reduce((sum, point) => ({ x: sum.x + point.x, y: sum.y + point.y }), { x: 0, y: 0 });
    center.x /= points.length;
    center.y /= points.length;
    return {
      center,
      distance: points.length > 1 ? Math.hypot(points[0].x - points[1].x, points[0].y - points[1].y) : 0
    };
  }, []);
  const handleMapPointerDown = useCallback((event: ReactPointerEvent<SVGSVGElement>) => {
    mapDidPanRef.current = false;
    const startedOnMarker = Boolean((event.target as Element).closest('[data-marker-pointer-target]'));
    const point = mapPointFromClient(event.clientX, event.clientY);
    mapPointersRef.current.set(event.pointerId, point);
    if (!startedOnMarker) {
      try {
        event.currentTarget.setPointerCapture(event.pointerId);
      } catch {
        // Synthetic accessibility tests do not create an active browser pointer.
      }
    }
    mapGestureRef.current = mapGesture();
    mapPointerOriginRef.current = point;
  }, [mapGesture, mapPointFromClient]);
  const handleMapPointerMove = useCallback((event: ReactPointerEvent<SVGSVGElement>) => {
    if (!mapPointersRef.current.has(event.pointerId)) return;
    const point = mapPointFromClient(event.clientX, event.clientY);
    mapPointersRef.current.set(event.pointerId, point);
    const previous = mapGestureRef.current;
    const next = mapGesture();
    if (!previous || !next) return;
    if (mapPointerOriginRef.current &&
      Math.hypot(point.x - mapPointerOriginRef.current.x, point.y - mapPointerOriginRef.current.y) > 3) {
      mapDidPanRef.current = true;
    }
    setMapView((current) => {
      if (mapPointersRef.current.size > 1 && previous.distance > 0 && next.distance > 0) {
        const scale = Math.min(4, Math.max(1, current.scale * next.distance / previous.distance));
        return constrainMapView(
          scale,
          next.center.x - (previous.center.x - current.x) * scale / current.scale,
          next.center.y - (previous.center.y - current.y) * scale / current.scale
        );
      }
      return constrainMapView(
        current.scale,
        current.x + next.center.x - previous.center.x,
        current.y + next.center.y - previous.center.y
      );
    });
    mapGestureRef.current = next;
  }, [constrainMapView, mapGesture, mapPointFromClient]);
  const handleMapPointerEnd = useCallback((event: ReactPointerEvent<SVGSVGElement>) => {
    mapPointersRef.current.delete(event.pointerId);
    try {
      if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    } catch {
      // The pointer may already have been released by the browser.
    }
    mapGestureRef.current = mapGesture();
    if (!mapPointersRef.current.size) mapPointerOriginRef.current = null;
  }, [mapGesture]);
  const handleMapWheel = useCallback((event: ReactWheelEvent<SVGSVGElement>) => {
    event.preventDefault();
    zoomMapAround(event.deltaY < 0 ? 1.22 : 1 / 1.22, mapPointFromClient(event.clientX, event.clientY));
  }, [mapPointFromClient, zoomMapAround]);
  const suppressClickAfterPan = useCallback((event: ReactMouseEvent<SVGSVGElement>) => {
    if (!mapDidPanRef.current) return;
    event.preventDefault();
    event.stopPropagation();
    mapDidPanRef.current = false;
  }, []);
  const rememberVisibleMapAnchor = useCallback(() => {
    const map = mapSectionRef.current;
    if (!map) return;
    const bounds = map.getBoundingClientRect();
    if (bounds.bottom > 0 && bounds.top < window.innerHeight) {
      pendingMapAnchorRef.current = bounds.top;
    }
  }, []);

  useLayoutEffect(() => {
    const map = mapSectionRef.current;
    if (!map) return;
    const bounds = map.getBoundingClientRect();
    const documentTop = bounds.top + window.scrollY;
    const previousDocumentTop = mapDocumentTopRef.current;
    const requestedViewportTop = pendingMapAnchorRef.current;
    pendingMapAnchorRef.current = null;
    mapDocumentTopRef.current = documentTop;

    const previousViewportTop = previousDocumentTop === null
      ? null
      : previousDocumentTop - window.scrollY;
    const wasVisible = previousViewportTop !== null &&
      previousViewportTop < window.innerHeight &&
      previousViewportTop + bounds.height > 0;
    const userHasLeftPageTop = window.scrollY > 1;
    const delta = requestedViewportTop !== null
      ? bounds.top - requestedViewportTop
      : wasVisible && userHasLeftPageTop && previousDocumentTop !== null
        ? documentTop - previousDocumentTop
        : 0;
    if (Math.abs(delta) > .5) window.scrollBy({ top: delta, left: 0, behavior: "auto" });
  }, [mapAnchorLayoutKey]);

  const activateNearestMapMarker = useCallback((event: ReactMouseEvent<SVGSVGElement>) => {
    if (event.defaultPrevented || (event.target as Element).closest("[data-map-marker]")) return;
    const markers = [...event.currentTarget.querySelectorAll<SVGGElement>("[data-map-marker]")];
    const nearest = markers.reduce<{ marker: SVGGElement; distance: number } | null>((best, marker) => {
      const distances = [...marker.querySelectorAll<SVGCircleElement>(":scope > .map-marker-hit-target")]
        .flatMap((target) => {
          const matrix = target.getScreenCTM();
          if (!matrix) return [];
          const centre = new DOMPoint(target.cx.baseVal.value, target.cy.baseVal.value).matrixTransform(matrix);
          return Math.hypot(event.clientX - centre.x, event.clientY - centre.y);
        });
      const distance = Math.min(...distances);
      if (!Number.isFinite(distance)) return best;
      return !best || distance < best.distance ? { marker, distance } : best;
    }, null);
    if (!nearest || nearest.distance > 22) return;
    event.preventDefault();
    nearest.marker.dispatchEvent(new MouseEvent("click", {
      bubbles: true,
      cancelable: true,
      clientX: event.clientX,
      clientY: event.clientY,
      view: window
    }));
  }, []);
  const showPreset = useCallback((preset: Exclude<Preset, "custom">) => {
    rememberVisibleMapAnchor();
    setLayers(new Set(PRESET_LAYERS[preset]));
    setActivePreset(preset);
    setSelected(null);
    setMapNotice(null);
    setRadarPlaying(false);
    setMapFeedback(`${preset === "all" ? "All layers" : `${preset[0]!.toUpperCase()}${preset.slice(1)}`} view shown.`);
  }, [rememberVisibleMapAnchor]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const storedPlace = readStoredPlace();
    const parsedView = parseViewState(window.location.search, PLACE_OPTIONS.map((place) => place.id));
    const requestedPlace = params.has("place") ? parsedView.placeId : storedPlace;
    if (requestedPlace && PLACE_OPTIONS.some((place) => place.id === requestedPlace)) {
      setSelectedPlaceId(requestedPlace);
    }

    if (parsedView.view !== "custom") {
      const preset = parsedView.view as Exclude<Preset, "custom">;
      setLayers(new Set(PRESET_LAYERS[preset]));
      setActivePreset(preset);
    } else {
      setLayers(new Set(parsedView.layers));
      setActivePreset("custom");
    }

    if (parsedView.zoom !== null) {
      setMapView(constrainMapView(
        parsedView.zoom,
        parsedView.panX ?? 0,
        parsedView.panY ?? 0
      ));
    } else if (window.location.hash) {
      const hashParams = new URLSearchParams(window.location.hash.slice(1));
      const hashLat = Number(hashParams.get("lat"));
      const hashLng = Number(hashParams.get("lng"));
      const hashZoom = Number(hashParams.get("zoom"));
      if (Number.isFinite(hashLat) && Number.isFinite(hashLng) && Number.isFinite(hashZoom) && hashZoom > 1 && hashZoom <= 4) {
        const point = projection([hashLng, hashLat]);
        if (point) {
          setMapView(constrainMapView(
            hashZoom,
            500 - (500 - point[0]) * hashZoom,
            450 - (450 - point[1]) * hashZoom
          ));
        }
      }
    }
    if (parsedView.at) {
      initialHistoryAtRef.current = parsedView.at;
      setTimeMode("past");
      void loadHistoryAt(parsedView.at);
      void fetchHistoryRange().then(setHistoryRange).catch(() => undefined);
    }
    setViewHydrated(true);
  }, [constrainMapView, loadHistoryAt, projection]);

  useEffect(() => {
    if (!viewHydrated) return;
    const restoreTimeView = () => {
      const parsed = parseViewState(window.location.search, PLACE_OPTIONS.map((place) => place.id));
      if (parsed.at) {
        initialHistoryAtRef.current = parsed.at;
        setTimeMode("past");
        void loadHistoryAt(parsed.at);
      } else if (timeMode === "past") {
        returnToNow();
      }
    };
    window.addEventListener("popstate", restoreTimeView);
    return () => window.removeEventListener("popstate", restoreTimeView);
  }, [loadHistoryAt, returnToNow, timeMode, viewHydrated]);

  useEffect(() => {
    if (!viewHydrated) return;
    if (!ephemeralPlace) storePlace(selectedPlaceId);
    const serialized = new URL(serializeViewState(window.location.href, {
      placeId: ephemeralPlace ? DEFAULT_PLACE_ID : selectedPlaceId,
      view: activePreset,
      layers,
      zoom: mapView.scale,
      panX: mapView.x,
      panY: mapView.y,
      at: timeMode === "past"
        ? historyState.envelope?.resolvedAt ?? historyState.requestedAt
        : null
    }));
    if (mapView.scale > 1) {
      const centerX = (500 - mapView.x) / mapView.scale;
      const centerY = (450 - mapView.y) / mapView.scale;
      const invert = projection.invert;
      if (invert) {
        const geo = invert([centerX, centerY]);
        if (geo) {
          serialized.hash = `lat=${geo[1].toFixed(4)}&lng=${geo[0].toFixed(4)}&zoom=${mapView.scale.toFixed(2)}`;
        }
      }
    }
    window.history.replaceState(null, "", `${serialized.pathname}${serialized.search}${serialized.hash}`);
  }, [activePreset, ephemeralPlace, historyState.envelope?.resolvedAt, historyState.requestedAt, layers, mapView, projection, selectedPlaceId, timeMode, viewHydrated]);

  const focusContext = useCallback((focus: ContextFocus) => {
    const contextLayers: Record<ContextFocus, Layer[]> = {
      weather: ["weather", "rain", "wind", "places"],
      wind: ["wind", "places"],
      trains: ["trains", "places"],
      rivers: ["rivers", "places"],
      sea: ["sea", "wind", "places"],
      warnings: ["warnings", "weather", "places"],
      radar: ["radar", "places"],
      grid: ["grid", "places"],
      air: ["air", "places"],
      aurora: ["aurora", "places"],
      tides: ["tides", "places"],
      bathing: ["bathing", "places"],
      iss: ["iss", "places"],
      satellite: ["satellite", "places"],
      earthquakes: ["earthquakes", "places"],
      transit: ["transit", "places"]
    };
    const notices: Record<ContextFocus, { title: string; detail: string }> = {
      weather: {
        title: "Weather observations",
        detail: weatherNotableCurrent
          ? reportingCount === null ? "Met Éireann station coverage is unavailable in this record." : `${reportingCount} fresh Met Éireann stations. Select a temperature marker for its latest reading.`
          : snapshot.sourceStatus === "stale"
            ? reportingCount === null ? "Saved Met Éireann station coverage is unavailable." : `${reportingCount} cached Met Éireann station records are retained from the last successful refresh; they are not current observations.`
            : "Met Éireann weather observations are unavailable, so current conditions cannot be assessed."
      },
      wind: {
        title: "Observed wind",
        detail: weatherNotableCurrent
          ? reportingCount === null ? "Met Éireann wind-station coverage is unavailable in this record." : `${reportingCount} Met Éireann stations with current wind direction and speed in km/h. Select an arrow for the complete observation.`
          : snapshot.sourceStatus === "stale"
            ? "Cached wind records are retained from the last successful refresh and are not presented as current wind."
            : "Met Éireann wind observations are unavailable, so current wind cannot be assessed."
      },
      trains: {
        title: railNotableCurrent ? "Live rail positions" : trainsCached ? "Cached rail positions" : "Rail positions unavailable",
        detail: railNotableCurrent
          ? runningTrainCount === null ? "Rail summary coverage is unavailable; no service count is inferred." : `${runningTrainCount} running trains and ${Math.max(0, snapshot.trains.length - runningTrainCount)} due to start. Select a train for its direction and status.`
          : trainsCached
            ? `${snapshot.trains.length} positions are retained from the last successful refresh; current rail movement cannot be assessed.`
            : "Iarnród Éireann positions are unavailable, so this view cannot determine how many trains are currently moving."
      },
      rivers: {
        title: riversLive && !riverDataStale ? "Fresh river readings" : riversPartial ? "Partial river readings" : riversCached ? "Cached river readings" : riversFallback ? "Fallback river readings" : "River readings unavailable",
        detail: riversLive && !riverDataStale
          ? riverStationCount === null ? "OPW gauge coverage is unavailable; no gauge count is inferred." : `${riverStationCount} OPW gauges observed within the last three hours. These are local levels, not flood warnings.`
          : riversPartial
            ? `${snapshot.rivers.length} recent readings · partial coverage`
          : riversCached
            ? riverStationCount === null ? "Saved gauge coverage is unavailable." : `${riverStationCount} gauge readings are retained from the last successful refresh; they are not current levels.`
            : riversFallback
              ? riverStationCount === null ? "Fallback gauge coverage is unavailable." : `${riverStationCount} readings come from the labelled fallback source; they are local levels, not flood warnings.`
              : "OPW river readings are unavailable, so current levels cannot be assessed."
      },
      sea: {
        title: "Marine conditions",
        detail: snapshot.contextStatus.marine === "live" && snapshot.marine.length
          ? `${weatherBuoyCount} Marine Institute weather buoy${weatherBuoyCount === 1 ? "" : "s"} and ${coastalObservatoryCount} coastal observator${coastalObservatoryCount === 1 ? "y" : "ies"} have recent observations. Select a marine site for details.`
          : snapshot.contextStatus.marine === "stale"
            ? "Cached Marine Institute observations are retained from the last successful refresh; current sea conditions cannot be assessed."
            : "Marine Institute observations are unavailable, so current sea conditions cannot be assessed."
      },
      warnings: {
        title: activeWarning
          ? "Current Met Éireann notice"
          : warningsUnavailable
            ? "Met Éireann notice feed unavailable"
            : "No current Met Éireann notices",
        detail: activeWarning?.headline ?? (warningsUnavailable
          ? "The notice feed could not be refreshed, so this view cannot confirm whether a current warning or advisory exists."
          : "Met Éireann is not currently publishing a warning or advisory for Ireland.")
      },
      radar: {
        title: "Rainfall radar",
        detail: snapshot.contextStatus.radar === "live" && snapshot.radar.length
          ? `${snapshot.radar.length} Met Éireann frame-metadata record${snapshot.radar.length === 1 ? " is" : "s are"} available. Ireland tile availability is checked when the frame is displayed.`
          : snapshot.contextStatus.radar === "stale" && snapshot.radar.length
            ? `${snapshot.radar.length} cached radar frames are retained from the last successful refresh; they are not current precipitation imagery.`
            : "Met Éireann radar imagery is unavailable, so current precipitation cannot be assessed."
      },
      grid: {
        title: "The all-island grid now",
        detail: snapshot.contextStatus.grid === "live" && snapshot.grid
          ? `Demand, wind, carbon and system frequency from EirGrid, with all displayed series available through ${snapshot.grid.observedAt ? formatTime(new Date(snapshot.grid.observedAt)) : "an unavailable time"}.`
          : snapshot.contextStatus.grid === "stale" && snapshot.grid
            ? `Cached EirGrid values from ${formatAge(snapshot.grid.observedAt, now)} are retained, but current grid conditions cannot be assessed.`
            : "EirGrid operational data is unavailable, so current demand and wind share cannot be assessed."
      },
      air: {
        title: "Measured and modelled air",
        detail: (snapshot.contextStatus.measuredAir === "live" || snapshot.contextStatus.measuredAir === "fallback" || snapshot.contextStatus.modelledAir === "live" || snapshot.contextStatus.modelledAir === "fallback") && snapshot.airQuality.length
          ? `${snapshot.airQuality.filter((item) => item.source === "measured").length} EEA monitoring stations alongside ${snapshot.airQuality.filter((item) => item.source === "modelled").length} regional CAMS model points. Nearby stations are grouped to the highest local index; solid markers are measurements and rings are model estimates.`
          : snapshot.contextStatus.measuredAir === "stale" || snapshot.contextStatus.modelledAir === "stale"
            ? "Cached air-quality records are retained from the last successful refresh; current air quality cannot be assessed."
            : "Air-quality observations and model output are unavailable, so current air quality cannot be assessed."
      },
      aurora: {
        title: "Aurora overhead probability",
        detail: (snapshot.contextStatus.aurora === "live" || snapshot.contextStatus.aurora === "fallback") && snapshot.aurora
          ? `NOAA OVATION currently estimates a ${snapshot.aurora.probability}% maximum probability directly over Ireland. Visibility also depends on darkness, cloud and light pollution.`
          : snapshot.contextStatus.aurora === "stale" && snapshot.aurora
            ? "A cached NOAA aurora estimate is retained, but current aurora probability cannot be assessed."
            : "NOAA aurora guidance is unavailable, so current aurora probability cannot be assessed."
      },
      tides: {
        title: "Tides and coastal anomaly",
        detail: snapshot.contextStatus.tides === "live" && snapshot.tides.length
          ? `${snapshot.tides.length} fresh Marine Institute gauges, compared with predicted tide and storm-surge guidance. Select a gauge for the next high and low water.`
          : snapshot.contextStatus.tides === "stale" && snapshot.tides.length
            ? `${snapshot.tides.length} cached tide-gauge records are retained; current coastal anomaly cannot be assessed.`
            : "Marine Institute tide-gauge data is unavailable, so current coastal anomaly cannot be assessed."
      },
      bathing: {
        title: snapshot.contextStatus.bathing === "unavailable" || snapshot.contextStatus.bathing === "stale"
          ? "Bathing-water feed unavailable"
          : snapshot.bathingAlerts.length ? "Active bathing-water alerts" : "No active bathing-water alerts",
        detail: snapshot.contextStatus.bathing === "stale"
          ? "Cached EPA alert records are retained, but current restrictions cannot be assessed."
          : snapshot.contextStatus.bathing === "unavailable"
          ? "The EPA bathing-water alert feed is temporarily unavailable, so no claim about current restrictions can be made."
          : snapshot.bathingAlerts.length
          ? `${snapshot.bathingAlerts.length} current EPA restrictions or advisories. Select an alert for the official reason and notice.`
          : "The EPA is not currently reporting an active alert through its public feed."
      },
      iss: {
        title: "The ISS over Ireland",
        detail: (snapshot.contextStatus.iss === "live" || snapshot.contextStatus.iss === "fallback") && snapshot.iss?.passes[0]
          ? `The next pass over central Ireland begins ${formatDate(new Date(snapshot.iss.passes[0].startsAt))} at ${formatTime(new Date(snapshot.iss.passes[0].startsAt))}, peaking at ${snapshot.iss.passes[0].maxElevation.toFixed(0)}°.`
          : snapshot.contextStatus.iss === "stale"
            ? "Cached orbital elements are retained, but the current ISS position and pass prediction are not confirmed."
            : "Current ISS elements or a pass prediction are unavailable."
      },
      satellite: {
        title: "Ireland from space",
        detail: snapshot.contextStatus.satellite === "unavailable"
          ? "NASA satellite imagery is temporarily unavailable."
          : snapshot.satellite
          ? `${snapshot.satellite.label}, dated ${formatDate(new Date(snapshot.satellite.observedAt))}. This is near-real-time daylight imagery, not a live camera.`
          : "NASA satellite imagery is temporarily unavailable."
      },
      earthquakes: {
        title: snapshot.contextStatus.earthquakes === "unavailable" || snapshot.contextStatus.earthquakes === "stale"
          ? "Earthquake feed unavailable"
          : snapshot.earthquakes.length ? "Recent seismic detections" : "No nearby earthquakes detected",
        detail: snapshot.contextStatus.earthquakes === "live" && snapshot.earthquakes.length
          ? `${snapshot.earthquakes.length} USGS event${snapshot.earthquakes.length === 1 ? "" : "s"} detected around Ireland in the past seven days.`
          : snapshot.contextStatus.earthquakes === "live"
            ? "The USGS feed contains no detected events in the Ireland region during the past seven days."
            : snapshot.contextStatus.earthquakes === "stale"
              ? "Cached USGS detections are retained, but the current seven-day window cannot be assessed."
              : "The USGS earthquake feed is unavailable, so no claim about recent events can be made."
      },
      transit: {
        title: snapshot.transitStatus === "live" ? "Live public transport" : snapshot.transitStatus === "stale" ? "Cached public transport" : "Public transport feed awaiting access",
        detail: snapshot.transitStatus === "live"
          ? `${snapshot.transit.length} current TFI vehicle positions, capped and clustered into a readable island view.`
          : snapshot.transitStatus === "stale"
            ? `${snapshot.transit.length} positions are retained from the last successful refresh; current vehicle movement cannot be assessed.`
          : snapshot.transitStatus === "credential-required"
            ? "The integration is ready, but the NTA requires a free developer API key before live vehicle positions can be displayed."
            : "The NTA live vehicle feed is temporarily unavailable."
      }
    };
    setLayers(new Set(contextLayers[focus]));
    setActivePreset("custom");
    setSelected(null);
    setMapNotice(online ? { ...notices[focus], focus } : {
      title: "Offline · source not current",
      detail: `${notices[focus].title} cannot be refreshed while offline. Last successful refresh ${lastSuccessLabel}; saved values are not presented as current map signals.`,
      focus
    });
    setRadarPlaying(false);
    if (focus === "radar") setRadarFrameIndex(0);
    window.requestAnimationFrame(() => {
      document.getElementById(focus === "warnings" && activeWarning ? "active-warning" : "live-map")
        ?.scrollIntoView({ behavior: prefersReducedMotion ? "auto" : "smooth", block: "start" });
    });
  }, [activeWarning, coastalObservatoryCount, lastSuccessLabel, now, online, prefersReducedMotion, railNotableCurrent, reportingCount, riverDataStale, riverStationCount, riversCached, riversFallback, riversLive, riversPartial, runningTrainCount, snapshot, trainsCached, warningsUnavailable, weatherBuoyCount, weatherNotableCurrent]);

  const toggleLayer = useCallback((layer: Layer) => {
    rememberVisibleMapAnchor();
    setActivePreset("custom");
    setLayers((current) => {
      const next = new Set(current);
      if (next.has(layer)) next.delete(layer);
      else next.add(layer);
      return next;
    });
    setMapFeedback("Custom layer selection updated.");
  }, [rememberVisibleMapAnchor]);

  const choosePlace = useCallback((placeId: string) => {
    if (!PLACE_OPTIONS.some((place) => place.id === placeId)) return;
    setEphemeralPlace(null);
    setSelectedPlaceId(placeId);
    setPlaceMessage("");
  }, []);

  const useMyLocation = useCallback(() => {
    if (!navigator.geolocation) {
      setPlaceMessage("Location is not available in this browser.");
      return;
    }
    setPlaceMessage("Finding nearby observations…");
    navigator.geolocation.getCurrentPosition(
      ({ coords }) => {
        const withinIreland = coords.latitude >= 51.2 && coords.latitude <= 55.6 &&
          coords.longitude >= -11 && coords.longitude <= -5.2;
        if (!withinIreland) {
          setPlaceMessage("That location is outside this Ireland view. Choose a mapped place instead.");
          return;
        }
        setEphemeralPlace({
          id: "nearby",
          name: "Your area",
          lat: coords.latitude,
          lon: coords.longitude
        });
        setPlaceMessage("Using your shared coordinates for this session only. They are not saved or added to share links.");
      },
      () => setPlaceMessage("Location was not shared. Choose a place instead."),
      { enableHighAccuracy: false, maximumAge: 300_000, timeout: 8_000 }
    );
  }, []);

  const focusActivity = useCallback((activityId: ActivityId, title: string, detail: string) => {
    const activityLayers: Record<ActivityId, Layer[]> = {
      "outdoor-walk": ["weather", "rain", "wind", "warnings", "places"],
      coast: ["sea", "wind", "tides", "bathing", "places"],
      stargazing: ["aurora", "iss", "places"],
      travel: ["trains", "transit", "places"]
    };
    setLayers(new Set(activityLayers[activityId]));
    setActivePreset("custom");
    setSelected(null);
    setRadarPlaying(false);
    setMapNotice({ title, detail });
    window.requestAnimationFrame(() => {
      document.getElementById("live-map")?.scrollIntoView({ behavior: prefersReducedMotion ? "auto" : "smooth", block: "start" });
    });
  }, [prefersReducedMotion]);

  const shareExperience = useCallback(async () => {
    const shareablePlaceId = selectedPlaceIsEphemeral ? DEFAULT_PLACE_ID : selectedPlace.id;
    const url = serializeViewState(window.location.href, {
      placeId: shareablePlaceId,
      view: activePreset,
      layers,
      zoom: mapView.scale,
      panX: mapView.x,
      panY: mapView.y,
      at: timeMode === "past"
        ? historyState.envelope?.resolvedAt ?? historyState.requestedAt
        : null
    });
    const shareData = {
      title: "A Day in Ireland",
      text: timeMode === "past" && (historyState.envelope?.resolvedAt ?? historyState.requestedAt)
        ? `See stored conditions around ${selectedPlace.name} at ${formatIrelandHistoryTime(historyState.envelope?.resolvedAt ?? historyState.requestedAt!)}.`
        : selectedPlace.id === "island" || selectedPlaceIsEphemeral
          ? "See weather, movement, water and energy across Ireland—happening now."
          : `See what is happening around ${selectedPlace.name} right now.`,
      url
    };
    try {
      if (navigator.share) {
        await navigator.share(shareData);
        return;
      }
      await navigator.clipboard.writeText(shareData.url);
      setShareStatus("copied");
      window.setTimeout(() => setShareStatus("idle"), 1800);
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      try {
        await navigator.clipboard.writeText(shareData.url);
        setShareStatus("copied");
        window.setTimeout(() => setShareStatus("idle"), 1800);
      } catch {
        window.prompt("Copy this link", shareData.url);
      }
    }
  }, [activePreset, historyState.envelope?.resolvedAt, historyState.requestedAt, layers, mapView, selectedPlace, selectedPlaceIsEphemeral, timeMode]);

  return (
    <main
      ref={experienceRef}
      className={`experience ${isNight ? "is-night" : ""} ${timeMode === "past" ? "is-history" : "is-now"}`}
      data-day-phase={dayPhase}
    >
      <a className="skip-link" href="#live-map">Skip to {timeMode === "past" ? "historical" : "live"} map</a>
      <header className="topbar">
        <Link className="brand" href="/" aria-label="A Day in Ireland, home">
          <span className="brand-mark" aria-hidden="true">
            <svg viewBox="0 0 32 32">
              <path className="brand-sun" d="M11 15a5 5 0 0 1 10 0" />
              <path className="brand-horizon" d="M5 18h22M8 22h16" />
            </svg>
          </span>
          <span><b>A Day in Ireland</b><small>{timeMode === "past" ? "Historical island view" : "Live island view"}</small></span>
        </Link>
        <div
          className="live-state"
          data-connection-status={connectionStatus}
          data-service-state={serviceDisplayState}
          role="status"
          aria-live="polite"
          aria-atomic="true"
          title={timeMode === "past"
            ? `${connectionLabel}. Stored record ${lastSuccessLabel}.`
            : `${connectionLabel}. Last successful refresh ${lastSuccessLabel}. Checked ${formatTime(lastCheckedAt)}.`}
        >
          <span className={`live-dot ${serviceDisplayState === "offline" ? "offline" : serviceDisplayState === "live" ? "live" : "partial"}`} aria-hidden="true" />
          <span className="network-state">{connectionLabel}</span>
          <span>{timeMode === "past"
            ? historyState.status === "ready"
              ? isDailyHistorySummary ? "Stored daily summary" : "Stored observations"
              : historyState.status === "loading" ? "Loading history" : "History unavailable"
            : serviceDisplayState === "live" ? "Live observations" : serviceDisplayState === "cached" || serviceDisplayState === "offline" ? "Saved observations" : serviceDisplayState === "unavailable" ? "Observations unavailable" : serviceDisplayState === "connecting" ? "Connecting" : "Partial observations"}</span>
          <time>{timeMode === "past" ? `Captured ${lastSuccessLabel}` : `Checked ${formatTime(lastCheckedAt)}`}</time>
        </div>
        <nav className="header-actions" aria-label="Experience controls">
          <button
            type="button"
            className="share-button"
            data-share-place-id={selectedPlace.id}
            aria-label={shareStatus === "copied" ? "Share link copied" : `Share this view for ${selectedPlace.name}`}
            onClick={() => void shareExperience()}
          >
            {shareStatus === "copied" ? "Copied" : "Share"}
            <span className="sr-only" role="status" aria-live="polite">
              {shareStatus === "copied" ? "Share link copied to clipboard." : ""}
            </span>
          </button>
          <button
            ref={panelOpenerRef}
            type="button"
            className="panel-button"
            onClick={(event) => {
              panelOpenerRef.current = event.currentTarget;
              setPanelOpen((value) => !value);
            }}
            aria-expanded={panelOpen}
          >
            Explore <span aria-hidden="true">⌁</span>
          </button>
        </nav>
      </header>

      <section className="dashboard-shell">
        <aside className="section-rail" aria-label="Section shortcuts">
          <p className="section-rail-kicker">{timeMode === "past" ? "Historical atlas" : "Living atlas"}</p>
          <nav className="section-nav" aria-label="Section shortcuts">
            {EXPERIENCE_SECTIONS.map((section) => (
              <a
                key={section.key}
                href={`#${section.id}`}
                aria-current={activeSection === section.key ? "location" : undefined}
              >
                <b>{section.label}</b>
                <small>{section.detail}</small>
              </a>
            ))}
          </nav>
          <p className="section-rail-note">{timeMode === "past"
            ? "Move between the retained map, notices, national briefing and the recorded shape of the day."
            : "Map presets stay with the map. Explore opens the full layer drawer without repeating the main view controls."}</p>
        </aside>

        <div className="map-workspace">
          <div className="workspace-heading" id="ireland-now">
            <div className="workspace-copy">
              <p className="eyebrow">{formatDate(now)}<span className="moment-time"> · {formatTime(now)} Irish time</span></p>
              <h1 id="moment-heading">Ireland {timeMode === "past" ? "then" : "now"}.</h1>
              <p className="hero-sentence">{heroSentence}</p>
              <p className="moment-summary">{heroSecondary}</p>
            </div>
            <div className="workspace-facts" role="group" aria-label={`${timeMode === "past" ? "Historical" : "Current"} national highlights across Ireland`}>
              {heroFacts.length ? heroFacts.map((fact) => (
                <button
                  type="button"
                  key={fact.key}
                  className={`hero-fact ${fact.family}`}
                  onClick={fact.onClick}
                >
                  <span>{fact.label}</span>
                  <b>{fact.value}</b>
                  <small>{fact.detail}</small>
                </button>
              )) : (
                <p className="workspace-facts-empty">Awaiting fresh island-wide signals.</p>
              )}
            </div>
          </div>

          {(() => {
            const placeControls = (
              <>
                <label htmlFor="place-select">Nearby context</label>
                <div className="place-controls">
                  <select id="place-select" value={selectedPlace.id} onChange={(event) => choosePlace(event.target.value)}>
                    {selectedPlaceIsEphemeral && <option value="nearby">Your area · this session</option>}
                    {PLACE_OPTIONS.map((place) => <option key={place.id} value={place.id}>{place.name}</option>)}
                  </select>
                  <button type="button" className="locate-button" onClick={useMyLocation} aria-label="Use my location"><span aria-hidden="true">⌖</span> Locate</button>
                </div>
                <small id="place-message" aria-live="polite">{placeMessage || "Saved as a place ID; GPS coordinates are never stored or shared."}</small>
                <small className="place-limits">{selectedPlaceIsEphemeral
                  ? "Session-only location: nearest available readings are shown with distance; the share link remains an Ireland view."
                  : `Nearby limits: weather ${NEARBY_RADIUS_KM.weather} km · rivers ${NEARBY_RADIUS_KM.river} km · air ${NEARBY_RADIUS_KM.air} km.`}</small>
              </>
            );
            const compactNotices = timeMode !== "past" &&
              layers.has("warnings") &&
              !isConnectingWithoutSnapshot &&
              !warningsUnavailable &&
              visibleWarnings.length === 0;
            const briefing = (
              <>
          <section
            className={`place-context ${selectedPlace.id === "island" ? "island-context place-context-compact" : "local-context"}`}
            data-place-id={selectedPlace.id}
            aria-labelledby="my-place-heading"
          >
            {selectedPlace.id === "island" ? (
              <div className="place-picker place-picker-compact">
                <div className="place-compact-copy">
                  <p className="eyebrow">My Place</p>
                  <h2 id="my-place-heading">Personalise this view</h2>
                  <p className="place-context-summary">Choose a place or use your location to add nearby weather, river and air observations.</p>
                </div>
                <div className="place-compact-controls">{placeControls}</div>
              </div>
            ) : (
              <>
                <div className="place-picker">
                  <p className="eyebrow">My Place</p>
                  <h2 id="my-place-heading">{selectedPlace.name}</h2>
                  <p className="place-context-summary">{selectedPlaceIsEphemeral
                    ? "Nearest available observations to the coordinates you shared for this session. Distances are shown so far-away readings are never presented as local."
                    : `Nearby observations for ${selectedPlace.name}. Each source has its own radius; outside it, no local reading is shown.`}</p>
                  {placeControls}
                </div>
                <div
                  className="place-observations"
                  aria-label={timeMode === "past" ? `Historical local observations near ${selectedPlace.name}` : `Local observations near ${selectedPlace.name}`}
                >
                  <p className="eyebrow">{timeMode === "past" ? `Historical local observations near ${selectedPlace.name}` : `Local observations near ${selectedPlace.name}`}</p>
                  <dl>
                    <div>
                      <dt>Temperature</dt>
                      <dd>{localStation?.item.temperature ?? "—"}°</dd>
                      <small>{localStation
                        ? formatLocalObservation("Met Éireann", localStation.item, localStation.distanceKm, now, timeMode === "past")
                        : isConnectingWithoutSnapshot ? `${timeMode === "past" ? "Loading stored" : "Connecting to"} weather observations…` : timeMode === "past" ? historyGapForFocus(historyGaps, "weather")?.detail ?? `No point weather observation was retained within ${NEARBY_RADIUS_KM.weather} km for this historical record.` : !online ? "Offline; saved weather is not used as a current nearby condition." : snapshot.sourceStatus === "live" || snapshot.sourceStatus === "partial" ? selectedPlaceIsEphemeral ? "No current weather observation is available." : `No nearby weather observation within ${NEARBY_RADIUS_KM.weather} km.` : "Weather observations are unavailable; nearby conditions cannot be assessed."}</small>
                    </div>
                    <div>
                      <dt>Rain</dt>
                      <dd>{localStation?.item.rainfall == null ? "—" : `${localStation.item.rainfall} mm`}</dd>
                      <small>{localStation
                        ? formatLocalObservation("Met Éireann", localStation.item, localStation.distanceKm, now, timeMode === "past")
                        : isConnectingWithoutSnapshot ? `${timeMode === "past" ? "Loading stored" : "Connecting to"} rain observations…` : timeMode === "past" ? historyGapForFocus(historyGaps, "weather")?.detail ?? `No point rain observation was retained within ${NEARBY_RADIUS_KM.weather} km for this historical record.` : !online ? "Offline; saved rain observations are not used as current nearby rainfall." : snapshot.sourceStatus === "live" || snapshot.sourceStatus === "partial" ? selectedPlaceIsEphemeral ? "No current rain observation is available." : `No nearby rain observation within ${NEARBY_RADIUS_KM.weather} km.` : "Rain observations are unavailable; nearby rainfall cannot be assessed."}</small>
                    </div>
                    <div>
                      <dt>River</dt>
                      <dd>{localRiver ? `${localRiver.item.level.toFixed(2)} m` : "—"}</dd>
                      <small>{localRiver
                        ? formatLocalObservation("OPW", localRiver.item, localRiver.distanceKm, now, timeMode === "past")
                        : isConnectingWithoutSnapshot ? `${timeMode === "past" ? "Loading stored" : "Connecting to"} river gauges…` : timeMode === "past" ? historyGapForFocus(historyGaps, "rivers")?.detail ?? `No point river observation was retained within ${NEARBY_RADIUS_KM.river} km for this historical record.` : riversLive || riversPartial || riversFallback ? selectedPlaceIsEphemeral ? "No current river observation is available." : `No nearby river observation within ${NEARBY_RADIUS_KM.river} km.` : riversCached ? "The river feed is unavailable; cached readings are not used as current local conditions." : "River readings are unavailable; nearby levels cannot be assessed."}</small>
                    </div>
                    <div>
                      <dt>Air</dt>
                      <dd>{localAir?.item.europeanAqi == null ? "—" : `AQI ${localAir.item.europeanAqi}`}</dd>
                      <small>{localAir
                        ? formatLocalObservation(localAir.item.source === "measured" ? "EEA measured" : "CAMS modelled", localAir.item, localAir.distanceKm, now, timeMode === "past")
                        : isConnectingWithoutSnapshot ? `${timeMode === "past" ? "Loading stored" : "Connecting to"} air-quality sources…` : timeMode === "past" ? historyGapForFocus(historyGaps, "air")?.detail ?? `No point air-quality observation was retained within ${NEARBY_RADIUS_KM.air} km for this historical record.` : !online ? "Offline; saved air-quality data is not used as a current nearby condition." : snapshot.contextStatus.measuredAir === "live" || snapshot.contextStatus.measuredAir === "fallback" || snapshot.contextStatus.modelledAir === "live" || snapshot.contextStatus.modelledAir === "fallback" ? selectedPlaceIsEphemeral ? "No current measured or modelled air context is available." : `No nearby air observation within ${NEARBY_RADIUS_KM.air} km.` : "Air-quality sources are unavailable; nearby conditions cannot be assessed."}</small>
                    </div>
                  </dl>
                </div>
              </>
            )}
          </section>

          <SkyLightStrip solar={snapshot.solar} status={snapshot.contextStatus.solar} now={now} />
          <ForecastStrip forecast={snapshot.forecast} status={snapshot.contextStatus.forecast} now={now} />

          <div className="freshness-strip" role="status" aria-label="Data freshness and provider status">
            {timeMode === "past" ? (
              <>
                <button type="button" className="refresh-data-button" disabled aria-describedby="connection-summary">Live refresh paused</button>
                <span id="connection-summary" className={`freshness-chip connection-chip ${historyState.status}`} data-connection-status={connectionStatus} data-service-state={serviceDisplayState}>
                  <i aria-hidden="true" /><b>Historical record</b><small>{historyState.status === "loading" ? "Loading stored conditions" : historyState.status === "ready" ? `${historyResolutionLabel(historyState.envelope?.resolutionMinutes ?? 15)} · captured ${lastSuccessLabel} · ${historyGaps.length} recorded gap${historyGaps.length === 1 ? "" : "s"}` : "No stored record is available for the selected time"}{connectionStatus === "offline" ? " · readable offline once loaded" : ""}</small>
                </span>
                <details className="freshness-details">
                  <summary>Data details</summary>
                  <div className="freshness-detail-grid">
                    <span className="freshness-chip cached"><i aria-hidden="true" /><b>Live separation</b><small>Live feeds remain paused and are never substituted into this historical view.</small></span>
                  </div>
                </details>
              </>
            ) : (
              <>
                <button
                  type="button"
                  className="retry-live-data refresh-data-button"
                  onClick={() => void refreshAllRef.current()}
                  disabled={connectionStatus === "offline" || servicesRefreshing}
                  aria-describedby="connection-summary"
                >
                  {servicesRefreshing ? "Refreshing…" : "Refresh live data"}
                </button>
                <span id="connection-summary" className={`freshness-chip connection-chip ${serviceDisplayState}`} data-connection-status={connectionStatus} data-service-state={serviceDisplayState}>
                  <i aria-hidden="true" /><b>Connection</b><small>{connectionStatus === "offline" ? `Offline · live refresh unavailable${snapshot.lastSuccessAt ? " · saved snapshot" : ""}` : serviceDisplayState === "connecting" ? "Checking for newer data" : `Connected · ${connectionLabel}`} · checked {formatTime(lastCheckedAt)} · last success {lastSuccessLabel}</small>
                </span>
                <details className="freshness-details">
                  <summary>Data details</summary>
                  <div className="freshness-detail-grid">
                    <span className={`freshness-chip ${isConnectingWithoutSnapshot ? "connecting" : weatherDisplayStatus}`} aria-label={isConnectingWithoutSnapshot ? "Weather provider connecting" : `Weather provider ${statusText(weatherDisplayStatus)}; latest national observation ${formatAge(latestWeatherObs > 0 ? new Date(latestWeatherObs).toISOString() : null, now)}${!online ? "; offline saved snapshot" : weatherStale && snapshot.stations.length > 0 ? "; observation data is stale" : ""}`}>
                      <i aria-hidden="true" /><b>Weather provider</b><small>{isConnectingWithoutSnapshot ? "Connecting…" : `Provider: ${statusText(weatherDisplayStatus)}${!online ? " (offline)" : ""} · observed ${formatAge(latestWeatherObs > 0 ? new Date(latestWeatherObs).toISOString() : null, now)}${online && weatherStale && snapshot.stations.length > 0 ? " · stale" : ""}`}</small>
                    </span>
                    <span className={`freshness-chip ${isConnectingWithoutSnapshot ? "connecting" : trainDisplayStatus}`} aria-label={isConnectingWithoutSnapshot ? "Rail provider connecting" : `Rail provider ${statusText(trainDisplayStatus)}; latest observation ${formatAge(snapshot.sourceProvenance?.trains.latestObservedAt, now)}${!online ? "; offline saved snapshot" : transitStale && snapshot.trains.length > 0 ? "; positions are stale" : ""}`}>
                      <i aria-hidden="true" /><b>Rail provider</b><small>{isConnectingWithoutSnapshot ? "Connecting…" : `Provider: ${statusText(trainDisplayStatus)}${!online ? " (offline)" : ""} · observed ${formatAge(snapshot.sourceProvenance?.trains.latestObservedAt, now)}${online && transitStale && snapshot.trains.length > 0 ? " · stale" : ""}`}</small>
                    </span>
                    <span className={`freshness-chip ${isConnectingWithoutSnapshot ? "connecting" : riverDisplayStatus}`} aria-label={isConnectingWithoutSnapshot ? "River provider connecting" : `River provider ${statusText(riverDisplayStatus)}; latest observation ${formatAge(snapshot.sourceProvenance?.rivers.latestObservedAt, now)}${!online ? "; offline saved snapshot" : riverDataStale && snapshot.rivers.length > 0 ? "; readings are stale" : ""}`}>
                      <i aria-hidden="true" /><b>River provider</b><small>{isConnectingWithoutSnapshot ? "Connecting…" : `Provider: ${statusText(riverDisplayStatus)}${!online ? " (offline)" : ""} · observed ${formatAge(snapshot.sourceProvenance?.rivers.latestObservedAt, now)}${online && riverDataStale && snapshot.rivers.length > 0 ? " · stale" : ""}`}</small>
                    </span>
                  </div>
                </details>
              </>
            )}
          </div>

          <section
            id="official-notices"
            className={`official-notices ${compactNotices ? "compact" : ""}`}
            data-scope="across-ireland"
            aria-labelledby="official-notices-heading"
          >
            {compactNotices ? (
              <div className="official-notices-compact-row">
                <span className="live-dot live" aria-hidden="true" />
                <h2 id="official-notices-heading">Official notices</h2>
                <p className="official-notices-empty">No current or upcoming Met Éireann notices.</p>
              </div>
            ) : (
              <>
            <div className="official-notices-heading">
              <div>
                <p className="eyebrow">{timeMode === "past" ? "Stored official notices" : "Official notices"}</p>
                <h2 id="official-notices-heading">Official notices {timeMode === "past" ? "at the selected time" : "across Ireland"}</h2>
              </div>
              <p>{timeMode === "past" ? "Notices are evaluated against the selected capture time. Gaps remain explicit and the current warning page is not treated as an archive." : "Met Éireann notices are shown with their named scope and timing. Regional notices do not describe the whole island."}</p>
            </div>
            {layers.has("warnings") ? isConnectingWithoutSnapshot ? (
              <p className="official-notices-empty">{timeMode === "past" ? "Loading stored Met Éireann notices…" : "Connecting to the Met Éireann notice feed…"}</p>
            ) : visibleWarnings.length ? (
              visibleWarnings.map((warning, warningIndex) => {
                const timing = warningTiming(warning, now.getTime());
                const isActive = timing === "active";
                const warningIdentity = warning.id || warning.capId || `${warning.headline}-${warningIndex}`;
                return (
                  <aside
                    id={isActive && warning === activeWarning ? "active-warning" : undefined}
                    key={warningIdentity}
                    className={`warning-strip official-notice ${(warning.level || "advisory").toLowerCase()} ${timing}`}
                    aria-label={`Official Met Éireann ${isActive ? "active" : "upcoming"} notice ${timeMode === "past" ? "at the selected time " : ""}for ${warningScopeText(warning)}`}
                    role="status"
                  >
                    <span className="warning-badge">{timeMode === "past" ? isActive ? "Active at capture" : "Upcoming at capture" : isActive ? "Official notice" : "Upcoming notice"}</span>
                    <div className="warning-copy">
                      <h3>{warning.headline}</h3>
                      <dl className="warning-key-facts">
                        <div><dt>Scope</dt><dd>{warningScopeText(warning)}</dd></div>
                        <div>
                          <dt>{isActive ? "Expires" : "Starts"}</dt>
                          <dd><time dateTime={isActive ? warning.expiry : warning.onset}>{formatWarningDate(isActive ? warning.expiry : warning.onset)}</time></dd>
                        </div>
                      </dl>
                      <p>{warning.description || "Met Éireann has not supplied a description for this notice."}</p>
                      <div className="warning-actions">
                        <a href={OFFICIAL_WARNING_URL} target="_blank" rel="noreferrer">{timeMode === "past" ? "Open current Met Éireann warning page" : "Check official Met Éireann notice"} <span aria-hidden="true">↗</span></a>
                        <details>
                          <summary>Source and issue details</summary>
                          <p>Met Éireann · {warning.level || "Unspecified"} level · severity {warning.severity || "not specified"} · issued {formatWarningDate(warning.issued)} · updated {formatWarningDate(warning.updated)}</p>
                        </details>
                      </div>
                    </div>
                  </aside>
                );
              })
            ) : warningsUnavailable ? (
              <p className="official-notices-empty">{timeMode === "past"
                ? historyGapForFocus(historyGaps, "warnings")?.detail ?? "Official notices were not retained in this historical record; no zero or all-clear state is inferred."
                : !online ? `Offline. The notice feed cannot be refreshed; last success ${lastSuccessLabel}, so current warnings cannot be confirmed.` : snapshot.contextStatus.warnings === "stale" ? `The last notice check is cached from ${lastSuccessLabel}; current warnings cannot be confirmed.` : "The Met Éireann notice feed is unavailable, so current warnings cannot be confirmed."}</p>
            ) : (
              <p className="official-notices-empty">{timeMode === "past" ? "No active or upcoming Met Éireann notices are represented in this stored record." : "No current or upcoming Met Éireann notices are represented in the current horizon."}</p>
            ) : (
              <p className="official-notices-empty">Met Éireann notices are hidden in this map view. Enable them in Explore to review {timeMode === "past" ? "the stored notices" : "official notices across Ireland"}.</p>
            )}
              </>
            )}
          </section>

              </>
            );
            return (
              <>

      <section
        id="live-map"
        className="map-stage"
        ref={mapSectionRef}
        aria-label={`${timeMode === "past" ? "Historical" : "Live"} map of Ireland`}
        aria-describedby="map-keyboard-instructions map-marker-announcement"
      >
        <div className="map-explorer-heading">
          <div>
            <p className="eyebrow">Living map · {timeMode === "past" ? "stored conditions" : "near real time"}</p>
            <h2>Ireland {timeMode === "past" ? "at the selected time" : "on the map"}</h2>
            <p>{timeMode === "past" ? "Choose a stored time, then explore only the observations retained for that record. Missing detail is never replaced with live data or inferred as zero." : "The map keeps one set of presets, one layer drawer and the original source meaning of every signal."}</p>
          </div>
        </div>
        <HistoryControls
          mode={timeMode}
          range={historyRange}
          history={historyState}
          comparison={historyComparison}
          onNow={returnToNow}
          onPast={() => void enterPast()}
          onRequest={(at) => void loadHistoryAt(at)}
          onCompare={() => void compareHistoryWithNow()}
        />
        <nav className="map-presets" aria-label="Map view shortcuts">
          <button className={activePreset === "weather" ? "active" : ""} aria-pressed={activePreset === "weather"} onClick={() => showPreset("weather")}><span className="preset-dot weather" aria-hidden="true" /><span className="preset-label">Weather</span></button>
          <button className={activePreset === "movement" ? "active" : ""} aria-pressed={activePreset === "movement"} onClick={() => showPreset("movement")}><span className="preset-dot movement" aria-hidden="true" /><span className="preset-label">Movement</span></button>
          <button className={activePreset === "water" ? "active" : ""} aria-pressed={activePreset === "water"} onClick={() => showPreset("water")}><span className="preset-dot water" aria-hidden="true" /><span className="preset-label">Water</span></button>
          <button className={activePreset === "all" ? "active" : ""} aria-pressed={activePreset === "all"} onClick={() => showPreset("all")}><span className="preset-label">All layers</span></button>
          <button
            className={activePreset === "custom" ? "active custom" : "custom"}
            aria-pressed={activePreset === "custom"}
            onClick={(event) => {
              panelOpenerRef.current = event.currentTarget;
              setPanelOpen(true);
            }}
          >
            <span className="preset-label">Custom · {layers.size} layers</span>
          </button>
        </nav>
        <small className="preset-scroll-hint">Swipe for more views →</small>
        <details className="map-legend">
          <summary>Legend · {layers.size} layers shown</summary>
          <div className="map-legend-content">
            <p>{densitySummary}</p>
            <ul>
              {activeLegendGroups.map((group) => (
                <li className={`legend-${group.id}`} key={group.id}>
                  <i aria-hidden="true" /><span><b>{group.label}</b><small>{group.layers.join(" · ")}</small></span>
                </li>
              ))}
            </ul>
            <p>Solid air markers are measurements; rings are model estimates. Alert colours are reserved for official notices or unusual signals.</p>
          </div>
        </details>
        {timeMode === "past" && isDailyHistorySummary && !displayedMapNotice && (
          <aside className="map-notice history-map-gap" role="status">
            <span>Historical coverage</span>
            <strong>Point map unavailable for this daily summary</strong>
            <p>Daily retention preserves summary values and recorded gaps, not a reconstructed point-by-point map.</p>
          </aside>
        )}
        {displayedMapNotice && (
          <aside className="map-notice" data-radar-availability={displayedMapNotice.focus === "radar" ? radarPresentationState : undefined} aria-live="polite">
            <span>Focused view</span>
            <button onClick={() => setMapNotice(null)} aria-label="Dismiss map context">×</button>
            <strong>{displayedMapNotice.title}</strong>
            <p>{displayedMapNotice.detail}</p>
          </aside>
        )}
        <div id="map-keyboard-instructions" className="sr-only">
          Use Left and Right or Up and Down to move between map markers. Home and End move to the first or last marker. Press Enter or Space to open marker details.
        </div>
        <p id="map-marker-announcement" className="sr-only" aria-live="polite" aria-atomic="true">{markerAnnouncement}</p>
        <p className="map-feedback sr-only" role="status" aria-live="polite">{mapFeedback}</p>
        <div className="map-canvas">
        <svg
          ref={mapRef}
          className={`ireland-map ${mapView.scale > 1 ? "is-zoomed" : ""} ${isDenseView ? "is-dense-map" : ""}`}
          data-visible-markers={markerIds.length}
          data-point-observations={rawPointMarkerCount}
          viewBox="0 0 1000 900"
          role="group"
          aria-labelledby="map-title map-description"
          aria-describedby="map-keyboard-instructions map-marker-announcement"
          onClickCapture={suppressClickAfterPan}
          onClick={activateNearestMapMarker}
          onPointerDown={handleMapPointerDown}
          onPointerMove={handleMapPointerMove}
          onPointerUp={handleMapPointerEnd}
          onPointerCancel={handleMapPointerEnd}
          onWheel={handleMapWheel}
        >
          <title id="map-title">{timeMode === "past" ? "Stored conditions across Ireland at the selected time" : "Near-real-time conditions across Ireland"}</title>
          <desc id="map-description">{timeMode === "past" ? "A map of retained historical observations across Ireland. Provider gaps and unavailable positions or imagery remain missing; daily summaries do not reconstruct point markers." : "A close map of Ireland showing weather, radar rain, observed wind, rail and public transport, river and tide gauges, sea conditions, measured and modelled air quality, bathing alerts, satellite imagery, seismic detections, ISS passes, aurora guidance and the live power grid."}</desc>
	          <defs>
	            <radialGradient id="sunGlow">
	              <stop offset="0" stopColor="#f4d8a2" stopOpacity=".88" />
	              <stop offset="1" stopColor="#c78f58" stopOpacity="0" />
	            </radialGradient>
	            <radialGradient id="rainMist">
	              <stop offset="0" stopColor="#6d97b2" stopOpacity=".42" />
	              <stop offset=".55" stopColor="#6d97b2" stopOpacity=".18" />
	              <stop offset="1" stopColor="#6d97b2" stopOpacity="0" />
	            </radialGradient>
            <radialGradient id="satelliteFade">
              <stop offset=".68" stopColor="white" stopOpacity="1" />
              <stop offset="1" stopColor="white" stopOpacity="0" />
            </radialGradient>
	            <linearGradient id="ocean" x1="0" y1="0" x2="0" y2="1">
	              <stop offset="0" stopColor="#1e3d42" />
	              <stop offset="1" stopColor="#102326" />
	            </linearGradient>
	            <linearGradient id="land" x1="0" y1="0" x2="1" y2="1">
	              <stop offset="0" stopColor="#889a6b" />
	              <stop offset=".45" stopColor="#5f7354" />
	              <stop offset="1" stopColor="#31453f" />
	            </linearGradient>
	            <linearGradient id="auroraGlow" x1="0" y1="0" x2="0" y2="1">
	              <stop offset="0" stopColor="#8fc9a0" stopOpacity=".62" />
	              <stop offset=".5" stopColor="#6b86a2" stopOpacity=".22" />
	              <stop offset="1" stopColor="#8fc9a0" stopOpacity="0" />
	            </linearGradient>
	            <filter id="landShadow" x="-30%" y="-30%" width="160%" height="160%">
	              <feDropShadow dx="0" dy="10" stdDeviation="18" floodColor="#081413" floodOpacity=".38" />
	            </filter>
            <clipPath id="viewportClip"><rect width="1000" height="900" rx="42" /></clipPath>
            <mask id="satelliteContextMask"><ellipse cx="520" cy="470" rx="315" ry="445" fill="url(#satelliteFade)" /></mask>
          </defs>
          <g clipPath="url(#viewportClip)">
            <rect width="1000" height="900" fill="url(#ocean)" />
            <g
              className="map-viewport"
              data-scale={mapView.scale.toFixed(2)}
              transform={`translate(${mapView.x} ${mapView.y}) scale(${mapView.scale})`}
            >
            <path className="day-arc" d="M120 145 Q500 -65 880 145" />
            <circle cx={sunX} cy={sunY} r="82" fill="url(#sunGlow)" className="sun-glow" />
            <circle cx={sunX} cy={sunY} r="7" className="sun-core" />
            {online && layers.has("aurora") && (snapshot.contextStatus.aurora === "live" || snapshot.contextStatus.aurora === "fallback") && snapshot.aurora && (
              <path
                className="aurora-curtain"
                style={{ opacity: Math.max(.12, (snapshot.aurora?.probability ?? 0) / 100) }}
                d="M0 0H1000V280C820 180 700 330 520 215C345 105 205 290 0 180Z"
                fill="url(#auroraGlow)"
              />
            )}
            <g className="sea-lines" aria-hidden="true">
              {Array.from({ length: 9 }, (_, index) => (
                <path key={index} d={`M -40 ${150 + index * 88} Q 230 ${120 + index * 88}, 520 ${155 + index * 88} T 1040 ${140 + index * 88}`} />
              ))}
            </g>
            <g className="island-shape" filter="url(#landShadow)">
              {islandPaths.map((path, index) => <path key={index} d={path} />)}
            </g>
            {timeMode !== "past" && online && !satelliteHistoryGap && layers.has("satellite") && (snapshot.contextStatus.satellite === "live" || snapshot.contextStatus.satellite === "fallback") && snapshot.satellite && <SatelliteTiles frame={snapshot.satellite} projection={projection} />}
            {radarLayerActive && radarFrame && radarFrameKey && (
              <RadarTiles
                frame={radarFrame}
                frameKey={radarFrameKey}
                projection={projection}
                onTileStatus={reportRadarTileStatus}
              />
            )}
            <g className="road-network" role="img" aria-label="Major roads from OpenStreetMap">
              {roadPaths.map((road, index) => (
                <path key={`${road.ref}-${index}`} d={road.path} className={road.roadClass} />
              ))}
            </g>
            <rect className="night-shade" x={isNight ? 0 : Math.max(0, sunX - 700)} width={isNight ? 1000 : 460} height="900" />
            {online && layers.has("wind") && (snapshot.sourceStatus === "live" || snapshot.sourceStatus === "partial") && (
              <g className="wind-field" aria-hidden="true">
                {Array.from({ length: 12 }, (_, index) => (
                  <path key={index} style={{ animationDelay: `${index * -0.45}s` }} d={`M ${75 + (index % 4) * 215} ${180 + Math.floor(index / 4) * 235} q 55 -22 115 0`} />
                ))}
              </g>
            )}
            {online && layers.has("rain") && (snapshot.sourceStatus === "live" || snapshot.sourceStatus === "partial") && snapshot.stations
              .filter((station) => (station.rainfall ?? 0) > 0)
              .map((station) => {
                const point = projection([station.longitude, station.latitude]);
                return point ? <circle key={`rain-${station.id}`} className="rain-cloud" cx={point[0]} cy={point[1]} r={45 + Math.min(65, (station.rainfall ?? 0) * 18)} /> : null;
              })}
            {layers.has("places") && PLACES.map((place, index) => {
              const point = projection([place.lon, place.lat]);
              return point ? (
                <g className={`place ${index < 3 ? "priority-major" : "priority-secondary"}`} key={place.name} transform={`translate(${point[0]} ${point[1]})`}>
                  <circle r="2.5" />
                  <text x="7" y="4">{place.name}</text>
                </g>
              ) : null;
            })}
            {selectedPlacePoint && (
              <g className="place-focus" transform={`translate(${selectedPlacePoint[0]} ${selectedPlacePoint[1]})`} aria-label={`${selectedPlace.name} is your selected place`}>
                <circle className="place-focus-ring" r="15" />
                <circle className="place-focus-core" r="4" />
                <text x="10" y="4">My place</text>
              </g>
            )}
            {layers.has("rivers") && displayedRivers.map((river) => {
              const point = projection([river.longitude, river.latitude]);
              return point ? (
                <MapMarker
                  className="river-marker"
                  key={river.id}
                  transform={`translate(${point[0]} ${point[1]})`}
                  interaction={markerInteraction(
                    `river:${river.id}`,
                    `${river.name} river gauge, ${river.level.toFixed(2)} metres`,
                    () => setSelected({ type: "river", item: river })
                  )}
                  focusRadius={13}
                  onActivate={() => setSelected({ type: "river", item: river })}
                >
                  <path d="M0 -7 C5 -1 7 2 7 6 A7 7 0 1 1 -7 6 C-7 2 -5 -1 0 -7Z" />
                </MapMarker>
              ) : null;
            })}
            {layers.has("sea") && displayedMarine.map((marineSite) => {
              const point = projection([marineSite.longitude, marineSite.latitude]);
              return point ? (
                <MapMarker
                  className="buoy"
                  key={marineSite.id}
                  transform={`translate(${point[0]} ${point[1]})`}
                  interaction={markerInteraction(
                    `buoy:${marineSite.id}`,
                    `${marineSite.name}, ${marineSite.kind === "weather-buoy" ? "weather buoy" : "coastal observatory"}, ${marineSite.waveHeight?.toFixed(1) ?? "unknown"} metre waves`,
                    () => setSelected({ type: "buoy", item: marineSite })
                  )}
                  focusRadius={18}
                  onActivate={() => setSelected({ type: "buoy", item: marineSite })}
                >
                  <circle className="buoy-wave" r={10 + (marineSite.waveHeight ?? 0) * 5} />
                  <circle className="buoy-core" r="3" />
                  <text x="8" y="4">{marineSite.waveHeight?.toFixed(1) ?? "—"} m</text>
                </MapMarker>
              ) : null;
            })}
            {layers.has("tides") && displayedTides.map((tide) => {
              const point = projection([tide.longitude, tide.latitude]);
              return point ? (
                <MapMarker
                  className={`tide-marker ${tide.surge !== null && Math.abs(tide.surge) >= .2 ? "is-unusual" : ""}`}
                  key={tide.id}
                  transform={`translate(${point[0]} ${point[1]})`}
                  interaction={markerInteraction(
                    `tide:${tide.id}`,
                    `${tide.name}, sea level ${tide.waterLevel?.toFixed(2) ?? "unknown"} metres, ${tide.surge === null ? "surge unavailable" : `${Math.abs(tide.surge).toFixed(2)} metres ${tide.surge >= 0 ? "above" : "below"} predicted tide`}`,
                    () => setSelected({ type: "tide", item: tide })
                  )}
                  focusRadius={15}
                  onActivate={() => setSelected({ type: "tide", item: tide })}
                >
                  <circle r="11" />
                  <path d="M-7 1Q-3-4 1 1T9 1" />
                  <text x="13" y="4">{tide.waterLevel?.toFixed(2) ?? "—"} m</text>
                </MapMarker>
              ) : null;
            })}
            {layers.has("bathing") && displayedBathingAlerts.map((alert) => {
              const point = bathingMarkerPoints.get(alert.id);
              return point ? (
                <MapMarker
                  className="bathing-marker"
                  key={alert.id}
                  transform={`translate(${point.x} ${point.y})`}
                  interaction={markerInteraction(
                    `bathing:${alert.id}`,
                    `${alert.name}, ${alert.restriction}`,
                    () => setSelected({ type: "bathing", item: alert })
                  )}
                  focusRadius={18}
                  onActivate={() => setSelected({ type: "bathing", item: alert })}
                >
                  <circle className="alert-pulse" r="15" />
                  <circle r="8" />
                  <text textAnchor="middle" y="4">!</text>
                </MapMarker>
              ) : null;
            })}
            {layers.has("weather") && displayedStations.map((station) => (
              <StationMarker
                key={station.id}
                station={station}
                projection={projection}
                active={selected?.type === "station" && selected.item.id === station.id}
                showWind={layers.has("wind")}
                onSelect={(item) => setSelected({ type: "station", item })}
                interaction={markerInteraction(
                  `station:${station.id}`,
                  `${station.name}, ${station.temperature ?? "unknown"} degrees, ${station.description}${layers.has("wind")
                    ? `, wind ${station.windSpeed ?? "unknown"} kilometres per hour from ${station.windDirection || "an unknown direction"}`
                    : ""}`,
                  () => setSelected({ type: "station", item: station })
                )}
              />
            ))}
            {layers.has("wind") && displayedStations.map((station) => {
              const point = projection([station.longitude, station.latitude]);
              if (!point || station.windSpeed === null) return null;
              const windLabel = `${station.name}, wind ${station.windSpeed} kilometres per hour from ${station.windDirection || "an unknown direction"}`;
              const onActivate = () => setSelected({ type: "station", item: station });
              const windInteraction = layers.has("weather")
                ? null
                : markerInteraction(`station:${station.id}`, windLabel, onActivate);
              const windContents = (
                <>
                  <circle r="12" />
                  <path transform={`rotate(${windDirectionDegrees(station.windDirection)})`} d="M0 -10L4 1L0 -1L-4 1Z" />
                  <text aria-hidden="true" x="14" y="4">{station.windSpeed} km/h</text>
                </>
              );
              return windInteraction ? (
                <MapMarker
                  className="wind-marker"
                  key={`wind-${station.id}`}
                  transform={`translate(${point[0] + 14} ${point[1] + 12})`}
                  interaction={windInteraction}
                  focusRadius={16}
                  onActivate={onActivate}
                >
                  {windContents}
                </MapMarker>
              ) : (
                <g
                  className="wind-marker"
                  data-wind-for={station.id}
                  key={`wind-${station.id}`}
                  transform={`translate(${point[0] + 14} ${point[1] + 12})`}
                  aria-hidden="true"
                  focusable="false"
                >
                  {windContents}
                </g>
              );
            })}
            {layers.has("air") && displayedAirQuality.map((reading) => {
              const point = projection([reading.longitude, reading.latitude]);
              return point ? (
                <MapMarker
                  className={`air-marker ${reading.source} aqi-${aqiLabel(reading.europeanAqi).toLowerCase().replaceAll(" ", "-")}`}
                  key={reading.id}
                  transform={`translate(${point[0]} ${point[1]})`}
                  interaction={markerInteraction(
                    `air:${reading.id}`,
                    `${reading.name}, ${reading.source} European air quality index ${reading.europeanAqi ?? "unavailable"}, ${aqiLabel(reading.europeanAqi)}`,
                    () => setSelected({ type: "air", item: reading })
                  )}
                  focusRadius={18}
                  onActivate={() => setSelected({ type: "air", item: reading })}
                >
                  <circle r="15" />
                  <text textAnchor="middle" y="4">{reading.europeanAqi ?? "—"}</text>
                </MapMarker>
              ) : null;
            })}
            {movementStacks.map((stack) => {
              const first = stack.items[0]!;
              const isStack = stack.items.length > 1;
              const isTrain = first.type === "train";
              const shouldZoom = stack.items.length > MOVEMENT_DRILL_THRESHOLD && mapView.scale < 4;
              const transitLabel = first.type === "transit" ? transitPresentation(first.item) : null;
              const openStack = () => isStack ? activateMovementStack(stack) : setSelected(first);
              const movementLabel = isStack
                ? `${stack.items.length} rail and public transport positions in this area; ${shouldZoom ? "activate to zoom in" : "activate to open a searchable list"}`
                : isTrain
                  ? `Train ${first.item.id}, ${first.item.direction}, ${first.item.status === "running" ? "running" : "due to start"}`
                  : `${transitLabel?.title}, ${transitLabel?.direction}, live public transport position`;
              return (
                <MapMarker
                  className={isStack
                    ? "movement-stack-marker"
                    : isTrain
                      ? `train-marker ${first.item.status}`
                      : "transit-marker"}
                  key={stack.key}
                  transform={`translate(${stack.x} ${stack.y})`}
                  interaction={markerInteraction(stack.key, movementLabel, openStack)}
                  focusRadius={15}
                  onActivate={openStack}
                  dataMovementMembers={stack.items.map(movementItemIdentity).join(",")}
                  dataClusterSize={stack.items.length}
                >
                  {isStack ? (
                    <>
                      <circle className="movement-stack-back" cx="3" cy="-3" r="10" />
                      <circle className="movement-stack-front" r="10" />
                      <text textAnchor="middle" y="3">{stack.items.length > 99 ? "99+" : stack.items.length}</text>
                    </>
                  ) : isTrain ? (
                    <>
                      <circle className="train-pulse" r="10" />
                      <path d="M-4-7h8a3 3 0 0 1 3 3v7a5 5 0 0 1-5 5h-4a5 5 0 0 1-5-5v-7a3 3 0 0 1 3-3Zm-1 3v4h10v-4Zm1 9h2m2 0h2" />
                    </>
                  ) : (
                    <>
                      <circle r="5" />
                      <path transform={`rotate(${first.item.bearing ?? 0})`} d="M0-8L4 3L0 1L-4 3Z" />
                    </>
                  )}
                </MapMarker>
              );
            })}
            {layers.has("earthquakes") && displayedEarthquakes.map((earthquake) => {
              const point = projection([earthquake.longitude, earthquake.latitude]);
              return point ? (
                <MapMarker
                  className="earthquake-marker"
                  key={earthquake.id}
                  transform={`translate(${point[0]} ${point[1]})`}
                  interaction={markerInteraction(
                    `earthquake:${earthquake.id}`,
                    `${earthquake.place}, magnitude ${earthquake.magnitude.toFixed(1)}`,
                    () => setSelected({ type: "earthquake", item: earthquake })
                  )}
                  focusRadius={16 + Math.max(0, earthquake.magnitude) * 3}
                  onActivate={() => setSelected({ type: "earthquake", item: earthquake })}
                >
                  <circle r={10 + Math.max(0, earthquake.magnitude) * 3} />
                  <path d="M-8 0H-3L0-7L3 7L6 0H10" />
                </MapMarker>
              ) : null;
            })}
            </g>
          </g>
        </svg>

        <nav className="map-navigation" aria-label="Map navigation">
          <button onClick={() => zoomMapAround(1.4)} disabled={mapView.scale >= 4} aria-label="Zoom in">+</button>
          <button onClick={() => zoomMapAround(1 / 1.4)} disabled={mapView.scale <= 1} aria-label="Zoom out">−</button>
          <button
            className="map-reset"
            onClick={() => setMapView({ scale: 1, x: 0, y: 0 })}
            disabled={mapView.scale === 1 && mapView.x === 0 && mapView.y === 0}
          >
            Reset
          </button>
          <output aria-live="polite" aria-label="Current map zoom">{Math.round(mapView.scale * 100)}%</output>
        </nav>
        </div>

        {layers.has("radar") && (
          <div
            className="radar-control"
            role="group"
            aria-label="Rainfall radar timeline"
            data-radar-availability={radarPresentationState}
            data-radar-ready-tiles={radarReadyCount}
            data-radar-unavailable-tiles={radarUnavailableCount}
          >
            <button
              type="button"
              onClick={() => {
                if (!prefersReducedMotion) setRadarPlaying((playing) => !playing);
              }}
              disabled={radarFrames.length < 2 || prefersReducedMotion || radarPresentationState !== "live"}
              aria-pressed={radarPlaying}
              aria-label={prefersReducedMotion
                ? "Replay radar timeline disabled because reduced motion is enabled"
                : radarPresentationState !== "live"
                  ? "Replay radar timeline unavailable until all Ireland tiles load"
                  : radarPlaying ? "Pause radar replay" : "Replay radar timeline"}
              aria-describedby="radar-motion-note"
            >
              {radarPlaying ? "Pause" : "Replay"}
            </button>
            <label>
              <span>{radarFrame ? formatTime(new Date(radarFrame.observedAt)) : "Unavailable"}</span>
              <input
                type="range"
                min="0"
                max={Math.max(0, radarFrames.length - 1)}
                value={Math.min(radarFrameIndex, Math.max(0, radarFrames.length - 1))}
                disabled={!radarFrames.length}
                onChange={(event) => {
                  setRadarPlaying(false);
                  setRadarFrameIndex(Number(event.target.value));
                }}
                aria-label="Radar frame"
                aria-valuetext={radarFrameValueText}
              />
              <small id="radar-motion-note">{radarPresentationState === "live" && prefersReducedMotion
                ? "Replay disabled for reduced motion · select a frame manually"
                : radarTimelineText}</small>
            </label>
          </div>
        )}

        {(layers.has("grid") || layers.has("aurora") || layers.has("iss")) && (
          <details
            className="map-context-disclosure"
            open={activePreset === "custom" && [layers.has("grid"), layers.has("aurora"), layers.has("iss")].filter(Boolean).length === 1 ? true : undefined}
          >
            <summary>Whole-island context · {[layers.has("grid"), layers.has("aurora"), layers.has("iss")].filter(Boolean).length} panel{[layers.has("grid"), layers.has("aurora"), layers.has("iss")].filter(Boolean).length === 1 ? "" : "s"}</summary>
            <div className="map-context-grid">
              {layers.has("grid") && <GridPanel historical={timeMode === "past"} grid={online && (snapshot.contextStatus.grid === "live" || snapshot.contextStatus.grid === "fallback") ? snapshot.grid : null} />}
              {layers.has("aurora") && <AuroraPanel aurora={online && (snapshot.contextStatus.aurora === "live" || snapshot.contextStatus.aurora === "fallback") ? snapshot.aurora : null} />}
              {layers.has("iss") && <IssPanel historical={timeMode === "past"} iss={online && (snapshot.contextStatus.iss === "live" || snapshot.contextStatus.iss === "fallback") ? snapshot.iss : null} />}
            </div>
          </details>
        )}

        <div className="map-caption">
          <span className="compass">N</span>
          <span>{timeMode === "past" ? "Stored observations, operational records and clearly labelled model data" : "Observed, operational, and clearly labelled model data"} · <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">© OpenStreetMap contributors</a></span>
        </div>

      </section>
                {briefing}
              </>
            );
          })()}
        </div>
      </section>

      {selected && createPortal(
        <div className="detail-modal-layer" onClick={(event) => {
          if (event.target === event.currentTarget) setSelected(null);
        }}>
          <DetailCard
            selected={selected}
            historical={timeMode === "past"}
            onClose={() => setSelected(null)}
            openerRef={markerOpenerRef}
            onStackChange={(index) => {
              setSelected((current) => current?.type === "movement-stack"
                ? { ...current, index }
                : current
              );
            }}
          />
        </div>,
        document.body
      )}

      <section id="what-matters-now" className="what-matters-now" data-scope="across-ireland" aria-labelledby="what-matters-heading">
        <div className="what-matters-heading">
          <div>
            <p className="eyebrow">Across Ireland · {timeMode === "past" ? "historical record" : "national briefing"}</p>
            <h2 id="what-matters-heading">What {timeMode === "past" ? "mattered then" : "matters now"}.</h2>
          </div>

        </div>
        {hasVisibleNotable && (
          <div className={`notable-signals ${showAllNotables ? "show-all" : ""}`} role="region" aria-label={`${timeMode === "past" ? "Historical" : "Current"} highlighted signals`}>
          {showRainNotable && weatherNotableCurrent && snapshot.summary.wettest && (snapshot.summary.wettest.rainfall ?? 0) > 0.5 && (
            <button className="signal-item" onClick={() => focusContext("radar")}>
              <span>Rainfall</span><b>{snapshot.summary.wettest.name}</b><small>{snapshot.summary.wettest.rainfall?.toFixed(1) ?? "—"} mm recently observed</small>
            </button>
          )}
          {showBathingNotables && bathingNotableCurrent && snapshot.bathingAlerts.map((alert) => (
            <button className="signal-item" key={alert.id} onClick={() => { focusContext("bathing"); setSelected({ type: "bathing", item: alert }); }}>
              <span>Bathing water</span><b>{alert.name}</b><small>{alert.restriction}</small>
            </button>
          ))}
          {showTideNotable && tideNotableCurrent && unusualTide && Math.abs(unusualTide.surge ?? 0) >= .15 && (
            <button className="signal-item" onClick={() => { focusContext("tides"); setSelected({ type: "tide", item: unusualTide }); }}>
              <span>Sea-level anomaly</span><b>{unusualTide.name}</b><small>{Math.abs(unusualTide.surge ?? 0).toFixed(2)} m {Number(unusualTide.surge) >= 0 ? "above" : "below"} modelled tide</small>
            </button>
          )}
          {showEarthquakeNotable && earthquakeNotableCurrent && largestEarthquake && (
            <button className="signal-item" onClick={() => { focusContext("earthquakes"); setSelected({ type: "earthquake", item: largestEarthquake }); }}>
              <span>Seismic detection</span><b>M {largestEarthquake.magnitude.toFixed(1)} · {largestEarthquake.place}</b><small>{formatDate(new Date(largestEarthquake.observedAt))}</small>
            </button>
          )}
          {showIssNotable && issNotableCurrent && visibleIssPass && (
            <button className="signal-item" onClick={() => focusContext("iss")}>
              <span>Night sky</span><b>ISS pass at {formatTime(new Date(visibleIssPass.startsAt))}</b><small>{formatDate(new Date(visibleIssPass.startsAt))} · up to {visibleIssPass.maxElevation.toFixed(0)}°</small>
            </button>
          )}
          {notableItemCount > 1 && (
            <button className="notable-more" onClick={() => setShowAllNotables((current) => !current)}>
              {showAllNotables ? "Show fewer" : `View ${notableItemCount - 1} more`}
            </button>
          )}
          </div>
        )}
        {!hasVisibleNotable && !isConnectingWithoutSnapshot && selectedSourceAssessment.assessedSourceCount > 0 && !selectedSourceAssessment.fullyAssessed && (
          <p className="signal-assessment"><span className="live-dot partial" />Unable to assess every selected signal source. Unavailable or non-current: {selectedSourceAssessment.unavailableSources.join(", ")}.</p>
        )}

        <div className="what-matters-grid">
        <button className="pulse-card grid" onClick={() => focusContext("grid")}>
          <span><i>ϟ</i> All-island electricity</span>
          <strong>{isConnectingWithoutSnapshot ? "…" : gridWindShare === null ? "—" : `${gridWindShare.toFixed(0)}%`}</strong>
          <small>{isConnectingWithoutSnapshot
            ? timeMode === "past" ? "Loading stored EirGrid coverage" : "Connecting to EirGrid operational data"
            : gridNotableCurrent && gridWindShare !== null
              ? `of ${timeMode === "past" ? "captured" : "current"} all-island demand supplied by wind, from EirGrid operational data`
              : gridNotableCurrent
                ? timeMode === "past" ? "The stored EirGrid record has no wind-share value" : "The current EirGrid response has no wind-share value, so wind share cannot be assessed"
                : timeMode === "past"
                  ? historyGapForFocus(historyGaps, "grid")?.detail ?? "Grid data was not retained for this record"
                : gridWindShare !== null
                  ? "saved wind share from the last successful refresh; current grid conditions are unconfirmed"
                  : gridSnapshotDisplayable
                    ? "The saved grid response has no wind-share value; current grid conditions are unconfirmed"
                    : "EirGrid data unavailable; current wind share cannot be assessed"}</small>
          <div className="signal-bars" aria-hidden="true">{[36, 52, 44, 70, 82, 65, 88].map((height, index) => <i key={index} style={{ height: `${height}%` }} />)}</div>
          <b>Open the grid {timeMode === "past" ? "at capture" : "now"} →</b>
        </button>
        <button className="pulse-card trains" onClick={() => focusContext("trains")}>
          <span><i>⌁</i> Rail positions</span>
          <strong>{isConnectingWithoutSnapshot ? "…" : timeMode === "past" ? historyState.envelope?.movementSummary.rail?.total ?? "—" : railNotableCurrent || trainsCached ? runningTrainCount ?? "—" : "—"}</strong>
          <small>{isConnectingWithoutSnapshot ? `${timeMode === "past" ? "Loading stored rail aggregate" : "Connecting to Iarnród Éireann positions"}` : timeMode === "past" ? historyState.envelope?.movementSummary.rail ? "rail services represented in the retained aggregate; individual positions were not retained" : historyGapForFocus(historyGaps, "trains")?.detail ?? "rail history unavailable; no zero is inferred" : railNotableCurrent ? runningTrainCount === null ? "rail positions are present, but the service count is unavailable" : "trains currently reporting a position across Ireland" : trainsCached ? runningTrainCount === null ? "cached positions are present, but the service count is unavailable" : "trains represented in the cached snapshot; current rail movement is unconfirmed" : "rail positions unavailable; current movement cannot be assessed"}</small>
          <div className="signal-line" aria-hidden="true"><i /><i /><i /><i /><i /><i /></div>
          <b>Follow the trains →</b>
        </button>
        <button className="pulse-card rivers" onClick={() => focusContext("rivers")}>
          <span><i>≈</i> River network</span>
          <strong>{isConnectingWithoutSnapshot ? "…" : riversAvailable ? (riverStationCount ?? snapshot.rivers.length) || "—" : "—"}</strong>
          <small>{isConnectingWithoutSnapshot ? timeMode === "past" ? "Loading stored OPW coverage" : "Connecting to OPW river gauges" : timeMode === "past" ? riversLive && !riverDataStale ? riverStationCount === null ? "OPW observations are present, but the retained gauge count is unavailable" : "OPW gauges retained in this historical record" : historyGapForFocus(historyGaps, "rivers")?.detail ?? "River observations were not retained" : riversLive && !riverDataStale ? riverStationCount === null ? "OPW readings are present, but the gauge count is unavailable" : "fresh OPW gauges distilled into a readable view across Ireland" : riversPartial ? `${snapshot.rivers.length} recent readings · partial coverage` : riversCached ? riverStationCount === null ? "cached river readings are present, but the gauge count is unavailable" : "gauges represented in the cached snapshot; current levels are unconfirmed" : riversFallback ? riverStationCount === null ? "fallback readings are present, but the gauge count is unavailable" : "gauges supplied by the labelled fallback source" : "river readings unavailable; current levels cannot be assessed"}</small>
          <div className="signal-wave" aria-hidden="true">⌁⌁⌁⌁⌁⌁</div>
          <b>See the water →</b>
        </button>
        </div>

        <details className="activity-context">
          <summary>{timeMode === "past" ? "Historical guidance note" : "Activity context"}</summary>
          {timeMode === "past" ? (
            <div className="now-guidance history-guidance" aria-labelledby="guidance-heading">
              <div className="guidance-heading">
                <div><p className="eyebrow">Historical context · {selectedPlace.name}</p><h3 id="guidance-heading">Live guidance is paused.</h3></div>
                <p>Stored observations are for review and comparison only. They are not used as current travel, coastal, outdoor or safety guidance.</p>
              </div>
            </div>
          ) : (
            <div className="now-guidance" aria-labelledby="guidance-heading">
              <div className="guidance-heading">
                <div>
                  <p className="eyebrow">Live context · {selectedPlace.name}</p>
                  <h3 id="guidance-heading">What the live data supports.</h3>
                </div>
                <p>Observed conditions, official notices and feed coverage grouped by intent. They are not a forecast, safety service, or promise of conditions at your exact location.</p>
              </div>
              <div className="guidance-list">
                {isConnectingWithoutSnapshot ? activityGuidance.map((item) => (
                  <button
                    type="button"
                    className="guidance-card connecting"
                    data-activity-id={item.id}
                    key={item.id}
                    disabled
                  >
                    <span className="guidance-status" data-guidance-mode="status">Connecting</span>
                    <strong>{item.title}</strong>
                    <span className="guidance-reason" data-guidance-mode="reason">Loading live observations and provider coverage…</span>
                    <span className="guidance-caveat" data-guidance-mode="caveat">No current condition is stated until the first refresh settles.</span>
                  </button>
                )) : serviceDisplayState === "offline" ? activityGuidance.map((item) => (
                  <button
                    type="button"
                    className="guidance-card unavailable"
                    data-activity-id={item.id}
                    key={item.id}
                    disabled
                  >
                    <span className="guidance-status" data-guidance-mode="status">Offline</span>
                    <strong>{item.title}</strong>
                    <span className="guidance-reason" data-guidance-mode="reason">Live sources cannot be refreshed while this device is offline.</span>
                    <span className="guidance-caveat" data-guidance-mode="caveat">Saved observations are not used as current activity context.</span>
                  </button>
                )) : activityGuidance.map((item) => (
                  <button
                    type="button"
                    className={`guidance-card ${item.status}`}
                    data-activity-id={item.id}
                    key={item.id}
                    onClick={() => focusActivity(item.id, item.title, `${item.reason} ${item.caveat}`)}
                  >
                    <span className="guidance-status" data-guidance-mode="status">{ACTIVITY_STATUS_LABELS[item.status]}</span>
                    <strong>{item.title}</strong>
                    <span className="guidance-reason" data-guidance-mode="reason">{item.reason}</span>
                    <span className="guidance-caveat" data-guidance-mode="caveat">{item.caveat}</span>
                  </button>
                ))}
              </div>
            </div>
          )}
        </details>
      </section>

      <section id="day-so-far" className="dayline" aria-label={`${timeMode === "past" ? "Selected day through capture" : "Today so far"} across Ireland`}>
        <div className="dayline-heading">
          <div><p className="eyebrow">{timeMode === "past" ? "Selected day through capture" : "Today so far"}</p><h2>The shape of the day</h2></div>
          <p>{snapshot.timeline.length
            ? "Temperature and average observed rain per reporting station use separate labelled scales. Select an hour for wind and exact values, or open the data list below."
            : "Hourly weather appears here only when recent Met Éireann observations can support it."}</p>
        </div>
        {snapshot.timeline.length ? (
          <>
            <div className="timeline-legend" role="img" aria-label="Chart legend">
              <span><i className="temperature" />Average temperature (°C)</span>
              <span><i className="rain" />Average observed rain per station (mm)</span>
            </div>
            {timeMode !== "past" && (snapshot.sourceStatus === "stale" || serviceDisplayState === "offline") && (
              <p className="timeline-empty">Saved hourly observations from the last successful refresh are shown below and are not labelled as current.</p>
            )}
            <div
              className="timeline-plot-scroll"
              role="region"
              aria-label="Scrollable hourly chart"
              tabIndex={0}
            >
              <div className="timeline-plot">
                <div className="timeline-axis temperature-axis" aria-hidden="true">
                  <span>{timelineTemperatureMax}°C</span>
                  <strong>Temperature</strong>
                  <span>{timelineTemperatureMin}°C</span>
                </div>
                <div className="timeline-chart" role="group" aria-label={`${timeMode === "past" ? "Stored" : snapshot.sourceStatus === "stale" || serviceDisplayState === "offline" ? "Saved" : "Current"} hourly average temperature, rainfall, and wind across reporting Met Éireann stations`}>
              {snapshot.timeline.map((point) => {
                const temperatureHeight = point.temperature === null
                  ? 4
                  : 12 + ((point.temperature - timelineTemperatureMin) / timelineTemperatureRange) * 76;
                const rainHeight = point.rainfall === null || point.rainfall <= 0
                  ? 0
                  : Math.max(5, (point.rainfall / timelineRainMax) * 88);
                return (
                  <button
                    type="button"
                    className={`timeline-point ${timelineSelection === point.time ? "selected" : ""}`}
                    key={point.time}
                    aria-pressed={timelineSelection === point.time}
                    aria-label={`${point.time}: average temperature ${point.temperature?.toFixed(1) ?? "unavailable"} degrees Celsius, average observed rainfall ${point.rainfall?.toFixed(1) ?? "unavailable"} millimetres per reporting station, average wind ${point.windSpeed?.toFixed(0) ?? "unavailable"} kilometres per hour`}
                    onClick={() => setTimelineSelection(point.time)}
                  >
                    <span className="timeline-bars" aria-hidden="true">
                      <span className="bar temperature" style={{ height: `${temperatureHeight}%` }} />
                      <span className="bar rain" style={{ height: `${rainHeight}%` }} />
                    </span>
                    <small>{point.time}</small>
                  </button>
                );
              })}
                </div>
                <div className="timeline-axis rain-axis" aria-hidden="true">
                  <span>{timelineRainMax.toFixed(1)} mm</span>
                  <strong>Average rain</strong>
                  <span>0 mm</span>
                </div>
                <p className="timeline-x-axis" aria-hidden="true">Hour of day · Irish time</p>
              </div>
            </div>
            <details className="timeline-data-list">
              <summary>View hourly values as a list</summary>
              <div className="timeline-table-scroll" role="region" aria-label="Hourly weather data table" tabIndex={0}>
                <table>
                  <caption>Hourly averages across reporting Met Éireann stations; rain is the mean of available station observations, not an island-wide total</caption>
                  <thead><tr><th scope="col">Time</th><th scope="col">Average temperature</th><th scope="col">Average rain</th><th scope="col">Average wind</th></tr></thead>
                  <tbody>
                    {snapshot.timeline.map((point) => (
                      <tr key={`list-${point.time}`}>
                        <th scope="row">{point.time}</th>
                        <td>{point.temperature === null ? "Unavailable" : `${point.temperature.toFixed(1)} °C`}</td>
                        <td>{point.rainfall === null ? "Unavailable" : `${point.rainfall.toFixed(1)} mm`}</td>
                        <td>{point.windSpeed === null ? "Unavailable" : `${point.windSpeed.toFixed(0)} km/h`}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </details>
          </>
        ) : (
          <div className="timeline-empty-state" role="status">
            <span aria-hidden="true">◌</span>
            <div>
              <h3>Hourly weather is not available yet</h3>
              <p>{isConnectingWithoutSnapshot
                ? "Connecting to recent Met Éireann observations…"
                : snapshot.sourceStatus === "live" || snapshot.sourceStatus === "partial"
                  ? timeMode === "past" ? "This historical record contains no retained hourly observations." : "The current provider response contains no hourly observations yet."
                  : snapshot.sourceStatus === "stale"
                    ? "No saved hourly observations remain within the retention window."
                    : "Hourly weather observations are unavailable. The chart will return when recent station data can support it."}</p>
            </div>
          </div>
        )}
        {selectedTimelinePoint && (
          <p className="timeline-selection" role="status">
            <b>{selectedTimelinePoint.time}</b> · {selectedTimelinePoint.temperature?.toFixed(1) ?? "—"}° average temperature · {selectedTimelinePoint.rainfall?.toFixed(1) ?? "—"} mm average observed rain per reporting station · {selectedTimelinePoint.windSpeed?.toFixed(0) ?? "—"} km/h average wind.
          </p>
        )}
      </section>

      <ExplorePanel
        open={panelOpen}
        onOpenChange={(open) => setPanelOpen(open)}
        openerRef={panelOpenerRef}
        timeMode={timeMode}
        activePreset={activePreset}
        layers={layers}
        layerGroups={LAYER_GROUPS}
        onShowPreset={showPreset}
        onToggleLayer={toggleLayer}
        snapshot={snapshot}
        historyEnvelope={historyState.envelope}
        historyGaps={historyGaps}
      />

      <footer>
        <div>
          <p><b>A Day in Ireland</b> turns public observations into a living portrait of the island.</p>
          <nav aria-label="Project information">
            <Link href="/about">About</Link>
            <Link href="/data">Data &amp; methodology</Link>
            <Link href="/privacy">Privacy</Link>
            <Link href="/contact">Contact</Link>
          </nav>
        </div>
        <p>Copyright Met Éireann; source met.ie; CC BY 4.0; presentation modified. Contains Irish Public Sector Information from waterlevel.ie, the Marine Institute and EPA; EirGrid operational data; EEA air-quality reports; CAMS model output via Open-Meteo; Sunrise-Sunset.org solar events; NOAA aurora guidance; NASA GIBS imagery; CelesTrak orbital elements; and USGS seismic detections. NTA GTFS data is licensed under CC BY 4.0, provided “as is”, and the NTA is not responsible for errors or inaccuracies. Road and boundary data © OpenStreetMap contributors, ODbL. Providers accept no liability for errors or omissions. Not for safety-critical decisions.</p>
      </footer>
    </main>
  );
}
