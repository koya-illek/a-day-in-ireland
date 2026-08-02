export const RIVER_PROVIDER = "OPW waterlevel.ie";
export const RIVER_ENDPOINT = "https://waterlevel.ie/geojson/latest/";
export const RIVER_FRESHNESS_MS = 3 * 60 * 60 * 1000;
const IRELAND_BOUNDS = {
  minLatitude: 51.2,
  maxLatitude: 55.6,
  minLongitude: -10.8,
  maxLongitude: -5.2
};

// A bounding box admits the Irish Sea, Wales and western Scotland. River
// gauges are land observations, so keep a deliberately coarse all-island
// outline as a second guard. It is not used for map rendering or coastline
// claims; it only rejects clearly impossible provider coordinates.
const IRELAND_OUTLINE = [
  [51.38, -9.85], [51.37, -9.25], [51.52, -8.55], [51.72, -8.00],
  [52.05, -7.35], [52.38, -6.15], [52.82, -6.05], [53.15, -6.00],
  [53.45, -5.95], [53.78, -5.75], [54.08, -5.70], [54.42, -5.72],
  [54.68, -5.80], [54.92, -5.95], [55.12, -6.20], [55.28, -6.55],
  [55.42, -7.05], [55.42, -7.75], [55.30, -8.20], [55.05, -8.55],
  [54.75, -8.80], [54.52, -9.15], [54.30, -9.55], [53.95, -9.95],
  [53.58, -10.25], [53.20, -10.35], [52.85, -10.45], [52.45, -10.35],
  [52.08, -10.15], [51.75, -10.20], [51.48, -10.10]
];

