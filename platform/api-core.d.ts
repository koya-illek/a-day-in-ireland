import type {
  BathingAlert,
  ContextSourceStatus,
  RiverReading,
  SatelliteFrame,
  TransitVehicle,
  TrainPosition,
  WeatherWarning
} from "../lib/types";

export const COORDINATOR_RAW_BODY_LIMIT: number;

export function methodResponse(request: Request): Response;
export function fetchTrains(): Promise<TrainPosition[]>;
export function dedupedFetchTrains(): Promise<TrainPosition[]>;
export function normalizeWeatherWarnings(rows: unknown[], now?: number): WeatherWarning[];
export function acquireRiverRaw(env: unknown, fetcher?: typeof fetch): Promise<unknown>;
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

export function livingResponse(loaders: {
  loadTrains: () => Promise<TrainPosition[]>;
  loadRivers: () => Promise<{
    rivers: RiverReading[];
    status: ContextSourceStatus;
    provenance: unknown;
  }>;
}): Promise<Response>;

export const CONTEXT_SOURCE_POLICIES: Readonly<Record<string, {
  ttlMs: number;
  jitterMs: number;
  staleIfErrorMs: number;
  circuitBaseMs: number;
  shareInFlight?: boolean;
}>>;
export function resetContextRefreshState(): void;
export function currentContexts(env: unknown): Promise<Response>;
export function transitResponse(value: { vehicles: unknown[]; status: string }): Response;
export function resolveTransit(env: {
  NTA_API_KEY?: string;
  NTA_FEED?: { getByName(name: string): { fetch(url: string): Promise<Response> } };
}): Promise<{ vehicles: TransitVehicle[]; status: ContextSourceStatus }>;
export function transitApiRoute(env: unknown): Promise<Response>;
export function contextsApiRoute(env: unknown): Promise<Response>;
export function apiErrorResponse(message: string): Response;
export function healthResponse(env: unknown, provenance?: unknown): Response;
export function handleApiRequest(
  request: Request,
  env: unknown,
  adapters: {
    health?(env: unknown): Response | Promise<Response>;
    living(env: unknown): Response | Promise<Response>;
    history?(request: Request, env: unknown): Response | Promise<Response>;
  }
): Promise<Response | undefined>;
