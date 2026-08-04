"use client";

import {
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type FocusEvent as ReactFocusEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
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
  BathingAlert,
  EarthquakeReading,
  LiveSnapshot,
  RiverReading,
  StationReading,
  TideReading,
  TrainPosition
} from "../lib/types";
import { maskRadarNoDataPixels } from "../lib/radar-tiles";
import { getSelectedSourceAssessment, getServiceDisplayState } from "../lib/data-state";
import { refreshCurrentContexts, refreshLivingLayers, refreshTransit, refreshWeather } from "../lib/browser-live";
import { getActivityGuidance, type ActivityId, type GuidancePlace } from "../lib/activity-guidance";
import { sortOfficialWeatherWarnings, warningTiming } from "../platform/river-source.js";
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

type Layer =
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

type Selection =
  | { type: "station"; item: StationReading }
  | { type: "train"; item: TrainPosition }
  | { type: "river"; item: RiverReading }
  | { type: "buoy"; item: LiveSnapshot["marine"][number] }
  | { type: "air"; item: AirQualityReading }
  | { type: "tide"; item: TideReading }
  | { type: "bathing"; item: BathingAlert }
  | { type: "earthquake"; item: EarthquakeReading }
  | { type: "transit"; item: LiveSnapshot["transit"][number] };

type MovementSelection = Extract<Selection, { type: "train" | "transit" }>;
type MapSelection =
  | Selection
  | { type: "movement-stack"; items: MovementSelection[]; index: number };

type MovementStack = {
  key: string;
  x: number;
  y: number;
  items: MovementSelection[];
};

const movementItemIdentity = (item: MovementSelection) => `${item.type}:${item.item.id}`;
const movementMarkerId = (identity: string) => `movement:${identity}`;
const MOVEMENT_DRILL_THRESHOLD = 12;
const MOVEMENT_PAGE_SIZE = 12;
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

type ContextFocus =
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

type Place = {
  id: string;
  name: string;
  lon: number;
  lat: number;
};

type Preset = "weather" | "movement" | "water" | "all" | "custom";

type LayerDefinition = readonly [Layer, string, string];

type LayerGroup = {
  id: string;
  label: string;
  detail: string;
  layers: LayerDefinition[];
};

type ConnectionStatus = "online" | "offline";

type NearbyReading<T> = {
  item: T;
  distanceKm: number;
};

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

const formatTime = (date: Date) => Number.isFinite(date.getTime())
  ? new Intl.DateTimeFormat("en-IE", {
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
      timeZone: "Europe/Dublin"
    }).format(date)
  : "Unavailable";

