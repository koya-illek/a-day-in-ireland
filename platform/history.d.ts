export function emptyHistoryPayload(timestamp: number): {
  schemaVersion: number;
  capturedAt: string;
  resolutionMinutes: number;
  snapshot: null;
  movementSummary: { rail: null; transit: null };
  periodSummary: null;
  gaps: Array<{ source: string; scope: string; reason: string; detail: string }>;
};

export function buildHistoryCapture(options: {
  env: { NTA_API_KEY?: string };
  capturedAtMs: number;
  fetcher?: typeof fetch;
  loadLiving: (capturedAtMs: number) => unknown;
  loadTransit: (capturedAtMs: number) => unknown;
  scoped?: unknown;
}): Promise<{
  sources: Record<string, unknown>;
  sourceStatus: Record<string, unknown>;
  payload: unknown;
  gaps: unknown[];
}>;

export function captureHistory(
  env: { HISTORY_DB?: unknown },
  scheduledTime: number,
  loaders: unknown
): Promise<{ skipped: boolean; reason?: string; bucketStartMs?: number; [key: string]: unknown }>;

export function maintainHistory(
  env: { HISTORY_DB?: unknown },
  scheduledTime: number
): Promise<{ skipped: boolean; hourStart?: number }>;

export function handleHistoryRequest(
  request: Request,
  env: { HISTORY_DB?: unknown },
  now?: number
): Promise<Response>;
