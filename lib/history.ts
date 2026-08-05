import type { LiveSnapshot } from "./types";

export type HistoryGap = {
  source: string;
  scope: string;
  reason: string;
  detail: string;
};

export type HistoryMovementSummary = {
  rail: { running: number; total: number } | null;
  transit: { vehicles: number; routes: number } | null;
};

export type HistoryPeriodSummary = {
  basis: "retained-hourly-representatives";
  representedSamples: number;
  weather: {
    highestTemperatureC: number | null;
    highestWindSpeedKmh: number | null;
    highestStationRainfallMm: number | null;
  };
  grid: {
    minWindSharePercent: number | null;
    maxWindSharePercent: number | null;
    minDemandMW: number | null;
    maxDemandMW: number | null;
  };
  transit: {
    maxVehicles: number | null;
    maxRoutes: number | null;
  };
  distinctCounts: {
    officialWarnings: number | null;
    bathingAlerts: number | null;
    earthquakes: number | null;
  };
};

export type HistoryRange = {
  availableFrom: string | null;
  availableTo: string | null;
  resolutionMinutes: number;
  snapshotCount: number | null;
  resolutions: Array<{
    name: string;
    resolutionMinutes: number;
    availableFrom: string | null;
    availableTo: string | null;
  }>;
};

export type HistoryEnvelope = HistoryRange & {
  schemaVersion: number;
  requestedAt: string;
  resolvedAt: string | null;
  periodStartAt: string | null;
  periodEndAt: string | null;
  previousAt: string | null;
  nextAt: string | null;
  snapshot: LiveSnapshot | null;
  movementSummary: HistoryMovementSummary;
  periodSummary: HistoryPeriodSummary | null;
  gaps: HistoryGap[];
};

export function isUsableHistoryEnvelope(envelope: HistoryEnvelope | null | undefined) {
  return Boolean(envelope?.resolvedAt && (
    envelope.snapshot ||
    (envelope.resolutionMinutes >= 1440 &&
      envelope.periodSummary?.basis === "retained-hourly-representatives" &&
      envelope.periodSummary.representedSamples > 0)
  ));
}

const RFC3339_WITH_ZONE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/i;

const validIso = (value: unknown): string | null => {
  if (typeof value !== "string" || !RFC3339_WITH_ZONE.test(value.trim())) return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
};

export function canonicalHistoryAt(value: unknown): string | null {
  return validIso(value);
}

const finiteNonNegative = (value: unknown): number | null => {
  if (value === null || value === undefined || (typeof value === "string" && !value.trim())) return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
};

const finiteNumber = (value: unknown): number | null => {
  if (value === null || value === undefined || (typeof value === "string" && !value.trim())) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};

const normalizeRange = (value: unknown): HistoryRange => {
  const record = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const nested = record.range && typeof record.range === "object"
    ? record.range as Record<string, unknown>
    : record;
  const resolutions = Array.isArray(nested.resolutions)
    ? nested.resolutions.flatMap((value) => {
        if (!value || typeof value !== "object") return [];
        const resolution = value as Record<string, unknown>;
        const resolutionMinutes = finiteNonNegative(resolution.resolutionMinutes ?? resolution.resolution_minutes);
        if (!resolutionMinutes) return [];
        return [{
          name: String(resolution.name ?? `${resolutionMinutes}-minute`),
          resolutionMinutes,
          availableFrom: validIso(resolution.availableFrom ?? resolution.from),
          availableTo: validIso(resolution.availableTo ?? resolution.to)
        }];
      })
    : [];
  const availableFrom = validIso(nested.availableFrom ?? nested.from);
  const availableTo = validIso(nested.availableTo ?? nested.to);
  const availableToMs = Date.parse(availableTo ?? "");
  const matchingResolutions = resolutions.filter((resolution) => {
    if (!Number.isFinite(availableToMs)) return true;
    const from = Date.parse(resolution.availableFrom ?? "");
    const to = Date.parse(resolution.availableTo ?? "");
    return (!Number.isFinite(from) || from <= availableToMs) && (!Number.isFinite(to) || to >= availableToMs);
  });
  const finestResolution = [...(matchingResolutions.length ? matchingResolutions : resolutions)]
    .sort((first, second) => first.resolutionMinutes - second.resolutionMinutes)[0]?.resolutionMinutes;
  return {
    availableFrom,
    availableTo,
    resolutionMinutes: finiteNonNegative(nested.resolutionMinutes ?? nested.resolution_minutes) ||
      finestResolution || 15,
    snapshotCount: finiteNonNegative(nested.snapshotCount ?? nested.count),
    resolutions
  };
};

