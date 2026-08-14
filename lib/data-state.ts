import type { ContextSourceStatus, LiveSnapshot, ObservationSourceStatus } from "./types";
import { WEATHER_OBSERVATION_MAX_AGE_MS } from "./weather-stations";

export type ServiceDisplayState =
  | "connecting"
  | "refreshing"
  | "offline"
  | "cached"
  | "stale"
  | "unavailable"
  | "degraded"
  | "live";

const timestampIsCurrent = (value: string | null | undefined, maximumAgeMs: number, now: number) => {
  const timestamp = Date.parse(value ?? "");
  const age = now - timestamp;
  return Number.isFinite(timestamp) && age >= 0 && age <= maximumAgeMs;
};

const latestTimestamp = (items: Array<{ observedAt: string | null }>) => items
  .map((item) => item.observedAt)
  .filter((value): value is string => Boolean(value))
  .sort((first, second) => Date.parse(first) - Date.parse(second))
  .at(-1) ?? null;

const healthyServiceStatus = (status: ObservationSourceStatus | ContextSourceStatus) =>
  status === "live" || status === "partial" || status === "fallback";

const ignoredAggregateStatus = (status: ObservationSourceStatus | ContextSourceStatus) =>
  status === "unavailable" || status === "credential-required";

const providerStatuses = (snapshot: LiveSnapshot) => [
  snapshot.sourceStatus,
  snapshot.sourceProvenance?.trains.status ?? "unavailable",
  snapshot.sourceProvenance?.rivers.status ?? "unavailable",
  ...(snapshot.transitStatus === "credential-required" ? [] : [snapshot.transitStatus]),
  ...Object.values(snapshot.contextStatus)
] as Array<ObservationSourceStatus | ContextSourceStatus>;

export function getServiceDisplayState(
  snapshot: LiveSnapshot,
  options: { initialRefreshComplete: boolean; refreshing: boolean; online: boolean; now?: number }
): ServiceDisplayState {
  if (!options.online) return "offline";
  if (!options.initialRefreshComplete) return "connecting";
  if (options.refreshing) return "refreshing";

  const statuses = providerStatuses(snapshot);
  const hasData = Boolean(
    snapshot.stations.length || snapshot.trains.length || snapshot.rivers.length || snapshot.radar.length ||
    snapshot.grid || snapshot.airQuality.length || snapshot.marine.length || snapshot.tides.length ||
    snapshot.bathingAlerts.length || snapshot.satellite || snapshot.earthquakes.length || snapshot.iss ||
    snapshot.transit.length || snapshot.aurora || snapshot.solar || snapshot.forecast || snapshot.contextStatus.warnings === "live"
  );
  if (!hasData && statuses.every((status) => status === "unavailable" || status === "fallback")) {
    return "unavailable";
  }
  if (statuses.includes("stale")) return "cached";

  const now = options.now ?? Date.now();
  const staleObservation =
    (snapshot.stations.length > 0 && !timestampIsCurrent(
      latestTimestamp(snapshot.stations),
      WEATHER_OBSERVATION_MAX_AGE_MS,
      now
    )) ||
    (snapshot.trains.length > 0 && !timestampIsCurrent(
      snapshot.sourceProvenance?.trains.latestObservedAt,
      3 * 60_000,
      now
    )) ||
    (snapshot.rivers.length > 0 && !timestampIsCurrent(
      snapshot.sourceProvenance?.rivers.latestObservedAt,
      3 * 60 * 60_000,
      now
    ));
  if (staleObservation) return "stale";
  if (statuses.some((status) => !healthyServiceStatus(status) && !ignoredAggregateStatus(status))) {
    return "degraded";
  }
  return "live";
}

type SourceCheck = { label: string; current: boolean };

export function getSelectedSourceAssessment(
  snapshot: LiveSnapshot,
  selectedLayers: ReadonlySet<string>,
  now = Date.now()
) {
  const checks: SourceCheck[] = [];
  const add = (label: string, current: boolean) => {
    if (!checks.some((check) => check.label === label)) checks.push({ label, current });
  };
  const availableContext = (status: ContextSourceStatus) => status === "live" || status === "fallback";

  if (["weather", "rain", "wind"].some((layer) => selectedLayers.has(layer))) {
    add("weather observations", snapshot.sourceStatus === "live" && snapshot.stations.length > 0 &&
      timestampIsCurrent(latestTimestamp(snapshot.stations), WEATHER_OBSERVATION_MAX_AGE_MS, now));
  }
  if (selectedLayers.has("warnings")) add("official notices", snapshot.contextStatus.warnings === "live");
  if (selectedLayers.has("sea")) add("marine observations", availableContext(snapshot.contextStatus.marine) && snapshot.marine.length > 0);
  if (selectedLayers.has("trains")) add("rail positions", snapshot.sourceProvenance?.trains.status === "live" && snapshot.trains.length > 0 &&
    timestampIsCurrent(snapshot.sourceProvenance.trains.latestObservedAt, 3 * 60_000, now));
  if (selectedLayers.has("rivers")) add("river gauges", (snapshot.sourceProvenance?.rivers.status === "live" || snapshot.sourceProvenance?.rivers.status === "partial" || snapshot.sourceProvenance?.rivers.status === "fallback") && snapshot.rivers.length > 0 &&
    timestampIsCurrent(snapshot.sourceProvenance.rivers.latestObservedAt, 3 * 60 * 60_000, now));
  if (selectedLayers.has("radar")) add("rain radar", availableContext(snapshot.contextStatus.radar) && snapshot.radar.length > 0);
  if (selectedLayers.has("grid")) add("electricity grid", availableContext(snapshot.contextStatus.grid) && Boolean(snapshot.grid));
  if (selectedLayers.has("air")) {
    add("measured air quality", availableContext(snapshot.contextStatus.measuredAir) && snapshot.airQuality.some((reading) => reading.source === "measured"));
    add("modelled air quality", availableContext(snapshot.contextStatus.modelledAir) && snapshot.airQuality.some((reading) => reading.source === "modelled"));
  }
  if (selectedLayers.has("aurora")) add("aurora guidance", availableContext(snapshot.contextStatus.aurora) && Boolean(snapshot.aurora));
  if (selectedLayers.has("tides")) add("tide gauges", availableContext(snapshot.contextStatus.tides) && snapshot.tides.length > 0);
  if (selectedLayers.has("bathing")) add("bathing alerts", availableContext(snapshot.contextStatus.bathing));
  if (selectedLayers.has("iss")) add("ISS elements", availableContext(snapshot.contextStatus.iss) && Boolean(snapshot.iss));
  if (selectedLayers.has("satellite")) add("satellite imagery", availableContext(snapshot.contextStatus.satellite) && Boolean(snapshot.satellite));
  if (selectedLayers.has("earthquakes")) add("earthquake detections", availableContext(snapshot.contextStatus.earthquakes));
  if (selectedLayers.has("transit")) add("public-transport positions", ["live", "partial"].includes(snapshot.transitStatus) && snapshot.transit.length > 0);
  return {
    assessedSourceCount: checks.length,
    fullyAssessed: checks.length > 0 && checks.every((check) => check.current),
    unavailableSources: checks.filter((check) => !check.current).map((check) => check.label)
  };
}
