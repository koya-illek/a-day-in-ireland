import type { LiveSnapshot } from "../lib/types";
import type { HistoryGap } from "../lib/history";
import type { ServiceDisplayState } from "../lib/data-state";
import {
  formatAge,
  formatTime,
  statusText,
  type ConnectionStatus,
  type HistoryLoadState,
  type TimeMode
} from "./experience-model";
import { historyResolutionLabel } from "../lib/history";

export function FreshnessStrip({
  timeMode,
  historyState,
  historyGaps,
  connectionStatus,
  serviceDisplayState,
  lastSuccessLabel,
  connectionLabel,
  lastCheckedAt,
  now,
  online,
  servicesRefreshing,
  isConnectingWithoutSnapshot,
  snapshot,
  weatherDisplayStatus,
  trainDisplayStatus,
  riverDisplayStatus,
  latestWeatherObs,
  weatherStale,
  transitStale,
  riverDataStale,
  onRefresh
}: {
  timeMode: TimeMode;
  historyState: HistoryLoadState;
  historyGaps: HistoryGap[];
  connectionStatus: ConnectionStatus;
  serviceDisplayState: ServiceDisplayState;
  lastSuccessLabel: string;
  connectionLabel: string;
  lastCheckedAt: Date;
  now: Date;
  online: boolean;
  servicesRefreshing: boolean;
  isConnectingWithoutSnapshot: boolean;
  snapshot: LiveSnapshot;
  weatherDisplayStatus: "live" | "partial" | "stale" | "fallback" | "unavailable";
  trainDisplayStatus: "live" | "partial" | "stale" | "fallback" | "unavailable";
  riverDisplayStatus: "live" | "partial" | "stale" | "fallback" | "unavailable";
  latestWeatherObs: number;
  weatherStale: boolean;
  transitStale: boolean;
  riverDataStale: boolean;
  onRefresh: () => void;
}) {
  return (
    // A plain container on purpose: role="status" would be implicitly
    // aria-atomic, re-announcing this whole strip every time a volatile age or
    // clock text flips. Only the connection-state words below are announced,
    // and the chips speak through their own visible text rather than an
    // aria-label that generic elements cannot reliably carry.
    <div className="freshness-strip">
      {timeMode === "past" ? (
        <>
          {/* Not describedby-linked: a disabled button is unreachable by
              keyboard, so the rationale lives in the adjacent connection chip
              and the Data details disclosure instead. */}
          <button type="button" className="refresh-data-button" disabled>Live refresh paused</button>
          <span id="connection-summary" className={`freshness-chip connection-chip ${historyState.status}`} data-connection-status={connectionStatus} data-service-state={serviceDisplayState}>
            <i aria-hidden="true" /><b>Historical record</b><small>{historyState.status === "loading" ? "Loading stored conditions" : historyState.status === "ready" ? `${historyResolutionLabel(historyState.envelope?.resolutionMinutes ?? 15)} · captured ${lastSuccessLabel} · ${historyGaps.length} recorded gap${historyGaps.length === 1 ? "" : "s"}` : historyState.status === "error" ? "Stored conditions could not be loaded" : "No stored record is available for the selected time"}{connectionStatus === "offline" ? " · readable offline once loaded" : ""}</small>
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
            onClick={onRefresh}
            disabled={connectionStatus === "offline" || servicesRefreshing}
            aria-describedby="connection-summary"
          >
            {servicesRefreshing ? "Refreshing…" : "Refresh live data"}
          </button>
          <span id="connection-summary" className={`freshness-chip connection-chip ${serviceDisplayState}`} data-connection-status={connectionStatus} data-service-state={serviceDisplayState}>
            <i aria-hidden="true" /><b>Connection</b>
            <small>
              <span role="status" aria-live="polite">
                {connectionStatus === "offline"
                  ? `Offline · live refresh unavailable${snapshot.lastSuccessAt ? " · saved snapshot" : ""}`
                  : serviceDisplayState === "connecting"
                    ? "Checking for newer data"
                    : connectionLabel}
              </span>
              {" · checked "}{formatTime(lastCheckedAt)}{" · last success "}{lastSuccessLabel}
            </small>
          </span>
          <details className="freshness-details">
            <summary>Data details</summary>
            <div className="freshness-detail-grid">
              <span className={`freshness-chip ${isConnectingWithoutSnapshot ? "connecting" : weatherDisplayStatus}`}>
                <i aria-hidden="true" /><b>Weather provider</b><small>{isConnectingWithoutSnapshot ? "Connecting…" : `Provider: ${statusText(weatherDisplayStatus)}${!online ? " (offline)" : ""} · observed ${formatAge(latestWeatherObs > 0 ? new Date(latestWeatherObs).toISOString() : null, now)}${online && weatherStale && snapshot.stations.length > 0 ? " · stale" : ""}`}</small>
              </span>
              <span className={`freshness-chip ${isConnectingWithoutSnapshot ? "connecting" : trainDisplayStatus}`}>
                <i aria-hidden="true" /><b>Rail provider</b><small>{isConnectingWithoutSnapshot ? "Connecting…" : `Provider: ${statusText(trainDisplayStatus)}${!online ? " (offline)" : ""} · last seen at refresh ${formatAge(snapshot.sourceProvenance?.trains.latestObservedAt, now)}${online && transitStale && snapshot.trains.length > 0 ? " · stale" : ""}`}</small>
              </span>
              <span className={`freshness-chip ${isConnectingWithoutSnapshot ? "connecting" : riverDisplayStatus}`}>
                <i aria-hidden="true" /><b>River provider</b><small>{isConnectingWithoutSnapshot ? "Connecting…" : `Provider: ${statusText(riverDisplayStatus)}${!online ? " (offline)" : ""}${snapshot.sourceProvenance?.rivers.fallback ? ` · temporary ${snapshot.sourceProvenance.rivers.fallback} path` : ""} · observed ${formatAge(snapshot.sourceProvenance?.rivers.latestObservedAt, now)}${online && riverDataStale && snapshot.rivers.length > 0 ? " · stale" : ""}`}</small>
              </span>
            </div>
          </details>
        </>
      )}
    </div>
  );
}
