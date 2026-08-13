export const RIVER_PROVIDER = "OPW waterlevel.ie";
export const RIVER_ENDPOINT = "https://waterlevel.ie/geojson/latest/";
export const RIVER_FRESHNESS_MS = 3 * 60 * 60 * 1000;
export { readBoundedJsonResponse, readBoundedResponseBytes, readBoundedTextResponse } from "./bounded-io.js";
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

const parseDublinWallTime = (year, month, day, hour, minute, second, notAfter = null) => {
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
  const selected = Number.isFinite(notAfter)
    ? candidates.filter((candidate) => candidate <= notAfter).at(-1)
    : candidates[0];
  return selected === undefined ? null : new Date(selected).toISOString();
};

export const parseIrelandLocalTimestamp = (date, time, notAfter = null) => {
  const dateMatch = /^(\d{2})-(\d{2})-(\d{4})$/.exec(String(date ?? "").trim());
  const timeMatch = /^(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(String(time ?? "").trim());
  if (!dateMatch || !timeMatch) return null;
  return parseDublinWallTime(
    Number(dateMatch[3]),
    Number(dateMatch[2]),
    Number(dateMatch[1]),
    Number(timeMatch[1]),
    Number(timeMatch[2]),
    Number(timeMatch[3] ?? "0"),
    notAfter
  );
};

const EIRGRID_MONTHS = {
  Jan: 1, Feb: 2, Mar: 3, Apr: 4, May: 5, Jun: 6,
  Jul: 7, Aug: 8, Sep: 9, Oct: 10, Nov: 11, Dec: 12
};

export const parseEirGridLocalTimestamp = (value, notAfter = null) => {
  const match = /^(\d{2})-([A-Za-z]{3})-(\d{4}) (\d{2}):(\d{2}):(\d{2})$/.exec(String(value ?? "").trim());
  if (!match) return null;
  const month = EIRGRID_MONTHS[match[2][0].toUpperCase() + match[2].slice(1).toLowerCase()];
  return month
    ? parseDublinWallTime(Number(match[3]), month, Number(match[1]), Number(match[4]), Number(match[5]), Number(match[6]), notAfter)
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

// Met Éireann's public feeds contain HTML entities in otherwise plain-text
// fields (for example "&amp;" in a regional headline). Keep decoding in the
// shared adapter so the server, edge worker and browser cannot disagree about
// what an official notice says.
const HTML_ENTITIES = {
  amp: "&",
  apos: "'",
  gt: ">",
  lt: "<",
  nbsp: " ",
  quot: '"'
};

export const decodeHtmlEntities = (input) => {
  let decoded = String(input ?? "");
  for (let pass = 0; pass < 2; pass += 1) {
    const next = decoded.replace(/&(#x[\da-f]+|#\d+|[a-z][\da-z]+);/gi, (match, token) => {
      const lower = token.toLowerCase();
      if (lower.startsWith("#x")) {
        const codePoint = Number.parseInt(lower.slice(2), 16);
        return Number.isInteger(codePoint) && codePoint >= 0 && codePoint <= 0x10ffff
          ? String.fromCodePoint(codePoint)
          : match;
      }
      if (lower.startsWith("#")) {
        const codePoint = Number.parseInt(lower.slice(1), 10);
        return Number.isInteger(codePoint) && codePoint >= 0 && codePoint <= 0x10ffff
          ? String.fromCodePoint(codePoint)
          : match;
      }
      return Object.prototype.hasOwnProperty.call(HTML_ENTITIES, lower) ? HTML_ENTITIES[lower] : match;
    });
    if (next === decoded) break;
    decoded = next;
  }
  return decoded;
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

const WARNING_HORIZON_MS = 48 * 60 * 60 * 1000;

const warningText = (value, fallback = "") => decodeHtmlEntities(String(value ?? fallback)).trim();

const warningRegions = (value) => {
  if (Array.isArray(value)) return value.map((region) => warningText(region)).filter(Boolean);
  const region = warningText(value);
  return region ? [region] : [];
};

const warningTimestamp = (value) => normalizeProviderTimestamp(value) ?? warningText(value);

const warningIdentity = (item, values) => {
  const id = warningText(item.id);
  const capId = warningText(item.capId ?? item.capID ?? item.cap_id);
  return id || capId || [values.type, values.headline, values.onset, values.expiry, values.regions.join(",")].join("|");
};

// Keep active notices and useful near-term notices. Expired notices are
// dropped, while future notices remain available for the UI to label as
// upcoming instead of silently turning them into current conditions.
export const normalizeOfficialWeatherWarnings = (rows, now = Date.now(), horizonMs = WARNING_HORIZON_MS) =>
  (Array.isArray(rows) ? rows : []).flatMap((raw) => {
    if (!raw || typeof raw !== "object") return [];
    const item = raw;
    const onsetTimestamp = parsedTimestamp(item.onset);
    const expiryTimestamp = parsedTimestamp(item.expiry);
    const hasOnset = warningText(item.onset) !== "";
    if (
      expiryTimestamp === null ||
      expiryTimestamp <= now ||
      (hasOnset && onsetTimestamp === null) ||
      (onsetTimestamp !== null && onsetTimestamp > now + horizonMs)
    ) return [];
    const onset = warningTimestamp(item.onset);
    const expiry = warningTimestamp(item.expiry);
    const issued = warningTimestamp(item.issued ?? item.issuedAt);
    const updated = warningTimestamp(item.updated ?? item.updatedAt ?? item.lastUpdated);
    const regions = warningRegions(item.regions ?? item.region);
    const values = {
      type: warningText(item.type ?? item.event ?? item.eventName),
      headline: warningText(item.headline, "Weather advisory"),
      onset: onset ?? "",
      expiry: expiry ?? "",
      regions
    };
    return [{
      id: warningIdentity(item, values),
      capId: warningText(item.capId ?? item.capID ?? item.cap_id) || warningIdentity(item, values),
      type: values.type,
      severity: warningText(item.severity, "Unknown"),
      certainty: warningText(item.certainty, "Unknown"),
      regions,
      status: warningText(item.status, "Unknown"),
      issued: issued ?? "",
      updated: updated ?? "",
      level: warningText(item.level, "Advisory"),
      headline: values.headline,
      description: warningText(item.description),
      onset: values.onset,
      expiry: values.expiry
    }];
  });

export const warningTiming = (warning, now = Date.now(), horizonMs = WARNING_HORIZON_MS) => {
  const onset = parsedTimestamp(warning?.onset);
  const expiry = parsedTimestamp(warning?.expiry);
  if (expiry === null || expiry <= now) return "expired";
  if (onset !== null && onset > now) return onset <= now + horizonMs ? "upcoming" : "future";
  return "active";
};

const warningSeverityRank = (warning) => {
  const value = `${warning?.level ?? ""} ${warning?.severity ?? ""} ${warning?.type ?? ""}`.toLowerCase();
  if (/\bred\b/.test(value)) return 4;
  if (/\borange\b/.test(value)) return 3;
  if (/\byellow\b/.test(value)) return 2;
  return 1;
};

const compareText = (first, second) => first < second ? -1 : first > second ? 1 : 0;

export const sortOfficialWeatherWarnings = (warnings, now = Date.now()) => [...(Array.isArray(warnings) ? warnings : [])]
  .filter((warning) => warningTiming(warning, now) !== "expired")
  .sort((first, second) => {
    const timingOrder = { active: 0, upcoming: 1, future: 2 };
    const timingDifference = timingOrder[warningTiming(first, now)] - timingOrder[warningTiming(second, now)];
    if (timingDifference) return timingDifference;
    const severityDifference = warningSeverityRank(second) - warningSeverityRank(first);
    if (severityDifference) return severityDifference;
    const firstOnset = parsedTimestamp(first.onset) ?? Number.POSITIVE_INFINITY;
    const secondOnset = parsedTimestamp(second.onset) ?? Number.POSITIVE_INFINITY;
    if (firstOnset !== secondOnset) return firstOnset - secondOnset;
    return compareText(String(first.id ?? first.capId ?? ""), String(second.id ?? second.capId ?? ""));
  });

export const isActivityRelevantWeatherWarning = (warning) => {
  const value = `${warning?.type ?? ""} ${warning?.headline ?? ""} ${warning?.description ?? ""}`.toLowerCase();
  if (/blight|agricultur|farming|potato|crop|pollen/.test(value)) return false;
  return /\b(?:wind(?:s)?|rain(?:fall|s)?|snow(?:fall|s)?|ice|thunder(?:storm)?s?|storm(?:s)?|fog(?:gy)?|flood(?:ing|s)?|sleet|hail(?:s)?|visibility)\b/.test(value);
};

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
  return [...cells.values()];
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
  // Response bytes are capped by the caller. Scan every retained row because
  // EirGrid groups series inconsistently and the requested metric is not
  // guaranteed to appear near the end of the response.
  const boundedRows = Array.isArray(rows) ? rows : [];
  let latest = null;
  for (const item of boundedRows) {
    if (!item || String(item.FieldName ?? "") !== field) continue;
    const value = finiteNumber(item.Value);
    const observedAt = parseEirGridLocalTimestamp(String(item.EffectiveTime ?? ""), now);
    const timestamp = observedAt ? Date.parse(observedAt) : Number.NaN;
    if (value !== null && Number.isFinite(timestamp) && timestamp <= now && now - timestamp < maxAgeMs &&
        (!latest || timestamp >= latest.timestamp)) latest = { value, observedAt, timestamp };
  }
  return latest;
};

export const buildEirGridReading = ({
  demand = null,
  generation = null,
  wind = null,
  carbonIntensity = null,
  carbonEmissions = null,
  frequency = null,
  interconnection = null
} = {}) => {
  const components = [demand, generation, wind, carbonIntensity, carbonEmissions, frequency, interconnection];
  const observedAt = components
    .map((item) => item?.observedAt)
    .filter((item) => Number.isFinite(Date.parse(item)))
    .sort((first, second) => Date.parse(first) - Date.parse(second))
    .at(-1) ?? null;
  if (!observedAt) return null;
  return {
    observedAt,
    demandMW: demand?.value ?? null,
    generationMW: generation?.value ?? null,
    windMW: wind?.value ?? null,
    windSharePercent: wind && demand && demand.value > 0 ? wind.value / demand.value * 100 : null,
    carbonIntensity: carbonIntensity?.value ?? null,
    carbonEmissions: carbonEmissions?.value ?? null,
    frequencyHz: frequency?.value ?? null,
    interconnectorMW: interconnection?.value ?? null
  };
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