const normalizeGap = (value: unknown): HistoryGap | null => {
  if (!value || typeof value !== "object") return null;
  const gap = value as Record<string, unknown>;
  const scope = typeof gap.scope === "string" && gap.scope.trim() ? gap.scope.trim() : "entire-source";
  const reason = typeof gap.reason === "string" && gap.reason.trim() ? gap.reason.trim() : "not-collected";
  const source = String(gap.source ?? "Unknown source").trim() || "Unknown source";
  const detail = String(gap.detail ?? `${source} is unavailable for this stored snapshot.`).trim();
  return { source, scope, reason, detail };
};

const summaryPart = (value: unknown, fields: [string, string]) => {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const first = finiteNonNegative(record[fields[0]]);
  const second = finiteNonNegative(record[fields[1]]);
  return first === null || second === null ? null : [first, second] as const;
};

const transitSummary = (value: unknown) => {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const vehicles = finiteNonNegative(record.vehicles ?? record.total);
  let routes = finiteNonNegative(record.routes);
  if (routes === null && Array.isArray(record.byRoute)) routes = record.byRoute.length;
  if (routes === null && record.byRoute && typeof record.byRoute === "object") {
    routes = Object.keys(record.byRoute as Record<string, unknown>).length;
  }
  return vehicles === null || routes === null ? null : { vehicles, routes };
};

const periodSummary = (value: unknown): HistoryPeriodSummary | null => {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (record.basis !== "retained-hourly-representatives") return null;
  const representedSamples = finiteNonNegative(record.representedSamples);
  if (representedSamples === null || representedSamples <= 0) return null;
  const weather = record.weather && typeof record.weather === "object"
    ? record.weather as Record<string, unknown>
    : {};
  const grid = record.grid && typeof record.grid === "object"
    ? record.grid as Record<string, unknown>
    : {};
  const transit = record.transit && typeof record.transit === "object"
    ? record.transit as Record<string, unknown>
    : {};
  const counts = record.distinctCounts && typeof record.distinctCounts === "object"
    ? record.distinctCounts as Record<string, unknown>
    : {};
  return {
    basis: "retained-hourly-representatives",
    representedSamples,
    weather: {
      highestTemperatureC: finiteNumber(weather.highestTemperatureC),
      highestWindSpeedKmh: finiteNonNegative(weather.highestWindSpeedKmh),
      highestStationRainfallMm: finiteNonNegative(weather.highestStationRainfallMm)
    },
    grid: {
      minWindSharePercent: finiteNonNegative(grid.minWindSharePercent),
      maxWindSharePercent: finiteNonNegative(grid.maxWindSharePercent),
      minDemandMW: finiteNonNegative(grid.minDemandMW),
      maxDemandMW: finiteNonNegative(grid.maxDemandMW)
    },
    transit: {
      maxVehicles: finiteNonNegative(transit.maxVehicles),
      maxRoutes: finiteNonNegative(transit.maxRoutes)
    },
    distinctCounts: {
      officialWarnings: finiteNonNegative(counts.officialWarnings),
      bathingAlerts: finiteNonNegative(counts.bathingAlerts),
      earthquakes: finiteNonNegative(counts.earthquakes)
    }
  };
};

export function normalizeHistoryRange(value: unknown): HistoryRange {
  return normalizeRange(value);
}

