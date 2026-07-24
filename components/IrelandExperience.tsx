"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { geoMercator, geoPath } from "d3-geo";
import { feature } from "topojson-client";
import landTopology from "world-atlas/land-50m.json";
import type { LiveSnapshot, StationReading } from "../lib/types";
import { refreshWeather } from "../lib/browser-live";

type Layer = "weather" | "rain" | "wind" | "warnings" | "places" | "sea";

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

export default function IrelandExperience({ initialSnapshot }: { initialSnapshot: LiveSnapshot }) {
  const [snapshot, setSnapshot] = useState(initialSnapshot);
  const [now, setNow] = useState(() => new Date(initialSnapshot.generatedAt));
  const [layers, setLayers] = useState<Set<Layer>>(
    () => new Set(["weather", "rain", "wind", "warnings", "places", "sea"])
  );
  const [selected, setSelected] = useState<StationReading | null>(null);
  const [panelOpen, setPanelOpen] = useState(false);
  const [sound, setSound] = useState(false);
  const [lastUpdated, setLastUpdated] = useState(() => new Date(initialSnapshot.generatedAt));
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
    update();
    const refresh = window.setInterval(update, 5 * 60_000);
    return () => {
      window.clearInterval(clock);
      window.clearInterval(refresh);
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

  const projection = useMemo(
    () => geoMercator().center([-8.05, 53.45]).scale(2250).translate([500, 420]),
    []
  );
  const landPath = useMemo(() => {
    const land = feature(
      landTopology as unknown as Parameters<typeof feature>[0],
      (landTopology as unknown as { objects: { land: Parameters<typeof feature>[1] } }).objects.land
    );
    return geoPath(projection)(land) ?? "";
  }, [projection]);
  const narrative = nationalNarrative(snapshot, now);
  const daylight = solarProgress(now);
  const sunX = 120 + daylight * 760;
  const sunY = 145 - Math.sin(daylight * Math.PI) * 105;
  const currentHour = irelandHour(now);
  const isNight = currentHour < 6 || currentHour >= 21;
  const activeWarning = snapshot.warnings[0] ?? null;

  const toggleLayer = useCallback((layer: Layer) => {
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
          <span className="brand-mark" aria-hidden="true">É</span>
          <span><b>A Day in Ireland</b><small>See Ireland happening</small></span>
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

      <section className="hero-copy" aria-labelledby="moment-heading">
        <p className="eyebrow">{formatDate(now)} · {formatTime(now)} IST</p>
        <h1 id="moment-heading">{narrative.period}</h1>
        <p>{narrative.detail}</p>
        <div className="moment-facts" aria-label="Current national highlights">
          <span><b>{snapshot.summary.warmest?.temperature ?? "—"}°</b> warmest</span>
          <span><b>{snapshot.summary.wettest?.rainfall ?? "—"} mm</b> recent rain</span>
          <span><b>{snapshot.summary.windiest?.windSpeed ?? "—"} km/h</b> strongest wind</span>
        </div>
      </section>

      <section id="live-map" className="map-stage" aria-label="Live map of Ireland">
        <svg className="ireland-map" viewBox="0 0 1000 900" role="img" aria-labelledby="map-title map-description">
          <title id="map-title">Near-real-time conditions across Ireland</title>
          <desc id="map-description">An illustrated map showing weather station readings, rain and major places.</desc>
          <defs>
            <radialGradient id="sunGlow">
              <stop offset="0" stopColor="#ffe9a3" stopOpacity=".85" />
              <stop offset="1" stopColor="#ffd56a" stopOpacity="0" />
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
              <feDropShadow dx="0" dy="18" stdDeviation="16" floodColor="#001311" floodOpacity=".55" />
            </filter>
            <filter id="blur"><feGaussianBlur stdDeviation="18" /></filter>
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
            <path d={landPath} fill="url(#land)" stroke="#abc093" strokeWidth="1.3" filter="url(#landShadow)" />
            <g className="terrain" aria-hidden="true">
              <path d="M280 274c70 24 103 87 75 130-18 27-38 43-58 78" />
              <path d="M382 490c68-20 126 0 163 50 29 39 63 73 116 91" />
              <path d="M311 639c55-50 112-58 172-31" />
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
            {layers.has("sea") && snapshot.marine.map((buoy) => {
              const point = projection([buoy.longitude, buoy.latitude]);
              return point ? (
                <g className="buoy" key={buoy.id} transform={`translate(${point[0]} ${point[1]})`}>
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
                active={selected?.id === station.id}
                onSelect={setSelected}
              />
            ))}
          </g>
        </svg>

        <div className="map-caption">
          <span className="compass">N</span>
          <span>Live and near-real-time observations</span>
        </div>

        {selected && (
          <aside className="station-card" aria-live="polite">
            <button onClick={() => setSelected(null)} aria-label="Close station details">×</button>
            <p className="eyebrow">Met Éireann station</p>
            <h2>{selected.name}</h2>
            <div className="station-temperature">{selected.temperature ?? "—"}°</div>
            <p>{selected.description}</p>
            <dl>
              <div><dt>Rain</dt><dd>{selected.rainfall ?? "—"} mm</dd></div>
              <div><dt>Wind</dt><dd>{selected.windSpeed ?? "—"} km/h {selected.windDirection}</dd></div>
              <div><dt>Observed</dt><dd>{selected.observedAt ? formatTime(new Date(selected.observedAt)) : "Unavailable"}</dd></div>
            </dl>
          </aside>
        )}
      </section>

      {activeWarning && layers.has("warnings") && (
        <aside className={`warning-strip ${activeWarning.level.toLowerCase()}`} aria-label="Active weather warning">
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

      <section className="dayline" aria-label="Today so far">
        <div className="dayline-heading">
          <div><p className="eyebrow">Today so far</p><h2>The shape of the day</h2></div>
          <p>Hourly observations from reporting Met Éireann stations.</p>
        </div>
        <div className="timeline-chart">
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

      <aside className={`explore-panel ${panelOpen ? "is-open" : ""}`} aria-hidden={!panelOpen}>
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
            ["places", "Places", "Major towns and cities"]
          ] as Array<[Layer, string, string]>).map(([id, label, detail]) => (
            <button key={id} className={layers.has(id) ? "active" : ""} onClick={() => toggleLayer(id)} aria-pressed={layers.has(id)}>
              <span className="layer-toggle" /><span><b>{label}</b><small>{detail}</small></span>
            </button>
          ))}
        </div>
        <div className="source-note">
          <p className="eyebrow">About the data</p>
          <p>Observations update automatically. Missing or stale readings are never shown as zero. Map effects are interpretations of measured conditions, not a safety forecast.</p>
          <a href="https://www.met.ie/about-us/specialised-services/open-data" target="_blank" rel="noreferrer">Met Éireann open data ↗</a>
        </div>
      </aside>

      <footer>
        <p><b>A Day in Ireland</b> turns public observations into a living portrait of the island.</p>
        <p>Weather data © Met Éireann, published under CC BY 4.0. Conditions are indicative and should not be used for safety-critical decisions.</p>
      </footer>
    </main>
  );
}
