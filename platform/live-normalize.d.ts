import type { AirQualityReading, GridReading, RadarFrame } from "../lib/types";

export const EIRGRID_BODY_LIMIT: number;
export const EIRGRID_HISTORY_BODY_LIMIT: number;
export function numeric(value: unknown): number | null;
export function haversineKm(
  first: { latitude: number; longitude: number },
  second: { latitude: number; longitude: number }
): number;
export function addEstimatedSpeeds<T extends {
  id: string;
  latitude: number;
  longitude: number;
  observedAt: string;
  speedKmh?: number | null;
  speedSource?: "reported" | "calculated" | null;
}>(
  current: T[],
  previous: T[],
  options?: number | {
    maximumKmh?: number;
    maximumIntervalMinutes?: number;
    clearUnusable?: boolean;
  }
): T[];
export function webMercatorToLonLat(x: number, y: number): { longitude: number; latitude: number };
export function eeaTimestamp(value: unknown): string;
export function europeanAqiScore(reading: {
  pm25?: number | null;
  pm10?: number | null;
  nitrogenDioxide?: number | null;
  ozone?: number | null;
}): number | null;
export const MEASURED_AIR_POLLUTANTS: ReadonlyArray<readonly [string, string]>;
export function measuredAirStamp(now?: number): string;
export function measuredAirUrl(pollutant: string, stamp: string): string;
export function parseMeasuredAirStations(
  responses: Array<readonly [string, string]>
): Array<AirQualityReading & { source: "measured" }>;
export function weatherBuoyQuery(now?: number): { since: string; query: string; url: string };
export function parseWeatherBuoyRows(
  rows: unknown,
  now?: number,
  maxAgeMs?: number
): Array<{
  id: string;
  name: string;
  kind: "weather-buoy";
  longitude: number;
  latitude: number;
  observedAt: string;
  windSpeedKnots: number | null;
  waveHeight: number | null;
  wavePeriod: number | null;
  seaTemperature: number | null;
}>;
export type CoastalMarineSource = {
  dataset: string;
  name: string;
  variables: string[];
  map: (row: unknown[]) => {
    observedAt: string;
    latitude: number;
    longitude: number;
    windSpeedKnots: number | null;
    waveHeight: number | null;
    wavePeriod: number | null;
    seaTemperature: number | null;
  };
};
export const COASTAL_MARINE_SOURCES: readonly CoastalMarineSource[];
export function parseCoastalObservatoryRow(
  source: CoastalMarineSource,
  row: unknown[] | undefined,
  now?: number,
  maxAgeMs?: number
): {
  id: string;
  name: string;
  kind: "coastal-observatory";
  observedAt: string;
  latitude: number;
  longitude: number;
  windSpeedKnots: number | null;
  waveHeight: number | null;
  wavePeriod: number | null;
  seaTemperature: number | null;
} | null;
export function irishGridToLonLat(east: number, north: number): { latitude: number; longitude: number };
export function normalizeRadarFrames(rows: unknown): RadarFrame[];
export function eirGridDublinHourWindow(now?: number): { dateFrom: string; dateTo: string };
export type GridRequestInit = RequestInit & {
  next?: { revalidate?: number };
  cf?: Record<string, unknown>;
};
export type GridFetchOptions = {
  maximumBytes?: number;
  requestInit?: (chartType: string) => GridRequestInit;
};
export function eirGridChartUrl(chartType: string, areas: string, now?: number): URL;
export function fetchGridRows(
  chartType: string,
  areas: string,
  fetcher?: typeof fetch,
  now?: number,
  options?: GridFetchOptions
): Promise<unknown[]>;
export function fetchGrid(
  fetcher?: typeof fetch,
  now?: number,
  options?: GridFetchOptions
): Promise<{ reading: GridReading | null; status: "live" | "partial" | "unavailable" }>;
export function tideQueryWindow(now?: number): { since: string; until: string };
export function classifyTideTrend(
  samples: Array<{ observedAt: string; waterLevel: unknown }>
): "rising" | "falling" | "steady" | "unknown";