export function normalizeHistoryEnvelope(value: unknown, fallbackRequestedAt: string): HistoryEnvelope {
  if (!value || typeof value !== "object") throw new Error("History response is not an object");
  const record = value as Record<string, unknown>;
  const range = normalizeRange(record);
  const requestedAt = validIso(record.requestedAt) ?? canonicalHistoryAt(fallbackRequestedAt);
  if (!requestedAt) throw new Error("History response has no valid requested time");
  const resolvedAt = validIso(record.resolvedAt ?? record.capturedAt ?? record.snapshotAt);
  const periodStartAt = validIso(record.periodStartAt) ?? resolvedAt;
  const periodEndAt = validIso(record.periodEndAt);
  const movement = record.movementSummary && typeof record.movementSummary === "object"
    ? record.movementSummary as Record<string, unknown>
    : record.summaries && typeof record.summaries === "object"
      ? (record.summaries as Record<string, unknown>).movement as Record<string, unknown> | undefined ?? {}
      : {};
  const rail = summaryPart(movement.rail, ["running", "total"]);
  const transit = transitSummary(movement.transit);
  const snapshot = record.snapshot && typeof record.snapshot === "object"
    ? record.snapshot as LiveSnapshot
    : null;
  const gaps = Array.isArray(record.gaps)
    ? record.gaps.map(normalizeGap).filter((gap): gap is HistoryGap => gap !== null)
    : [];
  return {
    ...range,
    schemaVersion: finiteNonNegative(record.schemaVersion) ?? 1,
    requestedAt,
    resolvedAt,
    periodStartAt,
    periodEndAt,
    previousAt: validIso(record.previousAt),
    nextAt: validIso(record.nextAt),
    snapshot,
    movementSummary: {
      rail: rail ? { running: rail[0], total: rail[1] } : null,
      transit
    },
    periodSummary: periodSummary(record.periodSummary),
    gaps
  };
}

async function fetchJson(url: string, signal?: AbortSignal) {
  const response = await fetch(url, { cache: "no-store", signal });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(detail || `History service returned ${response.status}`);
  }
  return response.json() as Promise<unknown>;
}

export async function fetchHistoryRange(signal?: AbortSignal): Promise<HistoryRange> {
  return normalizeHistoryRange(await fetchJson("/api/history/range", signal));
}

export async function fetchHistorySnapshot(at: string, signal?: AbortSignal): Promise<HistoryEnvelope> {
  const canonical = canonicalHistoryAt(at);
  if (!canonical) throw new RangeError("Historical time must be an RFC3339 instant with a timezone");
  const body = await fetchJson(`/api/history?at=${encodeURIComponent(canonical)}`, signal);
  return normalizeHistoryEnvelope(body, canonical);
}

const irelandPartsFormatter = new Intl.DateTimeFormat("en-IE", {
  timeZone: "Europe/Dublin",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23"
});

const irelandWallParts = (date: Date) => Object.fromEntries(
  irelandPartsFormatter.formatToParts(date)
    .filter((part) => part.type !== "literal")
    .map((part) => [part.type, part.value])
) as Record<string, string>;

export function irelandInputParts(value: string | Date) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) return { date: "", time: "" };
  const parts = irelandWallParts(date);
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    time: `${parts.hour}:${parts.minute}`
  };
}

export function irelandWallTimeCandidates(dateValue: string, timeValue: string): string[] {
  const dateMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateValue);
  const timeMatch = /^(\d{2}):(\d{2})$/.exec(timeValue);
  if (!dateMatch || !timeMatch) return [];
  const fields = [...dateMatch.slice(1), ...timeMatch.slice(1)].map(Number);
  const [year, month, day, hour, minute] = fields;
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day) ||
      !Number.isInteger(hour) || !Number.isInteger(minute) || hour > 23 || minute > 59) return [];
  const wallUtc = Date.UTC(year, month - 1, day, hour, minute);
  const candidates = new Set<string>();
  for (let offsetHours = -2; offsetHours <= 2; offsetHours += 1) {
    const candidate = new Date(wallUtc + offsetHours * 60 * 60_000);
    const parts = irelandWallParts(candidate);
    if (Number(parts.year) === year && Number(parts.month) === month && Number(parts.day) === day &&
        Number(parts.hour) === hour && Number(parts.minute) === minute) {
      candidates.add(candidate.toISOString());
    }
  }
  return [...candidates].sort((first, second) => Date.parse(first) - Date.parse(second));
}

export function formatIrelandHistoryTime(value: string | Date, includeZone = true) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) return "Unavailable";
  return new Intl.DateTimeFormat("en-IE", {
    timeZone: "Europe/Dublin",
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    ...(includeZone ? { timeZoneName: "short" as const } : {})
  }).format(date);
}
