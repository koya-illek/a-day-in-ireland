import type {
  BathingAlert,
  ContextSourceStatus,
  GridReading,
  OfficialForecast,
  RadarFrame,
  RiverReading,
  SatelliteFrame,
  SolarReading,
  TransitVehicle,
  TrainPosition,
  WeatherWarning
} from "../lib/types";

export {
  assessMetForecast,
  fetchMetForecast,
  fetchSolarDay,
  findSolarDay,
  normalizeMetForecast,
  normalizeSolarYear,
  selectForecastPeriod
} from "./sky-source.js";
export {
  addEstimatedSpeeds,
  classifyTideTrend,
  eirGridDublinHourWindow,
  fetchGrid,
  fetchGridRows,
  irishGridToLonLat,
  normalizeRadarFrames,
  tideQueryWindow,
  EIRGRID_BODY_LIMIT
} from "./live-normalize.js";

export const COORDINATOR_RAW_BODY_LIMIT: number;
export function fetchTrains(): Promise<TrainPosition[]>;
export function normalizeWeatherWarnings(
  rows: unknown[],
  now?: number
): WeatherWarning[];
export function acquireRiverRaw(
  env: unknown,
  fetcher?: typeof fetch
): Promise<unknown>;
export function normalizeRiverRaw(raw: unknown, captureNow?: number): unknown;
export function fetchRiversResult(
  env: unknown,
  fetcher?: typeof fetch,
  captureNow?: number
): Promise<{ rivers: RiverReading[]; provenance: unknown; status?: string }>;
export function fetchRivers(env: unknown): Promise<RiverReading[]>;
export function fetchMarine(): Promise<unknown>;
export function fetchAirQuality(): Promise<unknown>;
export function fetchTides(): Promise<unknown>;
export function fetchBathingAlerts(): Promise<{ alerts: BathingAlert[]; status: string }>;
export function satelliteTileTemplate(date: string): string;
export function probeSatelliteDate(date: string, fetcher?: typeof fetch): Promise<boolean>;
export function resolveSatelliteAvailability(options?: {
  now?: number;
  fetcher?: typeof fetch;
}): Promise<{ advertisedDate: string | null; startDate: string; cacheKey: string }>;
export function findLatestSatelliteFrame(options?: {
  now?: number;
  fetcher?: typeof fetch;
  maximumLookbackDays?: number;
  startDate?: string;
}): Promise<SatelliteFrame>;
export function createSatelliteAvailabilityResolver(options?: {
  clock?: () => number;
  fetcher?: typeof fetch;
  resolveAvailability?: typeof resolveSatelliteAvailability;
  discoverFrame?: typeof findLatestSatelliteFrame;
  maximumLookbackDays?: number;
  successCacheMs?: number;
  failureCacheMs?: number;
}): () => Promise<SatelliteFrame>;
export function acquireTransitRaw(
  env: { NTA_API_KEY?: string },
  fetcher?: typeof fetch
): Promise<unknown>;
export function normalizeTransitEntities(entities: unknown, now?: number): TransitVehicle[];
export function fetchTransit(
  env: { NTA_API_KEY?: string },
  fetcher?: typeof fetch,
  captureNow?: number
): Promise<{
  vehicles?: TransitVehicle[];
  status: ContextSourceStatus;
  truncated?: boolean;
  sourceEntityCount?: number;
}>;

declare const worker: { fetch(request: Request, env: unknown): Promise<Response> };
export default worker;

export type { GridReading, OfficialForecast, RadarFrame, SolarReading };
