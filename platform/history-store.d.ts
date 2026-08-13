export const HISTORY_SCHEMA_VERSION: 1;
export const HISTORY_CODEC: "gzip-json-v1";
export const RAW_RESOLUTION_MINUTES: 15;
export const HOUR_RESOLUTION_MINUTES: 60;
export const DAY_RESOLUTION_MINUTES: 1440;
export const MAX_COMPRESSED_ROW_BYTES: number;

export function canonicalJson(value: unknown): string;
export function gzipJson(value: unknown): Promise<{
  json: string;
  compressed: Uint8Array;
  uncompressedBytes: number;
}>;
export function gunzipJson(value: unknown): Promise<unknown>;
export function sha256Hex(value: string | ArrayBuffer | ArrayBufferView | number[]): Promise<string>;
export function rawBucketStart(timestamp: number): number;
export function hourBucketStart(timestamp: number): number;
export function previousDublinDayBounds(timestamp: number): { start: number; end: number };
export function isDublinHour(timestamp: number, hour: number): boolean;

export type HistorySnapshotRow = {
  resolutionMinutes: number;
  bucketStartMs: number;
  periodEndMs: number | null;
  representativeAtMs: number | null;
  collectedAtMs: number;
  codec: string;
  payload: Uint8Array;
  payloadBytes: number;
  uncompressedBytes: number;
  contentSha256: string;
  expectedSamples: number;
  collectedSamples: number;
  sourceStatusJson: string;
  gapsJson: string;
};

export function encodeSnapshotRow(input: {
  resolutionMinutes: number;
  bucketStartMs: number;
  periodEndMs?: number | null;
  representativeAtMs?: number | null;
  collectedAtMs: number;
  payload: unknown;
  expectedSamples: number;
  collectedSamples: number;
  sourceStatus: unknown;
  gaps: unknown;
}): Promise<HistorySnapshotRow>;

export function writeSnapshot(
  db: unknown,
  row: HistorySnapshotRow,
  options?: { replace?: boolean }
): Promise<unknown>;

export function historyRange(db: unknown): Promise<{
  schemaVersion: number;
  availableFrom: string | null;
  availableTo: string | null;
  resolutionMinutes: number | null;
  resolutions: Array<{
    name: string;
    resolutionMinutes: number;
    availableFrom: string;
    availableTo: string;
    snapshotCount: number;
  }>;
  snapshotCount: number;
}>;

export function resolveHistory(db: unknown, requestedAt: number, now?: number): Promise<unknown>;
export function mergeSourceStatus(
  rows: Array<{ source_status_json: string }>,
  sourceKeys: string[],
  expectedSamples: number
): Record<string, {
  status: string;
  expectedSamples: number;
  collectedSamples: number;
  counts: Record<string, number>;
}>;
export function summarizeDailyRepresentatives(payloads: unknown[]): unknown | null;
export function rollupPeriod(db: unknown, options: {
  fromResolutionMinutes: number;
  resolutionMinutes: number;
  startMs: number;
  endMs: number;
  expectedSamples: number;
  sourceKeys: string[];
  emptyPayload: (timestamp: number) => unknown;
  summaryOnly?: boolean;
}): Promise<HistorySnapshotRow>;
export function pruneHistory(db: unknown, now?: number): Promise<unknown>;
