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

export function parseLatestObservations(
  csv: string,
  stations: readonly StationDefinition[],
  observedAt = new Date().toISOString()
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
      observedAt,
      fresh: true
    }];
  });
}
