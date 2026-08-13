import type { GridReading, ProviderProvenance, RiverReading } from "../lib/types";

export const RIVER_PROVIDER: string;
export const RIVER_ENDPOINT: string;
export const RIVER_FRESHNESS_MS: number;
export function decodeHtmlEntities(value: unknown): string;
export function normalizeOfficialNotices(rows: unknown[], now?: number): Array<Record<string, unknown>>;
export function normalizeOfficialWeatherWarnings(rows: unknown[], now?: number, horizonMs?: number): Array<{
  id: string;
  capId: string;
  type: string;
  severity: string;
  certainty: string;
  regions: string[];
  status: string;
  issued: string;
  updated: string;
  level: string;
  headline: string;
  description: string;
  onset: string;
  expiry: string;
}>;
export function warningTiming(
  warning: { onset?: string; expiry?: string },
  now?: number,
  horizonMs?: number
): "active" | "upcoming" | "future" | "expired";
export function sortOfficialWeatherWarnings<T extends { id?: string; capId?: string; type?: string; severity?: string; level?: string; onset?: string; expiry?: string }>(warnings: T[], now?: number): T[];
export function isActivityRelevantWeatherWarning(warning: { type?: string; headline?: string; description?: string }): boolean;
export function normalizeBathingAlerts(rows: unknown[], now?: number): unknown[];
export function normalizeProviderTimestamp(value: unknown): string | null;
export function normalizeRiverReadings(readings: unknown[], now?: number): RiverReading[];
export function parseRiverGeoJson(body: unknown, now?: number): RiverReading[];
export function isIrelandCoordinate(latitude: unknown, longitude: unknown): boolean;
export function parseIrelandLocalTimestamp(date: string, time: string, notAfter?: number | null): string | null;
export function parseEirGridLocalTimestamp(value: string, notAfter?: number | null): string | null;
export function readBoundedResponseBytes(response: Response, label: string, maximumBytes: number): Promise<Uint8Array>;
export function readBoundedJsonResponse(
  response: Response,
  label: string,
  maximumBytes: number
): Promise<{ body: unknown; bodyBytes: number }>;
export function readBoundedTextResponse(response: Response, label: string, maximumBytes: number): Promise<string>;
export function latestObservedAt(readings: Array<{ observedAt: string }>): string | null;
export function latestEirGridValue(
  rows: unknown[],
  field: string,
  now?: number,
  maxAgeMs?: number
): { value: number; observedAt: string; timestamp: number } | null;
export function buildEirGridReading(values?: {
  demand?: { value: number; observedAt: string } | null;
  generation?: { value: number; observedAt: string } | null;
  wind?: { value: number; observedAt: string } | null;
  carbonIntensity?: { value: number; observedAt: string } | null;
  carbonEmissions?: { value: number; observedAt: string } | null;
  frequency?: { value: number; observedAt: string } | null;
  interconnection?: { value: number; observedAt: string } | null;
}): GridReading | null;
export function makeSourceProvenance(options: {
  provider: string;
  endpoint: string;
  status: ProviderProvenance["status"];
  fetchedAt?: string;
  readings?: RiverReading[];
  fallback?: string | null;
}): ProviderProvenance;
export function makeRiverProvenance(options: {
  status: ProviderProvenance["status"];
  fetchedAt?: string;
  readings?: RiverReading[];
  fallback?: string | null;
}): ProviderProvenance;
export const IRISH_RAIL_PROVIDER: string;
export const IRISH_RAIL_ENDPOINT: string;
export function buildLivingPayload(options?: {
  trains?: unknown[];
  rivers?: RiverReading[];
  riverProvenance?: ProviderProvenance | null;
  riverStatus?: ProviderProvenance["status"] | null;
  fetchedAt?: string;
}): {
  generatedAt: string;
  trains: unknown[];
  rivers: RiverReading[];
  sourceStatus: {
    trains: "live" | "unavailable";
    rivers: ProviderProvenance["status"];
  };
  sourceProvenance: {
    trains: ProviderProvenance;
    rivers: ProviderProvenance;
  };
};
