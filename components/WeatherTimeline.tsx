import { useEffect, useRef } from "react";
import type { ServiceDisplayState } from "../lib/data-state";
import type { LiveSnapshot } from "../lib/types";
import type { TimeMode } from "./experience-model";

export function WeatherTimeline({
  timeMode,
  timeline,
  sourceStatus,
  serviceDisplayState,
  isConnectingWithoutSnapshot,
  selection,
  onSelect
}: {
  timeMode: TimeMode;
  timeline: LiveSnapshot["timeline"];
  sourceStatus: LiveSnapshot["sourceStatus"];
  serviceDisplayState: ServiceDisplayState;
  isConnectingWithoutSnapshot: boolean;
  selection: string | null;
  onSelect: (time: string) => void;
}) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const latestTime = timeline.at(-1)?.time;
  useEffect(() => {
    const chart = scrollRef.current;
    if (chart && selection === null) chart.scrollLeft = chart.scrollWidth;
  }, [latestTime, selection]);
  const selectedPoint = timeline.find((point) => point.time === selection) ?? null;
  const temperatures = timeline
    .map((point) => point.temperature)
    .filter((value): value is number => value !== null && Number.isFinite(value));
  const temperatureMin = temperatures.length ? Math.floor(Math.min(...temperatures) - 1) : null;
  const temperatureMax = temperatures.length ? Math.ceil(Math.max(...temperatures) + 1) : null;
  const temperatureRange = Math.max(1, (temperatureMax ?? 0) - (temperatureMin ?? 0));
  const rainValues = timeline
    .map((point) => point.rainfall)
    .filter((value): value is number => value !== null && Number.isFinite(value));
  const rainMax = Math.max(1, ...rainValues);

  return (
    <section id="day-so-far" className="dayline" tabIndex={-1} aria-label={`${timeMode === "past" ? "Selected day through capture" : "Today so far"} across Ireland`}>
      <div className="dayline-heading">
        <div><p className="utility-label">{timeMode === "past" ? "Selected day through capture" : "Today so far"}</p><h2>The shape of the day</h2></div>
        <p>{timeline.length
          ? "Temperature and average observed rain per reporting station use separate labelled scales. Select an hour for wind and exact values, or open the data list below."
          : "Hourly weather appears here only when recent Met Éireann observations can support it."}</p>
      </div>
      {timeline.length ? (
        <>
          <div className="timeline-actions"><button type="button" onClick={() => { if (scrollRef.current) scrollRef.current.scrollLeft = 0; }}>Start of day</button>
            <button type="button" onClick={() => { if (scrollRef.current) scrollRef.current.scrollLeft = scrollRef.current.scrollWidth; }}>Latest hours</button></div>
          <div className="timeline-legend">
            <span><i aria-hidden="true" className="temperature" />Average temperature (°C)</span>
            <span><i aria-hidden="true" className="rain" />Average observed rain per station (mm)</span>
          </div>
          {timeMode !== "past" && (sourceStatus === "stale" || serviceDisplayState === "offline") && (
            <p className="timeline-empty">Saved hourly observations from the last successful refresh are shown below and are not labelled as current.</p>
          )}
          <div
            ref={scrollRef}
            className="timeline-plot-scroll"
            role="region"
            aria-label="Scrollable hourly chart"
            tabIndex={0}
          >
            <div className="timeline-plot">
              <div className="timeline-axis temperature-axis" aria-hidden="true">
                {/* Without any finite reading an invented 0-20 scale would
                    fabricate data the chart does not hold. */}
                <span>{temperatureMax !== null ? `${temperatureMax}°C` : "–"}</span>
                <strong>Temperature</strong>
                <span>{temperatureMin !== null ? `${temperatureMin}°C` : "–"}</span>
              </div>
              <div className="timeline-chart" style={{ minWidth: timeline.length * 48, display: "grid", gridTemplateColumns: `repeat(${timeline.length}, minmax(0, 1fr))`, gap: 0 }} role="group" aria-label={`${timeMode === "past" ? "Stored" : sourceStatus === "stale" || serviceDisplayState === "offline" ? "Saved" : "Current"} hourly average temperature, rainfall, and wind across reporting Met Éireann stations`}>
            <svg className="timeline-temperature-line" viewBox={`0 0 ${timeline.length * 48} 100`} preserveAspectRatio="none" aria-hidden="true">
              {timeline.map((point, index) => {
                const previous = timeline[index - 1];
                if (point.temperature === null || temperatureMax === null || !previous || previous.temperature === null) return null;
                return <line key={point.time} x1={(index - .5) * 48} x2={(index + .5) * 48}
                  y1={(temperatureMax - previous.temperature) / temperatureRange * 100}
                  y2={(temperatureMax - point.temperature) / temperatureRange * 100} vectorEffect="non-scaling-stroke" />;
              })}
            </svg>
            {timeline.map((point) => {
              const temperatureHeight = point.temperature === null || temperatureMin === null
                ? 4
                : ((point.temperature - temperatureMin) / temperatureRange) * 100;
              const rainHeight = point.rainfall === null || point.rainfall <= 0
                ? 0
                : (point.rainfall / rainMax) * 100;
              return (
                <button
                  type="button"
                  className={`timeline-point ${selection === point.time ? "selected" : ""}`}
                  key={point.time}
                  aria-pressed={selection === point.time}
                  aria-label={`${point.time}: average temperature ${point.temperature?.toFixed(1) ?? "unavailable"} degrees Celsius, average observed rainfall ${point.rainfall?.toFixed(1) ?? "unavailable"} millimetres per reporting station, average wind ${point.windSpeed?.toFixed(0) ?? "unavailable"} kilometres per hour`}
                  onClick={() => onSelect(point.time)}
                >
                  <span className="timeline-bars" aria-hidden="true">
                    {point.temperature !== null && <span className="temperature-dot" style={{ bottom: `${temperatureHeight}%` }} />}
                    <span className="bar rain" style={{ height: `${rainHeight}%` }} />
                  </span>
                  <small>{point.time}</small>
                </button>
              );
            })}
              </div>
              <div className="timeline-axis rain-axis" aria-hidden="true">
                <span>{rainMax.toFixed(1)} mm</span>
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
                  {timeline.map((point) => (
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
              : sourceStatus === "live" || sourceStatus === "partial"
                ? timeMode === "past" ? "This historical record contains no retained hourly observations." : "The current provider response contains no hourly observations yet."
                : sourceStatus === "stale"
                  ? "No saved hourly observations remain within the retention window."
                  : "Hourly weather observations are unavailable. The chart will return when recent station data can support it."}</p>
          </div>
        </div>
      )}
      {selectedPoint && (
        <p className="timeline-selection" role="status">
          <b>{selectedPoint.time}</b> · {selectedPoint.temperature?.toFixed(1) ?? "Unavailable"}° average temperature · {selectedPoint.rainfall?.toFixed(1) ?? "Unavailable"} mm average observed rain per reporting station · {selectedPoint.windSpeed?.toFixed(0) ?? "Unavailable"} km/h average wind.
        </p>
      )}
    </section>
  );
}