const finiteNumber = (value) => {
  if (value === null || value === undefined || (typeof value === "string" && !value.trim())) return null;
  const number = typeof value === "number" ? value : Number(String(value).trim());
  return Number.isFinite(number) ? number : null;
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

const dublinParts = (timestamp) => {
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

const dublinOffsetMinutes = (timestamp) => {
  const parts = dublinParts(timestamp);
  return (Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second) - timestamp) / 60_000;
};

const parseDublinWallTime = (year, month, day, hour, minute, second) => {
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

export const parseIrelandLocalTimestamp = (date, time) => {
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
};

const EIRGRID_MONTHS = {
  Jan: 1, Feb: 2, Mar: 3, Apr: 4, May: 5, Jun: 6,
  Jul: 7, Aug: 8, Sep: 9, Oct: 10, Nov: 11, Dec: 12
};

export const parseEirGridLocalTimestamp = (value) => {
  const match = /^(\d{2})-([A-Za-z]{3})-(\d{4}) (\d{2}):(\d{2}):(\d{2})$/.exec(String(value ?? "").trim());
  if (!match) return null;
  const month = EIRGRID_MONTHS[match[2][0].toUpperCase() + match[2].slice(1).toLowerCase()];
  return month
    ? parseDublinWallTime(Number(match[3]), month, Number(match[1]), Number(match[4]), Number(match[5]), Number(match[6]))
    : null;
};

const parsedTimestamp = (value) => {
  const text = String(value ?? "").trim();
  const dateOnlyMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  const localMatch = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?$/.exec(text);
  const localTimestamp = localMatch
    ? parseDublinWallTime(
        Number(localMatch[1]), Number(localMatch[2]), Number(localMatch[3]),
        Number(localMatch[4]), Number(localMatch[5]), Number(localMatch[6] ?? "0")
      )
    : dateOnlyMatch
      ? parseDublinWallTime(Number(dateOnlyMatch[1]), Number(dateOnlyMatch[2]), Number(dateOnlyMatch[3]), 0, 0, 0)
      : null;
  const milliseconds = localMatch?.[7]
    ? Number(localMatch[7].padEnd(3, "0"))
    : 0;
  const timestamp = localTimestamp
    ? Date.parse(localTimestamp) + milliseconds
    : Date.parse(text);
  return Number.isFinite(timestamp) ? timestamp : null;
};

export const normalizeProviderTimestamp = (value) => {
  const timestamp = parsedTimestamp(value);
  return timestamp === null ? null : new Date(timestamp).toISOString();
};

const bathingStart = (item) => item?.startedAt ?? item?.incident_start_date ?? item?.onset;
const bathingEnd = (item, startTimestamp) => {
  const explicitEnd = parsedTimestamp(item?.endsAt ?? item?.incident_end_date ?? item?.expiry);
  if (explicitEnd !== null) return explicitEnd;
  const expectedDuration = finiteNumber(item?.expectedDuration ?? item?.incident_expected_duration);
  return startTimestamp !== null && expectedDuration !== null && expectedDuration > 0
    ? startTimestamp + expectedDuration * 86_400_000
    : null;
};

export const normalizeOfficialNotices = (rows, now = Date.now()) => (Array.isArray(rows) ? rows : []).filter((item) => {
  if (!item || typeof item !== "object") return false;
  const expiry = parsedTimestamp(item.expiry);
  const onset = parsedTimestamp(item.onset);
  const hasOnset = String(item.onset ?? "").trim() !== "";
  return expiry !== null && expiry > now && (!hasOnset ? true : onset !== null && onset <= now);
});

export const normalizeOfficialWeatherWarnings = (rows, now = Date.now()) =>
  normalizeOfficialNotices(rows, now).flatMap((item) => {
    const expiry = normalizeProviderTimestamp(item.expiry);
    const onset = normalizeProviderTimestamp(item.onset);
    if (!expiry) return [];
    return [{
      level: String(item.level ?? "Advisory"),
      headline: String(item.headline ?? "Weather advisory"),
      description: String(item.description ?? ""),
      onset: onset ?? "",
      expiry
    }];
  });

export const normalizeBathingAlerts = (rows, now = Date.now()) => (Array.isArray(rows) ? rows : []).filter((item) => {
  if (!item || typeof item !== "object") return false;
  const start = parsedTimestamp(bathingStart(item));
  const end = bathingEnd(item, start);
  return start !== null && start <= now && (end === null || end > now);
});

export const isIrelandCoordinate = (latitude, longitude) => {
  const lat = finiteNumber(latitude);
  const lon = finiteNumber(longitude);
  if (lat === null || lon === null ||
    lat < IRELAND_BOUNDS.minLatitude || lat > IRELAND_BOUNDS.maxLatitude ||
    lon < IRELAND_BOUNDS.minLongitude || lon > IRELAND_BOUNDS.maxLongitude) return false;

  let inside = false;
  for (let index = 0, previous = IRELAND_OUTLINE.length - 1; index < IRELAND_OUTLINE.length; previous = index++) {
    const [currentLatitude, currentLongitude] = IRELAND_OUTLINE[index];
    const [previousLatitude, previousLongitude] = IRELAND_OUTLINE[previous];
    const crossesLatitude = (currentLatitude > lat) !== (previousLatitude > lat);
    if (crossesLatitude) {
      const crossingLongitude =
        (previousLongitude - currentLongitude) * (lat - currentLatitude) /
        (previousLatitude - currentLatitude) + currentLongitude;
      if (lon < crossingLongitude) inside = !inside;
    }
  }
  return inside;
};

const validObservedAt = (value) => {
  const observedAt = normalizeProviderTimestamp(value);
  const timestamp = observedAt ? Date.parse(observedAt) : Number.NaN;
  return Number.isFinite(timestamp) ? { observedAt, timestamp } : null;
};

const deduplicate = (readings) => {
  const cells = new Map();
  for (const reading of readings) {
    const key = `${Math.round(reading.longitude * 4)}:${Math.round(reading.latitude * 5)}`;
    const current = cells.get(key);
    if (!current || new Date(reading.observedAt) > new Date(current.observedAt)) {
      cells.set(key, reading);
    }
  }
  return [...cells.values()].slice(0, 90);
};

export const normalizeRiverReadings = (readings, now = Date.now()) => {
  const normalized = [];
  for (const item of Array.isArray(readings) ? readings : []) {
    if (!item || typeof item !== "object") continue;
    const latitude = finiteNumber(item.latitude);
    const longitude = finiteNumber(item.longitude);
    const level = finiteNumber(item.level);
    const observed = validObservedAt(item.observedAt);
    const id = String(item.id ?? "").trim();
    if (
      !id ||
      latitude === null ||
      longitude === null ||
      !isIrelandCoordinate(latitude, longitude) ||
      level === null ||
      !observed ||
      observed.timestamp > now ||
      now - observed.timestamp >= RIVER_FRESHNESS_MS
    ) continue;
    normalized.push({
      id,
      name: String(item.name ?? "River gauge"),
      latitude,
      longitude,
      level,
      observedAt: observed.observedAt,
      fresh: true
    });
  }
  return deduplicate(normalized);
};

export const parseRiverGeoJson = (body, now = Date.now()) => {
  const readings = [];
  for (const item of Array.isArray(body?.features) ? body.features : []) {
    if (item?.properties?.sensor_ref !== "0001") continue;
    const [longitude, latitude] = item.geometry?.coordinates ?? [];
    const stationNumber = Number.parseInt(String(item.properties?.station_ref ?? ""), 10);
    readings.push({
      id: String(item.properties?.station_ref ?? ""),
      name: String(item.properties?.station_name ?? "River gauge"),
      latitude,
      longitude,
      level: item.properties?.value,
      observedAt: item.properties?.datetime,
      stationNumber
    });
  }
  return normalizeRiverReadings(
    readings.filter((reading) => Number.isFinite(reading.stationNumber) && reading.stationNumber >= 0 && reading.stationNumber <= 41000),
    now
  );
};

export const latestObservedAt = (readings) => {
  const timestamps = (Array.isArray(readings) ? readings : [])
    .map((reading) => normalizeProviderTimestamp(reading.observedAt))
    .map((observedAt) => observedAt ? Date.parse(observedAt) : Number.NaN)
    .filter(Number.isFinite);
  return timestamps.length ? new Date(Math.max(...timestamps)).toISOString() : null;
};

export const latestEirGridValue = (rows, field, now = Date.now(), maxAgeMs = 6 * 60 * 60 * 1000) => {
  const candidates = (Array.isArray(rows) ? rows : []).flatMap((item) => {
    if (!item || String(item.FieldName ?? "") !== field) return [];
    const value = finiteNumber(item.Value);
    const observedAt = parseEirGridLocalTimestamp(String(item.EffectiveTime ?? ""));
    const timestamp = observedAt ? Date.parse(observedAt) : Number.NaN;
    return value !== null && Number.isFinite(timestamp) && timestamp <= now && now - timestamp < maxAgeMs
      ? [{ value, observedAt, timestamp }]
      : [];
  });
  return candidates.sort((first, second) => first.timestamp - second.timestamp).at(-1) ?? null;
};

export const makeSourceProvenance = ({
  provider,
  endpoint,
  status,
  fetchedAt = new Date().toISOString(),
  readings = [],
  fallback = null
}) => ({
  provider,
  endpoint,
  status,
  fetchedAt,
  latestObservedAt: latestObservedAt(readings),
  fallback
});

export const makeRiverProvenance = (options) => makeSourceProvenance({
  provider: RIVER_PROVIDER,
  endpoint: RIVER_ENDPOINT,
  ...options
});
