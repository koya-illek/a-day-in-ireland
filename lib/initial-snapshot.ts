import type { LiveSnapshot, ProviderProvenance } from "./types";

const unavailableProvenance = (
  provider: string,
  endpoint: string,
  generatedAt: string
): ProviderProvenance => ({
  provider,
  endpoint,
  status: "unavailable",
  fetchedAt: generatedAt,
  latestObservedAt: null,
  fallback: null
});

export function createInitialSnapshot(generatedAt = new Date().toISOString()): LiveSnapshot {
  return {
    generatedAt,
    lastSuccessAt: null,
    sourceStatus: "fallback",
    stations: [],
    warnings: [],
    marine: [],
    trains: [],
    rivers: [],
    radar: [],
    grid: null,
    airQuality: [],
    aurora: null,
    tides: [],
    bathingAlerts: [],
    iss: null,
    issTle: null,
    satellite: null,
    earthquakes: [],
    transit: [],
    transitStatus: "unavailable",
    sourceProvenance: {
      trains: unavailableProvenance(
        "Irish Rail",
        "https://api.irishrail.ie/realtime/realtime.asmx/getCurrentTrainsXML",
        generatedAt
      ),
      rivers: unavailableProvenance(
        "OPW waterlevel.ie",
        "https://waterlevel.ie/geojson/latest/",
        generatedAt
      )
    },
    contextStatus: {
      marine: "unavailable",
      radar: "unavailable",
      grid: "unavailable",
      measuredAir: "unavailable",
      modelledAir: "unavailable",
      aurora: "unavailable",
      tides: "unavailable",
      bathing: "unavailable",
      satellite: "unavailable",
      earthquakes: "unavailable",
      iss: "unavailable",
      warnings: "unavailable"
    },
    summary: {
      warmest: null,
      wettest: null,
      windiest: null,
      reporting: 0,
      runningTrains: 0,
      riverStations: 0
    },
    timeline: []
  };
}
