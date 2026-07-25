"use client";

import {
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type WheelEvent as ReactWheelEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState
} from "react";
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
import { refreshCurrentContexts, refreshLivingLayers, refreshWeather } from "../lib/browser-live";

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

const PLACES = [
  { name: "Dublin", lon: -6.2603, lat: 53.3498 },
  { name: "Belfast", lon: -5.9301, lat: 54.5973 },
  { name: "Cork", lon: -8.4756, lat: 51.8985 },
  { name: "Galway", lon: -9.0568, lat: 53.2707 },
  { name: "Limerick", lon: -8.6267, lat: 52.6638 },
  { name: "Waterford", lon: -7.1119, lat: 52.2593 },
  { name: "Derry", lon: -7.309, lat: 54.9966 }
];

const formatTime = (date: Date) =>
  new Intl.DateTimeFormat("en-IE", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "Europe/Dublin"
  }).format(date);

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
  const period = hour < 6 ? "A quiet night across the island." : hour < 12 ? "Ireland is waking." : hour < 18 ? "The day is in motion." : hour < 22 ? "Evening is settling in." : "The island grows quieter.";
  const warm = snapshot.summary.warmest;
  const rain = snapshot.summary.wettest;
  const detail = rain && (rain.rainfall ?? 0) > 0
    ? `Rain is being observed around ${rain.name}, while ${warm?.name ?? "the warmest station"} reports ${warm?.temperature ?? "—"}°.`
    : `${warm?.name ?? "The warmest station"} is reporting ${warm?.temperature ?? "—"}°, with mostly dry observations across the network.`;
  return { period, detail };
}

