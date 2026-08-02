import type { StationReading } from "./types";

type StationDefinition = {
  id: string;
  name: string;
  csvName: string;
  latitude: number;
  longitude: number;
};

const splitCsvLine = (line: string) => {
  const cells: string[] = [];
  let current = "";
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (character === "\"") {
      if (quoted && line[index + 1] === "\"") {
        current += "\"";
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (character === "," && !quoted) {
      cells.push(current);
      current = "";
    } else {
      current += character;
    }
  }
  cells.push(current);
  return cells;
};

const nullableNumber = (value: string) => {
  const parsed = Number.parseFloat(value.trim());
  return Number.isFinite(parsed) ? parsed : null;
};

const dublinFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: "Europe/Dublin",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23"
});

const dublinParts = (timestamp: number) => {
  const parts = Object.fromEntries(
    dublinFormatter.formatToParts(new Date(timestamp)).map((part) => [part.type, part.value])
  );
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second)
  };
};

const dublinOffsetMinutes = (timestamp: number) => {
  const parts = dublinParts(timestamp);
  return (Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second) - timestamp) / 60_000;
};

const parseDublinWallTime = (
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number
) => {
  if (![year, month, day, hour, minute, second].every(Number.isInteger)) return null;
  if (year < 1000 || month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 59) return null;
  const wallTimestamp = Date.UTC(year, month - 1, day, hour, minute, second);
  const wallDate = new Date(wallTimestamp);
  if (
    wallDate.getUTCFullYear() !== year ||
    wallDate.getUTCMonth() !== month - 1 ||
    wallDate.getUTCDate() !== day ||
    wallDate.getUTCHours() !== hour ||
    wallDate.getUTCMinutes() !== minute ||
    wallDate.getUTCSeconds() !== second
  ) return null;

  const offsets = new Set([
    dublinOffsetMinutes(wallTimestamp - 86_400_000),
    dublinOffsetMinutes(wallTimestamp),
    dublinOffsetMinutes(wallTimestamp + 86_400_000)
  ]);
  const candidates = [...offsets]
    .map((offset) => wallTimestamp - offset * 60_000)
    .filter((candidate) => {
      const parts = dublinParts(candidate);
      return parts.year === year && parts.month === month && parts.day === day &&
        parts.hour === hour && parts.minute === minute && parts.second === second;
    })
    .sort((first, secondValue) => first - secondValue);
  return candidates.length ? new Date(candidates[0]).toISOString() : null;
};

export function parseIrelandLocalTimestamp(date: string, time: string): string | null {
  const dateMatch = /^(\d{2})-(\d{2})-(\d{4})$/.exec(String(date ?? "").trim());
  const timeMatch = /^(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(String(time ?? "").trim());
  if (!dateMatch || !timeMatch) return null;
  return parseDublinWallTime(
    Number(dateMatch[3]),
    Number(dateMatch[2]),
    Number(dateMatch[1]),
    Number(timeMatch[1]),
    Number(timeMatch[2]),
    Number(timeMatch[3] ?? "0")
  );
}

const EIRGRID_MONTHS: Record<string, number> = {
  Jan: 1, Feb: 2, Mar: 3, Apr: 4, May: 5, Jun: 6,
  Jul: 7, Aug: 8, Sep: 9, Oct: 10, Nov: 11, Dec: 12
};

export function parseEirGridLocalTimestamp(value: string): string | null {
  const match = /^(\d{2})-([A-Za-z]{3})-(\d{4}) (\d{2}):(\d{2}):(\d{2})$/.exec(String(value ?? "").trim());
  if (!match) return null;
  const monthName = match[2][0].toUpperCase() + match[2].slice(1).toLowerCase();
  const month = EIRGRID_MONTHS[monthName];
  return month
    ? parseDublinWallTime(Number(match[3]), month, Number(match[1]), Number(match[4]), Number(match[5]), Number(match[6]))
    : null;
}

const normalizeObservedTimestamp = (value: string | null): string | null => {
  const text = String(value ?? "").trim();
  if (!text) return null;
  const localMatch = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(text);
  if (localMatch) {
    return parseDublinWallTime(
      Number(localMatch[1]),
      Number(localMatch[2]),
      Number(localMatch[3]),
      Number(localMatch[4]),
      Number(localMatch[5]),
      Number(localMatch[6] ?? "0")
    );
  }
  const timestamp = Date.parse(text);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
};

export function parseLatestObservations(
  csv: string,
  stations: readonly StationDefinition[],
  observedAt: string | null = null,
  now = Date.now()
): StationReading[] {
  const byName = new Map(
    csv
      .trim()
      .split(/\r?\n/)
      .slice(1)
      .map(splitCsvLine)
      .filter((row) => row.length >= 9)
      .map((row) => [row[0].trim().toLowerCase(), row] as const)
  );

  return stations.flatMap((station) => {
    const row = byName.get(station.csvName.toLowerCase());
    if (!row) return [];
    const windKnots = nullableNumber(row[3]);
    const normalizedObservedAt = normalizeObservedTimestamp(observedAt);
    const timestamp = normalizedObservedAt ? Date.parse(normalizedObservedAt) : Number.NaN;
    return [{
      id: station.id,
      name: station.name,
      latitude: station.latitude,
      longitude: station.longitude,
      temperature: nullableNumber(row[1]),
      rainfall: nullableNumber(row[7]),
      windSpeed: windKnots === null ? null : Math.round(windKnots * 1.852),
      windDirection: row[5].trim(),
      description: row[2].trim() || "Latest observation",
      observedAt: normalizedObservedAt,
      fresh: Number.isFinite(timestamp) && timestamp <= now && now - timestamp < 3 * 60 * 60 * 1000
    }];
  });
}
