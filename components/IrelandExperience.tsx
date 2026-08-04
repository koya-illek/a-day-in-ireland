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
import { refreshCurrentContexts, refreshLivingLayers, refreshTransit, refreshWeather } from "../lib/browser-live";
import { getActivityGuidance, type ActivityId, type GuidancePlace } from "../lib/activity-guidance";
import { sortOfficialWeatherWarnings, warningTiming } from "../platform/river-source.js";
import {
  DEFAULT_PLACE_ID,
  parseViewState,
  serializeViewState
} from "../lib/view-state";
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

const movementItemIdentity = (item: MovementSelection) => `${item.type}:${item.item.id}`;
const movementMarkerId = (identity: string) => `movement:${identity}`;
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
      ["radar", "Rainfall radar", "Observed Met Éireann precipitation frames, updated every five minutes"]
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
  const warm = snapshot.summary.warmest;
  const rain = snapshot.summary.wettest;
  const detail = !warm && !rain
    ? "Current weather observations are unavailable."
    : rain && (rain.rainfall ?? 0) > 0
    ? `Rain is being observed around ${rain.name}, while ${warm?.name ?? "the warmest station"} reports ${warm?.temperature ?? "—"}°.`
    : `${warm?.name ?? "The warmest station"} is reporting ${warm?.temperature ?? "—"}°, with mostly dry observations across Ireland.`;
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
  transit: 60_000,
  rivers: 15 * 60_000,
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
  children
}: {
  className: string;
  transform: string;
  interaction: MarkerInteraction;
  focusRadius: number;
  onActivate: () => void;
  dataMovementMembers?: string;
  children: ReactNode;
}) {
  return (
    <g
      className={className}
      data-map-marker="true"
      data-marker-id={interaction.markerId}
      data-movement-members={dataMovementMembers}
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

function RadarTiles({
  frame,
  projection
}: {
  frame: LiveSnapshot["radar"][number];
  projection: ReturnType<typeof geoMercator>;
}) {
  const zoom = 6;
  return (
    <g className="radar-tiles" aria-label={`Rainfall radar observed ${formatTime(new Date(frame.observedAt))}`}>
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
    ? selected.items[selected.index]
    : selected;
  const { type, item } = resolved;
  const dialogRef = useRef<HTMLElement | null>(null);
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

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
        "button, a[href], [tabindex]:not([tabindex='-1'])"
      )].filter((element) => !element.hasAttribute("disabled"));
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
      className={`station-card detail-${type}`}
      aria-live="polite"
      aria-modal="true"
      aria-labelledby="map-detail-title"
      role="dialog"
      tabIndex={-1}
    >
      <button ref={closeRef} onClick={onClose} aria-label="Close map details">×</button>
      {stack && (
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
            <strong>{grid.windSharePercent?.toFixed(0) ?? "—"}%</strong>
            <span>of current demand supplied by wind</span>
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
  const [activePreset, setActivePreset] = useState<Preset>("weather");
  const [servicesRefreshing, setServicesRefreshing] = useState(() => initialSnapshot.stations.length === 0);
  const [showAllNotables, setShowAllNotables] = useState(false);
  const [lastUpdated, setLastUpdated] = useState(() => new Date(initialSnapshot.generatedAt));
  const [mapNotice, setMapNotice] = useState<{ title: string; detail: string } | null>(null);
  const [radarFrameIndex, setRadarFrameIndex] = useState(() => Math.max(0, initialSnapshot.radar.length - 1));
  const [radarPlaying, setRadarPlaying] = useState(false);
  const [prefersReducedMotion, setPrefersReducedMotion] = useState(() =>
    typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
  const [mapView, setMapView] = useState({ scale: 1, x: 0, y: 0 });
  const [shareStatus, setShareStatus] = useState<"idle" | "copied">("idle");
  const [selectedPlaceId, setSelectedPlaceId] = useState(DEFAULT_PLACE_ID);
  const [placeMessage, setPlaceMessage] = useState("");
  const [viewHydrated, setViewHydrated] = useState(false);
  const [timelineSelection, setTimelineSelection] = useState<string | null>(null);
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>("online");
  const snapshotRef = useRef(initialSnapshot);
  const mapRef = useRef<SVGSVGElement | null>(null);
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
      setLastUpdated(new Date(next.generatedAt));
    };
    const updateLivingLayers = async () => {
      const next = await refreshLivingLayers(snapshotRef.current);
      commit((current) => ({
        ...current,
        trains: next.trains,
        rivers: next.rivers,
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
        transit: next.transit,
        transitStatus: next.transitStatus
      }));
    };
    const refreshInitial = async () => {
      setServicesRefreshing(true);
      await Promise.allSettled([update(), updateLivingLayers(), updateCurrentContexts(), updateTransit()]);
      setServicesRefreshing(false);
    };
    void refreshInitial();
    const recoveryRefresh = window.setTimeout(() => {
      const current = snapshotRef.current;
      const missingCoreService =
        current.stations.length === 0 ||
        current.rivers.length === 0 ||
        current.marine.length === 0 ||
        current.radar.length === 0 ||
        current.transitStatus !== "live";
      if (missingCoreService) {
        void Promise.allSettled([update(), updateLivingLayers(), updateCurrentContexts(), updateTransit()]);
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
    };
  }, []);

  useEffect(() => {
    setShowAllNotables(false);
  }, [layers]);

  useEffect(() => {
    if (prefersReducedMotion || !radarPlaying || !layers.has("radar") || snapshot.radar.length < 2) return;
    const animation = window.setInterval(() => {
      setRadarFrameIndex((index) => (index + 1) % snapshot.radar.length);
    }, 850);
    return () => window.clearInterval(animation);
  }, [layers, prefersReducedMotion, radarPlaying, snapshot.radar.length]);


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
        .filter((element) => element.getAttribute("aria-hidden") !== "true");
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
  const displayedAirQuality = useMemo(() => {
    const measured = snapshot.airQuality.filter((reading) => reading.source === "measured");
    const cells = new Map<string, AirQualityReading>();
    for (const reading of measured) {
      const key = `${Math.round(reading.longitude * 3)}:${Math.round(reading.latitude * 3)}`;
      const current = cells.get(key);
      if (!current || (reading.europeanAqi ?? -1) > (current.europeanAqi ?? -1)) cells.set(key, reading);
    }
    const modelled = snapshot.airQuality.filter((reading) =>
      reading.source === "modelled" &&
      !measured.some((station) => Math.hypot(station.longitude - reading.longitude, station.latitude - reading.latitude) < .42)
    );
    return [...cells.values(), ...modelled];
  }, [snapshot.airQuality]);
  const transitClusters = useMemo(() => {
    const cellSize = 22 / mapView.scale;
    const cells = new Map<string, { sumX: number; sumY: number; vehicles: LiveSnapshot["transit"] }>();
    const orderedTransit = deduplicateMovementRecords(snapshot.transit);
    for (const vehicle of orderedTransit) {
      const point = projection([vehicle.longitude, vehicle.latitude]);
      if (!point || point[0] < 0 || point[0] > 1000 || point[1] < 0 || point[1] > 900) continue;
      const cellX = Math.floor(point[0] / cellSize);
      const cellY = Math.floor(point[1] / cellSize);
      const key = `${cellX}:${cellY}`;
      const cell = cells.get(key) ?? {
        sumX: 0,
        sumY: 0,
        vehicles: []
      };
      cell.sumX += point[0];
      cell.sumY += point[1];
      cell.vehicles.push(vehicle);
      cells.set(key, cell);
    }
    return [...cells.values()]
      .map((cell) => ({
        x: cell.sumX / cell.vehicles.length,
        y: cell.sumY / cell.vehicles.length,
        vehicles: [...cell.vehicles].sort((first, second) => compareStableIds(first.id, second.id))
      }))
      .sort((first, second) => compareStableIds(first.vehicles[0]?.id ?? "", second.vehicles[0]?.id ?? ""));
  }, [mapView.scale, projection, snapshot.transit]);
  const movementStacks = useMemo(() => {
    const points: Array<{
      x: number;
      y: number;
      items: MovementSelection[];
      trainAnchor: boolean;
    }> = [];

    if (layers.has("trains")) {
      const orderedTrains = deduplicateMovementRecords(snapshot.trains);
      for (const train of orderedTrains) {
        const point = projection([train.longitude, train.latitude]);
        if (point) {
          points.push({
            x: point[0],
            y: point[1],
            items: [{ type: "train", item: train }],
            trainAnchor: true
          });
        }
      }
    }
    if (layers.has("transit")) {
      for (const cluster of transitClusters) {
        points.push({
          // The cell is only a rendering aid. Marker identity is assigned
          // below from a stable vehicle or train constituent.
          x: cluster.x,
          y: cluster.y,
          items: cluster.vehicles.map((vehicle) => ({ type: "transit", item: vehicle })),
          trainAnchor: false
        });
      }
    }

    points.sort((first, second) => compareStableIds(
      movementItemIdentity(first.items[0]!),
      movementItemIdentity(second.items[0]!)
    ));

    const collisionDistance = 25 / mapView.scale;
    const groups: typeof points = [];
    for (const point of points) {
      const group = groups.find((candidate) =>
        Math.hypot(candidate.x - point.x, candidate.y - point.y) < collisionDistance
      );
      if (!group) {
        groups.push({ ...point, items: [...point.items] });
        continue;
      }
      group.items.push(...point.items);
      if (point.trainAnchor && !group.trainAnchor) {
        group.x = point.x;
        group.y = point.y;
        group.trainAnchor = true;
      }
    }
    const focusedMovementIdentity = activeMarkerId?.startsWith("movement:")
      ? activeMarkerId.slice("movement:".length)
      : null;
    return groups.map((group) => {
      const items = [...group.items].sort((first, second) => {
        const firstIdentity = movementItemIdentity(first);
        const secondIdentity = movementItemIdentity(second);
        return firstIdentity < secondIdentity ? -1 : firstIdentity > secondIdentity ? 1 : 0;
      });
      const anchor = focusedMovementIdentity && items.some((item) =>
        movementItemIdentity(item) === focusedMovementIdentity
      )
        ? focusedMovementIdentity
        : movementItemIdentity(items[0]!);
      return {
        key: movementMarkerId(anchor),
        x: group.x,
        y: group.y,
        items,
        trainAnchor: group.trainAnchor
      };
    });
  }, [activeMarkerId, layers, mapView.scale, projection, snapshot.trains, transitClusters]);
  const markerIds = useMemo(() => {
    const ids: string[] = [];
    const isProjected = (longitude: number, latitude: number) => Boolean(projection([longitude, latitude]));

    if (layers.has("rivers")) {
      snapshot.rivers.forEach((river) => {
        if (isProjected(river.longitude, river.latitude)) ids.push(`river:${river.id}`);
      });
    }
    if (layers.has("sea")) {
      snapshot.marine.forEach((marineSite) => {
        if (isProjected(marineSite.longitude, marineSite.latitude)) ids.push(`buoy:${marineSite.id}`);
      });
    }
    if (layers.has("tides")) {
      snapshot.tides.forEach((tide) => {
        if (isProjected(tide.longitude, tide.latitude)) ids.push(`tide:${tide.id}`);
      });
    }
    if (layers.has("bathing")) {
      snapshot.bathingAlerts.forEach((alert) => {
        if (isProjected(alert.longitude, alert.latitude)) ids.push(`bathing:${alert.id}`);
      });
    }
    if (layers.has("weather")) {
      snapshot.stations.forEach((station) => {
        if (isProjected(station.longitude, station.latitude)) ids.push(`station:${station.id}`);
      });
    } else if (layers.has("wind")) {
      snapshot.stations.forEach((station) => {
        if (station.windSpeed !== null && isProjected(station.longitude, station.latitude)) {
          ids.push(`station:${station.id}`);
        }
      });
    }
    if (layers.has("air")) {
      displayedAirQuality.forEach((reading) => {
        if (isProjected(reading.longitude, reading.latitude)) ids.push(`air:${reading.id}`);
      });
    }
    if (layers.has("trains") || layers.has("transit")) {
      movementStacks.forEach((stack) => ids.push(stack.key));
    }
    if (layers.has("earthquakes")) {
      snapshot.earthquakes.forEach((earthquake) => {
        if (isProjected(earthquake.longitude, earthquake.latitude)) ids.push(`earthquake:${earthquake.id}`);
      });
    }
    return ids;
  }, [displayedAirQuality, layers, movementStacks, projection, snapshot.bathingAlerts, snapshot.earthquakes, snapshot.marine, snapshot.rivers, snapshot.stations, snapshot.tides]);
  const rovingMarkerId = activeMarkerId && markerIds.includes(activeMarkerId)
    ? activeMarkerId
    : markerIds[0] ?? null;

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
  const isConnectingWithoutSnapshot = servicesRefreshing && snapshot.stations.length === 0;
  const selectedPlace = PLACE_OPTIONS.find((place) => place.id === selectedPlaceId) ?? PLACE_OPTIONS[0]!;
  const selectedPlacePoint = selectedPlace.id === "island"
    ? null
    : projection([selectedPlace.lon, selectedPlace.lat]);
  const localStation = selectedPlace.id === "island"
    ? null
    : nearestReadingWithinRadius(
        snapshot.stations.filter((station) => station.fresh),
        selectedPlace,
        NEARBY_RADIUS_KM.weather
      );
  const localRiver = selectedPlace.id === "island"
    ? null
    : nearestReadingWithinRadius(
        snapshot.rivers.filter((river) => river.fresh),
        selectedPlace,
        NEARBY_RADIUS_KM.river
      );
  const localAir = selectedPlace.id === "island"
    ? null
    : nearestReadingWithinRadius(
        snapshot.airQuality
          .filter((reading) => reading.source === "measured")
          .sort((first, second) => Date.parse(second.observedAt) - Date.parse(first.observedAt)),
        selectedPlace,
        NEARBY_RADIUS_KM.air
      ) ?? nearestReadingWithinRadius(
        snapshot.airQuality
          .filter((reading) => reading.source === "modelled")
          .sort((first, second) => Date.parse(second.observedAt) - Date.parse(first.observedAt)),
        selectedPlace,
        NEARBY_RADIUS_KM.air
      );
  const warningsUnavailable = snapshot.contextStatus.warnings === "unavailable";
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
  const showRailNotable = layers.has("trains") || layers.has("transit");
  const showGridNotable = layers.has("grid");
  const showSeaNotables = layers.has("sea") || layers.has("bathing") || layers.has("tides");
  const showEarthquakeNotable = layers.has("earthquakes");
  const showIssNotable = layers.has("iss");
  const hasVisibleNotable =
    Boolean(showRainNotable && snapshot.summary.wettest && (snapshot.summary.wettest.rainfall ?? 0) > 0.5) ||
    Boolean(showRailNotable && snapshot.summary.runningTrains > 0) ||
    Boolean(showGridNotable && snapshot.grid) ||
    Boolean(showSeaNotables && snapshot.bathingAlerts.length) ||
    Boolean(showSeaNotables && unusualTide && Math.abs(unusualTide.surge ?? 0) >= .15) ||
    Boolean(showEarthquakeNotable && largestEarthquake) ||
    Boolean(showIssNotable && visibleIssPass);
  const notableItemCount =
    (showRainNotable && snapshot.summary.wettest && (snapshot.summary.wettest.rainfall ?? 0) > 0.5 ? 1 : 0) +
    (showRailNotable && snapshot.summary.runningTrains > 0 ? 1 : 0) +
    (showGridNotable && snapshot.grid ? 1 : 0) +
    (showSeaNotables ? snapshot.bathingAlerts.length : 0) +
    (showSeaNotables && unusualTide && Math.abs(unusualTide.surge ?? 0) >= .15 ? 1 : 0) +
    (showEarthquakeNotable && largestEarthquake ? 1 : 0) +
    (showIssNotable && visibleIssPass ? 1 : 0);
  const selectedNotableSourceStates = [
    showSeaNotables ? snapshot.contextStatus.bathing : null,
    showSeaNotables ? snapshot.contextStatus.tides : null,
    showEarthquakeNotable ? snapshot.contextStatus.earthquakes : null,
    showIssNotable ? snapshot.contextStatus.iss : null
  ].filter((status): status is "live" | "fallback" | "unavailable" => status !== null);
  const notableSourcesLive = selectedNotableSourceStates.every((status) => status === "live");
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
  const liveServiceCount = [
    snapshot.sourceStatus === "live" && snapshot.stations.length > 0 && !weatherStale,
    snapshot.sourceProvenance?.trains.status === "live" && snapshot.trains.length > 0 && !transitStale,
    snapshot.sourceProvenance?.rivers.status === "live" && snapshot.rivers.length > 0 && !riverDataStale,
    snapshot.contextStatus.marine === "live" && snapshot.marine.length > 0,
    snapshot.radar.length > 0,
    Boolean(snapshot.grid),
    snapshot.airQuality.length > 0,
    snapshot.contextStatus.tides === "live",
    snapshot.contextStatus.bathing === "live",
    snapshot.contextStatus.satellite === "live",
    snapshot.contextStatus.earthquakes === "live",
    snapshot.contextStatus.iss === "live",
    snapshot.transitStatus === "live",
    Boolean(snapshot.aurora)
  ].filter(Boolean).length;
  const weatherBuoyCount = snapshot.marine.filter((reading) => reading.kind === "weather-buoy").length;
  const coastalObservatoryCount = snapshot.marine.length - weatherBuoyCount;
  const trainsLive = snapshot.sourceProvenance?.trains.status === "live";
  const riversLive = snapshot.sourceProvenance?.rivers.status === "live";
  const riversStale = snapshot.sourceProvenance?.rivers.status === "stale";
  const riversAvailable = riversLive || riversStale;
  const radarFrame = snapshot.radar[Math.min(radarFrameIndex, Math.max(0, snapshot.radar.length - 1))] ?? null;
  const connectionLabel = connectionStatus === "offline"
    ? "Offline · refresh unavailable"
    : servicesRefreshing
      ? "Online · refreshing"
      : "Online";
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
  const showPreset = useCallback((preset: Exclude<Preset, "custom">) => {
    setLayers(new Set(PRESET_LAYERS[preset]));
    setActivePreset(preset);
    setSelected(null);
    setMapNotice(null);
    setRadarPlaying(false);
  }, []);

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
    storePlace(selectedPlaceId);
    const serialized = new URL(serializeViewState(window.location.href, {
      placeId: selectedPlaceId,
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
  }, [activePreset, layers, mapView, projection, selectedPlaceId, viewHydrated]);

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
        detail: `${snapshot.summary.reporting} fresh Met Éireann stations. Select a temperature marker for its latest reading.`
      },
      wind: {
        title: "Observed wind",
        detail: `${snapshot.summary.reporting} Met Éireann stations with wind direction and speed in km/h. Select an arrow for the complete observation.`
      },
      trains: {
        title: "Live rail positions",
        detail: snapshot.trains.length
          ? `${snapshot.summary.runningTrains} running trains and ${snapshot.trains.length - snapshot.summary.runningTrains} due to start. Select a train for its direction and status.`
          : "Iarnród Éireann is not reporting any train positions right now. The map will refresh automatically."
      },
      rivers: {
        title: "Fresh river readings",
        detail: `${snapshot.summary.riverStations} OPW gauges observed within the last three hours. These are local levels, not flood warnings.`
      },
      sea: {
        title: "Marine conditions",
        detail: snapshot.marine.length
          ? `${weatherBuoyCount} Marine Institute weather buoy${weatherBuoyCount === 1 ? "" : "s"} and ${coastalObservatoryCount} coastal observator${coastalObservatoryCount === 1 ? "y" : "ies"} have recent observations. Select a marine site for details.`
          : snapshot.contextStatus.marine === "unavailable"
            ? "Marine Institute observations are temporarily unavailable."
            : "No Marine Institute observation is fresh enough to display right now."
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
        detail: snapshot.radar.length
          ? `${snapshot.radar.length} Met Éireann frames at five-minute intervals. Use the timeline to replay the latest half hour.`
          : "Met Éireann radar imagery is temporarily unavailable."
      },
      grid: {
        title: "The all-island grid now",
        detail: snapshot.grid
          ? `Demand, wind, carbon and system frequency from EirGrid, with all displayed series available through ${snapshot.grid.observedAt ? formatTime(new Date(snapshot.grid.observedAt)) : "an unavailable time"}.`
          : "EirGrid operational data is temporarily unavailable."
      },
      air: {
        title: "Measured and modelled air",
        detail: snapshot.airQuality.length
          ? `${snapshot.airQuality.filter((item) => item.source === "measured").length} EEA monitoring stations alongside ${snapshot.airQuality.filter((item) => item.source === "modelled").length} regional CAMS model points. Nearby stations are grouped to the highest local index; solid markers are measurements and rings are model estimates.`
          : "Air-quality observations and model output are temporarily unavailable."
      },
      aurora: {
        title: "Aurora overhead probability",
        detail: snapshot.aurora
          ? `NOAA OVATION currently estimates a ${snapshot.aurora.probability}% maximum probability directly over Ireland. Visibility also depends on darkness, cloud and light pollution.`
          : "NOAA aurora guidance is temporarily unavailable."
      },
      tides: {
        title: "Tides and coastal anomaly",
        detail: snapshot.contextStatus.tides === "unavailable"
          ? "Marine Institute tide-gauge data is temporarily unavailable."
          : snapshot.tides.length
          ? `${snapshot.tides.length} fresh Marine Institute gauges, compared with predicted tide and storm-surge guidance. Select a gauge for the next high and low water.`
          : "No tide-gauge observation is fresh enough to display."
      },
      bathing: {
        title: snapshot.contextStatus.bathing === "unavailable"
          ? "Bathing-water feed unavailable"
          : snapshot.bathingAlerts.length ? "Active bathing-water alerts" : "No active bathing-water alerts",
        detail: snapshot.contextStatus.bathing === "unavailable"
          ? "The EPA bathing-water alert feed is temporarily unavailable, so no claim about current restrictions can be made."
          : snapshot.bathingAlerts.length
          ? `${snapshot.bathingAlerts.length} current EPA restrictions or advisories. Select an alert for the official reason and notice.`
          : "The EPA is not currently reporting an active alert through its public feed."
      },
      iss: {
        title: "The ISS over Ireland",
        detail: snapshot.iss?.passes[0]
          ? `The next pass over central Ireland begins ${formatDate(new Date(snapshot.iss.passes[0].startsAt))} at ${formatTime(new Date(snapshot.iss.passes[0].startsAt))}, peaking at ${snapshot.iss.passes[0].maxElevation.toFixed(0)}°.`
          : "Current ISS elements or a pass prediction are temporarily unavailable."
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
        title: snapshot.contextStatus.earthquakes === "unavailable"
          ? "Earthquake feed unavailable"
          : snapshot.earthquakes.length ? "Recent seismic detections" : "No nearby earthquakes detected",
        detail: snapshot.contextStatus.earthquakes === "unavailable"
          ? "The USGS earthquake feed is temporarily unavailable, so no claim about recent events can be made."
          : snapshot.earthquakes.length
          ? `${snapshot.earthquakes.length} USGS event${snapshot.earthquakes.length === 1 ? "" : "s"} detected around Ireland in the past seven days.`
          : "The USGS feed contains no detected events in the Ireland region during the past seven days."
      },
      transit: {
        title: snapshot.transitStatus === "live" ? "Live public transport" : "Public transport feed awaiting access",
        detail: snapshot.transitStatus === "live"
          ? `${snapshot.transit.length} current TFI vehicle positions, capped and clustered into a readable island view.`
          : snapshot.transitStatus === "credential-required"
            ? "The integration is ready, but the NTA requires a free developer API key before live vehicle positions can be displayed."
            : "The NTA live vehicle feed is temporarily unavailable."
      }
    };
    setLayers(new Set(contextLayers[focus]));
    setActivePreset("custom");
    setSelected(null);
    setMapNotice(notices[focus]);
    setRadarPlaying(focus === "radar" && snapshot.radar.length > 1 && !prefersReducedMotion);
    if (focus === "radar") setRadarFrameIndex(0);
    window.requestAnimationFrame(() => {
      document.getElementById(focus === "warnings" && activeWarning ? "active-warning" : "live-map")
        ?.scrollIntoView({ behavior: prefersReducedMotion ? "auto" : "smooth", block: "start" });
    });
  }, [activeWarning, coastalObservatoryCount, prefersReducedMotion, snapshot, warningsUnavailable, weatherBuoyCount]);

  const toggleLayer = useCallback((layer: Layer) => {
    setActivePreset("custom");
    setLayers((current) => {
      const next = new Set(current);
      if (next.has(layer)) next.delete(layer);
      else next.add(layer);
      return next;
    });
  }, []);

  const choosePlace = useCallback((placeId: string) => {
    if (!PLACE_OPTIONS.some((place) => place.id === placeId)) return;
    setSelectedPlaceId(placeId);
    setPlaceMessage("");
  }, []);

  const useMyLocation = useCallback(() => {
    if (!navigator.geolocation) {
      setPlaceMessage("Location is not available in this browser.");
      return;
    }
    setPlaceMessage("Finding the nearest place…");
    navigator.geolocation.getCurrentPosition(
      ({ coords }) => {
        const nearest = PLACES.reduce((best, place) => {
          const candidateDistance = distanceKm(
            { lat: coords.latitude, lon: coords.longitude },
            { lat: place.lat, lon: place.lon }
          );
          const bestDistance = distanceKm(
            { lat: coords.latitude, lon: coords.longitude },
            { lat: best.lat, lon: best.lon }
          );
          return candidateDistance < bestDistance ? place : best;
        });
        setSelectedPlaceId(nearest.id);
        setPlaceMessage(`Using ${nearest.name} as the nearest mapped place.`);
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
    const url = serializeViewState(window.location.href, {
      placeId: selectedPlace.id,
      view: activePreset,
      layers,
      zoom: mapView.scale,
      panX: mapView.x,
      panY: mapView.y
    });
    const shareData = {
      title: "A Day in Ireland",
      text: selectedPlace.id === "island"
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
  }, [activePreset, layers, mapView, selectedPlace]);

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
          title={`${connectionLabel}. ${isConnectingWithoutSnapshot ? "Connecting to live services" : `Snapshot generated ${lastUpdated.toLocaleString("en-IE", { timeZone: "Europe/Dublin" })}`}`}
        >
          <span className={`live-dot ${connectionStatus === "offline" ? "offline" : snapshot.sourceStatus}`} />
          <span className="network-state">{connectionLabel}</span>
          <span>{isConnectingWithoutSnapshot ? "Connecting" : snapshot.sourceStatus === "live" ? "Live observations" : "Partial observations"}</span>
          <time>{isConnectingWithoutSnapshot ? "Now" : formatTime(lastUpdated)}</time>
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
            <span className={`live-dot ${connectionStatus === "offline" ? "offline" : snapshot.sourceStatus}`} />
            <span><b>Live systems</b><small>{connectionLabel}</small><small>{servicesRefreshing ? "Refreshing services…" : `${liveServiceCount} services connected`}</small></span>
          </div>
          <nav aria-label="Map view shortcuts">
            <button className={activePreset === "weather" ? "active" : ""} onClick={() => showPreset("weather")}><span>☁</span>Weather</button>
            <button className="rail-extra" onClick={() => focusContext("radar")}><span>◉</span>Rain radar</button>
            <button className={activePreset === "movement" ? "active" : ""} onClick={() => showPreset("movement")}><span>↗</span>Movement</button>
            <button className={activePreset === "water" ? "active" : ""} onClick={() => showPreset("water")}><span>≈</span>Water</button>
            <button className="rail-extra" onClick={() => focusContext("sea")}><span>⌁</span>Sea</button>
            <button className="rail-extra" onClick={() => focusContext("grid")}><span>ϟ</span>Energy</button>
            <button className="rail-extra" onClick={() => focusContext("air")}><span>◌</span>Air</button>
            <button className={activePreset === "all" ? "active" : ""} onClick={() => showPreset("all")}><span>⌘</span>All layers</button>
          </nav>
          <div className="rail-metrics">
            <p><span>Warmest</span><strong>{snapshot.summary.warmest?.temperature ?? "—"}°</strong><small>{snapshot.summary.warmest?.name ?? "No report"}</small></p>
            <p><span>Strongest wind</span><strong>{snapshot.summary.windiest?.windSpeed ?? "—"}</strong><small>km/h · {snapshot.summary.windiest?.name ?? "No report"}</small></p>
            <p><span>Trains moving</span><strong>{trainsLive ? snapshot.summary.runningTrains : "—"}</strong><small>{trainsLive ? "Current positions" : "Provider unavailable"}</small></p>
            <p><span>River gauges</span><strong>{riversAvailable ? snapshot.summary.riverStations : "—"}</strong><small>{riversLive ? "Fresh readings" : riversStale ? "Cached readings" : "Provider unavailable"}</small></p>
          </div>
        </aside>

        <div className="map-workspace">
          <div className="workspace-heading">
            <div>
              <p className="eyebrow">Across Ireland · {formatDate(now)} · {formatTime(now)} IST</p>
              <h1 id="moment-heading">See Ireland happening.</h1>
              <p>{isConnectingWithoutSnapshot ? "Connecting to live observations across the island…" : servicesRefreshing ? "Updating live observations across the island…" : `${narrative.period} ${narrative.detail}`}</p>
            </div>
            <div className="workspace-facts" aria-label="Current national highlights across Ireland">
              <button onClick={() => focusContext("grid")}><b>{snapshot.grid?.windSharePercent?.toFixed(0) ?? "—"}%</b><small>demand met by wind</small></button>
              <button onClick={() => focusContext("sea")}><b>{snapshot.contextStatus.marine === "live" ? snapshot.marine.length : "—"}</b><small>marine sites reporting</small></button>
              <button onClick={() => focusContext("radar")}><b>{snapshot.summary.wettest?.rainfall ?? "—"} mm</b><small>recent observed rain</small></button>
            </div>
          </div>

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
                  ? "Whole-island context is shown above; choose a town for local observations."
                  : `Nearby observations for ${selectedPlace.name}. Each source has its own radius; outside it, no local reading is shown.`}
              </p>
              <label htmlFor="place-select">Nearby context</label>
              <div className="place-controls">
                <select id="place-select" value={selectedPlace.id} onChange={(event) => choosePlace(event.target.value)}>
                  {PLACE_OPTIONS.map((place) => <option key={place.id} value={place.id}>{place.name}</option>)}
                </select>
                <button type="button" className="locate-button" onClick={useMyLocation} aria-label="Use my location">⌖ Locate</button>
              </div>
              <small id="place-message" aria-live="polite">{placeMessage || "Saved as a place ID; GPS coordinates are never stored or shared."}</small>
              <small className="place-limits">Nearby limits: weather {NEARBY_RADIUS_KM.weather} km · rivers {NEARBY_RADIUS_KM.river} km · air {NEARBY_RADIUS_KM.air} km.</small>
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
                    : `No nearby weather observation within ${NEARBY_RADIUS_KM.weather} km.`}</small>
                </div>
                <div>
                  <dt>Rain</dt>
                  <dd>{localStation?.item.rainfall == null ? "—" : `${localStation.item.rainfall} mm`}</dd>
                  <small>{localStation
                    ? formatLocalObservation("Met Éireann", localStation.item, localStation.distanceKm, now)
                    : `No nearby rain observation within ${NEARBY_RADIUS_KM.weather} km.`}</small>
                </div>
                <div>
                  <dt>River</dt>
                  <dd>{localRiver ? `${localRiver.item.level.toFixed(2)} m` : "—"}</dd>
                  <small>{localRiver
                    ? formatLocalObservation("OPW", localRiver.item, localRiver.distanceKm, now)
                    : `No nearby river observation within ${NEARBY_RADIUS_KM.river} km.`}</small>
                </div>
                <div>
                  <dt>Air</dt>
                  <dd>{localAir?.item.europeanAqi == null ? "—" : `AQI ${localAir.item.europeanAqi}`}</dd>
                  <small>{localAir
                    ? formatLocalObservation(localAir.item.source === "measured" ? "EEA measured" : "CAMS modelled", localAir.item, localAir.distanceKm, now)
                    : `No nearby air observation within ${NEARBY_RADIUS_KM.air} km.`}</small>
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
            <span className={`freshness-chip connection-chip ${connectionStatus}`} data-connection-status={connectionStatus} aria-live="polite">
              <i aria-hidden="true" /><b>Connection</b><small>{connectionLabel}</small>
            </span>
            <span
              className={`freshness-chip ${snapshot.sourceStatus}`}
              aria-label={`Weather provider ${statusText(snapshot.sourceStatus)}; latest national observation ${formatAge(latestWeatherObs > 0 ? new Date(latestWeatherObs).toISOString() : null, now)}${weatherStale && snapshot.stations.length > 0 ? "; observation data is stale" : ""}`}
            >
              <i aria-hidden="true" /><b>Weather provider</b><small>Provider: {statusText(snapshot.sourceStatus)} · Observation: {formatAge(latestWeatherObs > 0 ? new Date(latestWeatherObs).toISOString() : null, now)}{weatherStale && snapshot.stations.length > 0 ? " · stale" : ""}</small>
            </span>
            <span
              className={`freshness-chip ${snapshot.sourceProvenance?.trains.status ?? "unavailable"}`}
              aria-label={`Rail provider ${statusText(snapshot.sourceProvenance?.trains.status ?? "unavailable")}; latest observation ${formatAge(snapshot.sourceProvenance?.trains.latestObservedAt, now)}${transitStale && snapshot.trains.length > 0 ? "; positions are stale" : ""}`}
            >
              <i aria-hidden="true" /><b>Rail provider</b><small>Provider: {statusText(snapshot.sourceProvenance?.trains.status ?? "unavailable")} · Observation: {formatAge(snapshot.sourceProvenance?.trains.latestObservedAt, now)}{transitStale && snapshot.trains.length > 0 ? " · stale" : ""}</small>
            </span>
            <span
              className={`freshness-chip ${snapshot.sourceProvenance?.rivers.status ?? "unavailable"}`}
              aria-label={`River provider ${statusText(snapshot.sourceProvenance?.rivers.status ?? "unavailable")}; latest observation ${formatAge(snapshot.sourceProvenance?.rivers.latestObservedAt, now)}${riverDataStale && snapshot.rivers.length > 0 ? "; readings are stale" : ""}`}
            >
              <i aria-hidden="true" /><b>River provider</b><small>Provider: {statusText(snapshot.sourceProvenance?.rivers.status ?? "unavailable")} · Observation: {formatAge(snapshot.sourceProvenance?.rivers.latestObservedAt, now)}{riverDataStale && snapshot.rivers.length > 0 ? " · stale" : ""}</small>
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
            {layers.has("warnings") ? visibleWarnings.length ? (
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
              <p className="official-notices-empty">The Met Éireann notice feed is unavailable, so current warnings cannot be confirmed.</p>
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
              {activityGuidance.map((item) => (
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

      <section
        id="live-map"
        className="map-stage"
        aria-label="Live map of Ireland"
        aria-describedby="map-keyboard-instructions map-marker-announcement"
      >
        {mapNotice && (
          <aside className="map-notice" aria-live="polite">
            <span>Focused view</span>
            <button onClick={() => setMapNotice(null)} aria-label="Dismiss map context">×</button>
            <strong>{mapNotice.title}</strong>
            <p>{mapNotice.detail}</p>
          </aside>
        )}
        <nav className="map-presets" aria-label="Map views">
          <button className={activePreset === "weather" ? "active" : ""} aria-pressed={activePreset === "weather"} onClick={() => showPreset("weather")}><span className="preset-dot weather" />Weather</button>
          <button className={activePreset === "movement" ? "active" : ""} aria-pressed={activePreset === "movement"} onClick={() => showPreset("movement")}><span className="preset-dot movement" />Movement</button>
          <button className={activePreset === "water" ? "active" : ""} aria-pressed={activePreset === "water"} onClick={() => showPreset("water")}><span className="preset-dot water" />Water</button>
          <button className={activePreset === "all" ? "active" : ""} aria-pressed={activePreset === "all"} onClick={() => showPreset("all")}>All layers</button>
        </nav>
        <div id="map-keyboard-instructions" className="sr-only">
          Use Left and Right or Up and Down to move between map markers. Home and End move to the first or last marker. Press Enter or Space to open marker details.
        </div>
        <p id="map-marker-announcement" className="sr-only" aria-live="polite" aria-atomic="true">{markerAnnouncement}</p>
        <svg
          ref={mapRef}
          className={mapView.scale > 1 ? "ireland-map is-zoomed" : "ireland-map"}
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
            {layers.has("aurora") && (
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
            {layers.has("satellite") && snapshot.satellite && <SatelliteTiles frame={snapshot.satellite} projection={projection} />}
            {layers.has("radar") && radarFrame && <RadarTiles frame={radarFrame} projection={projection} />}
            <g className="road-network" role="img" aria-label="Major roads from OpenStreetMap">
              {roadPaths.map((road, index) => (
                <path key={`${road.ref}-${index}`} d={road.path} className={road.roadClass} />
              ))}
            </g>
            <rect className="night-shade" x={isNight ? 0 : Math.max(0, sunX - 700)} width={isNight ? 1000 : 460} height="900" />
            {layers.has("wind") && (
              <g className="wind-field" aria-hidden="true">
                {Array.from({ length: 12 }, (_, index) => (
                  <path key={index} style={{ animationDelay: `${index * -0.45}s` }} d={`M ${75 + (index % 4) * 215} ${180 + Math.floor(index / 4) * 235} q 55 -22 115 0`} />
                ))}
              </g>
            )}
            {layers.has("rain") && snapshot.stations
              .filter((station) => (station.rainfall ?? 0) > 0)
              .map((station) => {
                const point = projection([station.longitude, station.latitude]);
                return point ? <circle key={`rain-${station.id}`} className="rain-cloud" cx={point[0]} cy={point[1]} r={45 + Math.min(65, (station.rainfall ?? 0) * 18)} /> : null;
              })}
            {layers.has("places") && PLACES.map((place) => {
              const point = projection([place.lon, place.lat]);
              return point ? (
                <g className="place" key={place.name} transform={`translate(${point[0]} ${point[1]})`}>
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
            {layers.has("rivers") && snapshot.rivers.map((river) => {
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
            {layers.has("sea") && snapshot.marine.map((marineSite) => {
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
            {layers.has("tides") && snapshot.tides.map((tide) => {
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
            {layers.has("bathing") && snapshot.bathingAlerts.map((alert) => {
              const point = projection([alert.longitude, alert.latitude]);
              return point ? (
                <MapMarker
                  className="bathing-marker"
                  key={alert.id}
                  transform={`translate(${point[0]} ${point[1]})`}
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
            {layers.has("weather") && snapshot.stations.map((station) => (
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
            {layers.has("wind") && snapshot.stations.map((station) => {
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
              const first = stack.items[0];
              const isStack = stack.items.length > 1;
              const isTrain = first.type === "train";
              const openStack = () => setSelected(isStack
                ? { type: "movement-stack", items: stack.items, index: 0 }
                : first
              );
              const movementLabel = isStack
                ? `${stack.items.length} rail and public transport items at this location; select to browse`
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
            {layers.has("earthquakes") && snapshot.earthquakes.map((earthquake) => {
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

        {layers.has("radar") && (
          <div className="radar-control" role="group" aria-label="Rainfall radar timeline">
            <button
              type="button"
              onClick={() => {
                if (!prefersReducedMotion) setRadarPlaying((playing) => !playing);
              }}
              disabled={snapshot.radar.length < 2 || prefersReducedMotion}
              aria-pressed={radarPlaying}
              aria-label={prefersReducedMotion ? "Replay radar timeline disabled because reduced motion is enabled" : radarPlaying ? "Pause radar replay" : "Replay radar timeline"}
              aria-describedby="radar-motion-note"
            >
              {radarPlaying ? "Pause" : "Replay"}
            </button>
            <label>
              <span>{radarFrame ? formatTime(new Date(radarFrame.observedAt)) : "Unavailable"}</span>
              <input
                type="range"
                min="0"
                max={Math.max(0, snapshot.radar.length - 1)}
                value={Math.min(radarFrameIndex, Math.max(0, snapshot.radar.length - 1))}
                disabled={!snapshot.radar.length}
                onChange={(event) => {
                  setRadarPlaying(false);
                  setRadarFrameIndex(Number(event.target.value));
                }}
                aria-label="Radar frame"
                aria-valuetext={radarFrame ? `Radar frame observed ${formatTime(new Date(radarFrame.observedAt))}` : "Radar frame unavailable"}
              />
              <small id="radar-motion-note">{prefersReducedMotion
                ? "Replay disabled for reduced motion · select a frame manually"
                : snapshot.radar.length
                  ? "Observed precipitation · 5-minute frames"
                  : "Radar temporarily unavailable"}</small>
            </label>
          </div>
        )}

        {(layers.has("grid") || layers.has("aurora") || layers.has("iss")) && (
          <div className="desktop-context-stack">
            {layers.has("grid") && <GridPanel grid={snapshot.grid} />}
            {layers.has("aurora") && <AuroraPanel aurora={snapshot.aurora} />}
            {layers.has("iss") && <IssPanel iss={snapshot.iss} />}
          </div>
        )}

        <div className="map-caption">
          <span className="compass">N</span>
          <span>Observed, operational, and clearly labelled model data · <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">© OpenStreetMap contributors</a></span>
        </div>

        <div className="live-signal-dock" aria-label="Current provider signals across Ireland">
          <strong><span className={`live-dot ${liveServiceCount ? "live" : "partial"}`} />Current feeds</strong>
          <span><time>{snapshot.summary.reporting ? formatTime(lastUpdated) : "—"}</time>{snapshot.summary.reporting && !weatherStale ? `${snapshot.summary.reporting} weather stations reporting` : snapshot.summary.reporting ? `${snapshot.summary.reporting} stations (data stale)` : "Weather observations unavailable"}</span>
          <span><time>{trainsLive && snapshot.sourceProvenance?.trains.latestObservedAt ? formatTime(new Date(snapshot.sourceProvenance.trains.latestObservedAt)) : "—"}</time>{trainsLive && !transitStale ? `${snapshot.summary.runningTrains} trains sharing positions` : trainsLive ? `${snapshot.summary.runningTrains} trains (positions stale)` : "Rail positions unavailable"}</span>
          <span><time>{riversAvailable && snapshot.sourceProvenance?.rivers.latestObservedAt ? formatTime(new Date(snapshot.sourceProvenance.rivers.latestObservedAt)) : "—"}</time>{riversLive && !riverDataStale ? `${snapshot.summary.riverStations} fresh river gauges` : riversLive ? `${snapshot.summary.riverStations} gauges (data stale)` : riversStale ? `${snapshot.summary.riverStations} cached river gauges` : "River readings unavailable"}</span>
        </div>

      </section>
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

      {layers.has("grid") && <GridPanel grid={snapshot.grid} className="mobile-context-panel" />}
      {layers.has("aurora") && <AuroraPanel aurora={snapshot.aurora} className="mobile-context-panel" />}
      {layers.has("iss") && <IssPanel iss={snapshot.iss} className="mobile-context-panel" />}

      <section className="notable-now" aria-labelledby="notable-heading">
        <div>
          <p className="eyebrow">Notable now</p>
          <h2 id="notable-heading">Signals that matter to this view.</h2>
        </div>
        <div className={`notable-signals ${showAllNotables ? "show-all" : ""}`}>
          {showRainNotable && snapshot.summary.wettest && (snapshot.summary.wettest.rainfall ?? 0) > 0.5 && (
            <button className="signal-item" onClick={() => focusContext("radar")}>
              <span>Rainfall</span><b>{snapshot.summary.wettest.name}</b><small>{snapshot.summary.wettest.rainfall?.toFixed(1) ?? "—"} mm recently observed</small>
            </button>
          )}
          {showRailNotable && snapshot.summary.runningTrains > 0 && (
            <button className="signal-item" onClick={() => focusContext("trains")}>
              <span>Movement</span><b>{snapshot.summary.runningTrains} trains moving</b><small>{snapshot.trains.length} rail positions in the current snapshot</small>
            </button>
          )}
          {showGridNotable && snapshot.grid && (
            <button className="signal-item" onClick={() => focusContext("grid")}>
              <span>Energy</span><b>{snapshot.grid.windSharePercent?.toFixed(0) ?? "—"}% wind share</b><small>{snapshot.grid.demandMW?.toFixed(0) ?? "—"} MW current demand</small>
            </button>
          )}
          {showSeaNotables && snapshot.bathingAlerts.map((alert) => (
            <button className="signal-item" key={alert.id} onClick={() => { focusContext("bathing"); setSelected({ type: "bathing", item: alert }); }}>
              <span>Bathing water</span><b>{alert.name}</b><small>{alert.restriction}</small>
            </button>
          ))}
          {showSeaNotables && unusualTide && Math.abs(unusualTide.surge ?? 0) >= .15 && (
            <button className="signal-item" onClick={() => { focusContext("tides"); setSelected({ type: "tide", item: unusualTide }); }}>
              <span>Sea-level anomaly</span><b>{unusualTide.name}</b><small>{Math.abs(unusualTide.surge ?? 0).toFixed(2)} m {Number(unusualTide.surge) >= 0 ? "above" : "below"} modelled tide</small>
            </button>
          )}
          {showEarthquakeNotable && largestEarthquake && (
            <button className="signal-item" onClick={() => { focusContext("earthquakes"); setSelected({ type: "earthquake", item: largestEarthquake }); }}>
              <span>Seismic detection</span><b>M {largestEarthquake.magnitude.toFixed(1)} · {largestEarthquake.place}</b><small>{formatDate(new Date(largestEarthquake.observedAt))}</small>
            </button>
          )}
          {showIssNotable && visibleIssPass && (
            <button className="signal-item" onClick={() => focusContext("iss")}>
              <span>Night sky</span><b>ISS pass at {formatTime(new Date(visibleIssPass.startsAt))}</b><small>{formatDate(new Date(visibleIssPass.startsAt))} · up to {visibleIssPass.maxElevation.toFixed(0)}°</small>
            </button>
          )}
          {!hasVisibleNotable && notableSourcesLive && (
            <p className="all-quiet"><span className="live-dot live" />No unusual signals match the selected layers.</p>
          )}
          {!hasVisibleNotable && !notableSourcesLive && (
            <p className="all-quiet"><span className="live-dot partial" />Some selected signal sources are temporarily unavailable.</p>
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
          <strong>{snapshot.grid?.windSharePercent?.toFixed(0) ?? "—"}%</strong>
          <small>of current demand across Ireland supplied by wind, from EirGrid operational data</small>
          <div className="signal-bars" aria-hidden="true">{[36, 52, 44, 70, 82, 65, 88].map((height, index) => <i key={index} style={{ height: `${height}%` }} />)}</div>
          <b>Open the grid now →</b>
        </button>
        <button className="pulse-card trains" onClick={() => focusContext("trains")}>
          <span><i>⌁</i> Rail positions</span>
          <strong>{snapshot.summary.runningTrains}</strong>
          <small>trains currently reporting a position across Ireland</small>
          <div className="signal-line" aria-hidden="true"><i /><i /><i /><i /><i /><i /></div>
          <b>Follow the trains →</b>
        </button>
        <button className="pulse-card rivers" onClick={() => focusContext("rivers")}>
          <span><i>≈</i> River network</span>
          <strong>{snapshot.summary.riverStations}</strong>
          <small>fresh OPW gauges distilled into a readable view across Ireland</small>
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
        <div className="timeline-chart" role="group" aria-label="Hourly average temperature and observed rainfall across reporting Met Éireann stations">
          {snapshot.timeline.length === 0 && (
            <p className="timeline-empty">The day is just beginning. Hourly observations will gather here as stations report.</p>
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
        <div className="layer-list" aria-label="Explore layer categories">
          {LAYER_GROUPS.map((group) => (
            <section className="layer-group" data-layer-group={group.id} key={group.id} aria-labelledby={`layer-group-${group.id}`}>
              <div className="layer-group-heading">
                <h3 id={`layer-group-${group.id}`}>{group.label}</h3>
                <p>{group.detail}</p>
              </div>
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
            </section>
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
