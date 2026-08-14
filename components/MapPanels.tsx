"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { LiveSnapshot } from "../lib/types";
import { transitPresentation } from "../lib/presentation.js";
import {
  type MapSelection,
  type Selection,
  MOVEMENT_DRILL_THRESHOLD,
  MOVEMENT_PAGE_SIZE,
  aqiLabel,
  formatDate,
  formatTime,
  movementItemIdentity,
  orderedTideEvents
} from "./experience-model";

export function DetailCard({
  selected,
  onClose,
  onStackChange,
  openerRef,
  historical = false
}: {
  selected: MapSelection;
  onClose: () => void;
  onStackChange: (index: number) => void;
  openerRef: { current: SVGElement | null };
  historical?: boolean;
}) {
  const stack = selected.type === "movement-stack" ? selected : null;
  const resolved: Selection = selected.type === "movement-stack"
    ? selected.items[selected.index]!
    : selected;
  const { type, item } = resolved;
  const [movementQuery, setMovementQuery] = useState("");
  const [movementKind, setMovementKind] = useState<"all" | "train" | "transit">("all");
  const [movementPage, setMovementPage] = useState(0);
  const transitDetail = type === "transit" ? transitPresentation(item) : null;
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
        <div className="detail-stack-navigation" role="navigation" aria-label="Overlapping map items">
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
          <small>{movement.type === "train" ? "Iarnród Éireann · last seen at refresh" : "Transport for Ireland"} · updated {formatTime(new Date(movement.item.observedAt))}</small>
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
          <p className="eyebrow">Iarnród Éireann · {historical ? "stored position" : "live position"}</p>
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
            <div><dt>Last seen at refresh</dt><dd>{formatTime(new Date(item.observedAt))}</dd></div>
          </dl>
          <small className="detail-method-note">
            {item.speedSource === "calculated"
              ? "Estimated from the distance and time between successive Irish Rail positions. Irish Rail XML has no per-train observation clock."
              : "Irish Rail does not publish train speed or a per-train observation clock; this time is last seen at refresh."}
          </small>
        </>
      )}
      {type === "river" && (
        <>
          <p className="eyebrow">OPW river gauge · {historical ? "stored observation" : "near real time"}</p>
          <h2 id="map-detail-title">{item.name}</h2>
          <div className="station-temperature">{item.level.toFixed(2)}<small> m</small></div>
          <p>A gauge measurement—not a flood warning. Levels are local to each station and should not be compared between gauges.</p>
          <dl>
            <div><dt>Observed</dt><dd>{formatTime(new Date(item.observedAt))}</dd></div>
            <div><dt>Freshness</dt><dd>{item.fresh ? historical ? "Fresh at capture" : "Current" : "Stale"}</dd></div>
          </dl>
        </>
      )}
      {type === "buoy" && (
        <>
          <p className="eyebrow">Marine Institute · {historical ? "stored observation" : "near real time"}</p>
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
          <p className="eyebrow">EPA · {historical ? "stored bathing-water alert" : "active bathing-water alert"}</p>
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
          <p className="eyebrow">Transport for Ireland · {historical ? "stored position" : "live position"}</p>
          <h2 id="map-detail-title">{transitDetail?.title}</h2>
          <div className="detail-emblem">↗</div>
          <p className="transit-direction">{transitDetail?.direction}</p>
          {transitDetail?.label && <p className="transit-service-label">{transitDetail.label}</p>}
          <dl>
            <div><dt>Route</dt><dd>{transitDetail?.route || `Route unavailable from this TFI ${historical ? "stored record" : "live vehicle feed"}`}</dd></div>
            <div><dt>Destination</dt><dd>{transitDetail?.destination}</dd></div>
            <div><dt>Direction</dt><dd>{transitDetail?.direction}</dd></div>
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

export function GridPanel({ grid, className = "", historical = false }: { grid: LiveSnapshot["grid"]; className?: string; historical?: boolean }) {
  return (
    <aside className={`map-data-panel grid-panel ${className}`} aria-label={`All-island electricity grid ${historical ? "at the selected time" : "now"}`}>
      <p className="eyebrow">EirGrid · operational data</p>
      <h2>{historical ? "The grid then" : "The grid now"}</h2>
      {grid ? (
        <>
          <div className="grid-hero">
            <strong>{grid.windSharePercent === null ? "—" : `${grid.windSharePercent.toFixed(0)}%`}</strong>
            <span>{grid.windSharePercent === null ? "wind share is unavailable in this grid response" : `of ${historical ? "captured" : "current"} demand supplied by wind`}</span>
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

export function AuroraPanel({ aurora, className = "" }: { aurora: LiveSnapshot["aurora"]; className?: string }) {
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

export function IssPanel({ iss, className = "", historical = false }: { iss: LiveSnapshot["iss"]; className?: string; historical?: boolean }) {
  const next = iss?.passes[0] ?? null;
  const visible = iss?.passes.find((pass) => pass.visible) ?? null;
  return (
    <aside className={`map-data-panel iss-panel ${className}`} aria-label="International Space Station over Ireland">
      <p className="eyebrow">CelesTrak · calculated locally</p>
      <h2>ISS over Ireland{historical ? " at capture" : ""}</h2>
      {iss ? (
        <>
          <div className="iss-orbit-value">
            <strong>{iss.altitudeKm.toFixed(0)}</strong><span>km above Earth {historical ? "at capture" : "now"}</span>
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
