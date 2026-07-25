"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { geoMercator, geoPath } from "d3-geo";
import islandBoundary from "../public/map/island.json";
import majorRoads from "../public/map/major-roads.json";
import type {
  LiveSnapshot,
  RiverReading,
  StationReading,
  TrafficCounter,
  TrainPosition
} from "../lib/types";
import { refreshLivingLayers, refreshWeather } from "../lib/browser-live";

type Layer =
  | "weather"
  | "rain"
  | "wind"
  | "warnings"
  | "places"
  | "sea"
  | "trains"
  | "traffic"
  | "rivers";

type Selection =
  | { type: "station"; item: StationReading }
  | { type: "train"; item: TrainPosition }
  | { type: "river"; item: RiverReading }
  | { type: "traffic"; item: TrafficCounter }
  | { type: "buoy"; item: LiveSnapshot["marine"][number] };

type ContextFocus = "weather" | "traffic" | "trains" | "rivers" | "sea" | "warnings";

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

const compactNumber = new Intl.NumberFormat("en-IE", {
  notation: "compact",
  maximumFractionDigits: 1
});

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
      {type === "traffic" && (
        <>
          <p className="eyebrow">TII traffic counter · historical context</p>
          <h2>{item.name.replace("TMU ", "")}</h2>
          <div className="station-temperature">{compactNumber.format(item.averageDailyTraffic)}</div>
          <p>{item.description}</p>
          <dl>
            <div><dt>Typical volume</dt><dd>{item.averageDailyTraffic.toLocaleString("en-IE")} vehicles/day</dd></div>
            <div><dt>Road class</dt><dd>{item.category}</dd></div>
            <div><dt>Meaning</dt><dd>Historical AADT—not live traffic</dd></div>
          </dl>
        </>
      )}
      {type === "buoy" && (
        <>
          <p className="eyebrow">Marine Institute buoy · near real time</p>
          <h2>{item.id}</h2>
          <div className="station-temperature">{item.waveHeight?.toFixed(1) ?? "—"}<small> m waves</small></div>
          <p>Observed conditions at an offshore buoy. Measurements can be delayed or temporarily unavailable.</p>
          <dl>
            <div><dt>Wind</dt><dd>{item.windSpeedKnots?.toFixed(1) ?? "—"} knots</dd></div>
            <div><dt>Sea temperature</dt><dd>{item.seaTemperature?.toFixed(1) ?? "—"}°C</dd></div>
            <div><dt>Observed</dt><dd>{formatTime(new Date(item.observedAt))}</dd></div>
          </dl>
        </>
      )}
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
  const [sound, setSound] = useState(false);
  const [lastUpdated, setLastUpdated] = useState(() => new Date(initialSnapshot.generatedAt));
  const [mapNotice, setMapNotice] = useState<{ title: string; detail: string } | null>(null);
  const audioRef = useRef<AudioContext | null>(null);

  useEffect(() => {
    const clock = window.setInterval(() => setNow(new Date()), 1000);
    const update = () => {
      setSnapshot((current) => {
        void refreshWeather(current).then((next) => {
          setSnapshot(next);
          setLastUpdated(new Date(next.generatedAt));
        });
        return current;
      });
    };
    const updateLivingLayers = () => {
      setSnapshot((current) => {
        void refreshLivingLayers(current).then(setSnapshot);
        return current;
      });
    };
    update();
    updateLivingLayers();
    const refresh = window.setInterval(update, 5 * 60_000);
    const livingRefresh = window.setInterval(updateLivingLayers, 60_000);
    return () => {
      window.clearInterval(clock);
      window.clearInterval(refresh);
      window.clearInterval(livingRefresh);
    };
  }, []);

  useEffect(() => {
    if (!sound) {
      void audioRef.current?.close();
      audioRef.current = null;
      return;
    }
    const AudioContextClass = window.AudioContext;
    const context = new AudioContextClass();
    const oscillator = context.createOscillator();
    const oscillatorGain = context.createGain();
    const lowpass = context.createBiquadFilter();
    oscillator.type = "sine";
    oscillator.frequency.value = 68 + Math.min(35, snapshot.summary.windiest?.windSpeed ?? 0);
    oscillatorGain.gain.value = 0.018;
    lowpass.type = "lowpass";
    lowpass.frequency.value = 190;
    oscillator.connect(lowpass).connect(oscillatorGain).connect(context.destination);
    oscillator.start();
    audioRef.current = context;
    return () => {
      oscillator.stop();
      void context.close();
      audioRef.current = null;
    };
  }, [sound, snapshot.summary.windiest?.windSpeed]);

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
  const narrative = nationalNarrative(snapshot, now);
  const daylight = solarProgress(now);
  const sunX = 120 + daylight * 760;
  const sunY = 145 - Math.sin(daylight * Math.PI) * 105;
  const currentHour = irelandHour(now);
  const isNight = currentHour < 6 || currentHour >= 21;
  const activeWarning = snapshot.warnings[0] ?? null;
  const showPreset = useCallback((preset: "weather" | "movement" | "water" | "all") => {
    const presets: Record<typeof preset, Layer[]> = {
      weather: ["weather", "rain", "wind", "warnings", "places"],
      movement: ["traffic", "trains", "places"],
      water: ["rain", "rivers", "sea", "warnings", "places"],
      all: ["weather", "rain", "wind", "warnings", "places", "sea", "trains", "traffic", "rivers"]
    };
    setLayers(new Set(presets[preset]));
    setActivePreset(preset);
    setSelected(null);
    setMapNotice(null);
  }, []);

  const focusContext = useCallback((focus: ContextFocus) => {
    const contextLayers: Record<ContextFocus, Layer[]> = {
      weather: ["weather", "rain", "wind", "places"],
      traffic: ["traffic", "places"],
      trains: ["trains", "places"],
      rivers: ["rivers", "places"],
      sea: ["sea", "wind", "places"],
      warnings: ["warnings", "weather", "places"]
    };
    const notices: Record<ContextFocus, { title: string; detail: string }> = {
      weather: {
        title: "Weather observations",
        detail: `${snapshot.summary.reporting} fresh Met Éireann stations. Select a temperature marker for its latest reading.`
      },
      traffic: {
        title: "Road-volume context",
        detail: `${snapshot.traffic.length} TII counters showing latest signed-off average daily traffic—not live congestion. Select a marker for details.`
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
      }
    };
    setLayers(new Set(contextLayers[focus]));
    setActivePreset("custom");
    setSelected(null);
    setMapNotice(notices[focus]);
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
    <main className={`experience ${isNight ? "is-night" : ""}`} data-sound={sound}>
      <a className="skip-link" href="#live-map">Skip to live map</a>
      <header className="topbar">
        <a className="brand" href="#" aria-label="A Day in Ireland, home">
          <span className="brand-mark" aria-hidden="true">AI</span>
          <span><b>A Day in Ireland</b><small>Live island view</small></span>
        </a>
        <div className="live-state" title={`Snapshot generated ${lastUpdated.toLocaleString("en-IE", { timeZone: "Europe/Dublin" })}`}>
          <span className={`live-dot ${snapshot.sourceStatus}`} />
          <span>{snapshot.sourceStatus === "live" ? "Live observations" : "Partial observations"}</span>
          <time>{formatTime(lastUpdated)}</time>
        </div>
        <nav className="header-actions" aria-label="Experience controls">
          <button className="icon-button" onClick={() => setSound((value) => !value)} aria-pressed={sound}>
            {sound ? "Sound on" : "Sound off"}
          </button>
          <button className="panel-button" onClick={() => setPanelOpen((value) => !value)} aria-expanded={panelOpen}>
            Explore <span aria-hidden="true">⌁</span>
          </button>
        </nav>
      </header>

      <section className="dashboard-shell">
        <aside className="section-rail" aria-label="Live view summary">
          <div className="rail-status">
            <span className={`live-dot ${snapshot.sourceStatus}`} />
            <span><b>Island online</b><small>{snapshot.summary.reporting} stations reporting</small></span>
          </div>
          <nav aria-label="Map view shortcuts">
            <button className={activePreset === "weather" ? "active" : ""} onClick={() => showPreset("weather")}><span>☁</span>Weather</button>
            <button className={activePreset === "movement" ? "active" : ""} onClick={() => showPreset("movement")}><span>↗</span>Movement</button>
            <button className={activePreset === "water" ? "active" : ""} onClick={() => showPreset("water")}><span>≈</span>Water</button>
            <button className={activePreset === "all" ? "active" : ""} onClick={() => showPreset("all")}><span>⌘</span>All layers</button>
          </nav>
          <div className="rail-metrics">
            <p><span>Warmest</span><strong>{snapshot.summary.warmest?.temperature ?? "—"}°</strong><small>{snapshot.summary.warmest?.name ?? "No report"}</small></p>
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
              <span><b>{snapshot.summary.wettest?.rainfall ?? "—"} mm</b><small>recent rain</small></span>
              <span><b>{snapshot.traffic.length}</b><small>traffic counters</small></span>
              <span><b>{snapshot.marine.length}</b><small>marine buoys</small></span>
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
          <button className={activePreset === "movement" ? "active" : ""} aria-pressed={activePreset === "movement"} onClick={() => showPreset("movement")}><span className="preset-dot movement" />Movement</button>
          <button className={activePreset === "water" ? "active" : ""} aria-pressed={activePreset === "water"} onClick={() => showPreset("water")}><span className="preset-dot water" />Water</button>
          <button className={activePreset === "all" ? "active" : ""} aria-pressed={activePreset === "all"} onClick={() => showPreset("all")}>All layers</button>
        </nav>
        <svg className="ireland-map" viewBox="0 0 1000 900" role="img" aria-labelledby="map-title map-description">
          <title id="map-title">Near-real-time conditions across Ireland</title>
          <desc id="map-description">A close map of Ireland showing weather, rain, trains, traffic volumes, river gauges, sea conditions and major places.</desc>
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
            <linearGradient id="ocean" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stopColor="#163d3d" />
              <stop offset="1" stopColor="#071f22" />
            </linearGradient>
            <linearGradient id="land" x1="0" y1="0" x2="1" y2="1">
              <stop offset="0" stopColor="#94a86c" />
              <stop offset=".45" stopColor="#667f57" />
              <stop offset="1" stopColor="#344f45" />
            </linearGradient>
            <filter id="landShadow" x="-30%" y="-30%" width="160%" height="160%">
              <feDropShadow dx="0" dy="0" stdDeviation="12" floodColor="#00dbe9" floodOpacity=".22" />
            </filter>
            <clipPath id="viewportClip"><rect width="1000" height="900" rx="42" /></clipPath>
          </defs>
          <g clipPath="url(#viewportClip)">
            <rect width="1000" height="900" fill="url(#ocean)" />
            <circle cx={sunX} cy={sunY} r="135" fill="url(#sunGlow)" className="sun-glow" />
            <g className="sea-lines" aria-hidden="true">
              {Array.from({ length: 9 }, (_, index) => (
                <path key={index} d={`M -40 ${150 + index * 88} Q 230 ${120 + index * 88}, 520 ${155 + index * 88} T 1040 ${140 + index * 88}`} />
              ))}
            </g>
            <g className="island-shape" filter="url(#landShadow)">
              {islandPaths.map((path, index) => <path key={index} d={path} />)}
            </g>
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
            {layers.has("traffic") && snapshot.traffic.map((counter) => {
              const point = projection([counter.longitude, counter.latitude]);
              const radius = 3.5 + Math.min(8, Math.sqrt(counter.averageDailyTraffic) / 34);
              return point ? (
                <g
                  className="traffic-marker"
                  key={counter.id}
                  transform={`translate(${point[0]} ${point[1]})`}
                  role="button"
                  tabIndex={0}
                  aria-label={`${counter.name}, typical daily traffic ${counter.averageDailyTraffic.toLocaleString("en-IE")} vehicles`}
                  onClick={() => setSelected({ type: "traffic", item: counter })}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") setSelected({ type: "traffic", item: counter });
                  }}
                >
                  <circle className="traffic-halo" r={radius + 5} />
                  <circle className="traffic-core" r={radius} />
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
                  aria-label={`${buoy.id} marine buoy, ${buoy.waveHeight?.toFixed(1) ?? "unknown"} metre waves`}
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
            {layers.has("weather") && snapshot.stations.map((station) => (
              <StationMarker
                key={station.id}
                station={station}
                projection={projection}
                active={selected?.type === "station" && selected.item.id === station.id}
                onSelect={(item) => setSelected({ type: "station", item })}
              />
            ))}
            {layers.has("trains") && snapshot.trains.map((train) => {
              const point = projection([train.longitude, train.latitude]);
              return point ? (
                <g
                  className={`train-marker ${train.status}`}
                  key={train.id}
                  transform={`translate(${point[0]} ${point[1]})`}
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
              ) : null;
            })}
          </g>
        </svg>

        <div className="map-caption">
          <span className="compass">N</span>
          <span>Live and near-real-time observations · <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">© OpenStreetMap contributors</a></span>
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

      <section className="island-pulse" aria-labelledby="pulse-heading">
        <div className="pulse-intro">
          <p className="eyebrow">National signal board</p>
          <h2 id="pulse-heading">Ireland, at a glance.</h2>
          <p>Movement and water readings alongside the weather. Every signal keeps its own timestamp and meaning.</p>
        </div>
        <button className="pulse-card traffic" onClick={() => focusContext("traffic")}>
          <span><i>↗</i> Historical road context</span>
          <strong>{snapshot.summary.busiestRoad ? compactNumber.format(snapshot.summary.busiestRoad.averageDailyTraffic) : "—"}</strong>
          <small>latest signed-off AADT at the busiest displayed TII counter—not current traffic</small>
          <div className="signal-bars" aria-hidden="true">{[36, 52, 44, 70, 82, 65, 88].map((height, index) => <i key={index} style={{ height: `${height}%` }} />)}</div>
          <b>Show movement →</b>
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

      <nav className="context-actions" aria-label="More live contexts">
        <button onClick={() => focusContext("weather")}>
          <span>☁</span><b>Weather stations</b><small>{snapshot.summary.reporting} reporting now</small><i>View context →</i>
        </button>
        <button onClick={() => focusContext("sea")}>
          <span>⌁</span><b>Sea conditions</b><small>{snapshot.marine.length} recent buoy observations</small><i>View context →</i>
        </button>
        <button onClick={() => focusContext("warnings")}>
          <span>△</span><b>Weather notices</b><small>{activeWarning ? `${activeWarning.level}: ${activeWarning.headline}` : "No active warning"}</small><i>View context →</i>
        </button>
      </nav>

      <section className="dayline" aria-label="Today so far">
        <div className="dayline-heading">
          <div><p className="eyebrow">Today so far</p><h2>The shape of the day</h2></div>
          <p>Hourly observations from reporting Met Éireann stations.</p>
        </div>
        <div className="timeline-chart">
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
            ["wind", "Wind", "Ambient motion driven by reported wind"],
            ["warnings", "Warnings", "Current official Met Éireann warnings"],
            ["sea", "Sea conditions", "Near-real-time Marine Institute buoy observations"],
            ["trains", "Moving trains", "Current Iarnród Éireann train positions"],
            ["traffic", "Historical road volume", "Latest signed-off TII AADT; not current traffic or congestion"],
            ["rivers", "River levels", "Latest fresh OPW readings; stale gauges expire automatically"],
            ["places", "Places", "Major towns and cities"]
          ] as Array<[Layer, string, string]>).map(([id, label, detail]) => (
            <button key={id} className={layers.has(id) ? "active" : ""} onClick={() => toggleLayer(id)} aria-pressed={layers.has(id)}>
              <span className="layer-toggle" /><span><b>{label}</b><small>{detail}</small></span>
            </button>
          ))}
        </div>
        <div className="source-note">
          <p className="eyebrow">About the data</p>
          <p>Weather and rail refresh automatically. Road volume is contextual AADT, not live congestion. River readings expire after three hours if OPW refresh is unavailable; they are local measurements, not flood warnings. Missing data is never shown as zero.</p>
          <a href="https://www.met.ie/about-us/specialised-services/open-data" target="_blank" rel="noreferrer">Met Éireann open data ↗</a>
          <a href="https://trafficdata.tii.ie/" target="_blank" rel="noreferrer">TII traffic data ↗</a>
          <a href="https://waterlevel.ie/page/api/" target="_blank" rel="noreferrer">OPW water levels ↗</a>
        </div>
      </aside>

      <footer>
        <p><b>A Day in Ireland</b> turns public observations into a living portrait of the island.</p>
        <p>Copyright Met Éireann; source met.ie; CC BY 4.0; presentation modified. Contains Irish Public Sector Information from waterlevel.ie (OPW), TII and the Marine Institute under CC BY 4.0. Road and boundary data © OpenStreetMap contributors, ODbL. Providers accept no liability for errors or omissions. Not for safety-critical decisions.</p>
      </footer>
    </main>
  );
}