function StationMarker({
  station,
  projection,
  active,
  onSelect
}: {
  station: StationReading;
  projection: ReturnType<typeof geoMercator>;
  active: boolean;
  onSelect: (station: StationReading) => void;
}) {
  const point = projection([station.longitude, station.latitude]);
  if (!point) return null;
  const [x, y] = point;
  const wet = (station.rainfall ?? 0) > 0;
  return (
    <g
      className={`station-marker ${active ? "is-active" : ""} ${wet ? "is-wet" : ""}`}
      transform={`translate(${x} ${y})`}
      role="button"
      tabIndex={0}
      aria-label={`${station.name}, ${station.temperature ?? "unknown"} degrees, ${station.description}`}
      onClick={() => onSelect(station)}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") onSelect(station);
      }}
    >
      {wet && <circle className="rain-ring" r="17" />}
      <circle className="station-halo" r="11" />
      <circle className="station-core" r="4" />
      <text x="10" y="-7">{station.temperature ?? "—"}°</text>
    </g>
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
      {[30, 31].map((x) => {
        const y = 20;
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

function DetailCard({ selected, onClose }: { selected: Selection; onClose: () => void }) {
  const { type, item } = selected;
  return (
    <aside className={`station-card detail-${type}`} aria-live="polite">
      <button onClick={onClose} aria-label="Close map details">×</button>
      {type === "station" && (
        <>
          <p className="eyebrow">Met Éireann station</p>
          <h2>{item.name}</h2>
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
          <h2>Train {item.id}</h2>
          <div className="detail-emblem">↗</div>
          <p>{item.message || item.direction}</p>
          <dl>
            <div><dt>Status</dt><dd>{item.status === "running" ? "Running" : "Due to start"}</dd></div>
            <div><dt>Direction</dt><dd>{item.direction}</dd></div>
            <div><dt>Checked</dt><dd>{formatTime(new Date(item.observedAt))}</dd></div>
          </dl>
        </>
      )}
      {type === "river" && (
        <>
          <p className="eyebrow">OPW river gauge · near real time</p>
          <h2>{item.name}</h2>
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
          <h2>{item.name}</h2>
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
          <h2>{item.name}</h2>
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
          <h2>{item.name}</h2>
          <div className="station-temperature">{item.waterLevel?.toFixed(2) ?? "—"}<small> m OD Malin</small></div>
          <p>
            {item.surge === null
              ? "Observed sea level. The modelled tide and surge comparison is temporarily unavailable."
              : `${Math.abs(item.surge).toFixed(2)} m ${item.surge >= 0 ? "above" : "below"} the modelled astronomical tide.`}
          </p>
          <dl>
            <div><dt>Observed</dt><dd>{formatTime(new Date(item.observedAt))}</dd></div>
            <div><dt>Movement</dt><dd>{item.trend}</dd></div>
            <div><dt>Next high</dt><dd>{item.nextHighAt ? `${formatTime(new Date(item.nextHighAt))} · ${item.nextHighLevel?.toFixed(2) ?? "—"} m` : "—"}</dd></div>
            <div><dt>Next low</dt><dd>{item.nextLowAt ? `${formatTime(new Date(item.nextLowAt))} · ${item.nextLowLevel?.toFixed(2) ?? "—"} m` : "—"}</dd></div>
          </dl>
        </>
      )}
      {type === "bathing" && (
        <>
          <p className="eyebrow">EPA · active bathing-water alert</p>
          <h2>{item.name}</h2>
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
          <h2>{item.place}</h2>
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
          <h2>{item.route ? `Route ${item.route}` : item.label}</h2>
          <div className="detail-emblem">↗</div>
          <p>{item.label}</p>
          <dl>
            <div><dt>Speed</dt><dd>{item.speedKmh?.toFixed(0) ?? "—"} km/h</dd></div>
            <div><dt>Updated</dt><dd>{formatTime(new Date(item.observedAt))}</dd></div>
          </dl>
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
      ) : <p>Operational grid data is temporarily unavailable.</p>}
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
      ) : <p>NOAA aurora guidance is temporarily unavailable.</p>}
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
  const [snapshot, setSnapshot] = useState(initialSnapshot);
  const [now, setNow] = useState(() => new Date(initialSnapshot.generatedAt));
  const [layers, setLayers] = useState<Set<Layer>>(
    () => new Set(["weather", "rain", "wind", "warnings", "places"])
  );
  const [selected, setSelected] = useState<Selection | null>(null);
  const [panelOpen, setPanelOpen] = useState(false);
  const [activePreset, setActivePreset] = useState<"weather" | "movement" | "water" | "all" | "custom">("weather");
  const [servicesRefreshing, setServicesRefreshing] = useState(true);
  const [showAllNotables, setShowAllNotables] = useState(false);
  const [lastUpdated, setLastUpdated] = useState(() => new Date(initialSnapshot.generatedAt));
  const [mapNotice, setMapNotice] = useState<{ title: string; detail: string } | null>(null);
  const [radarFrameIndex, setRadarFrameIndex] = useState(() => Math.max(0, initialSnapshot.radar.length - 1));
  const [radarPlaying, setRadarPlaying] = useState(false);
  const [mapView, setMapView] = useState({ scale: 1, x: 0, y: 0 });
  const snapshotRef = useRef(initialSnapshot);
  const mapRef = useRef<SVGSVGElement | null>(null);
  const mapPointersRef = useRef(new Map<number, { x: number; y: number }>());
  const mapGestureRef = useRef<{ center: { x: number; y: number }; distance: number } | null>(null);
  const mapPointerOriginRef = useRef<{ x: number; y: number } | null>(null);
  const mapDidPanRef = useRef(false);

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
        stations: next.stations,
        warnings: next.warnings,
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
        transit: next.transit,
        transitStatus: next.transitStatus,
        contextStatus: next.contextStatus
      }));
      setRadarFrameIndex(Math.max(0, next.radar.length - 1));
    };
    const refreshInitial = async () => {
      await Promise.allSettled([update(), updateLivingLayers(), updateCurrentContexts()]);
      setServicesRefreshing(false);
    };
    void refreshInitial();
    const refresh = window.setInterval(() => void update(), 5 * 60_000);
    const livingRefresh = window.setInterval(() => void updateLivingLayers(), 60_000);
    const contextRefresh = window.setInterval(() => void updateCurrentContexts(), 5 * 60_000);
    return () => {
      window.clearInterval(clock);
      window.clearInterval(refresh);
      window.clearInterval(livingRefresh);
      window.clearInterval(contextRefresh);
    };
  }, []);

  useEffect(() => {
    setShowAllNotables(false);
  }, [layers]);

  useEffect(() => {
    if (!radarPlaying || !layers.has("radar") || snapshot.radar.length < 2) return;
    const animation = window.setInterval(() => {
      setRadarFrameIndex((index) => (index + 1) % snapshot.radar.length);
    }, 850);
    return () => window.clearInterval(animation);
  }, [layers, radarPlaying, snapshot.radar.length]);


  useEffect(() => {
    if (!panelOpen) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setPanelOpen(false);
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [panelOpen]);

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
    const cells = new Map<string, { x: number; y: number; vehicles: LiveSnapshot["transit"] }>();
    for (const vehicle of snapshot.transit) {
      const point = projection([vehicle.longitude, vehicle.latitude]);
      if (!point || point[0] < 0 || point[0] > 1000 || point[1] < 0 || point[1] > 900) continue;
      const cellX = Math.floor(point[0] / cellSize);
      const cellY = Math.floor(point[1] / cellSize);
      const key = `${cellX}:${cellY}`;
      const cell = cells.get(key) ?? {
        x: (cellX + .5) * cellSize,
        y: (cellY + .5) * cellSize,
        vehicles: []
      };
      cell.vehicles.push(vehicle);
      cells.set(key, cell);
    }
    return [...cells.entries()].map(([key, cell]) => ({ key, ...cell }));
  }, [mapView.scale, projection, snapshot.transit]);
  const narrative = nationalNarrative(snapshot, now);
  const daylight = solarProgress(now);
  const sunX = 880 - daylight * 760;
  const sunY = 145 - Math.sin(daylight * Math.PI) * 105;
  const currentHour = irelandHour(now);
  const isNight = currentHour < 6 || currentHour >= 21;
  const activeWarning = snapshot.warnings[0] ?? null;
  const unusualTide = snapshot.tides
    .filter((tide) => tide.surge !== null)
    .sort((a, b) => Math.abs(b.surge ?? 0) - Math.abs(a.surge ?? 0))[0] ?? null;
  const largestEarthquake = [...snapshot.earthquakes].sort((a, b) => b.magnitude - a.magnitude)[0] ?? null;
  const visibleIssPass = snapshot.iss?.passes.find((pass) => pass.visible) ?? null;
  const showWeatherNotable = layers.has("warnings");
  const showSeaNotables = layers.has("sea") || layers.has("bathing") || layers.has("tides");
  const showEarthquakeNotable = layers.has("earthquakes");
  const showIssNotable = layers.has("iss");
  const hasVisibleNotable =
    Boolean(showWeatherNotable && activeWarning) ||
    Boolean(showSeaNotables && snapshot.bathingAlerts.length) ||
    Boolean(showSeaNotables && unusualTide && Math.abs(unusualTide.surge ?? 0) >= .15) ||
    Boolean(showEarthquakeNotable && largestEarthquake) ||
    Boolean(showIssNotable && visibleIssPass);
  const notableItemCount =
    (showWeatherNotable && activeWarning ? 1 : 0) +
    (showSeaNotables ? snapshot.bathingAlerts.length : 0) +
    (showSeaNotables && unusualTide && Math.abs(unusualTide.surge ?? 0) >= .15 ? 1 : 0) +
    (showEarthquakeNotable && largestEarthquake ? 1 : 0) +
    (showIssNotable && visibleIssPass ? 1 : 0);
  const selectedNotableSourceStates = [
    showSeaNotables ? snapshot.contextStatus.bathing : null,
    showSeaNotables ? snapshot.contextStatus.tides : null,
    showEarthquakeNotable ? snapshot.contextStatus.earthquakes : null,
    showIssNotable ? snapshot.contextStatus.iss : null
  ].filter((status): status is "live" | "unavailable" => status !== null);
  const notableSourcesLive = selectedNotableSourceStates.every((status) => status === "live");
  const liveServiceCount = [
    snapshot.stations.length > 0,
    snapshot.trains.length > 0,
    snapshot.rivers.length > 0,
    snapshot.marine.length > 0,
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
  const radarFrame = snapshot.radar[Math.min(radarFrameIndex, Math.max(0, snapshot.radar.length - 1))] ?? null;
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
    if ((event.target as Element).closest('[role="button"]')) return;
    const point = mapPointFromClient(event.clientX, event.clientY);
    mapPointersRef.current.set(event.pointerId, point);
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // Synthetic accessibility tests do not create an active browser pointer.
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
  const showPreset = useCallback((preset: "weather" | "movement" | "water" | "all") => {
    const presets: Record<typeof preset, Layer[]> = {
      weather: ["weather", "rain", "wind", "warnings", "places"],
      movement: ["trains", "transit", "places"],
      water: ["rain", "rivers", "sea", "tides", "bathing", "warnings", "places"],
      all: ["weather", "rain", "wind", "warnings", "places", "sea", "trains", "rivers", "radar", "grid", "air", "aurora", "tides", "bathing", "iss", "earthquakes"]
    };
    setLayers(new Set(presets[preset]));
    setActivePreset(preset);
    setSelected(null);
    setMapNotice(null);
    setRadarPlaying(false);
  }, []);

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
        title: "Offshore conditions",
        detail: snapshot.marine.length
          ? `${snapshot.marine.length} Marine Institute buoys with recent observations. Select a buoy for wave, wind and sea temperature.`
          : "No Marine Institute buoy observations are fresh enough to display right now."
      },
      warnings: {
        title: activeWarning ? "Active weather notice" : "No active weather warnings",
        detail: activeWarning?.headline ?? "Met Éireann is not currently publishing a warning for Ireland."
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
    setRadarPlaying(focus === "radar" && snapshot.radar.length > 1);
    if (focus === "radar") setRadarFrameIndex(0);
    window.requestAnimationFrame(() => {
      document.getElementById(focus === "warnings" && activeWarning ? "active-warning" : "live-map")
        ?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  }, [activeWarning, snapshot]);

  const toggleLayer = useCallback((layer: Layer) => {
    setActivePreset("custom");
    setLayers((current) => {
      const next = new Set(current);
      if (next.has(layer)) next.delete(layer);
      else next.add(layer);
      return next;
    });
  }, []);

  return (
    <main className={`experience ${isNight ? "is-night" : ""}`}>
      <a className="skip-link" href="#live-map">Skip to live map</a>
      <header className="topbar">
        <a className="brand" href="#" aria-label="A Day in Ireland, home">
          <span className="brand-mark" aria-hidden="true">
            <svg viewBox="0 0 32 32">
              <path className="brand-sun" d="M11 15a5 5 0 0 1 10 0" />
              <path className="brand-horizon" d="M5 18h22M8 22h16" />
            </svg>
          </span>
          <span><b>A Day in Ireland</b><small>Live island view</small></span>
        </a>
        <div className="live-state" title={`Snapshot generated ${lastUpdated.toLocaleString("en-IE", { timeZone: "Europe/Dublin" })}`}>
          <span className={`live-dot ${snapshot.sourceStatus}`} />
          <span>{snapshot.sourceStatus === "live" ? "Live observations" : "Partial observations"}</span>
          <time>{formatTime(lastUpdated)}</time>
        </div>
        <nav className="header-actions" aria-label="Experience controls">
          <button className="panel-button" onClick={() => setPanelOpen((value) => !value)} aria-expanded={panelOpen}>
            Explore <span aria-hidden="true">⌁</span>
          </button>
        </nav>
      </header>

      <section className="dashboard-shell">
        <aside className="section-rail" aria-label="Live view summary">
          <div className="rail-status">
            <span className={`live-dot ${snapshot.sourceStatus}`} />
            <span><b>Live systems</b><small>{servicesRefreshing ? "Refreshing services…" : `${liveServiceCount} services connected`}</small></span>
          </div>
          <nav aria-label="Map view shortcuts">
            <button className={activePreset === "weather" ? "active" : ""} onClick={() => showPreset("weather")}><span>☁</span>Weather</button>
            <button className="rail-extra" onClick={() => focusContext("radar")}><span>◉</span>Rain radar</button>
            <button className={activePreset === "movement" ? "active" : ""} onClick={() => showPreset("movement")}><span>↗</span>Transport</button>
            <button className={activePreset === "water" ? "active" : ""} onClick={() => showPreset("water")}><span>≈</span>Water</button>
            <button className="rail-extra" onClick={() => focusContext("sea")}><span>⌁</span>Sea</button>
            <button className="rail-extra" onClick={() => focusContext("grid")}><span>ϟ</span>Energy</button>
            <button className="rail-extra" onClick={() => focusContext("air")}><span>◌</span>Air</button>
            <button className={activePreset === "all" ? "active" : ""} onClick={() => showPreset("all")}><span>⌘</span>All layers</button>
          </nav>
          <div className="rail-metrics">
            <p><span>Warmest</span><strong>{snapshot.summary.warmest?.temperature ?? "—"}°</strong><small>{snapshot.summary.warmest?.name ?? "No report"}</small></p>
            <p><span>Strongest wind</span><strong>{snapshot.summary.windiest?.windSpeed ?? "—"}</strong><small>km/h · {snapshot.summary.windiest?.name ?? "No report"}</small></p>
            <p><span>Trains moving</span><strong>{snapshot.summary.runningTrains}</strong><small>Live positions</small></p>
            <p><span>River gauges</span><strong>{snapshot.summary.riverStations}</strong><small>Fresh readings</small></p>
          </div>
        </aside>

        <div className="map-workspace">
          <div className="workspace-heading">
            <div>
              <p className="eyebrow">{formatDate(now)} · {formatTime(now)} IST</p>
              <h1 id="moment-heading">{narrative.period}</h1>
              <p>{narrative.detail}</p>
            </div>
            <div className="workspace-facts" aria-label="Current national highlights">
              <button onClick={() => focusContext("grid")}><b>{snapshot.grid?.windSharePercent?.toFixed(0) ?? "—"}%</b><small>demand met by wind</small></button>
              <button onClick={() => focusContext("sea")}><b>{snapshot.marine.length}</b><small>buoys reporting at sea</small></button>
              <button onClick={() => focusContext("radar")}><b>{snapshot.summary.wettest?.rainfall ?? "—"} mm</b><small>recent observed rain</small></button>
            </div>
          </div>

      <section id="live-map" className="map-stage" aria-label="Live map of Ireland">
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
          <button className={activePreset === "movement" ? "active" : ""} aria-pressed={activePreset === "movement"} onClick={() => showPreset("movement")}><span className="preset-dot movement" />Rail</button>
          <button className={activePreset === "water" ? "active" : ""} aria-pressed={activePreset === "water"} onClick={() => showPreset("water")}><span className="preset-dot water" />Water</button>
          <button className={activePreset === "all" ? "active" : ""} aria-pressed={activePreset === "all"} onClick={() => showPreset("all")}>All layers</button>
        </nav>
        <svg
          ref={mapRef}
          className={mapView.scale > 1 ? "ireland-map is-zoomed" : "ireland-map"}
          viewBox="0 0 1000 900"
          role="img"
          aria-labelledby="map-title map-description"
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
            <g className="road-network" aria-label="Major roads from OpenStreetMap">
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
            {layers.has("rivers") && snapshot.rivers.map((river) => {
              const point = projection([river.longitude, river.latitude]);
              return point ? (
                <g
                  className="river-marker"
                  key={river.id}
                  transform={`translate(${point[0]} ${point[1]})`}
                  role="button"
                  tabIndex={0}
                  aria-label={`${river.name} river gauge, ${river.level.toFixed(2)} metres`}
                  onClick={() => setSelected({ type: "river", item: river })}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") setSelected({ type: "river", item: river });
                  }}
                >
                  <path d="M0 -7 C5 -1 7 2 7 6 A7 7 0 1 1 -7 6 C-7 2 -5 -1 0 -7Z" />
                </g>
              ) : null;
            })}
            {layers.has("sea") && snapshot.marine.map((buoy) => {
              const point = projection([buoy.longitude, buoy.latitude]);
              return point ? (
                <g
                  className="buoy"
                  key={buoy.id}
                  transform={`translate(${point[0]} ${point[1]})`}
                  role="button"
                  tabIndex={0}
                  aria-label={`${buoy.name}, ${buoy.waveHeight?.toFixed(1) ?? "unknown"} metre waves`}
                  onClick={() => setSelected({ type: "buoy", item: buoy })}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") setSelected({ type: "buoy", item: buoy });
                  }}
                >
                  <circle className="buoy-wave" r={10 + (buoy.waveHeight ?? 0) * 5} />
                  <circle className="buoy-core" r="3" />
                  <text x="8" y="4">{buoy.waveHeight?.toFixed(1) ?? "—"} m</text>
                </g>
              ) : null;
            })}
            {layers.has("tides") && snapshot.tides.map((tide) => {
              const point = projection([tide.longitude, tide.latitude]);
              return point ? (
                <g
                  className={`tide-marker ${tide.surge !== null && Math.abs(tide.surge) >= .2 ? "is-unusual" : ""}`}
                  key={tide.id}
                  transform={`translate(${point[0]} ${point[1]})`}
                  role="button"
                  tabIndex={0}
                  aria-label={`${tide.name}, sea level ${tide.waterLevel?.toFixed(2) ?? "unknown"} metres, ${tide.surge === null ? "surge unavailable" : `${Math.abs(tide.surge).toFixed(2)} metres ${tide.surge >= 0 ? "above" : "below"} predicted tide`}`}
                  onClick={() => setSelected({ type: "tide", item: tide })}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") setSelected({ type: "tide", item: tide });
                  }}
                >
                  <circle r="11" />
                  <path d="M-7 1Q-3-4 1 1T9 1" />
                  <text x="13" y="4">{tide.waterLevel?.toFixed(2) ?? "—"} m</text>
                </g>
              ) : null;
            })}
            {layers.has("bathing") && snapshot.bathingAlerts.map((alert) => {
              const point = projection([alert.longitude, alert.latitude]);
              return point ? (
                <g
                  className="bathing-marker"
                  key={alert.id}
                  transform={`translate(${point[0]} ${point[1]})`}
                  role="button"
                  tabIndex={0}
                  aria-label={`${alert.name}, ${alert.restriction}`}
                  onClick={() => setSelected({ type: "bathing", item: alert })}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") setSelected({ type: "bathing", item: alert });
                  }}
                >
                  <circle className="alert-pulse" r="15" />
                  <circle r="8" />
                  <text textAnchor="middle" y="4">!</text>
                </g>
              ) : null;
            })}
            {layers.has("weather") && snapshot.stations.map((station) => (
              <StationMarker
                key={station.id}
                station={station}
                projection={projection}
                active={selected?.type === "station" && selected.item.id === station.id}
                onSelect={(item) => setSelected({ type: "station", item })}
              />
            ))}
            {layers.has("wind") && snapshot.stations.map((station) => {
              const point = projection([station.longitude, station.latitude]);
              if (!point || station.windSpeed === null) return null;
              return (
                <g
                  className="wind-marker"
                  key={`wind-${station.id}`}
                  transform={`translate(${point[0] + 14} ${point[1] + 12})`}
                  role="button"
                  tabIndex={0}
                  aria-label={`${station.name}, wind ${station.windSpeed} kilometres per hour from ${station.windDirection || "an unknown direction"}`}
                  onClick={() => setSelected({ type: "station", item: station })}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") setSelected({ type: "station", item: station });
                  }}
                >
                  <circle r="12" />
                  <path transform={`rotate(${windDirectionDegrees(station.windDirection)})`} d="M0 -10L4 1L0 -1L-4 1Z" />
                  <text x="14" y="4">{station.windSpeed} km/h</text>
                </g>
              );
            })}
            {layers.has("air") && displayedAirQuality.map((reading) => {
              const point = projection([reading.longitude, reading.latitude]);
              return point ? (
                <g
                  className={`air-marker ${reading.source} aqi-${aqiLabel(reading.europeanAqi).toLowerCase().replaceAll(" ", "-")}`}
                  key={reading.id}
                  transform={`translate(${point[0]} ${point[1]})`}
                  role="button"
                  tabIndex={0}
                  aria-label={`${reading.name}, ${reading.source} European air quality index ${reading.europeanAqi ?? "unavailable"}, ${aqiLabel(reading.europeanAqi)}`}
                  onClick={() => setSelected({ type: "air", item: reading })}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") setSelected({ type: "air", item: reading });
                  }}
                >
                  <circle r="15" />
                  <text textAnchor="middle" y="4">{reading.europeanAqi ?? "—"}</text>
                </g>
              ) : null;
            })}
            {layers.has("trains") && (() => {
              const occupied: [number, number][] = [];
              return snapshot.trains.map((train) => {
                const point = projection([train.longitude, train.latitude]);
                if (!point) return null;
                const candidates: [number, number][] = [[0, 0]];
                for (const radius of [24, 48, 72]) {
                  for (let step = 0; step < 12; step += 1) {
                    const angle = (step / 12) * Math.PI * 2 - Math.PI / 2;
                    candidates.push([Math.cos(angle) * radius, Math.sin(angle) * radius]);
                  }
                }
                const offset = candidates.find(([x, y]) =>
                  occupied.every(([usedX, usedY]) => Math.hypot(point[0] + x - usedX, point[1] + y - usedY) >= 24),
                ) ?? candidates.at(-1)!;
                const markerPoint: [number, number] = [point[0] + offset[0], point[1] + offset[1]];
                occupied.push(markerPoint);
                return (
                  <g
                    className={`train-marker ${train.status}`}
                    key={train.id}
                    transform={`translate(${markerPoint[0]} ${markerPoint[1]})`}
                    role="button"
                    tabIndex={0}
                    aria-label={`Train ${train.id}, ${train.direction}, ${train.status === "running" ? "running" : "due to start"}`}
                    onClick={() => setSelected({ type: "train", item: train })}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") setSelected({ type: "train", item: train });
                    }}
                  >
                    <circle className="train-pulse" r="10" />
                    <path d="M-4-7h8a3 3 0 0 1 3 3v7a5 5 0 0 1-5 5h-4a5 5 0 0 1-5-5v-7a3 3 0 0 1 3-3Zm-1 3v4h10v-4Zm1 9h2m2 0h2" />
                  </g>
                );
              });
            })()}
            {layers.has("earthquakes") && snapshot.earthquakes.map((earthquake) => {
              const point = projection([earthquake.longitude, earthquake.latitude]);
              return point ? (
                <g
                  className="earthquake-marker"
                  key={earthquake.id}
                  transform={`translate(${point[0]} ${point[1]})`}
                  role="button"
                  tabIndex={0}
                  aria-label={`${earthquake.place}, magnitude ${earthquake.magnitude.toFixed(1)}`}
                  onClick={() => setSelected({ type: "earthquake", item: earthquake })}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") setSelected({ type: "earthquake", item: earthquake });
                  }}
                >
                  <circle r={10 + Math.max(0, earthquake.magnitude) * 3} />
                  <path d="M-8 0H-3L0-7L3 7L6 0H10" />
                </g>
              ) : null;
            })}
            {layers.has("transit") && transitClusters.map((cluster) => {
                const vehicle = cluster.vehicles[0];
                const isCluster = cluster.vehicles.length > 1;
                return (
                  <g
                    className={isCluster ? "transit-marker transit-cluster" : "transit-marker"}
                    key={cluster.key}
                    transform={`translate(${cluster.x} ${cluster.y})`}
                    role="button"
                    tabIndex={0}
                    aria-label={isCluster
                      ? `${cluster.vehicles.length} live public transport vehicles nearby; ${mapView.scale < 4 ? "select to zoom in" : "select for a representative vehicle"}`
                      : `${vehicle.route ? `Route ${vehicle.route}` : vehicle.label}, live public transport position`}
                    onClick={() => {
                      if (isCluster && mapView.scale < 4) {
                        zoomMapAround(1.8, { x: cluster.x, y: cluster.y });
                        setSelected(null);
                      } else {
                        setSelected({ type: "transit", item: vehicle });
                      }
                    }}
                    onKeyDown={(event) => {
                      if (event.key !== "Enter" && event.key !== " ") return;
                      event.preventDefault();
                      if (isCluster && mapView.scale < 4) {
                        zoomMapAround(1.8, { x: cluster.x, y: cluster.y });
                        setSelected(null);
                      } else {
                        setSelected({ type: "transit", item: vehicle });
                      }
                    }}
                  >
                    <circle r={isCluster ? 9 : 5} />
                    {isCluster
                      ? <text textAnchor="middle" y="3">{cluster.vehicles.length > 99 ? "99+" : cluster.vehicles.length}</text>
                      : <path transform={`rotate(${vehicle.bearing ?? 0})`} d="M0-8L4 3L0 1L-4 3Z" />}
                  </g>
                );
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
          <div className="radar-control" aria-label="Rainfall radar timeline">
            <button
              onClick={() => setRadarPlaying((playing) => !playing)}
              disabled={snapshot.radar.length < 2}
              aria-pressed={radarPlaying}
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
              />
              <small>{snapshot.radar.length ? "Observed precipitation · 5-minute frames" : "Radar temporarily unavailable"}</small>
            </label>
          </div>
        )}

        {layers.has("grid") && <GridPanel grid={snapshot.grid} className="desktop-context-panel" />}
        {layers.has("aurora") && <AuroraPanel aurora={snapshot.aurora} className="desktop-context-panel" />}
        {layers.has("iss") && <IssPanel iss={snapshot.iss} className="desktop-context-panel" />}

        <div className="map-caption">
          <span className="compass">N</span>
          <span>Observed, operational, and clearly labelled model data · <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">© OpenStreetMap contributors</a></span>
        </div>

        <div className="live-signal-dock" aria-label="Live island signals">
          <strong><span className="live-dot live" />Live now</strong>
          <span><time>{formatTime(lastUpdated)}</time>{snapshot.summary.reporting} weather stations reporting</span>
          <span><time>{formatTime(now)}</time>{snapshot.summary.runningTrains} trains sharing positions</span>
          <span><time>{formatTime(now)}</time>{snapshot.summary.riverStations} fresh river gauges</span>
        </div>

        {selected && <DetailCard selected={selected} onClose={() => setSelected(null)} />}
      </section>
        </div>
      </section>

      {layers.has("grid") && <GridPanel grid={snapshot.grid} className="mobile-context-panel" />}
      {layers.has("aurora") && <AuroraPanel aurora={snapshot.aurora} className="mobile-context-panel" />}
      {layers.has("iss") && <IssPanel iss={snapshot.iss} className="mobile-context-panel" />}

      {activeWarning && layers.has("warnings") && (
        <aside id="active-warning" className={`warning-strip ${activeWarning.level.toLowerCase()}`} aria-label="Active weather warning">
          <span>{activeWarning.level}</span>
          <div><b>{activeWarning.headline}</b><small>{activeWarning.description}</small></div>
          <time>Until {new Date(activeWarning.expiry).toLocaleString("en-IE", {
            weekday: "short",
            hour: "2-digit",
            minute: "2-digit",
            timeZone: "Europe/Dublin"
          })}</time>
        </aside>
      )}

      <section className="notable-now" aria-labelledby="notable-heading">
        <div>
          <p className="eyebrow">Notable now</p>
          <h2 id="notable-heading">Signals that matter to this view.</h2>
        </div>
        <div className={`notable-signals ${showAllNotables ? "show-all" : ""}`}>
          {showWeatherNotable && activeWarning && <button className="signal-item" onClick={() => focusContext("warnings")}><span>Weather</span><b>{activeWarning.headline}</b><small>{activeWarning.level} notice</small></button>}
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

      <section className="island-pulse" aria-labelledby="pulse-heading">
        <div className="pulse-intro">
          <p className="eyebrow">National signal board</p>
          <h2 id="pulse-heading">Ireland, at a glance.</h2>
          <p>Energy, movement and water alongside the weather. Every signal keeps its own timestamp and meaning.</p>
        </div>
        <button className="pulse-card grid" onClick={() => focusContext("grid")}>
          <span><i>ϟ</i> All-island electricity</span>
          <strong>{snapshot.grid?.windSharePercent?.toFixed(0) ?? "—"}%</strong>
          <small>of current demand supplied by wind, from EirGrid operational data</small>
          <div className="signal-bars" aria-hidden="true">{[36, 52, 44, 70, 82, 65, 88].map((height, index) => <i key={index} style={{ height: `${height}%` }} />)}</div>
          <b>Open the grid now →</b>
        </button>
        <button className="pulse-card trains" onClick={() => focusContext("trains")}>
          <span><i>⌁</i> Rail positions</span>
          <strong>{snapshot.summary.runningTrains}</strong>
          <small>trains currently reporting a position across the network</small>
          <div className="signal-line" aria-hidden="true"><i /><i /><i /><i /><i /><i /></div>
          <b>Follow the trains →</b>
        </button>
        <button className="pulse-card rivers" onClick={() => focusContext("rivers")}>
          <span><i>≈</i> River network</span>
          <strong>{snapshot.summary.riverStations}</strong>
          <small>fresh OPW gauges distilled into a readable national view</small>
          <div className="signal-wave" aria-hidden="true">⌁⌁⌁⌁⌁⌁</div>
          <b>See the water →</b>
        </button>
      </section>

      <section className="dayline" aria-label="Today so far">
        <div className="dayline-heading">
          <div><p className="eyebrow">Today so far</p><h2>The shape of the day</h2></div>
          <p>Bar height is average temperature; cyan marks hours with observed rain.</p>
        </div>
        <div className="timeline-legend" aria-label="Chart legend">
          <span><i className="temperature" />Average temperature</span>
          <span><i className="rain" />Observed rain</span>
        </div>
        <div className="timeline-chart" role="img" aria-label="Hourly average temperature and observed rainfall across reporting Met Éireann stations">
          {snapshot.timeline.length === 0 && (
            <p className="timeline-empty">The day is just beginning. Hourly observations will gather here as stations report.</p>
          )}
          {snapshot.timeline.map((point) => {
            const height = point.temperature === null ? 4 : Math.max(10, Math.min(96, (point.temperature + 4) * 3.2));
            return (
              <div className="timeline-point" key={point.time}>
                <span className={point.rainfall > 0 ? "bar rain" : "bar"} style={{ height }} title={`${point.time}: ${point.temperature?.toFixed(1) ?? "—"}°, ${point.rainfall.toFixed(1)} mm`} />
                <small>{point.time.endsWith(":00") && Number.parseInt(point.time) % 3 === 0 ? point.time : ""}</small>
              </div>
            );
          })}
        </div>
      </section>

      {panelOpen && (
        <button
          className="panel-backdrop"
          aria-label="Close layer panel backdrop"
          onClick={() => setPanelOpen(false)}
        />
      )}
      <aside
        className={`explore-panel ${panelOpen ? "is-open" : ""}`}
        aria-hidden={!panelOpen}
        aria-modal={panelOpen}
        role="dialog"
        aria-label="Explore live map layers"
        inert={!panelOpen}
      >
        <div className="panel-heading">
          <div><p className="eyebrow">Explore the moment</p><h2>Live layers</h2></div>
          <button onClick={() => setPanelOpen(false)} aria-label="Close explore panel">×</button>
        </div>
        <div className="layer-list">
          {([
            ["weather", "Weather stations", "Temperature and current conditions"],
            ["rain", "Observed rain", "Measured recent rainfall around stations"],
            ["wind", "Observed wind", "Met Éireann direction and speed in km/h"],
            ["warnings", "Warnings", "Current official Met Éireann warnings"],
            ["radar", "Rainfall radar", "Observed Met Éireann precipitation frames, updated every five minutes"],
            ["sea", "Sea conditions", "Near-real-time Marine Institute buoy observations"],
            ["trains", "Moving trains", "Current Iarnród Éireann train positions"],
            ["rivers", "River levels", "Latest fresh OPW readings; stale gauges expire automatically"],
            ["grid", "Electricity grid", "Current all-island EirGrid demand, wind, carbon and frequency"],
            ["air", "Air & exposure", "EEA monitoring stations plus regional CAMS model estimates"],
            ["aurora", "Aurora probability", "NOAA OVATION overhead probability guidance"],
            ["tides", "Tides & surge", "Fresh gauges, predicted high and low water, and surge anomaly"],
            ["bathing", "Bathing alerts", "Current EPA restrictions and pollution advisories only"],
            ["iss", "ISS passes", "Current orbit and locally calculated passes over Ireland"],
            ["satellite", "Satellite image", "NASA VIIRS latest complete daylight image; usually several hours old"],
            ["earthquakes", "Earthquakes", "USGS detections around Ireland during the past seven days"],
            ["transit", "Public transport", "TFI live bus, Luas and other vehicle positions when API access is configured"],
            ["places", "Places", "Major towns and cities"]
          ] as Array<[Layer, string, string]>).map(([id, label, detail]) => (
            <button key={id} className={layers.has(id) ? "active" : ""} onClick={() => toggleLayer(id)} aria-pressed={layers.has(id)}>
              <span className="layer-toggle" /><span><b>{label}</b><small>{detail}</small></span>
            </button>
          ))}
        </div>
        <div className="source-note">
          <p className="eyebrow">About the data</p>
          <p>Weather, radar, rail, marine, grid and public signals refresh automatically. Air markers explicitly distinguish delayed station measurements from model output. Satellite imagery is near-real-time rather than live; ISS passes are calculations; river and tide readings are observations, not safety warnings. Missing data is never shown as zero.</p>
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
        <p><b>A Day in Ireland</b> turns public observations into a living portrait of the island.</p>
        <p>Copyright Met Éireann; source met.ie; CC BY 4.0; presentation modified. Contains Irish Public Sector Information from waterlevel.ie, the Marine Institute and EPA; EirGrid operational data; EEA air-quality reports; CAMS model output via Open-Meteo; NOAA aurora guidance; NASA GIBS imagery; CelesTrak orbital elements; and USGS seismic detections. NTA GTFS data is licensed under CC BY 4.0, provided “as is”, and the NTA is not responsible for errors or inaccuracies. Road and boundary data © OpenStreetMap contributors, ODbL. Providers accept no liability for errors or omissions. Not for safety-critical decisions.</p>
      </footer>
    </main>
  );
}
