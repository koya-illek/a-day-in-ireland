import type { OfficialForecast, SolarReading } from "../lib/types";

export const SUNRISE_SUNSET_ENDPOINT: string;
export const SUNRISE_SUNSET_ATTRIBUTION_URL: string;
export const SUNRISE_SUNSET_ATTRIBUTION: string;
export const IRELAND_CENTRE: { latitude: number; longitude: number };
export const IRELAND_TIME_ZONE: string;
export const SOLAR_BODY_LIMIT: number;
export const SOLAR_WINDOW_CACHE_MS: number;
export const MET_FORECAST_ENDPOINT: string;
export const MET_FORECAST_DATASET_URL: string;
export const MET_FORECAST_ATTRIBUTION: string;
export const MET_FORECAST_BODY_LIMIT: number;

export const normalizeSolarYear: (body: unknown, options?: { year?: number; now?: number }) => SolarReading[];
export const findSolarDay: (days: SolarReading[], dateOrTimestamp?: string | number) => SolarReading | null;
export const fetchSolarWindow: (options?: { year?: number; now?: number; fetcher?: typeof fetch; date?: string }) => Promise<{ year: number; days: SolarReading[]; fetchedAt: number; bodyBytes: number; cached: boolean }>;
export const fetchSolarDay: (options?: { now?: number; fetcher?: typeof fetch }) => Promise<{ reading: SolarReading; status: "live"; fetchedAt: number; days: SolarReading[] }>;
export const fetchMetForecast: (options?: { now?: number; fetcher?: typeof fetch }) => Promise<{ forecast: OfficialForecast; status: "live"; fetchedAt: number; bodyBytes: number; cached?: boolean }>;
export const resetMetForecastCache: () => void;
export const normalizeMetForecast: (body: unknown, now?: number) => OfficialForecast | null;
export const assessMetForecast: (body: unknown, now?: number) => { forecast: OfficialForecast | null; status: "live" | "stale" | "unavailable"; reason: string | null };
export const selectForecastPeriod: (forecast: OfficialForecast | null, now?: number) => { period: string; copy: string } | null;
export const acceptClientSolar: (value: unknown, now?: number) => SolarReading | null;
export const acceptClientForecast: (value: unknown, now?: number) => OfficialForecast | null;
export const resetSolarCache: () => void;