const orderedTideEvents = (tide: TideReading) => [
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

const provenanceLabel = (status: "live" | "partial" | "stale" | "fallback" | "unavailable") =>
  ({ live: "live", partial: "partial", stale: "cached", fallback: "fallback", unavailable: "unavailable" })[status];

const formatDate = (date: Date) =>
  new Intl.DateTimeFormat("en-IE", {
    weekday: "long",
    day: "numeric",
    month: "long",
    timeZone: "Europe/Dublin"
  }).format(date);

const irelandHour = (date: Date) =>
  Number.parseInt(
    new Intl.DateTimeFormat("en-IE", {
      hour: "2-digit",
      hour12: false,
      timeZone: "Europe/Dublin"
    }).format(date),
    10
  ) % 24;

function solarProgress(now: Date) {
  const hour = irelandHour(now) + now.getUTCMinutes() / 60;
  return Math.max(0, Math.min(1, (hour - 5) / 17));
}

function nationalNarrative(snapshot: LiveSnapshot, now: Date) {
  const hour = irelandHour(now);
  const period = hour < 6 ? "A quiet night across Ireland." : hour < 12 ? "Ireland is waking across the island." : hour < 18 ? "The day is in motion across Ireland." : hour < 22 ? "Evening is settling across Ireland." : "Ireland grows quieter across the island.";
  const currentWeather = snapshot.sourceStatus === "live" || snapshot.sourceStatus === "partial";
  const warm = snapshot.summary.warmest;
  const rain = snapshot.summary.wettest;
  const detail = !currentWeather
    ? snapshot.sourceStatus === "stale"
      ? "The most recent weather snapshot is cached, so current national conditions are not stated."
      : "Current weather observations are unavailable."
    : !warm && !rain
    ? "Current weather observations are unavailable."
    : rain && (rain.rainfall ?? 0) > 0
    ? `Rain is being observed around ${rain.name}, while ${warm?.name ?? "the warmest station"} reports ${warm?.temperature ?? "—"}°.`
    : `${warm?.name ?? "The warmest station"} is reporting ${warm?.temperature ?? "—"}°; no recent rain is represented among the reporting stations.`;
  return { period, detail };
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

const formatDistance = (value: number) => value < 10 ? `${value.toFixed(1)} km away` : `${Math.round(value)} km away`;

const ACTIVITY_STATUS_LABELS: Record<ReturnType<typeof getActivityGuidance>[number]["status"], string> = {
  "live-observations": "Live observations",
  "relevant-notice": "Relevant notice",
  "localized-notice": "Localized notice",
  "limited-context": "Limited context",
  "live-coverage": "Live coverage",
  "no-current-signal": "No current signal",
  unavailable: "Unavailable"
};

function formatAge(value: string | null | undefined, now: Date) {
  if (!value) return "unknown age";
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return "unknown age";
  const ageMinutes = Math.max(0, Math.round((now.getTime() - timestamp) / 60_000));
  if (ageMinutes < 1) return "just now";
  if (ageMinutes < 60) return `${ageMinutes}m ago`;
  const ageHours = Math.round(ageMinutes / 60);
  return `${ageHours}h ago`;
}

const newestTimestamp = (first: string | null | undefined, second: string | null | undefined) => {
  const firstTime = Date.parse(first ?? "");
  const secondTime = Date.parse(second ?? "");
  if (!Number.isFinite(secondTime)) return first ?? null;
  if (!Number.isFinite(firstTime) || secondTime > firstTime) return new Date(secondTime).toISOString();
  return first ?? null;
};

const warningScopeText = (warning: LiveSnapshot["warnings"][number]) => (warning.regions ?? []).length
  ? `named regions ${(warning.regions ?? []).join(", ")}`
  : "scope not specified";

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

function statusText(status: "live" | "partial" | "stale" | "fallback" | "unavailable") {
  return status === "stale" ? "cached" : status;
}

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
  now: Date
) {
  return `${provider} · ${item.name} · ${formatDistance(distanceKm)} · ${formatAge(item.observedAt, now)}`;
}

type MarkerInteraction = {
  markerId: string;
  ariaLabel: string;
  tabIndex: number;
  onFocus: (event: ReactFocusEvent<SVGGElement>) => void;
  onKeyDown: (event: ReactKeyboardEvent<SVGGElement>) => void;
  onKeyUp: (event: ReactKeyboardEvent<SVGGElement>) => void;
  onPointerActivate?: (element: SVGElement) => void;
};

function MapMarker({
  className,
  transform,
  interaction,
  focusRadius,
  onActivate,
  dataMovementMembers,
  dataClusterSize,
  children
}: {
  className: string;
  transform: string;
  interaction: MarkerInteraction;
  focusRadius: number;
  onActivate: () => void;
  dataMovementMembers?: string;
  dataClusterSize?: number;
  children: ReactNode;
}) {
  return (
    <g
      className={className}
      data-map-marker="true"
      data-marker-id={interaction.markerId}
      data-movement-members={dataMovementMembers}
      data-cluster-size={dataClusterSize}
      data-marker-pointer-target="true"
      transform={transform}
      role="button"
      tabIndex={interaction.tabIndex}
      aria-label={interaction.ariaLabel}
      onClick={(event) => {
        interaction.onPointerActivate?.(event.currentTarget);
        onActivate();
      }}
      onFocus={interaction.onFocus}
      onKeyDown={interaction.onKeyDown}
      onKeyUp={interaction.onKeyUp}
    >
      <circle className="map-marker-focus-ring" r={focusRadius} aria-hidden="true" />
      {children}
    </g>
  );
}

function StationMarker({
  station,
  projection,
  active,
  onSelect,
  interaction
}: {
  station: StationReading;
  projection: ReturnType<typeof geoMercator>;
  active: boolean;
  onSelect: (station: StationReading) => void;
  interaction: MarkerInteraction;
}) {
  const point = projection([station.longitude, station.latitude]);
  if (!point) return null;
  const [x, y] = point;
  const wet = (station.rainfall ?? 0) > 0;
  return (
    <MapMarker
      className={`station-marker ${active ? "is-active" : ""} ${wet ? "is-wet" : ""}`}
      transform={`translate(${x} ${y})`}
      interaction={interaction}
      focusRadius={19}
      onActivate={() => onSelect(station)}
    >
      {wet && <circle className="rain-ring" r="17" />}
      <circle className="station-halo" r="11" />
      <circle className="station-core" r="4" />
      <text aria-hidden="true" x="10" y="-7">{station.temperature ?? "—"}°</text>
    </MapMarker>
  );
}

const windDirectionDegrees = (direction: string) => {
  const points = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"];
  const index = points.indexOf(direction.toUpperCase());
  return index < 0 ? 0 : index * 22.5;
};

const aqiLabel = (value: number | null) => {
  if (value === null) return "Unavailable";
  if (value <= 20) return "Good";
  if (value <= 40) return "Fair";
  if (value <= 60) return "Moderate";
  if (value <= 80) return "Poor";
  if (value <= 100) return "Very poor";
  return "Extremely poor";
};

const tileLatitude = (y: number, zoom: number) =>
  Math.atan(Math.sinh(Math.PI * (1 - 2 * y / 2 ** zoom))) * 180 / Math.PI;

const IRELAND_RADAR_TILES = [
  [30, 20], [31, 20], [30, 21], [31, 21]
] as const;
type RadarTileStatus = "loading" | "ready" | "unavailable";
type RadarPresentationState = "unchecked" | "loading" | "partial" | "live" | "cached" | "unavailable";
type RadarTileStatusReporter = (
  frameKey: string,
  tileKey: string,
  status: RadarTileStatus
) => void;
const createRadarTileStatusRecord = (): Record<string, RadarTileStatus> => Object.fromEntries(
  IRELAND_RADAR_TILES.map(([x, y]) => [`${x}-${y}`, "loading" as const])
);

function RadarTileImage({
  href,
  frameKey,
  tileKey,
  onStatus,
  x,
  y,
  width,
  height
}: {
  href: string;
  frameKey: string;
  tileKey: string;
  onStatus: RadarTileStatusReporter;
  x: number;
  y: number;
  width: number;
  height: number;
}) {
  const [tile, setTile] = useState<{ href: string | null; status: "loading" | "ready" | "unavailable" }>({
    href: null,
    status: "loading"
  });

  useEffect(() => {
    const controller = new AbortController();
    let objectUrl: string | null = null;
    setTile({ href: null, status: "loading" });
    onStatus(frameKey, tileKey, "loading");

    const prepare = async () => {
      try {
        const response = await fetch(href, {
          cache: "force-cache",
          mode: "cors",
          signal: controller.signal
        });
        if (!response.ok || !response.headers.get("content-type")?.toLowerCase().startsWith("image/png")) {
          throw new Error(`Radar tile returned ${response.status}`);
        }
        const bitmap = await createImageBitmap(await response.blob());
        try {
          if (!bitmap.width || !bitmap.height || bitmap.width > 1024 || bitmap.height > 1024) {
            throw new Error("Radar tile dimensions are invalid");
          }
          const canvas = document.createElement("canvas");
          canvas.width = bitmap.width;
          canvas.height = bitmap.height;
          const context = canvas.getContext("2d", { willReadFrequently: true });
          if (!context) throw new Error("Radar tile canvas is unavailable");
          context.drawImage(bitmap, 0, 0);
          const image = context.getImageData(0, 0, bitmap.width, bitmap.height);
          maskRadarNoDataPixels(image.data);
          context.putImageData(image, 0, 0);
          const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
          if (!blob) throw new Error("Radar tile could not be encoded");
          objectUrl = URL.createObjectURL(blob);
          if (controller.signal.aborted) {
            URL.revokeObjectURL(objectUrl);
            objectUrl = null;
            return;
          }
          setTile({ href: objectUrl, status: "ready" });
          onStatus(frameKey, tileKey, "ready");
        } finally {
          bitmap.close();
        }
      } catch {
        if (!controller.signal.aborted) {
          setTile({ href: null, status: "unavailable" });
          onStatus(frameKey, tileKey, "unavailable");
        }
      }
    };
    void prepare();
    return () => {
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [frameKey, href, onStatus, tileKey]);

  return (
    <image
      className="radar-tile"
      data-radar-tile-state={tile.status}
      href={tile.href ?? undefined}
      x={x}
      y={y}
      width={width}
      height={height}
      preserveAspectRatio="none"
      aria-hidden="true"
    />
  );
}

function RadarTiles({
  frame,
  frameKey,
  projection,
  onTileStatus
}: {
  frame: LiveSnapshot["radar"][number];
  frameKey: string;
  projection: ReturnType<typeof geoMercator>;
  onTileStatus: RadarTileStatusReporter;
}) {
  const zoom = 6;
  return (
    <g className="radar-tiles" aria-label={`${frame.provider ?? "Met Éireann"} rainfall radar tiles for ${formatTime(new Date(frame.observedAt))}`}>
      {IRELAND_RADAR_TILES.map(([x, y]) => {
        const west = x / 2 ** zoom * 360 - 180;
        const east = (x + 1) / 2 ** zoom * 360 - 180;
        const north = tileLatitude(y, zoom);
        const south = tileLatitude(y + 1, zoom);
        const topLeft = projection([west, north]);
        const bottomRight = projection([east, south]);
        if (!topLeft || !bottomRight) return null;
        const tileKey = `${x}-${y}`;
        return <RadarTileImage
          key={tileKey}
          href={frame.tileTemplate
            .replace("{x}", String(x))
            .replace("{y}", String(y))
            .replace("{z}", String(zoom))}
          frameKey={frameKey}
          tileKey={tileKey}
          onStatus={onTileStatus}
          x={topLeft[0]}
          y={topLeft[1]}
          width={bottomRight[0] - topLeft[0]}
          height={bottomRight[1] - topLeft[1]}
        />;
      })}
    </g>
  );
}

function SatelliteTiles({
  frame,
  projection
}: {
  frame: NonNullable<LiveSnapshot["satellite"]>;
  projection: ReturnType<typeof geoMercator>;
}) {
  const zoom = 6;
  return (
    <g className="satellite-tiles" mask="url(#satelliteContextMask)" aria-label={`${frame.label}, ${formatDate(new Date(frame.observedAt))}`}>
      {[30, 31].flatMap((x) => [20, 21].map((y) => {
        const west = x / 2 ** zoom * 360 - 180;
        const east = (x + 1) / 2 ** zoom * 360 - 180;
        const north = tileLatitude(y, zoom);
        const south = tileLatitude(y + 1, zoom);
        const topLeft = projection([west, north]);
        const bottomRight = projection([east, south]);
        if (!topLeft || !bottomRight) return null;
        return (
          <image
            key={`${x}-${y}`}
            href={frame.tileTemplate
              .replace("{x}", String(x))
              .replace("{y}", String(y))
              .replace("{z}", String(zoom))}
            x={topLeft[0]}
            y={topLeft[1]}
            width={bottomRight[0] - topLeft[0]}
            height={bottomRight[1] - topLeft[1]}
            preserveAspectRatio="none"
          />
        );
      }))}
    </g>
  );
}

function DetailCard({
  selected,
  onClose,
  onStackChange,
  openerRef
}: {
  selected: MapSelection;
  onClose: () => void;
  onStackChange: (index: number) => void;
  openerRef: { current: SVGElement | null };
}) {
  const stack = selected.type === "movement-stack" ? selected : null;
  const resolved: Selection = selected.type === "movement-stack"
    ? selected.items[selected.index]!
    : selected;
  const { type, item } = resolved;
  const [movementQuery, setMovementQuery] = useState("");
  const [movementKind, setMovementKind] = useState<"all" | "train" | "transit">("all");
  const [movementPage, setMovementPage] = useState(0);
  const dialogRef = useRef<HTMLElement | null>(null);
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  const movementMatches = useMemo(() => {
    if (!stack) return [];
    const query = movementQuery.trim().toLocaleLowerCase("en-IE");
    return stack.items.map((movement, index) => ({ movement, index })).filter(({ movement }) => {
      if (movementKind !== "all" && movement.type !== movementKind) return false;
      if (!query) return true;
      const searchable = movement.type === "train"
        ? [movement.item.id, movement.item.direction, movement.item.message, "rail", "train"]
        : [movement.item.id, movement.item.route, movement.item.label, "tfi", "public transport"];
      return searchable.some((value) => value.toLocaleLowerCase("en-IE").includes(query));
    });
  }, [movementKind, movementQuery, stack]);
  const movementPageCount = Math.max(1, Math.ceil(movementMatches.length / MOVEMENT_PAGE_SIZE));
  const visibleMovementMatches = movementMatches.slice(
    movementPage * MOVEMENT_PAGE_SIZE,
    (movementPage + 1) * MOVEMENT_PAGE_SIZE
  );

  useEffect(() => {
    setMovementPage(0);
  }, [movementKind, movementQuery]);

  useEffect(() => {
    setMovementPage((current) => Math.min(current, movementPageCount - 1));
  }, [movementPageCount]);

  useLayoutEffect(() => {
    const focused = document.activeElement instanceof HTMLElement || document.activeElement instanceof SVGElement
      ? document.activeElement
      : null;
    const previouslyFocused = openerRef.current?.isConnected
      ? openerRef.current
      : focused && focused !== document.body
        ? focused
        : null;
    openerRef.current = null;
    const dialog = dialogRef.current;
    const previousOverflow = document.documentElement.style.overflow;
    document.documentElement.style.overflow = "hidden";
    closeRef.current?.focus({ preventScroll: true });
    if (!dialog) {
      document.documentElement.style.overflow = previousOverflow;
      return undefined;
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = [...dialog.querySelectorAll<HTMLElement>(
        "button, a[href], input, select, textarea, [tabindex]:not([tabindex='-1'])"
      )].filter((element) => !element.hasAttribute("disabled") && element.getClientRects().length > 0);
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      document.documentElement.style.overflow = previousOverflow;
      if (previouslyFocused?.isConnected) {
        window.requestAnimationFrame(() => {
          if (previouslyFocused.isConnected) previouslyFocused.focus();
        });
      }
    };
  }, [openerRef]);

  return (
    <aside
      ref={dialogRef}
      className={`station-card detail-${type} ${stack ? "has-movement-browser" : ""}`}
      aria-live="polite"
      aria-modal="true"
      aria-labelledby="map-detail-title"
      role="dialog"
      tabIndex={-1}
    >
      <button ref={closeRef} onClick={onClose} aria-label="Close map details">×</button>
      {stack && stack.items.length <= MOVEMENT_DRILL_THRESHOLD && (
        <div className="detail-stack-navigation" aria-label="Overlapping map items">
          <button
            onClick={() => onStackChange((stack.index - 1 + stack.items.length) % stack.items.length)}
            aria-label="Previous item at this location"
          >
            ←
          </button>
          <span>{stack.index + 1} of {stack.items.length}</span>
          <button
            onClick={() => onStackChange((stack.index + 1) % stack.items.length)}
            aria-label="Next item at this location"
          >
            →
          </button>
        </div>
      )}
      {stack && (
        <section className="movement-browser" aria-label={`${stack.items.length} transport positions in this area`}>
          <div className="movement-browser-heading">
            <strong>Transport in this area</strong>
            <span>{movementMatches.length} of {stack.items.length}</span>
          </div>
          <div className="movement-browser-filters">
            <label>
              <span>Search route, direction or vehicle</span>
              <input
                type="search"
                value={movementQuery}
                onChange={(event) => setMovementQuery(event.target.value)}
                placeholder="Try 42, Cork, or rail"
              />
            </label>
            <label>
              <span>Transport type</span>
              <select value={movementKind} onChange={(event) => setMovementKind(event.target.value as typeof movementKind)}>
                <option value="all">Rail and TFI</option>
                <option value="train">Rail only</option>
                <option value="transit">TFI only</option>
              </select>
            </label>
          </div>
          {visibleMovementMatches.length ? (
            <ol className="movement-results">
              {visibleMovementMatches.map(({ movement, index }) => {
                const label = movement.type === "train"
                  ? `Train ${movement.item.id} · ${movement.item.direction || "Direction unavailable"}`
                  : `${movement.item.route ? `Route ${movement.item.route}` : "TFI vehicle"} · ${movement.item.label}`;
                return (
                  <li key={movementItemIdentity(movement)}>
                    <button
                      type="button"
                      className={index === stack.index ? "active" : ""}
                      aria-current={index === stack.index ? "true" : undefined}
                      onClick={() => onStackChange(index)}
                    >
                      <b>{label}</b>
                      <small>{movement.type === "train" ? "Iarnród Éireann" : "Transport for Ireland"} · updated {formatTime(new Date(movement.item.observedAt))}</small>
                    </button>
                  </li>
                );
              })}
            </ol>
          ) : <p className="movement-results-empty">No transport positions match this search.</p>}
          {movementPageCount > 1 && (
            <nav className="movement-pagination" aria-label="Transport result pages">
              <button type="button" disabled={movementPage === 0} onClick={() => setMovementPage((page) => page - 1)}>Previous</button>
              <span>Page {movementPage + 1} of {movementPageCount}</span>
              <button type="button" disabled={movementPage >= movementPageCount - 1} onClick={() => setMovementPage((page) => page + 1)}>Next</button>
            </nav>
          )}
        </section>
      )}
      {type === "station" && (
        <>
          <p className="eyebrow">Met Éireann station</p>
          <h2 id="map-detail-title">{item.name}</h2>
          <div className="station-temperature">{item.temperature ?? "—"}°</div>
          <p>{item.description}</p>
          <dl>
            <div><dt>Rain</dt><dd>{item.rainfall ?? "—"} mm</dd></div>
            <div><dt>Wind</dt><dd>{item.windSpeed ?? "—"} km/h {item.windDirection}</dd></div>
            <div><dt>Observed</dt><dd>{item.observedAt ? formatTime(new Date(item.observedAt)) : "Unavailable"}</dd></div>
          </dl>
        </>
      )}
      {type === "train" && (
        <>
          <p className="eyebrow">Iarnród Éireann · live position</p>
          <h2 id="map-detail-title">Train {item.id}</h2>
          <div className="detail-emblem">↗</div>
          <p>{item.message || item.direction}</p>
          <dl>
            <div><dt>Status</dt><dd>{item.status === "running" ? "Running" : "Due to start"}</dd></div>
            <div>
              <dt>Speed</dt>
              <dd>{item.speedKmh == null ? "Awaiting next position" : `≈ ${item.speedKmh.toFixed(0)} km/h`}</dd>
            </div>
            <div><dt>Direction</dt><dd>{item.direction}</dd></div>
            <div><dt>Checked</dt><dd>{formatTime(new Date(item.observedAt))}</dd></div>
          </dl>
          <small className="detail-method-note">
            {item.speedSource === "calculated"
              ? "Estimated from the distance and time between successive Irish Rail positions."
              : "Irish Rail does not publish train speed; an estimate appears after a second usable position."}
          </small>
        </>
      )}
      {type === "river" && (
        <>
          <p className="eyebrow">OPW river gauge · near real time</p>
          <h2 id="map-detail-title">{item.name}</h2>
          <div className="station-temperature">{item.level.toFixed(2)}<small> m</small></div>
          <p>A gauge measurement—not a flood warning. Levels are local to each station and should not be compared between gauges.</p>
          <dl>
            <div><dt>Observed</dt><dd>{formatTime(new Date(item.observedAt))}</dd></div>
            <div><dt>Freshness</dt><dd>{item.fresh ? "Current" : "Stale"}</dd></div>
          </dl>
        </>
      )}
      {type === "buoy" && (
        <>
          <p className="eyebrow">Marine Institute · near real time</p>
          <h2 id="map-detail-title">{item.name}</h2>
          <div className="station-temperature">{item.waveHeight?.toFixed(1) ?? "—"}<small> m waves</small></div>
          <p>{item.kind === "weather-buoy" ? "Observed conditions at an offshore weather buoy." : "Observed conditions at a coastal marine observatory."} Measurements can be delayed or temporarily unavailable.</p>
          <dl>
            <div><dt>Wind</dt><dd>{item.windSpeedKnots?.toFixed(1) ?? "—"} knots</dd></div>
            <div><dt>Wave period</dt><dd>{item.wavePeriod?.toFixed(1) ?? "—"} seconds</dd></div>
            <div><dt>Sea temperature</dt><dd>{item.seaTemperature?.toFixed(1) ?? "—"}°C</dd></div>
            <div><dt>Observed</dt><dd>{formatTime(new Date(item.observedAt))}</dd></div>
          </dl>
        </>
      )}
      {type === "air" && (
        <>
          <p className="eyebrow">{item.source === "measured" ? "EEA · monitoring station" : "Open-Meteo CAMS · modelled"}</p>
          <h2 id="map-detail-title">{item.name}</h2>
          <div className="station-temperature">{item.europeanAqi ?? "—"}<small> European AQI</small></div>
          <p>
            {aqiLabel(item.europeanAqi)} air quality. {item.source === "measured"
              ? `This is a reported monitoring-station reading${item.stationClassification ? ` at a ${item.stationClassification} site` : ""}; EEA data normally arrives a few hours after measurement.`
              : "This is regional model output, not a reading from a sensor at this marker."}
          </p>
          <dl>
            <div><dt>PM2.5</dt><dd>{item.pm25?.toFixed(1) ?? "—"} μg/m³</dd></div>
            <div><dt>PM10</dt><dd>{item.pm10?.toFixed(1) ?? "—"} μg/m³</dd></div>
            <div><dt>Ozone</dt><dd>{item.ozone?.toFixed(0) ?? "—"} μg/m³</dd></div>
            <div><dt>UV index</dt><dd>{item.uvIndex?.toFixed(1) ?? "—"}</dd></div>
            <div><dt>Grass pollen</dt><dd>{item.grassPollen?.toFixed(1) ?? "—"} grains/m³</dd></div>
            <div><dt>{item.source === "measured" ? "Observed" : "Model time"}</dt><dd>{formatTime(new Date(item.observedAt))}</dd></div>
          </dl>
        </>
      )}
      {type === "tide" && (
        <>
          <p className="eyebrow">Marine Institute · tide gauge</p>
          <h2 id="map-detail-title">{item.name}</h2>
          <div className="station-temperature">{item.waterLevel?.toFixed(2) ?? "—"}<small> m relative to OD Malin</small></div>
          <p>
            Ordnance Datum Malin is Ireland&apos;s national height reference. A negative height means the sea is below that reference level—not that the water has negative depth.
          </p>
          <p>
            {item.surge === null
              ? "Observed sea level. The modelled tide and surge comparison is temporarily unavailable."
              : `${Math.abs(item.surge).toFixed(2)} m ${item.surge >= 0 ? "above" : "below"} the modelled astronomical tide.`}
          </p>
          <dl>
            <div><dt>Observed</dt><dd>{formatTime(new Date(item.observedAt))}</dd></div>
            <div><dt>Movement</dt><dd>{item.trend}</dd></div>
            {orderedTideEvents(item).map((event) => (
              <div key={event.label}>
                <dt>{event.label}</dt>
                <dd>{event.at ? `${formatTime(new Date(event.at))} · ${event.level?.toFixed(2) ?? "—"} m` : "—"}</dd>
              </div>
            ))}
          </dl>
        </>
      )}
      {type === "bathing" && (
        <>
          <p className="eyebrow">EPA · active bathing-water alert</p>
          <h2 id="map-detail-title">{item.name}</h2>
          <div className="detail-emblem warning">!</div>
          <p><strong>{item.restriction}</strong></p>
          <p>{item.description}</p>
          <dl>
            <div><dt>County</dt><dd>{item.county}</dd></div>
            <div><dt>Updated</dt><dd>{formatTime(new Date(item.updatedAt))}</dd></div>
          </dl>
          {item.noticeUrl && <a className="detail-link" href={item.noticeUrl} target="_blank" rel="noreferrer">Open official notice ↗</a>}
        </>
      )}
      {type === "earthquake" && (
        <>
          <p className="eyebrow">USGS · detected event</p>
          <h2 id="map-detail-title">{item.place}</h2>
          <div className="station-temperature">{item.magnitude.toFixed(1)}<small> magnitude</small></div>
          <p>A detected seismic event, not an impact or safety assessment.</p>
          <dl>
            <div><dt>Depth</dt><dd>{item.depthKm.toFixed(1)} km</dd></div>
            <div><dt>Detected</dt><dd>{formatTime(new Date(item.observedAt))}</dd></div>
          </dl>
          {item.detailUrl && <a className="detail-link" href={item.detailUrl} target="_blank" rel="noreferrer">Open USGS event ↗</a>}
        </>
      )}
      {type === "transit" && (
        <>
          <p className="eyebrow">Transport for Ireland · live position</p>
          <h2 id="map-detail-title">{item.route ? `Route ${item.route}` : item.label}</h2>
          <div className="detail-emblem">↗</div>
          <p>{item.label}</p>
          <dl>
            <div>
              <dt>Speed</dt>
              <dd>
                {item.speedKmh == null
                  ? "Awaiting next position"
                  : `${item.speedSource === "calculated" ? "≈ " : ""}${item.speedKmh.toFixed(0)} km/h`}
              </dd>
            </div>
            <div><dt>Updated</dt><dd>{formatTime(new Date(item.observedAt))}</dd></div>
          </dl>
          <small className="detail-method-note">
            {item.speedSource === "reported"
              ? "Speed reported by the NTA vehicle feed."
              : item.speedSource === "calculated"
                ? "Estimated from the distance and time between successive NTA positions."
                : "The NTA is not reporting speed for this vehicle; an estimate appears after a second usable position."}
          </small>
        </>
      )}
    </aside>
  );
}

function GridPanel({ grid, className = "" }: { grid: LiveSnapshot["grid"]; className?: string }) {
  return (
    <aside className={`map-data-panel grid-panel ${className}`} aria-label="All-island electricity grid now">
      <p className="eyebrow">EirGrid · operational data</p>
      <h2>The grid now</h2>
      {grid ? (
        <>
          <div className="grid-hero">
            <strong>{grid.windSharePercent === null ? "—" : `${grid.windSharePercent.toFixed(0)}%`}</strong>
            <span>{grid.windSharePercent === null ? "wind share is unavailable in this grid response" : "of current demand supplied by wind"}</span>
          </div>
          <dl>
            <div><dt>Demand</dt><dd>{grid.demandMW?.toLocaleString("en-IE") ?? "—"} MW</dd></div>
            <div><dt>Generation</dt><dd>{grid.generationMW?.toLocaleString("en-IE") ?? "—"} MW</dd></div>
            <div><dt>Wind</dt><dd>{grid.windMW?.toLocaleString("en-IE") ?? "—"} MW</dd></div>
            <div><dt>Carbon intensity</dt><dd>{grid.carbonIntensity?.toFixed(0) ?? "—"} gCO₂/kWh</dd></div>
            <div><dt>CO₂ emissions</dt><dd>{grid.carbonEmissions?.toFixed(0) ?? "—"} tCO₂/hr</dd></div>
            <div><dt>Frequency</dt><dd>{grid.frequencyHz?.toFixed(2) ?? "—"} Hz</dd></div>
            <div>
              <dt>Interconnection</dt>
              <dd>
                {grid.interconnectorMW === null
                  ? "—"
                  : grid.interconnectorMW > 0
                    ? `Import ${grid.interconnectorMW.toLocaleString("en-IE")} MW`
                    : grid.interconnectorMW < 0
                      ? `Export ${Math.abs(grid.interconnectorMW).toLocaleString("en-IE")} MW`
                      : "Balanced 0 MW"}
              </dd>
            </div>
            <div><dt>Data through</dt><dd>{grid.observedAt ? formatTime(new Date(grid.observedAt)) : "—"}</dd></div>
          </dl>
        </>
      ) : (
        <>
          <p>Operational grid data is temporarily unavailable.</p>
          <dl>
            <div><dt>Demand</dt><dd>— MW</dd></div>
            <div><dt>Generation</dt><dd>— MW</dd></div>
            <div><dt>Wind</dt><dd>— MW</dd></div>
            <div><dt>Frequency</dt><dd>— Hz</dd></div>
          </dl>
        </>
      )}
    </aside>
  );
}

function AuroraPanel({ aurora, className = "" }: { aurora: LiveSnapshot["aurora"]; className?: string }) {
  return (
    <aside className={`map-data-panel aurora-panel ${className}`} aria-label="Aurora probability over Ireland">
      <p className="eyebrow">NOAA OVATION · forecast</p>
      <h2>Aurora over Ireland</h2>
      {aurora ? (
        <>
          <div className="aurora-probability">
            <strong>{aurora.probability}%</strong>
            <span>maximum overhead probability</span>
          </div>
          <p>Kp {aurora.kpIndex?.toFixed(1) ?? "—"} · forecast for {formatTime(new Date(aurora.forecastAt))}</p>
          <small>This is probability directly overhead—not a guarantee of seeing aurora near the northern horizon. Darkness, cloud and light pollution matter.</small>
        </>
      ) : (
        <>
          <p>NOAA aurora guidance is temporarily unavailable.</p>
          <small>Aurora probability is guidance, not a guarantee of seeing aurora. Darkness, cloud and light pollution matter.</small>
        </>
      )}
    </aside>
  );
}

function IssPanel({ iss, className = "" }: { iss: LiveSnapshot["iss"]; className?: string }) {
  const next = iss?.passes[0] ?? null;
  const visible = iss?.passes.find((pass) => pass.visible) ?? null;
  return (
    <aside className={`map-data-panel iss-panel ${className}`} aria-label="International Space Station over Ireland">
      <p className="eyebrow">CelesTrak · calculated locally</p>
      <h2>ISS over Ireland</h2>
      {iss ? (
        <>
          <div className="iss-orbit-value">
            <strong>{iss.altitudeKm.toFixed(0)}</strong><span>km above Earth now</span>
          </div>
          <dl>
            <div><dt>Next pass</dt><dd>{next ? `${formatDate(new Date(next.startsAt))}, ${formatTime(new Date(next.startsAt))}` : "No pass in 48 hours"}</dd></div>
            <div><dt>Peak elevation</dt><dd>{next ? `${next.maxElevation.toFixed(0)}°` : "—"}</dd></div>
            <div><dt>Approaches from</dt><dd>{next?.direction ?? "—"}</dd></div>
            <div><dt>Next dark-sky pass</dt><dd>{visible ? `${formatDate(new Date(visible.startsAt))}, ${formatTime(new Date(visible.startsAt))}` : "None calculated in 48 hours"}</dd></div>
          </dl>
          <small>Passes are calculated for central Ireland. “Dark-sky” means the pass occurs at night; actual visibility also depends on sunlight on the station, cloud, your location and the horizon.</small>
        </>
      ) : <p>ISS orbital data is temporarily unavailable.</p>}
    </aside>
  );
}

export default function IrelandExperience({ initialSnapshot }: { initialSnapshot: LiveSnapshot }) {
  const [snapshot, setSnapshot] = useState(() => initialSnapshot);
  const [now, setNow] = useState(() => new Date(initialSnapshot.generatedAt));
  const [layers, setLayers] = useState<Set<Layer>>(
    () => new Set(["weather", "rain", "wind", "warnings", "places"])
  );
  const [activeMarkerId, setActiveMarkerId] = useState<string | null>(null);
  const [markerAnnouncement, setMarkerAnnouncement] = useState("");
  const [selected, setSelected] = useState<MapSelection | null>(null);
  const [panelOpen, setPanelOpen] = useState(false);
  const [openLayerGroups, setOpenLayerGroups] = useState<Set<string>>(() => new Set(["weather"]));
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
  const [viewHydrated, setViewHydrated] = useState(false);
  const [timelineSelection, setTimelineSelection] = useState<string | null>(null);
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>("online");
  const [mapDimensions, setMapDimensions] = useState({ width: 1000, height: 900 });
  const [mapFeedback, setMapFeedback] = useState("");
  const snapshotRef = useRef(initialSnapshot);
  const refreshAllRef = useRef<() => Promise<void>>(async () => undefined);
  const activeRadarFrameKeyRef = useRef<string | null>(null);
  const mapRef = useRef<SVGSVGElement | null>(null);
  const mapSectionRef = useRef<HTMLElement | null>(null);
  const pendingMapAnchorRef = useRef<number | null>(null);
  const markerOpenerRef = useRef<SVGElement | null>(null);
  const focusedMarkerRef = useRef<{ id: string; element: SVGGElement } | null>(null);
  const mapPointersRef = useRef(new Map<number, { x: number; y: number }>());
  const mapGestureRef = useRef<{ center: { x: number; y: number }; distance: number } | null>(null);
  const mapPointerOriginRef = useRef<{ x: number; y: number } | null>(null);
  const mapDidPanRef = useRef(false);
  const panelRef = useRef<HTMLElement | null>(null);
  const panelCloseRef = useRef<HTMLButtonElement | null>(null);
  const panelOpenerRef = useRef<HTMLButtonElement | null>(null);
  const experienceRef = useRef<HTMLElement | null>(null);

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
    const clock = window.setInterval(() => setNow(new Date()), 1000);
    const commit = (merge: (current: LiveSnapshot) => LiveSnapshot) => {
      setSnapshot((current) => {
        const next = merge(current);
        snapshotRef.current = next;
        return next;
      });
    };
    const update = async () => {
      const next = await refreshWeather(snapshotRef.current);
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
      const next = await refreshLivingLayers(snapshotRef.current);
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
      const next = await refreshCurrentContexts(snapshotRef.current);
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
        contextStatus: next.contextStatus,
        warnings: next.warnings
      }));
      setRadarFrameIndex(Math.max(0, next.radar.length - 1));
    };
    const updateTransit = async () => {
      const next = await refreshTransit(snapshotRef.current);
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
        setServicesRefreshing(false);
      }
    };
    refreshAllRef.current = refreshAll;
    void refreshAll();
    const recoveryRefresh = window.setTimeout(() => {
      const current = snapshotRef.current;
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
      window.clearInterval(clock);
      window.clearInterval(refresh);
      window.clearInterval(livingRefresh);
      window.clearInterval(contextRefresh);
      window.clearInterval(transitRefresh);
      window.clearTimeout(recoveryRefresh);
      refreshAllRef.current = async () => undefined;
    };
  }, []);

  useEffect(() => {
    setShowAllNotables(false);
  }, [layers]);

  useEffect(() => {
    if (!panelOpen) return;
    const panel = panelRef.current;
    const opener = panelOpenerRef.current;
    if (!panel) return;

    const closeButton = panelCloseRef.current;
    closeButton?.focus();
    const focusableSelector = [
      "button:not([disabled])",
      "a[href]",
      "input:not([disabled])",
      "select:not([disabled])",
      "textarea:not([disabled])",
      "summary",
      "[tabindex]:not([tabindex=\"-1\"])",
    ].join(", ");
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setPanelOpen(false);
        return;
      }
      if (event.key !== "Tab") return;

      const focusable = Array.from(panel.querySelectorAll<HTMLElement>(focusableSelector))
        .filter((element) => element.getAttribute("aria-hidden") !== "true" && element.getClientRects().length > 0);
      if (!focusable.length) {
        event.preventDefault();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;
      if (event.shiftKey && (active === first || !panel.contains(active))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (active === last || !panel.contains(active))) {
        event.preventDefault();
        first.focus();
      }
    };

    panel.addEventListener("keydown", handleKeyDown);
    return () => {
      panel.removeEventListener("keydown", handleKeyDown);
      if (opener?.isConnected) opener.focus();
    };
  }, [panelOpen]);

  useEffect(() => {
    const experience = experienceRef.current;
    if (!experience || !selected) return;
    experience.setAttribute("inert", "");
    return () => experience.removeAttribute("inert");
  }, [selected]);

  useEffect(() => {
    const sourceIsCurrent = (selection: Selection) => {
      if (connectionStatus !== "online") return false;
      if (selection.type === "station") return snapshot.sourceStatus === "live" || snapshot.sourceStatus === "partial";
      if (selection.type === "train") return snapshot.sourceProvenance?.trains.status === "live";
      if (selection.type === "river") return snapshot.sourceProvenance?.rivers.status === "live" || snapshot.sourceProvenance?.rivers.status === "fallback";
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
  }, [connectionStatus, snapshot.contextStatus, snapshot.sourceProvenance, snapshot.sourceStatus, snapshot.transitStatus]);

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
    if (connectionStatus !== "online") return [];
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
  }, [connectionStatus, snapshot.airQuality, snapshot.contextStatus.measuredAir, snapshot.contextStatus.modelledAir]);
  const displayedStations = useMemo(() => selectDeclutteredPoints(
    projectReadings(
      connectionStatus === "online" && (snapshot.sourceStatus === "live" || snapshot.sourceStatus === "partial")
        ? snapshot.stations.filter((station) => layers.has("weather") || station.windSpeed !== null)
        : [],
      projection,
      (station) => `station:${station.id}`,
      (station) => (station.rainfall ?? 0) > 0 ? 20 : 0
    ),
    mapViewport,
    isDenseView ? (activePreset === "all" ? 38 : 30) : 0,
    activeMarkerId
  ).map(({ item }) => item), [activeMarkerId, activePreset, connectionStatus, isDenseView, layers, mapViewport, projection, snapshot.sourceStatus, snapshot.stations]);
  const displayedRivers = useMemo(() => selectDeclutteredPoints(
    projectReadings(
      connectionStatus === "online" && (snapshot.sourceProvenance?.rivers.status === "live" || snapshot.sourceProvenance?.rivers.status === "fallback")
        ? snapshot.rivers
        : [],
      projection,
      (river) => `river:${river.id}`
    ),
    mapViewport,
    isDenseView ? (activePreset === "all" ? 42 : 32) : 0,
    activeMarkerId
  ).map(({ item }) => item), [activeMarkerId, activePreset, connectionStatus, isDenseView, mapViewport, projection, snapshot.rivers, snapshot.sourceProvenance?.rivers.status]);
  const displayedMarine = useMemo(() => selectDeclutteredPoints(
    projectReadings(
      connectionStatus === "online" && snapshot.contextStatus.marine === "live" ? snapshot.marine : [],
      projection,
      (reading) => `buoy:${reading.id}`,
      (reading) => reading.kind === "weather-buoy" ? 10 : 0
    ),
    mapViewport,
    isDenseView ? 40 : 0,
    activeMarkerId
  ).map(({ item }) => item), [activeMarkerId, connectionStatus, isDenseView, mapViewport, projection, snapshot.contextStatus.marine, snapshot.marine]);
  const displayedTides = useMemo(() => selectDeclutteredPoints(
    projectReadings(
      connectionStatus === "online" && (snapshot.contextStatus.tides === "live" || snapshot.contextStatus.tides === "fallback") ? snapshot.tides : [],
      projection,
      (tide) => `tide:${tide.id}`,
      (tide) => tide.surge !== null && Math.abs(tide.surge) >= .2 ? 80 : 20
    ),
    mapViewport,
    isDenseView ? 38 : 0,
    activeMarkerId
  ).map(({ item }) => item), [activeMarkerId, connectionStatus, isDenseView, mapViewport, projection, snapshot.contextStatus.tides, snapshot.tides]);
  const displayedBathingAlerts = useMemo(() => selectDeclutteredPoints(
    projectReadings(
      connectionStatus === "online" && (snapshot.contextStatus.bathing === "live" || snapshot.contextStatus.bathing === "fallback") ? snapshot.bathingAlerts : [],
      projection,
      (alert) => `bathing:${alert.id}`,
      () => 100
    ),
    mapViewport,
    0,
    activeMarkerId
  ).map(({ item }) => item), [activeMarkerId, connectionStatus, mapViewport, projection, snapshot.bathingAlerts, snapshot.contextStatus.bathing]);
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
      connectionStatus === "online" && (snapshot.contextStatus.earthquakes === "live" || snapshot.contextStatus.earthquakes === "fallback") ? snapshot.earthquakes : [],
      projection,
      (reading) => `earthquake:${reading.id}`,
      (reading) => reading.magnitude * 10
    ),
    mapViewport,
    isDenseView ? 40 : 0,
    activeMarkerId
  ).map(({ item }) => item), [activeMarkerId, connectionStatus, isDenseView, mapViewport, projection, snapshot.contextStatus.earthquakes, snapshot.earthquakes]);
  const movementStacks = useMemo<MovementStack[]>(() => {
    const points: ProjectedPoint<MovementSelection>[] = [];

    if (connectionStatus === "online" && layers.has("trains") && snapshot.sourceProvenance?.trains.status === "live") {
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
    if (connectionStatus === "online" && layers.has("transit") && snapshot.transitStatus === "live") {
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
  }, [activeMarkerId, activePreset, connectionStatus, layers, mapDimensions.width, mapViewport, projection, snapshot.sourceProvenance?.trains.status, snapshot.trains, snapshot.transit, snapshot.transitStatus]);
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
    (connectionStatus === "online" && layers.has("rivers") && (snapshot.sourceProvenance?.rivers.status === "live" || snapshot.sourceProvenance?.rivers.status === "fallback") ? snapshot.rivers.length : 0) +
    (connectionStatus === "online" && layers.has("sea") && snapshot.contextStatus.marine === "live" ? snapshot.marine.length : 0) +
    (connectionStatus === "online" && layers.has("tides") && (snapshot.contextStatus.tides === "live" || snapshot.contextStatus.tides === "fallback") ? snapshot.tides.length : 0) +
    (connectionStatus === "online" && layers.has("bathing") && (snapshot.contextStatus.bathing === "live" || snapshot.contextStatus.bathing === "fallback") ? snapshot.bathingAlerts.length : 0) +
    (connectionStatus === "online" && (snapshot.sourceStatus === "live" || snapshot.sourceStatus === "partial") && (layers.has("weather") || layers.has("wind")) ? snapshot.stations.filter((station) => layers.has("weather") || station.windSpeed !== null).length : 0) +
    (layers.has("air") ? sourceAirQuality.length : 0) +
    (connectionStatus === "online" && layers.has("trains") && snapshot.sourceProvenance?.trains.status === "live" ? deduplicateMovementRecords(snapshot.trains).length : 0) +
    (connectionStatus === "online" && layers.has("transit") && snapshot.transitStatus === "live" ? deduplicateMovementRecords(snapshot.transit).length : 0) +
    (connectionStatus === "online" && layers.has("earthquakes") && (snapshot.contextStatus.earthquakes === "live" || snapshot.contextStatus.earthquakes === "fallback") ? snapshot.earthquakes.length : 0);
  const activeLegendGroups = useMemo(() => LAYER_GROUPS.map((group) => ({
    id: group.id,
    label: group.label,
    layers: group.layers.filter(([id]) => layers.has(id)).map(([, label]) => label)
  })).filter((group) => group.layers.length > 0), [layers]);
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

  const narrative = nationalNarrative(snapshot, now);
  const daylight = solarProgress(now);
  const sunX = 880 - daylight * 760;
  const sunY = 145 - Math.sin(daylight * Math.PI) * 105;
  const currentHour = irelandHour(now);
  const isNight = currentHour < 6 || currentHour >= 21;
  const selectedPlace = ephemeralPlace ?? PLACE_OPTIONS.find((place) => place.id === selectedPlaceId) ?? PLACE_OPTIONS[0]!;
  const selectedPlaceIsEphemeral = selectedPlace.id === "nearby";
  const selectedPlacePoint = selectedPlace.id === "island"
    ? null
    : projection([selectedPlace.lon, selectedPlace.lat]);
  const localStation = selectedPlace.id === "island"
    ? null
    : nearestReadingWithinRadius(
        connectionStatus === "online" && (snapshot.sourceStatus === "live" || snapshot.sourceStatus === "partial")
          ? snapshot.stations.filter((station) => station.fresh)
          : [],
        selectedPlace,
        selectedPlaceIsEphemeral ? Number.POSITIVE_INFINITY : NEARBY_RADIUS_KM.weather
      );
  const localRiver = selectedPlace.id === "island"
    ? null
    : nearestReadingWithinRadius(
        connectionStatus === "online" && (snapshot.sourceProvenance?.rivers.status === "live" || snapshot.sourceProvenance?.rivers.status === "fallback")
          ? snapshot.rivers.filter((river) => river.fresh)
          : [],
        selectedPlace,
        selectedPlaceIsEphemeral ? Number.POSITIVE_INFINITY : NEARBY_RADIUS_KM.river
      );
  const localAir = selectedPlace.id === "island"
    ? null
    : nearestReadingWithinRadius(
        (connectionStatus === "online" && (snapshot.contextStatus.measuredAir === "live" || snapshot.contextStatus.measuredAir === "fallback") ? snapshot.airQuality : [])
          .filter((reading) => reading.source === "measured")
          .sort((first, second) => Date.parse(second.observedAt) - Date.parse(first.observedAt)),
        selectedPlace,
        selectedPlaceIsEphemeral ? Number.POSITIVE_INFINITY : NEARBY_RADIUS_KM.air
      ) ?? nearestReadingWithinRadius(
        (connectionStatus === "online" && (snapshot.contextStatus.modelledAir === "live" || snapshot.contextStatus.modelledAir === "fallback") ? snapshot.airQuality : [])
          .filter((reading) => reading.source === "modelled")
          .sort((first, second) => Date.parse(second.observedAt) - Date.parse(first.observedAt)),
        selectedPlace,
        selectedPlaceIsEphemeral ? Number.POSITIVE_INFINITY : NEARBY_RADIUS_KM.air
      );
  const warningsUnavailable = connectionStatus !== "online" || snapshot.contextStatus.warnings !== "live";
  const guidancePlace: GuidancePlace = {
    id: selectedPlace.id,
    name: selectedPlace.name,
    latitude: selectedPlace.lat,
    longitude: selectedPlace.lon
  };
  const activityGuidance = getActivityGuidance(snapshot, now, guidancePlace);
  const selectedTimelinePoint = snapshot.timeline.find((point) => point.time === timelineSelection) ?? null;
  const visibleWarnings = warningsUnavailable ? [] : sortOfficialWeatherWarnings(snapshot.warnings, now.getTime());
  const currentWarnings = visibleWarnings.filter((warning) => warningTiming(warning, now.getTime()) === "active");
  const activeWarning = currentWarnings[0] ?? null;
  const unusualTide = snapshot.tides
    .filter((tide) => tide.surge !== null)
    .sort((a, b) => Math.abs(b.surge ?? 0) - Math.abs(a.surge ?? 0))[0] ?? null;
  const largestEarthquake = [...snapshot.earthquakes].sort((a, b) => b.magnitude - a.magnitude)[0] ?? null;
  const visibleIssPass = snapshot.iss?.passes.find((pass) => pass.visible) ?? null;
  const showRainNotable = layers.has("rain");
  const showRailNotable = layers.has("trains");
  const showGridNotable = layers.has("grid");
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
  const online = connectionStatus === "online";
  const radarLayerActive = layers.has("radar");
  const radarFrames = online && snapshot.contextStatus.radar === "live" ? snapshot.radar : [];
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
  const weatherCached = snapshot.sourceStatus === "stale" || (!online && snapshot.stations.length > 0);
  const trainsLive = online && snapshot.sourceProvenance?.trains.status === "live";
  const trainsCached = snapshot.sourceProvenance?.trains.status === "stale" || (!online && snapshot.sourceProvenance?.trains.status === "live" && snapshot.trains.length > 0);
  const riversLive = online && snapshot.sourceProvenance?.rivers.status === "live";
  const riversCached = snapshot.sourceProvenance?.rivers.status === "stale" || (!online && (snapshot.sourceProvenance?.rivers.status === "live" || snapshot.sourceProvenance?.rivers.status === "fallback") && snapshot.rivers.length > 0);
  const riversFallback = online && snapshot.sourceProvenance?.rivers.status === "fallback";
  const riversAvailable = riversLive || riversCached || riversFallback;
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
    Boolean(showRailNotable && railNotableCurrent && snapshot.summary.runningTrains > 0) ||
    Boolean(showGridNotable && gridNotableCurrent && snapshot.grid) ||
    Boolean(showBathingNotables && bathingNotableCurrent && snapshot.bathingAlerts.length) ||
    Boolean(showTideNotable && tideNotableCurrent && unusualTide && Math.abs(unusualTide.surge ?? 0) >= .15) ||
    Boolean(showEarthquakeNotable && earthquakeNotableCurrent && largestEarthquake) ||
    Boolean(showIssNotable && issNotableCurrent && visibleIssPass);
  const notableItemCount =
    (showRainNotable && weatherNotableCurrent && snapshot.summary.wettest && (snapshot.summary.wettest.rainfall ?? 0) > 0.5 ? 1 : 0) +
    (showRailNotable && railNotableCurrent && snapshot.summary.runningTrains > 0 ? 1 : 0) +
    (showGridNotable && gridNotableCurrent && snapshot.grid ? 1 : 0) +
    (showBathingNotables && bathingNotableCurrent ? snapshot.bathingAlerts.length : 0) +
    (showTideNotable && tideNotableCurrent && unusualTide && Math.abs(unusualTide.surge ?? 0) >= .15 ? 1 : 0) +
    (showEarthquakeNotable && earthquakeNotableCurrent && largestEarthquake ? 1 : 0) +
    (showIssNotable && issNotableCurrent && visibleIssPass ? 1 : 0);
  const assessmentSnapshot = radarLayerActive && radarPresentationState !== "live"
    ? { ...snapshot, contextStatus: { ...snapshot.contextStatus, radar: "unavailable" as const } }
    : snapshot;
  const assessedSources = getSelectedSourceAssessment(assessmentSnapshot, layers, now.getTime());
  const selectedSourceAssessment = online ? assessedSources : {
    ...assessedSources,
    fullyAssessed: false,
    unavailableSources: ["offline connection", ...assessedSources.unavailableSources]
  };
  const liveServiceCount = online ? [
    snapshot.sourceStatus === "live" && snapshot.stations.length > 0 && !weatherStale,
    snapshot.sourceProvenance?.trains.status === "live" && snapshot.trains.length > 0 && !transitStale,
    snapshot.sourceProvenance?.rivers.status === "live" && snapshot.rivers.length > 0 && !riverDataStale,
    snapshot.contextStatus.marine === "live" && snapshot.marine.length > 0,
    radarPresentationState === "live",
    snapshot.contextStatus.grid === "live" && Boolean(snapshot.grid),
    snapshot.contextStatus.modelledAir === "live" && snapshot.airQuality.some((reading) => reading.source === "modelled"),
    snapshot.contextStatus.tides === "live",
    snapshot.contextStatus.bathing === "live",
    snapshot.contextStatus.satellite === "live",
    snapshot.contextStatus.earthquakes === "live",
    snapshot.contextStatus.iss === "live",
    snapshot.transitStatus === "live",
    snapshot.contextStatus.aurora === "live" && Boolean(snapshot.aurora)
  ].filter(Boolean).length : 0;
  const weatherBuoyCount = snapshot.marine.filter((reading) => reading.kind === "weather-buoy").length;
  const coastalObservatoryCount = snapshot.marine.length - weatherBuoyCount;
  const serviceDisplayState = getServiceDisplayState(snapshot, {
    initialRefreshComplete,
    refreshing: servicesRefreshing,
    online: connectionStatus === "online",
    now: now.getTime()
  });
  const isConnectingWithoutSnapshot = serviceDisplayState === "connecting";
  const weatherDisplayStatus = online ? snapshot.sourceStatus : snapshot.stations.length ? "stale" : "unavailable";
  const trainDisplayStatus = online ? snapshot.sourceProvenance?.trains.status ?? "unavailable" : snapshot.trains.length ? "stale" : "unavailable";
  const riverDisplayStatus = online ? snapshot.sourceProvenance?.rivers.status ?? "unavailable" : snapshot.rivers.length ? "stale" : "unavailable";
  const lastSuccessLabel = snapshot.lastSuccessAt ? formatAge(snapshot.lastSuccessAt, now) : "not yet";
  const connectionLabel = ({
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
  const displayedMapNotice = mapNotice?.focus === "radar"
    ? online
      ? { ...radarAvailabilityNotice, focus: "radar" as const }
      : {
          title: "Offline · radar not current",
          detail: `Radar tiles cannot be refreshed while offline. Last successful refresh ${lastSuccessLabel}; saved metadata is not presented as current precipitation imagery.`,
          focus: "radar" as const
        }
    : mapNotice;
  const radarTimelineText = radarPresentationState === "live"
    ? "Observed precipitation · all Ireland tiles loaded"
    : radarPresentationState === "partial"
      ? `Partial radar coverage · ${radarReadyCount} of ${radarTileCount} Ireland tiles loaded`
      : radarPresentationState === "loading"
        ? `Loading radar tiles · ${radarReadyCount} of ${radarTileCount} loaded`
        : radarPresentationState === "cached"
          ? "Cached radar metadata · current imagery unavailable"
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
    const previousTop = pendingMapAnchorRef.current;
    const map = mapSectionRef.current;
    if (previousTop === null || !map) return;
    pendingMapAnchorRef.current = null;
    const delta = map.getBoundingClientRect().top - previousTop;
    if (Math.abs(delta) > .5) window.scrollBy({ top: delta, left: 0, behavior: "auto" });
  }, [activePreset, layers]);

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
    setViewHydrated(true);
  }, [constrainMapView, projection]);

  useEffect(() => {
    if (!viewHydrated) return;
    if (!ephemeralPlace) storePlace(selectedPlaceId);
    const serialized = new URL(serializeViewState(window.location.href, {
      placeId: ephemeralPlace ? DEFAULT_PLACE_ID : selectedPlaceId,
      view: activePreset,
      layers,
      zoom: mapView.scale,
      panX: mapView.x,
      panY: mapView.y
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
  }, [activePreset, ephemeralPlace, layers, mapView, projection, selectedPlaceId, viewHydrated]);

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
          ? `${snapshot.summary.reporting} fresh Met Éireann stations. Select a temperature marker for its latest reading.`
          : snapshot.sourceStatus === "stale"
            ? `${snapshot.summary.reporting} cached Met Éireann station records are retained from the last successful refresh; they are not current observations.`
            : "Met Éireann weather observations are unavailable, so current conditions cannot be assessed."
      },
      wind: {
        title: "Observed wind",
        detail: weatherNotableCurrent
          ? `${snapshot.summary.reporting} Met Éireann stations with current wind direction and speed in km/h. Select an arrow for the complete observation.`
          : snapshot.sourceStatus === "stale"
            ? "Cached wind records are retained from the last successful refresh and are not presented as current wind."
            : "Met Éireann wind observations are unavailable, so current wind cannot be assessed."
      },
      trains: {
        title: railNotableCurrent ? "Live rail positions" : trainsCached ? "Cached rail positions" : "Rail positions unavailable",
        detail: railNotableCurrent
          ? `${snapshot.summary.runningTrains} running trains and ${snapshot.trains.length - snapshot.summary.runningTrains} due to start. Select a train for its direction and status.`
          : trainsCached
            ? `${snapshot.trains.length} positions are retained from the last successful refresh; current rail movement cannot be assessed.`
            : "Iarnród Éireann positions are unavailable, so this view cannot determine how many trains are currently moving."
      },
      rivers: {
        title: riversLive && !riverDataStale ? "Fresh river readings" : riversCached ? "Cached river readings" : riversFallback ? "Fallback river readings" : "River readings unavailable",
        detail: riversLive && !riverDataStale
          ? `${snapshot.summary.riverStations} OPW gauges observed within the last three hours. These are local levels, not flood warnings.`
          : riversCached
            ? `${snapshot.summary.riverStations} gauge readings are retained from the last successful refresh; they are not current levels.`
            : riversFallback
              ? `${snapshot.summary.riverStations} readings come from the labelled fallback source; they are local levels, not flood warnings.`
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
  }, [activeWarning, coastalObservatoryCount, lastSuccessLabel, now, online, prefersReducedMotion, railNotableCurrent, riverDataStale, riversCached, riversFallback, riversLive, snapshot, trainsCached, warningsUnavailable, weatherBuoyCount, weatherNotableCurrent]);

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
      panY: mapView.y
    });
    const shareData = {
      title: "A Day in Ireland",
      text: selectedPlace.id === "island" || selectedPlaceIsEphemeral
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
  }, [activePreset, layers, mapView, selectedPlace, selectedPlaceIsEphemeral]);

  return (
    <main ref={experienceRef} className={`experience ${isNight ? "is-night" : ""}`}>
      <a className="skip-link" href="#live-map">Skip to live map</a>
      <header className="topbar">
        <Link className="brand" href="/" aria-label="A Day in Ireland, home">
          <span className="brand-mark" aria-hidden="true">
            <svg viewBox="0 0 32 32">
              <path className="brand-sun" d="M11 15a5 5 0 0 1 10 0" />
              <path className="brand-horizon" d="M5 18h22M8 22h16" />
            </svg>
          </span>
          <span><b>A Day in Ireland</b><small>Live island view</small></span>
        </Link>
        <div
          className="live-state"
          data-connection-status={connectionStatus}
          data-service-state={serviceDisplayState}
          title={`${connectionLabel}. Last successful refresh ${lastSuccessLabel}.`}
        >
          <span className={`live-dot ${serviceDisplayState === "offline" ? "offline" : serviceDisplayState === "live" ? "live" : "partial"}`} />
          <span className="network-state">{connectionLabel}</span>
          <span>{serviceDisplayState === "live" ? "Live observations" : serviceDisplayState === "cached" || serviceDisplayState === "offline" ? "Saved observations" : serviceDisplayState === "unavailable" ? "Observations unavailable" : serviceDisplayState === "connecting" ? "Connecting" : "Partial observations"}</span>
          <time>{snapshot.lastSuccessAt ? formatTime(new Date(snapshot.lastSuccessAt)) : "—"}</time>
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
        <aside className="section-rail" aria-label="Live view across Ireland">
          <div className="rail-status">
            <span className={`live-dot ${serviceDisplayState === "offline" ? "offline" : serviceDisplayState === "live" ? "live" : "partial"}`} />
            <span><b>Live systems</b><small>{connectionLabel}</small><small>{isConnectingWithoutSnapshot ? "Connecting…" : `${liveServiceCount} live · last success ${lastSuccessLabel}`}</small></span>
          </div>
          <nav aria-label="Map view shortcuts">
            <button className={activePreset === "weather" ? "active" : ""} aria-pressed={activePreset === "weather"} onClick={() => showPreset("weather")}><span aria-hidden="true">☁</span><span className="rail-label">Weather</span></button>
            <button className="rail-extra" onClick={() => focusContext("radar")}><span aria-hidden="true">◉</span><span className="rail-label">Rain radar</span></button>
            <button className={activePreset === "movement" ? "active" : ""} aria-pressed={activePreset === "movement"} onClick={() => showPreset("movement")}><span aria-hidden="true">↗</span><span className="rail-label">Movement</span></button>
            <button className={activePreset === "water" ? "active" : ""} aria-pressed={activePreset === "water"} onClick={() => showPreset("water")}><span aria-hidden="true">≈</span><span className="rail-label">Water</span></button>
            <button className="rail-extra" onClick={() => focusContext("sea")}><span aria-hidden="true">⌁</span><span className="rail-label">Sea</span></button>
            <button className="rail-extra" onClick={() => focusContext("grid")}><span aria-hidden="true">ϟ</span><span className="rail-label">Energy</span></button>
            <button className="rail-extra" onClick={() => focusContext("air")}><span aria-hidden="true">◌</span><span className="rail-label">Air</span></button>
            <button className={activePreset === "all" ? "active" : ""} aria-pressed={activePreset === "all"} onClick={() => showPreset("all")}><span aria-hidden="true">⌘</span><span className="rail-label">All layers</span></button>
            <button
              className={activePreset === "custom" ? "active rail-custom" : "rail-custom"}
              aria-pressed={activePreset === "custom"}
              onClick={(event) => {
                panelOpenerRef.current = event.currentTarget;
                setPanelOpen(true);
              }}
            ><span aria-hidden="true">⋯</span><span className="rail-label">Custom · {layers.size}</span></button>
          </nav>
          <a className="rail-map-action" href="#live-map">View live map <span aria-hidden="true">↓</span></a>
          <div className="rail-metrics">
            <p><span>Warmest</span><strong>{isConnectingWithoutSnapshot ? "…" : weatherNotableCurrent ? `${snapshot.summary.warmest?.temperature ?? "—"}°` : "—"}</strong><small>{isConnectingWithoutSnapshot ? "Connecting" : weatherNotableCurrent ? snapshot.summary.warmest?.name ?? "No usable report" : weatherCached ? "Saved weather; summary withheld" : "Provider unavailable"}</small></p>
            <p><span>Strongest wind</span><strong>{isConnectingWithoutSnapshot ? "…" : weatherNotableCurrent ? snapshot.summary.windiest?.windSpeed ?? "—" : "—"}</strong><small>{isConnectingWithoutSnapshot ? "Connecting" : weatherNotableCurrent ? `km/h · ${snapshot.summary.windiest?.name ?? "No usable report"}` : weatherCached ? "Saved weather; summary withheld" : "Provider unavailable"}</small></p>
            <p><span>Trains moving</span><strong>{isConnectingWithoutSnapshot ? "…" : trainsLive || trainsCached ? snapshot.summary.runningTrains : "—"}</strong><small>{isConnectingWithoutSnapshot ? "Connecting" : trainsLive ? "Current positions" : trainsCached ? "Cached positions" : "Provider unavailable"}</small></p>
            <p><span>River gauges</span><strong>{isConnectingWithoutSnapshot ? "…" : riversAvailable ? snapshot.summary.riverStations : "—"}</strong><small>{isConnectingWithoutSnapshot ? "Connecting" : riversLive ? "Fresh readings" : riversCached ? "Cached readings" : riversFallback ? "Fallback source" : "Provider unavailable"}</small></p>
          </div>
        </aside>

        <div className="map-workspace">
          <div className="workspace-heading" id="ireland-now">
            <div>
              <p className="eyebrow">Ireland now<span className="moment-time"> · {formatDate(now)} · {formatTime(now)} IST</span></p>
              <h1 id="moment-heading">Ireland now.</h1>
              <p>{isConnectingWithoutSnapshot ? "Connecting to live observations across the island…" : servicesRefreshing ? "Loading fresh observations across the island…" : serviceDisplayState === "offline" ? `Offline. Showing the last saved observations where available; last success ${lastSuccessLabel}.` : serviceDisplayState === "cached" ? `A refresh failed. Cached observations are labelled and last succeeded ${lastSuccessLabel}.` : serviceDisplayState === "unavailable" ? "Live services are unavailable, so national conditions cannot be assessed." : `${narrative.period} ${narrative.detail}`}</p>
              <a className="view-map-action" href="#live-map">View live map <span aria-hidden="true">↓</span></a>
            </div>
            <div className="workspace-facts" aria-label="Current national highlights across Ireland">
              <button onClick={() => focusContext("grid")}><b>{gridNotableCurrent && snapshot.grid?.windSharePercent !== null && snapshot.grid?.windSharePercent !== undefined ? `${snapshot.grid.windSharePercent.toFixed(0)}%` : "—"}</b><small>{gridNotableCurrent && snapshot.grid?.windSharePercent !== null && snapshot.grid?.windSharePercent !== undefined ? "demand met by wind" : "grid wind share unavailable"}</small></button>
              <button onClick={() => focusContext("sea")}><b>{online && snapshot.contextStatus.marine === "live" ? snapshot.marine.length : "—"}</b><small>{online && snapshot.contextStatus.marine === "live" ? "marine sites reporting" : "marine observations unavailable"}</small></button>
              <button onClick={() => focusContext("radar")}><b>{weatherNotableCurrent && snapshot.summary.wettest?.rainfall !== null && snapshot.summary.wettest?.rainfall !== undefined ? `${snapshot.summary.wettest.rainfall} mm` : "—"}</b><small>{weatherNotableCurrent ? "recent observed rain" : "rain observations unavailable"}</small></button>
            </div>
          </div>

          {(() => {
            const briefing = (
              <>
          <section
            className={`place-context ${selectedPlace.id === "island" ? "island-context" : "local-context"}`}
            data-place-id={selectedPlace.id}
            aria-labelledby="my-place-heading"
          >
            <div className="place-picker">
              <p className="eyebrow">My Place</p>
              <h2 id="my-place-heading">{selectedPlace.name}</h2>
              <p className="place-context-summary">
                {selectedPlace.id === "island"
                  ? "Whole-island context is shown above; choose a mapped place or use your location for nearby observations."
                  : selectedPlaceIsEphemeral
                    ? "Nearest available observations to the coordinates you shared for this session. Distances are shown so far-away readings are never presented as local."
                    : `Nearby observations for ${selectedPlace.name}. Each source has its own radius; outside it, no local reading is shown.`}
              </p>
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
            </div>
            <div
              className="place-observations"
              aria-label={selectedPlace.id === "island" ? "Local observations unavailable until a place is selected" : `Local observations near ${selectedPlace.name}`}
            >
              <p className="eyebrow">{selectedPlace.id === "island" ? "Local observations · choose a place" : `Local observations near ${selectedPlace.name}`}</p>
              <dl>
                <div>
                  <dt>Temperature</dt>
                  <dd>{localStation?.item.temperature ?? "—"}°</dd>
                  <small>{localStation
                    ? formatLocalObservation("Met Éireann", localStation.item, localStation.distanceKm, now)
                    : isConnectingWithoutSnapshot ? "Connecting to weather observations…" : !online ? "Offline; saved weather is not used as a current nearby condition." : snapshot.sourceStatus === "live" || snapshot.sourceStatus === "partial" ? selectedPlaceIsEphemeral ? "No current weather observation is available." : `No nearby weather observation within ${NEARBY_RADIUS_KM.weather} km.` : "Weather observations are unavailable; nearby conditions cannot be assessed."}</small>
                </div>
                <div>
                  <dt>Rain</dt>
                  <dd>{localStation?.item.rainfall == null ? "—" : `${localStation.item.rainfall} mm`}</dd>
                  <small>{localStation
                    ? formatLocalObservation("Met Éireann", localStation.item, localStation.distanceKm, now)
                    : isConnectingWithoutSnapshot ? "Connecting to rain observations…" : !online ? "Offline; saved rain observations are not used as current nearby rainfall." : snapshot.sourceStatus === "live" || snapshot.sourceStatus === "partial" ? selectedPlaceIsEphemeral ? "No current rain observation is available." : `No nearby rain observation within ${NEARBY_RADIUS_KM.weather} km.` : "Rain observations are unavailable; nearby rainfall cannot be assessed."}</small>
                </div>
                <div>
                  <dt>River</dt>
                  <dd>{localRiver ? `${localRiver.item.level.toFixed(2)} m` : "—"}</dd>
                  <small>{localRiver
                    ? formatLocalObservation("OPW", localRiver.item, localRiver.distanceKm, now)
                    : isConnectingWithoutSnapshot ? "Connecting to river gauges…" : riversLive || riversFallback ? selectedPlaceIsEphemeral ? "No current river observation is available." : `No nearby river observation within ${NEARBY_RADIUS_KM.river} km.` : riversCached ? "The river feed is unavailable; cached readings are not used as current local conditions." : "River readings are unavailable; nearby levels cannot be assessed."}</small>
                </div>
                <div>
                  <dt>Air</dt>
                  <dd>{localAir?.item.europeanAqi == null ? "—" : `AQI ${localAir.item.europeanAqi}`}</dd>
                  <small>{localAir
                    ? formatLocalObservation(localAir.item.source === "measured" ? "EEA measured" : "CAMS modelled", localAir.item, localAir.distanceKm, now)
                    : isConnectingWithoutSnapshot ? "Connecting to air-quality sources…" : !online ? "Offline; saved air-quality data is not used as a current nearby condition." : snapshot.contextStatus.measuredAir === "live" || snapshot.contextStatus.measuredAir === "fallback" || snapshot.contextStatus.modelledAir === "live" || snapshot.contextStatus.modelledAir === "fallback" ? selectedPlaceIsEphemeral ? "No current measured or modelled air context is available." : `No nearby air observation within ${NEARBY_RADIUS_KM.air} km.` : "Air-quality sources are unavailable; nearby conditions cannot be assessed."}</small>
                </div>
              </dl>
            </div>
          </section>

          <div className="freshness-strip" aria-label="Data freshness and provider status">
            <button
              type="button"
              onClick={(event) => {
                panelOpenerRef.current = event.currentTarget;
                setPanelOpen(true);
              }}
            >
              Data details <span aria-hidden="true">→</span>
            </button>
            <button
              type="button"
              className="retry-live-data"
              onClick={() => void refreshAllRef.current()}
              disabled={connectionStatus === "offline" || servicesRefreshing}
            >
              {servicesRefreshing ? "Loading…" : "Retry live data"}
            </button>
            <span className={`freshness-chip connection-chip ${serviceDisplayState}`} data-connection-status={connectionStatus} data-service-state={serviceDisplayState} aria-live="polite">
              <i aria-hidden="true" /><b>Connection</b><small>{connectionLabel} · Last success {lastSuccessLabel}</small>
            </span>
            <span
              className={`freshness-chip ${isConnectingWithoutSnapshot ? "connecting" : weatherDisplayStatus}`}
              aria-label={isConnectingWithoutSnapshot ? "Weather provider connecting" : `Weather provider ${statusText(weatherDisplayStatus)}; latest national observation ${formatAge(latestWeatherObs > 0 ? new Date(latestWeatherObs).toISOString() : null, now)}${!online ? "; offline saved snapshot" : weatherStale && snapshot.stations.length > 0 ? "; observation data is stale" : ""}`}
            >
              <i aria-hidden="true" /><b>Weather provider</b><small>{isConnectingWithoutSnapshot ? "Connecting…" : `Provider: ${statusText(weatherDisplayStatus)}${!online ? " (offline)" : ""} · Observation: ${formatAge(latestWeatherObs > 0 ? new Date(latestWeatherObs).toISOString() : null, now)}${online && weatherStale && snapshot.stations.length > 0 ? " · stale" : ""}`}</small>
            </span>
            <span
              className={`freshness-chip ${isConnectingWithoutSnapshot ? "connecting" : trainDisplayStatus}`}
              aria-label={isConnectingWithoutSnapshot ? "Rail provider connecting" : `Rail provider ${statusText(trainDisplayStatus)}; latest observation ${formatAge(snapshot.sourceProvenance?.trains.latestObservedAt, now)}${!online ? "; offline saved snapshot" : transitStale && snapshot.trains.length > 0 ? "; positions are stale" : ""}`}
            >
              <i aria-hidden="true" /><b>Rail provider</b><small>{isConnectingWithoutSnapshot ? "Connecting…" : `Provider: ${statusText(trainDisplayStatus)}${!online ? " (offline)" : ""} · Observation: ${formatAge(snapshot.sourceProvenance?.trains.latestObservedAt, now)}${online && transitStale && snapshot.trains.length > 0 ? " · stale" : ""}`}</small>
            </span>
            <span
              className={`freshness-chip ${isConnectingWithoutSnapshot ? "connecting" : riverDisplayStatus}`}
              aria-label={isConnectingWithoutSnapshot ? "River provider connecting" : `River provider ${statusText(riverDisplayStatus)}; latest observation ${formatAge(snapshot.sourceProvenance?.rivers.latestObservedAt, now)}${!online ? "; offline saved snapshot" : riverDataStale && snapshot.rivers.length > 0 ? "; readings are stale" : ""}`}
            >
              <i aria-hidden="true" /><b>River provider</b><small>{isConnectingWithoutSnapshot ? "Connecting…" : `Provider: ${statusText(riverDisplayStatus)}${!online ? " (offline)" : ""} · Observation: ${formatAge(snapshot.sourceProvenance?.rivers.latestObservedAt, now)}${online && riverDataStale && snapshot.rivers.length > 0 ? " · stale" : ""}`}</small>
            </span>
          </div>

          <section className="official-notices" data-scope="across-ireland" aria-labelledby="official-notices-heading">
            <div className="official-notices-heading">
              <div>
                <p className="eyebrow">Official notices</p>
                <h2 id="official-notices-heading">Official notices across Ireland</h2>
              </div>
              <p>Met Éireann notices are shown with their named scope and timing. Regional notices do not describe the whole island.</p>
            </div>
            {layers.has("warnings") ? isConnectingWithoutSnapshot ? (
              <p className="official-notices-empty">Connecting to the Met Éireann notice feed…</p>
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
                    aria-label={`Official Met Éireann ${isActive ? "active" : "upcoming"} notice for ${warningScopeText(warning)}`}
                    role="status"
                  >
                    <span>{isActive ? "Official notice" : "Upcoming notice"}</span>
                    <div>
                      <b>{warning.headline}</b>
                      <small>
                        Met Éireann · {warningScopeText(warning)} · {warning.description || "Description unavailable."}
                      </small>
                      <small>
                        {warning.level} level · severity {warning.severity || "unknown"} · issued {formatWarningDate(warning.issued)} · updated {formatWarningDate(warning.updated)}
                      </small>
                    </div>
                    <time>{isActive ? "Until" : "From"} {formatWarningDate(isActive ? warning.expiry : warning.onset)}</time>
                  </aside>
                );
              })
            ) : warningsUnavailable ? (
              <p className="official-notices-empty">{!online ? `Offline. The notice feed cannot be refreshed; last success ${lastSuccessLabel}, so current warnings cannot be confirmed.` : snapshot.contextStatus.warnings === "stale" ? `The last notice check is cached from ${lastSuccessLabel}; current warnings cannot be confirmed.` : "The Met Éireann notice feed is unavailable, so current warnings cannot be confirmed."}</p>
            ) : (
              <p className="official-notices-empty">No current or upcoming Met Éireann notices are represented in the current horizon.</p>
            ) : (
              <p className="official-notices-empty">Met Éireann notices are hidden in this map view. Enable them in Explore to review official notices across Ireland.</p>
            )}
          </section>

          <section className="now-guidance" aria-labelledby="guidance-heading">
            <div className="guidance-heading">
              <div>
                <p className="eyebrow">Live signals · {selectedPlace.name}</p>
                <h2 id="guidance-heading">What the live data shows.</h2>
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
          </section>

              </>
            );
            return (
              <>

      <section
        id="live-map"
        className="map-stage"
        ref={mapSectionRef}
        aria-label="Live map of Ireland"
        aria-describedby="map-keyboard-instructions map-marker-announcement"
      >
        <div className="map-explorer-heading">
          <div>
            <p className="eyebrow">Explore map · near real time</p>
            <h2>Ireland on the map</h2>
            <p>Choose a view, zoom into grouped markers, or open the layer catalogue. Observations keep their provider meaning and timestamps.</p>
          </div>
          <button
            type="button"
            aria-label="Choose map layers"
            onClick={(event) => {
              panelOpenerRef.current = event.currentTarget;
              setPanelOpen(true);
            }}
          >
            Layers
          </button>
        </div>
        <nav className="map-presets" aria-label="Map views">
          <button className={activePreset === "weather" ? "active" : ""} aria-pressed={activePreset === "weather"} onClick={() => showPreset("weather")}><span className="preset-dot weather" aria-hidden="true" />Weather</button>
          <button className={activePreset === "movement" ? "active" : ""} aria-pressed={activePreset === "movement"} onClick={() => showPreset("movement")}><span className="preset-dot movement" aria-hidden="true" />Movement</button>
          <button className={activePreset === "water" ? "active" : ""} aria-pressed={activePreset === "water"} onClick={() => showPreset("water")}><span className="preset-dot water" aria-hidden="true" />Water</button>
          <button className={activePreset === "all" ? "active" : ""} aria-pressed={activePreset === "all"} onClick={() => showPreset("all")}>All layers</button>
          <button
            className={activePreset === "custom" ? "active custom" : "custom"}
            aria-pressed={activePreset === "custom"}
            onClick={(event) => {
              panelOpenerRef.current = event.currentTarget;
              setPanelOpen(true);
            }}
          >
            Custom · {layers.size} layers
          </button>
        </nav>
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
          onPointerDown={handleMapPointerDown}
          onPointerMove={handleMapPointerMove}
          onPointerUp={handleMapPointerEnd}
          onPointerCancel={handleMapPointerEnd}
          onWheel={handleMapWheel}
        >
          <title id="map-title">Near-real-time conditions across Ireland</title>
          <desc id="map-description">A close map of Ireland showing weather, radar rain, observed wind, rail and public transport, river and tide gauges, sea conditions, measured and modelled air quality, bathing alerts, satellite imagery, seismic detections, ISS passes, aurora guidance and the live power grid.</desc>
          <defs>
            <radialGradient id="sunGlow">
              <stop offset="0" stopColor="#ffe9a3" stopOpacity=".85" />
              <stop offset="1" stopColor="#ffd56a" stopOpacity="0" />
            </radialGradient>
            <radialGradient id="rainMist">
              <stop offset="0" stopColor="#5689a0" stopOpacity=".48" />
              <stop offset=".55" stopColor="#5689a0" stopOpacity=".2" />
              <stop offset="1" stopColor="#5689a0" stopOpacity="0" />
            </radialGradient>
            <radialGradient id="satelliteFade">
              <stop offset=".68" stopColor="white" stopOpacity="1" />
              <stop offset="1" stopColor="white" stopOpacity="0" />
            </radialGradient>
            <linearGradient id="ocean" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stopColor="#163d3d" />
              <stop offset="1" stopColor="#071f22" />
            </linearGradient>
            <linearGradient id="land" x1="0" y1="0" x2="1" y2="1">
              <stop offset="0" stopColor="#94a86c" />
              <stop offset=".45" stopColor="#667f57" />
              <stop offset="1" stopColor="#344f45" />
            </linearGradient>
            <linearGradient id="auroraGlow" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stopColor="#55ffc1" stopOpacity=".78" />
              <stop offset=".5" stopColor="#7a7cff" stopOpacity=".25" />
              <stop offset="1" stopColor="#55ffc1" stopOpacity="0" />
            </linearGradient>
            <filter id="landShadow" x="-30%" y="-30%" width="160%" height="160%">
              <feDropShadow dx="0" dy="0" stdDeviation="12" floodColor="#00dbe9" floodOpacity=".22" />
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
            {online && layers.has("satellite") && (snapshot.contextStatus.satellite === "live" || snapshot.contextStatus.satellite === "fallback") && snapshot.satellite && <SatelliteTiles frame={snapshot.satellite} projection={projection} />}
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
              const openHiddenWind = () => {
                markerOpenerRef.current = [...(mapRef.current?.querySelectorAll<SVGElement>("[data-map-marker]") ?? [])]
                  .find((candidate) => candidate.getAttribute("data-marker-id") === `station:${station.id}`) ?? null;
                onActivate();
              };
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
                  key={`wind-${station.id}`}
                  transform={`translate(${point[0] + 14} ${point[1] + 12})`}
                  data-marker-pointer-target="true"
                  aria-hidden="true"
                  focusable="false"
                  onClick={openHiddenWind}
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
              const openStack = () => isStack ? activateMovementStack(stack) : setSelected(first);
              const movementLabel = isStack
                ? `${stack.items.length} rail and public transport positions in this area; ${shouldZoom ? "activate to zoom in" : "activate to open a searchable list"}`
                : isTrain
                  ? `Train ${first.item.id}, ${first.item.direction}, ${first.item.status === "running" ? "running" : "due to start"}`
                  : `${first.item.route ? `Route ${first.item.route}` : first.item.label}, live public transport position`;
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
              {layers.has("grid") && <GridPanel grid={online && (snapshot.contextStatus.grid === "live" || snapshot.contextStatus.grid === "fallback") ? snapshot.grid : null} />}
              {layers.has("aurora") && <AuroraPanel aurora={online && (snapshot.contextStatus.aurora === "live" || snapshot.contextStatus.aurora === "fallback") ? snapshot.aurora : null} />}
              {layers.has("iss") && <IssPanel iss={online && (snapshot.contextStatus.iss === "live" || snapshot.contextStatus.iss === "fallback") ? snapshot.iss : null} />}
            </div>
          </details>
        )}

        <div className="map-caption">
          <span className="compass">N</span>
          <span>Observed, operational, and clearly labelled model data · <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">© OpenStreetMap contributors</a></span>
        </div>

        <div className="live-signal-dock" aria-label="Provider signal status across Ireland">
          <strong><span className={`live-dot ${liveServiceCount ? "live" : "partial"}`} />Provider feeds</strong>
          <span><time>{latestWeatherObs > 0 ? formatTime(new Date(latestWeatherObs)) : "—"}</time>{isConnectingWithoutSnapshot ? "Connecting to weather observations" : weatherNotableCurrent ? `${snapshot.summary.reporting} weather stations reporting` : weatherCached ? `${snapshot.summary.reporting} saved weather stations` : "Weather observations unavailable"}</span>
          <span><time>{snapshot.sourceProvenance?.trains.latestObservedAt ? formatTime(new Date(snapshot.sourceProvenance.trains.latestObservedAt)) : "—"}</time>{isConnectingWithoutSnapshot ? "Connecting to rail positions" : railNotableCurrent ? `${snapshot.summary.runningTrains} trains sharing current positions` : trainsCached ? `${snapshot.summary.runningTrains} trains in cached positions` : "Rail positions unavailable"}</span>
          <span><time>{snapshot.sourceProvenance?.rivers.latestObservedAt ? formatTime(new Date(snapshot.sourceProvenance.rivers.latestObservedAt)) : "—"}</time>{isConnectingWithoutSnapshot ? "Connecting to river gauges" : riversLive && !riverDataStale ? `${snapshot.summary.riverStations} fresh river gauges` : riversCached ? `${snapshot.summary.riverStations} cached river gauges` : riversFallback ? `${snapshot.summary.riverStations} fallback-source river gauges` : "River readings unavailable"}</span>
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

      <section className="notable-now" aria-labelledby="notable-heading">
        <div>
          <p className="eyebrow">Notable now</p>
          <h2 id="notable-heading">Signals that matter to this view.</h2>
        </div>
        <div className={`notable-signals ${showAllNotables ? "show-all" : ""}`}>
          {showRainNotable && weatherNotableCurrent && snapshot.summary.wettest && (snapshot.summary.wettest.rainfall ?? 0) > 0.5 && (
            <button className="signal-item" onClick={() => focusContext("radar")}>
              <span>Rainfall</span><b>{snapshot.summary.wettest.name}</b><small>{snapshot.summary.wettest.rainfall?.toFixed(1) ?? "—"} mm recently observed</small>
            </button>
          )}
          {showRailNotable && railNotableCurrent && snapshot.summary.runningTrains > 0 && (
            <button className="signal-item" onClick={() => focusContext("trains")}>
              <span>Movement</span><b>{snapshot.summary.runningTrains} trains moving</b><small>{snapshot.trains.length} rail positions in the current snapshot</small>
            </button>
          )}
          {showGridNotable && gridNotableCurrent && snapshot.grid && (
            <button className="signal-item" onClick={() => focusContext("grid")}>
              <span>Energy</span><b>{snapshot.grid.windSharePercent === null ? "Wind share unavailable" : `${snapshot.grid.windSharePercent.toFixed(0)}% wind share`}</b><small>{snapshot.grid.demandMW === null ? "Current demand unavailable" : `${snapshot.grid.demandMW.toFixed(0)} MW current demand`}</small>
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
          {!hasVisibleNotable && isConnectingWithoutSnapshot && (
            <p className="all-quiet"><span className="live-dot partial" />Connecting to the selected signal sources…</p>
          )}
          {!hasVisibleNotable && !isConnectingWithoutSnapshot && selectedSourceAssessment.assessedSourceCount === 0 && (
            <p className="all-quiet"><span className="live-dot partial" />No automated highlight rule applies to the selected orientation layers.</p>
          )}
          {!hasVisibleNotable && !isConnectingWithoutSnapshot && selectedSourceAssessment.fullyAssessed && (
            <p className="all-quiet"><span className="live-dot live" />Provider checks completed; no highlighted signal matches the selected layers.</p>
          )}
          {!hasVisibleNotable && !isConnectingWithoutSnapshot && selectedSourceAssessment.assessedSourceCount > 0 && !selectedSourceAssessment.fullyAssessed && (
            <p className="all-quiet"><span className="live-dot partial" />Unable to assess every selected signal source. Unavailable or non-current: {selectedSourceAssessment.unavailableSources.join(", ")}.</p>
          )}
          {notableItemCount > 3 && (
            <button className="notable-more" onClick={() => setShowAllNotables((current) => !current)}>
              {showAllNotables ? "Show fewer" : `View ${notableItemCount - 3} more`}
            </button>
          )}
        </div>
      </section>

      <section className="island-pulse" data-scope="across-ireland" aria-labelledby="pulse-heading">
        <div className="pulse-intro">
          <p className="eyebrow">Across Ireland · national signal board</p>
          <h2 id="pulse-heading">Ireland, at a glance.</h2>
          <p>Energy, movement and water alongside the weather across Ireland. Every signal keeps its own timestamp and meaning.</p>
        </div>
        <button className="pulse-card grid" onClick={() => focusContext("grid")}>
          <span><i>ϟ</i> All-island electricity</span>
          <strong>{isConnectingWithoutSnapshot ? "…" : gridWindShare === null ? "—" : `${gridWindShare.toFixed(0)}%`}</strong>
          <small>{isConnectingWithoutSnapshot
            ? "Connecting to EirGrid operational data"
            : gridNotableCurrent && gridWindShare !== null
              ? "of current all-island demand supplied by wind, from EirGrid operational data"
              : gridNotableCurrent
                ? "The current EirGrid response has no wind-share value, so wind share cannot be assessed"
                : gridWindShare !== null
                  ? "saved wind share from the last successful refresh; current grid conditions are unconfirmed"
                  : gridSnapshotDisplayable
                    ? "The saved grid response has no wind-share value; current grid conditions are unconfirmed"
                    : "EirGrid data unavailable; current wind share cannot be assessed"}</small>
          <div className="signal-bars" aria-hidden="true">{[36, 52, 44, 70, 82, 65, 88].map((height, index) => <i key={index} style={{ height: `${height}%` }} />)}</div>
          <b>Open the grid now →</b>
        </button>
        <button className="pulse-card trains" onClick={() => focusContext("trains")}>
          <span><i>⌁</i> Rail positions</span>
          <strong>{isConnectingWithoutSnapshot ? "…" : railNotableCurrent || trainsCached ? snapshot.summary.runningTrains : "—"}</strong>
          <small>{isConnectingWithoutSnapshot ? "Connecting to Iarnród Éireann positions" : railNotableCurrent ? "trains currently reporting a position across Ireland" : trainsCached ? "trains represented in the cached snapshot; current rail movement is unconfirmed" : "rail positions unavailable; current movement cannot be assessed"}</small>
          <div className="signal-line" aria-hidden="true"><i /><i /><i /><i /><i /><i /></div>
          <b>Follow the trains →</b>
        </button>
        <button className="pulse-card rivers" onClick={() => focusContext("rivers")}>
          <span><i>≈</i> River network</span>
          <strong>{isConnectingWithoutSnapshot ? "…" : riversAvailable ? snapshot.summary.riverStations : "—"}</strong>
          <small>{isConnectingWithoutSnapshot ? "Connecting to OPW river gauges" : riversLive && !riverDataStale ? "fresh OPW gauges distilled into a readable view across Ireland" : riversCached ? "gauges represented in the cached snapshot; current levels are unconfirmed" : riversFallback ? "gauges supplied by the labelled fallback source" : "river readings unavailable; current levels cannot be assessed"}</small>
          <div className="signal-wave" aria-hidden="true">⌁⌁⌁⌁⌁⌁</div>
          <b>See the water →</b>
        </button>
      </section>

      <section className="dayline" aria-label="Today so far across Ireland">
        <div className="dayline-heading">
          <div><p className="eyebrow">Today so far</p><h2>The shape of the day</h2></div>
          <p>Bar height is average temperature; cyan marks hours with observed rain.</p>
        </div>
        <div className="timeline-legend" aria-label="Chart legend">
          <span><i className="temperature" />Average temperature</span>
          <span><i className="rain" />Observed rain</span>
        </div>
        {(snapshot.sourceStatus === "stale" || serviceDisplayState === "offline") && snapshot.timeline.length > 0 && (
          <p className="timeline-empty">Saved hourly observations from the last successful refresh are shown below and are not labelled as current.</p>
        )}
        <div className="timeline-chart" role="group" aria-label={`${snapshot.sourceStatus === "stale" || serviceDisplayState === "offline" ? "Saved" : "Current"} hourly average temperature and observed rainfall across reporting Met Éireann stations`}>
          {snapshot.timeline.length === 0 && (
            <p className="timeline-empty">{isConnectingWithoutSnapshot
              ? "Connecting to hourly weather observations…"
              : snapshot.sourceStatus === "live" || snapshot.sourceStatus === "partial"
                ? "The current provider response contains no hourly observations yet."
                : snapshot.sourceStatus === "stale"
                  ? "No saved hourly observations remain within the retention window."
                  : "Hourly weather observations are unavailable."}</p>
          )}
          {snapshot.timeline.map((point) => {
            const height = point.temperature === null ? 4 : Math.max(10, Math.min(96, (point.temperature + 4) * 3.2));
            return (
              <button
                type="button"
                className={`timeline-point ${timelineSelection === point.time ? "selected" : ""}`}
                key={point.time}
                aria-pressed={timelineSelection === point.time}
                aria-label={`${point.time}: temperature ${point.temperature?.toFixed(1) ?? "unavailable"} degrees, rainfall ${point.rainfall.toFixed(1)} millimetres`}
                onClick={() => setTimelineSelection(point.time)}
              >
                <span className={point.rainfall > 0 ? "bar rain" : "bar"} style={{ height: `${height}%` }} />
                <small>{point.time.endsWith(":00") && Number.parseInt(point.time) % 3 === 0 ? point.time : ""}</small>
              </button>
            );
          })}
        </div>
        {selectedTimelinePoint && (
          <p className="timeline-selection" role="status">
            <b>{selectedTimelinePoint.time}</b> · {selectedTimelinePoint.temperature?.toFixed(1) ?? "—"}° average temperature · {selectedTimelinePoint.rainfall.toFixed(1)} mm observed rain · {selectedTimelinePoint.windSpeed?.toFixed(0) ?? "—"} km/h average wind.
          </p>
        )}
      </section>

      {panelOpen && (
        <button
          className="panel-backdrop"
          aria-label="Close layer panel backdrop"
          onClick={() => setPanelOpen(false)}
        />
      )}
      <aside
        ref={panelRef}
        className={`explore-panel ${panelOpen ? "is-open" : ""}`}
        aria-hidden={!panelOpen}
        aria-modal={panelOpen}
        role="dialog"
        aria-label="Explore live map layers"
        inert={!panelOpen}
      >
        <div className="panel-heading">
          <div><p className="eyebrow">Explore the moment</p><h2>Live layers</h2></div>
          <button ref={panelCloseRef} onClick={() => setPanelOpen(false)} aria-label="Close explore panel">×</button>
        </div>
        <div className="panel-layer-state" role="status">
          <strong>{activePreset === "custom"
            ? `Custom · ${layers.size} layers`
            : `${activePreset === "all" ? "All layers" : `${activePreset[0]!.toUpperCase()}${activePreset.slice(1)}`} preset · ${layers.size} layers`}</strong>
          <small>Named presets reset the map. Individual switches create a shareable custom view.</small>
        </div>
        <nav className="panel-presets" aria-label="Layer panel presets">
          {(["weather", "movement", "water", "all"] as const).map((preset) => (
            <button
              type="button"
              key={preset}
              className={activePreset === preset ? "active" : ""}
              aria-pressed={activePreset === preset}
              onClick={() => showPreset(preset)}
            >
              {preset === "all" ? "All layers" : `${preset[0]!.toUpperCase()}${preset.slice(1)}`}
            </button>
          ))}
        </nav>
        <div className="layer-list" aria-label="Explore layer categories">
          {LAYER_GROUPS.map((group) => (
            <details
              className="layer-group"
              data-layer-group={group.id}
              key={group.id}
              open={openLayerGroups.has(group.id)}
              onToggle={(event) => {
                const isOpen = event.currentTarget.open;
                setOpenLayerGroups((current) => {
                  if (current.has(group.id) === isOpen) return current;
                  const next = new Set(current);
                  if (isOpen) next.add(group.id);
                  else next.delete(group.id);
                  return next;
                });
              }}
            >
              <summary className="layer-group-heading">
                <h3 id={`layer-group-${group.id}`}>{group.label}</h3>
                <p>{group.detail}</p>
              </summary>
              <div className="layer-group-controls">
                {group.layers.map(([id, label, detail]) => (
                  <button
                    key={id}
                    data-layer-id={id}
                    className={layers.has(id) ? "active" : ""}
                    onClick={() => toggleLayer(id)}
                    aria-pressed={layers.has(id)}
                  >
                    <span className="layer-toggle" /><span><b>{label}</b><small>{detail}</small></span>
                  </button>
                ))}
              </div>
            </details>
          ))}
        </div>
        <div className="source-note">
          <p className="eyebrow">About the data</p>
          <p>Weather, radar, rail, marine, grid and public signals refresh automatically. Air markers explicitly distinguish delayed station measurements from model output. Satellite imagery is near-real-time rather than live; ISS passes are calculations; river and tide readings are observations, not safety warnings. Missing data is never shown as zero.</p>
          <p>Provider status: rail {provenanceLabel(snapshot.sourceProvenance?.trains.status ?? "unavailable")}; rivers {provenanceLabel(snapshot.sourceProvenance?.rivers.status ?? "unavailable")}{snapshot.sourceProvenance?.rivers.fallback ? ` via ${snapshot.sourceProvenance.rivers.fallback}` : ""}.</p>
          <a href="https://www.met.ie/about-us/specialised-services/open-data" target="_blank" rel="noreferrer">Met Éireann open data ↗</a>
          <a href="https://waterlevel.ie/page/api/" target="_blank" rel="noreferrer">OPW water levels ↗</a>
          <a href="https://www.smartgriddashboard.com/" target="_blank" rel="noreferrer">EirGrid Smart Grid Dashboard ↗</a>
          <a href="https://open-meteo.com/en/docs/air-quality-api" target="_blank" rel="noreferrer">Open-Meteo air quality ↗</a>
          <a href="https://www.swpc.noaa.gov/products/aurora-30-minute-forecast" target="_blank" rel="noreferrer">NOAA aurora guidance ↗</a>
          <a href="https://aqportal.discomap.eea.europa.eu/" target="_blank" rel="noreferrer">EEA measured air quality ↗</a>
          <a href="https://data.epa.ie/api-list/bathing-water-open-data/" target="_blank" rel="noreferrer">EPA bathing-water alerts ↗</a>
          <a href="https://earthdata.nasa.gov/gibs/" target="_blank" rel="noreferrer">NASA satellite imagery ↗</a>
          <a href="https://earthquake.usgs.gov/earthquakes/feed/v1.0/" target="_blank" rel="noreferrer">USGS earthquake feed ↗</a>
          <a href="https://celestrak.org/NORAD/elements/" target="_blank" rel="noreferrer">CelesTrak orbital elements ↗</a>
          <a href="https://developer.nationaltransport.ie/" target="_blank" rel="noreferrer">NTA developer portal ↗</a>
        </div>
      </aside>

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
        <p>Copyright Met Éireann; source met.ie; CC BY 4.0; presentation modified. Contains Irish Public Sector Information from waterlevel.ie, the Marine Institute and EPA; EirGrid operational data; EEA air-quality reports; CAMS model output via Open-Meteo; NOAA aurora guidance; NASA GIBS imagery; CelesTrak orbital elements; and USGS seismic detections. NTA GTFS data is licensed under CC BY 4.0, provided “as is”, and the NTA is not responsible for errors or inaccuracies. Road and boundary data © OpenStreetMap contributors, ODbL. Providers accept no liability for errors or omissions. Not for safety-critical decisions.</p>
      </footer>
    </main>
  );
}
