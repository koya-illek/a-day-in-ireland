export const HISTORY_SOURCE_KEYS: readonly string[];
export function eirGridDublinHourWindow(now?: number): { dateFrom: string; dateTo: string };

export type HistorySourceEnvelope = {
  status: string;
  fetchedAt: string;
  latestObservedAt: string | null;
  itemCount: number | null;
  errorCode: string | null;
  data: unknown;
};

export type HistorySourceGap = {
  source: string;
  scope: string;
  reason: string;
  detail: string;
};

export type HistorySourceResult = {
  envelope: HistorySourceEnvelope;
  gaps: HistorySourceGap[];
};

export function collectWeather(fetcher: typeof fetch, now: number): Promise<HistorySourceResult>;
export function collectWarnings(fetcher: typeof fetch, now: number): Promise<HistorySourceResult>;
export function collectMarine(fetcher: typeof fetch, now: number): Promise<HistorySourceResult>;
export function collectGridShard(fetcher: typeof fetch, now: number, shard: string): Promise<HistorySourceResult>;
export function mergeGridShards(shards: HistorySourceResult[], now: number): HistorySourceResult;
export function collectGrid(fetcher: typeof fetch, now: number): Promise<HistorySourceResult>;
export function collectModelledAir(fetcher: typeof fetch, now: number): Promise<HistorySourceResult>;
export function collectTides(fetcher: typeof fetch, now: number): Promise<HistorySourceResult>;
export function collectBathing(
  fetcher: typeof fetch,
  now: number,
  compactLocations?: unknown
): Promise<HistorySourceResult>;
export function collectEarthquakes(fetcher: typeof fetch, now: number): Promise<HistorySourceResult>;
export function summarizeTransit(vehicles: unknown, status: string, capturedAt: string): unknown | null;
export function collectScopedSources(
  fetcher?: typeof fetch,
  now?: number
): Promise<{ sources: Record<string, HistorySourceEnvelope>; gaps: HistorySourceGap[] }>;
