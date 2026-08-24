import { readBoundedJsonResponse, readBoundedResponseBytes } from "./bounded-io.js";

export const SUNRISE_SUNSET_ENDPOINT = "https://api.sunrise-sunset.org/v2";
export const SUNRISE_SUNSET_ATTRIBUTION_URL = "https://sunrise-sunset.org/";
export const SUNRISE_SUNSET_ATTRIBUTION = "Sunrise-Sunset.org";
export const IRELAND_CENTRE = { latitude: 53.4129, longitude: -8.2439 };
export const IRELAND_TIME_ZONE = "Europe/Dublin";
export const SOLAR_BODY_LIMIT = 768_000;
export const SOLAR_WINDOW_CACHE_MS = 6 * 60 * 60 * 1000;

const number = (value) => {
  if (value === null || value === undefined || (typeof value === "string" && !value.trim())) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const finiteInteger = (value) => {
  const parsed = number(value);
  return parsed !== null && Number.isInteger(parsed) ? parsed : null;
};

const text = (value, maximum = 240) => {
  const result = String(value ?? "").trim();
  return result && result.length <= maximum ? result : result.slice(0, maximum);
};

const dateKey = (value) => {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value ?? "").trim());
  if (!match) return null;
  const date = new Date(`${match[0]}T12:00:00Z`);
  return date.getUTCFullYear() === Number(match[1]) &&
    date.getUTCMonth() + 1 === Number(match[2]) &&
    date.getUTCDate() === Number(match[3]) ? match[0] : null;
};

export const dublinDateKey = (timestamp) => {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone: IRELAND_TIME_ZONE,
    year: "numeric", month: "2-digit", day: "2-digit"
  }).formatToParts(new Date(timestamp)).map((part) => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
};

const unwrapTime = (value) => {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "object") {
    const item = value;
    return unwrapTime(item.begin ?? item.start ?? item.time ?? item.timestamp ?? item.value ?? null);
  }
  const result = text(value, 80);
  return result || null;
};

const eventValue = (record, key, aliases = []) => {
  for (const name of [key, ...aliases]) {
    if (Object.prototype.hasOwnProperty.call(record, name)) return unwrapTime(record[name]);
  }
  return null;
};

const eventWithinDate = (value, date) => {
  if (value === null) return null;
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return null;
  // Sunrise-Sunset returns ISO timestamps for time_format=iso8601. Allow local or
  // UTC offsets, but reject values that are implausibly far from the named day.
  const dayStart = Date.parse(`${date}T00:00:00Z`);
  if (!Number.isFinite(dayStart) || Math.abs(timestamp - dayStart) > 36 * 60 * 60 * 1000) return null;
  return new Date(timestamp).toISOString();
};

const phaseFromName = (value) => {
  const name = String(value ?? "").trim().toLowerCase();
  const phases = [
    ["new moon", 0], ["waxing crescent", .125], ["first quarter", .25],
    ["waxing gibbous", .375], ["full moon", .5], ["waning gibbous", .625],
    ["last quarter", .75], ["third quarter", .75], ["waning crescent", .875]
  ];
  return phases.find(([label]) => name.includes(label))?.[1] ?? null;
};

const normalizedPhase = (value) => {
  const parsed = number(value);
  if (parsed !== null) {
    const fraction = parsed > 1 && parsed <= 100 ? parsed / 100 : parsed;
    return fraction >= 0 && fraction <= 1 ? fraction : null;
  }
  return phaseFromName(value);
};

const normalizedIllumination = (value) => {
  const parsed = number(value);
  if (parsed === null) return null;
  // Sunrise-Sunset v2 documents moon_illumination as a percentage. Keep the
  // internal contract as a fraction, including values such as 0.12 (0.12%,
  // not 12%).
  const fraction = parsed >= 0 && parsed <= 100 ? parsed / 100 : null;
  return fraction >= 0 && fraction <= 1 ? fraction : null;
};

const normalizeSolarPosition = (value) => {
  if (!value || typeof value !== "object") return null;
  const item = value;
  const azimuthValues = [item.azimuth, item.azimuth_degrees, item.sunrise_azimuth, item.sunset_azimuth, item.solar_noon_azimuth]
    .map(number).filter((entry) => entry !== null);
  const elevationValues = [item.elevation, item.altitude, item.elevation_degrees, item.solar_noon_altitude]
    .map(number).filter((entry) => entry !== null);
  if (azimuthValues.some((entry) => entry < -360 || entry > 360) ||
      elevationValues.some((entry) => entry < -90 || entry > 90)) return null;
  // The v2 provider supplies sunrise, sunset and solar-noon azimuths. The
  // public shape exposes one representative position, so prefer solar noon
  // rather than accidentally presenting the sunrise bearing as the current
  // sun direction.
  const azimuth = number(item.azimuth ?? item.azimuth_degrees ?? item.solar_noon_azimuth ?? item.sunrise_azimuth ?? item.sunset_azimuth ?? item[0]);
  const elevation = number(item.elevation ?? item.altitude ?? item.elevation_degrees ?? item.solar_noon_altitude ?? item[1]);
  if (azimuth === null || elevation === null || azimuth < -360 || azimuth > 360 || elevation < -90 || elevation > 90) return null;
  return { azimuth, elevation };
};

const resultRecords = (body, requestedYear) => {
  if (!body || typeof body !== "object") return [];
  const source = body.results ?? body.data ?? body.days ?? body;
  const providerTzid = body.tzid ?? body.timezone ?? null;
  const candidates = Array.isArray(source)
    ? source
    : source && typeof source === "object" && Array.isArray(source.results)
      ? source.results
      : source && typeof source === "object"
        ? [source]
        : [];
  return candidates.filter((item) => item && typeof item === "object").slice(0, 400).map((item) => ({
    ...item,
    date: item.date ?? item.local_date ?? item.day ?? item.date_local ?? null,
    tzid: item.tzid ?? item.timezone ?? providerTzid,
    requestedYear
  }));
};

/**
 * Normalize a Sunrise-Sunset v2 day or range response. Every event is nullable
 * on its own: a missing moonrise, for example, never becomes a fabricated
 * midnight value. Invalid event values are discarded, while a valid day can
 * still be used for the other events the provider supplied.
 */
export const normalizeSolarYear = (body, { year, now = Date.now() } = {}) => {
  const requestedYear = finiteInteger(year) ?? new Date(now).getUTCFullYear();
  if (body?.status && String(body.status).toUpperCase() !== "OK") return [];
  const records = resultRecords(body, requestedYear);
  const days = records.flatMap((record) => {
    // A range response must identify each day explicitly. Inferring the date
    // from request time would turn a malformed/provider-truncated row into a
    // seemingly authoritative event record.
    const candidateDate = dateKey(record.date);
    if (!candidateDate || Number(candidateDate.slice(0, 4)) !== requestedYear) return [];
    const tzid = text(record.tzid ?? record.timezone, 80);
    if (tzid !== IRELAND_TIME_ZONE) return [];
    const hasField = (name, aliases = []) => [name, ...aliases]
      .some((key) => Object.prototype.hasOwnProperty.call(record, key));
    // Nullable events still need to be represented by the provider schema;
    // silently accepting a row with only a date would make a truncated body
    // look like a valid day of astronomical data.
    const requiredFields = [
      ["sunrise"], ["sunset"], ["dawn"], ["dusk"], ["first_light", "firstLight"],
      ["last_light", "lastLight"], ["golden_hour", "goldenHour"], ["blue_hour", "blueHour"],
      ["solar_position", "solarPosition"], ["moonrise"], ["moonset"],
      ["moon_phase", "moonPhase"], ["moon_illumination", "moonIllumination"]
    ];
    if (!requiredFields.every(([name, ...aliases]) => hasField(name, aliases))) return [];
    const nestedGolden = record.golden_hour && typeof record.golden_hour === "object" ? record.golden_hour : {};
    const nestedBlue = record.blue_hour && typeof record.blue_hour === "object" ? record.blue_hour : {};
    const sourcePhase = record.moon_phase ?? record.moonPhase ?? record.phase ?? record.moon_phase_name;
    const phaseName = typeof sourcePhase === "string" && number(sourcePhase) === null ? text(sourcePhase, 60) : null;
    const day = {
      date: candidateDate,
      tzid,
      sunrise: eventWithinDate(eventValue(record, "sunrise"), candidateDate),
      sunset: eventWithinDate(eventValue(record, "sunset"), candidateDate),
      dawn: eventWithinDate(eventValue(record, "dawn", ["civil_twilight_begin"]), candidateDate),
      dusk: eventWithinDate(eventValue(record, "dusk", ["civil_twilight_end"]), candidateDate),
      firstLight: eventWithinDate(eventValue(record, "first_light", ["firstLight"]), candidateDate),
      lastLight: eventWithinDate(eventValue(record, "last_light", ["lastLight"]), candidateDate),
      goldenHourMorning: eventWithinDate(
        eventValue(record, "golden_hour_morning", ["goldenHourMorning"]) ?? unwrapTime(nestedGolden.morning),
        candidateDate
      ),
      goldenHourEvening: eventWithinDate(
        eventValue(record, "golden_hour_evening", ["goldenHourEvening"]) ?? unwrapTime(nestedGolden.evening),
        candidateDate
      ),
      blueHourMorning: eventWithinDate(
        eventValue(record, "blue_hour_morning", ["blueHourMorning"]) ?? unwrapTime(nestedBlue.morning),
        candidateDate
      ),
      blueHourEvening: eventWithinDate(
        eventValue(record, "blue_hour_evening", ["blueHourEvening"]) ?? unwrapTime(nestedBlue.evening),
        candidateDate
      ),
      solarPosition: normalizeSolarPosition(record.solar_position ?? record.solarPosition),
      moonrise: eventWithinDate(eventValue(record, "moonrise"), candidateDate),
      moonset: eventWithinDate(eventValue(record, "moonset"), candidateDate),
      moonPhase: normalizedPhase(sourcePhase),
      moonPhaseName: phaseName ?? (typeof sourcePhase === "string" ? text(sourcePhase, 60) : null),
      moonIllumination: normalizedIllumination(record.moon_illumination ?? record.moonIllumination ?? record.illumination),
      source: SUNRISE_SUNSET_ATTRIBUTION,
      attributionUrl: SUNRISE_SUNSET_ATTRIBUTION_URL
    };
    return [day];
  });
  const byDate = new Map();
  for (const day of days) if (!byDate.has(day.date)) byDate.set(day.date, day);
  return [...byDate.values()].sort((first, second) => first.date.localeCompare(second.date));
};

export const findSolarDay = (days, dateOrTimestamp = Date.now()) => {
  const target = typeof dateOrTimestamp === "string" && /^\d{4}-\d{2}-\d{2}$/.test(dateOrTimestamp)
    ? dateOrTimestamp
    : dublinDateKey(dateOrTimestamp);
  return (Array.isArray(days) ? days : []).find((day) => day?.date === target) ?? null;
};

const SOLAR_DAY_CACHE_LIMIT = 8;
const solarDayCache = new Map();

const rememberSolarWindow = (cacheKey, result) => {
  // One entry per requested Dublin-day window; evict oldest first so a
  // long-lived isolate cannot grow the map without bound.
  while (solarDayCache.size >= SOLAR_DAY_CACHE_LIMIT) {
    const oldestKey = solarDayCache.keys().next().value;
    if (oldestKey === undefined) break;
    solarDayCache.delete(oldestKey);
  }
  solarDayCache.set(cacheKey, result);
};

const addDublinDays = (date, days) => {
  const timestamp = Date.parse(`${date}T12:00:00Z`);
  if (!Number.isFinite(timestamp)) return date;
  return dublinDateKey(timestamp + days * 24 * 60 * 60 * 1000);
};

const solarWindowUrl = (startDate, endDate) => {
  const url = new URL(SUNRISE_SUNSET_ENDPOINT);
  url.search = new URLSearchParams({
    lat: String(IRELAND_CENTRE.latitude),
    lng: String(IRELAND_CENTRE.longitude),
    date_start: startDate,
    date_end: endDate,
    tz: IRELAND_TIME_ZONE,
    time_format: "iso8601"
  }).toString();
  return url;
};

export const fetchSolarWindow = async ({ year, now = Date.now(), fetcher = fetch, date } = {}) => {
  const requestedDate = dateKey(date) ?? dublinDateKey(now);
  const requestedYear = finiteInteger(year) ?? Number(requestedDate.slice(0, 4));
  const startDate = addDublinDays(requestedDate, -1);
  const endDate = addDublinDays(requestedDate, 1);
  const cacheKey = `${startDate}:${endDate}:${SUNRISE_SUNSET_ENDPOINT}`;
  const cached = solarDayCache.get(cacheKey);
  if (cached && now - cached.fetchedAt >= 0 && now - cached.fetchedAt < SOLAR_WINDOW_CACHE_MS) {
    return { ...cached, cached: true };
  }
  const response = await fetcher(solarWindowUrl(startDate, endDate), {
    headers: { accept: "application/json" }
  });
  if (!response.ok) {
    await readBoundedResponseBytes(response, "sunrise-sunset", SOLAR_BODY_LIMIT);
    throw new Error(`Sunrise-Sunset returned ${response.status}`);
  }
  const bounded = await readBoundedJsonResponse(response, "sunrise-sunset", SOLAR_BODY_LIMIT);
  const windowYears = [...new Set([startDate, requestedDate, endDate].map((value) => Number(value.slice(0, 4))))];
  const days = windowYears
    .flatMap((windowYear) => normalizeSolarYear(bounded.body, { year: windowYear, now }))
    .filter((day, index, list) => list.findIndex((entry) => entry.date === day.date) === index)
    .sort((first, second) => first.date.localeCompare(second.date));
  if (!days.length) throw new Error("Sunrise-Sunset returned no valid solar days");
  const result = { year: requestedYear, days, fetchedAt: now, bodyBytes: bounded.bodyBytes, cached: false };
  rememberSolarWindow(cacheKey, result);
  return result;
};

export const fetchSolarDay = async ({ now = Date.now(), fetcher = fetch } = {}) => {
  const result = await fetchSolarWindow({ now, fetcher });
  const day = findSolarDay(result.days, now);
  if (!day) throw new Error("Sunrise-Sunset returned no current Dublin solar day");
  return { reading: day, status: "live", fetchedAt: result.fetchedAt, days: result.days };
};

export const resetSolarCache = () => solarDayCache.clear();

export const MET_FORECAST_ENDPOINT = "https://www.met.ie/Open_Data/json/National.json";
export const MET_FORECAST_DATASET_URL = "https://data.gov.ie/dataset/met-eireann-live-text-forecast-data";
export const MET_FORECAST_ATTRIBUTION = "Met Éireann";
export const MET_FORECAST_BODY_LIMIT = 512_000;
export const MET_FORECAST_MAX_AGE_MS = 18 * 60 * 60 * 1000;
export const MET_FORECAST_FUTURE_TOLERANCE_MS = 10 * 60 * 1000;
export const MET_FORECAST_CACHE_MS = 15 * 60 * 1000;
export const MET_FORECAST_MAX_FORECASTS = 16;
export const MET_FORECAST_MAX_REGIONS = 128;

const decodeEntities = (value) => String(value ?? "")
  .replaceAll("&nbsp;", " ")
  .replaceAll("&#160;", " ")
  .replaceAll("&quot;", '"')
  .replaceAll("&#39;", "'")
  .replaceAll("&#x27;", "'")
  .replaceAll("&lt;", "<")
  .replaceAll("&gt;", ">")
  .replaceAll("&amp;", "&");

export const normalizeForecastCopy = (value, maximum = 8_000) => {
  if (value !== null && value !== undefined && typeof value !== "string") return null;
  const decoded = decodeEntities(value)
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p\s*>/gi, "\n")
    .replace(/<[^>]*>/g, "")
    .replace(/[\t\r ]+/g, " ")
    .replace(/\n\s*/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  // Truncating a provider's official copy would be a material rewrite. A
  // bounded but oversized field is therefore rejected and rendered
  // unavailable rather than partially presented as verbatim text.
  return decoded.length <= maximum ? decoded : null;
};

const forecastRows = (body) => {
  if (!body || typeof body !== "object") return [];
  const forecasts = (Array.isArray(body.forecasts) ? body.forecasts : body.forecasts ? [body.forecasts] : [])
    .slice(0, MET_FORECAST_MAX_FORECASTS);
  const rows = forecasts.flatMap((forecast) => {
    if (!forecast || typeof forecast !== "object") return [];
    const regions = (Array.isArray(forecast.regions) ? forecast.regions : forecast.regions ? [forecast.regions] : [])
      .slice(0, MET_FORECAST_MAX_REGIONS);
    const singletonKeys = new Set(["region", "issued", "today", "tonight", "tomorrow", "outlook"]);
    const singletonNames = regions.map((region) => Object.keys(region ?? {})[0]).filter(Boolean);
    const isSingletonShape = regions.length > 1 && singletonNames.length === regions.length &&
      new Set(singletonNames).size === singletonNames.length && regions.every((region) => {
      if (!region || typeof region !== "object") return false;
      const keys = Object.keys(region);
      return keys.length === 1 && keys.every((key) => singletonKeys.has(key));
    });
    if (isSingletonShape) {
      const merged = Object.assign({}, ...regions);
      return [{ ...merged, issued: forecast.issued ?? merged.issued }];
    }
    return regions.map((region) => ({ ...region, issued: region.issued ?? forecast.issued }));
  });
  if (rows.length) return rows;
  const direct = body.region || body.issued || body.today || body.tonight || body.tomorrow;
  return direct ? [body] : [];
};

const parseIssued = (value) => {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  const timestamp = Date.parse(raw);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
};

const forecastFreshness = (issued, now) => {
  const timestamp = Date.parse(issued ?? "");
  if (!Number.isFinite(timestamp)) return "invalid";
  const age = now - timestamp;
  if (age < -MET_FORECAST_FUTURE_TOLERANCE_MS) return "future";
  if (age > MET_FORECAST_MAX_AGE_MS) return "stale";
  return "fresh";
};

/** Normalize Met Éireann's singleton-region array without rewriting its copy. */
export const normalizeMetForecast = (body, now = Date.now()) => {
  const rows = forecastRows(body);
  const candidates = rows.flatMap((row) => {
    const issued = parseIssued(row.issued ?? row.issue_time ?? row.issuedAt);
    if (!issued || forecastFreshness(issued, now) !== "fresh") return [];
    const copy = [
      normalizeForecastCopy(row.region ?? row.name ?? "National", 160),
      normalizeForecastCopy(row.today),
      normalizeForecastCopy(row.tonight),
      normalizeForecastCopy(row.tomorrow),
      normalizeForecastCopy(row.outlook)
    ];
    if (copy.some((value) => value === null)) return [];
    const [region, today, tonight, tomorrow, outlook] = copy;
    const forecast = {
      region: region ?? "",
      issued,
      today: today ?? "",
      tonight: tonight ?? "",
      tomorrow: tomorrow ?? "",
      outlook: outlook ?? "",
      source: MET_FORECAST_ATTRIBUTION,
      sourceUrl: MET_FORECAST_ENDPOINT,
      datasetUrl: MET_FORECAST_DATASET_URL
    };
    return forecast.region || forecast.today || forecast.tonight || forecast.tomorrow || forecast.outlook ? [forecast] : [];
  });
  return candidates.find((candidate) => candidate.region.toLocaleLowerCase() === "national") ?? candidates[0] ?? null;
};

export const assessMetForecast = (body, now = Date.now()) => {
  const rows = forecastRows(body);
  if (!rows.length) return { forecast: null, status: "unavailable", reason: "malformed" };
  const issued = rows.map((row) => parseIssued(row.issued ?? row.issue_time ?? row.issuedAt)).find(Boolean) ?? null;
  const freshness = forecastFreshness(issued, now);
  const forecast = normalizeMetForecast(body, now);
  return forecast
    ? { forecast, status: "live", reason: null }
    : { forecast: null, status: freshness === "stale" ? "stale" : "unavailable", reason: freshness };
};

const irelandHour = (timestamp) => Number(new Intl.DateTimeFormat("en-IE", {
  timeZone: IRELAND_TIME_ZONE, hour: "2-digit", hour12: false
}).format(new Date(timestamp))) % 24;

export const selectForecastPeriod = (forecast, now = Date.now()) => {
  if (!forecast) return null;
  const hour = irelandHour(now);
  const candidates = hour >= 18 || hour < 6
    ? [["tonight", forecast.tonight], ["tomorrow", forecast.tomorrow], ["today", forecast.today]]
    : [["today", forecast.today], ["tonight", forecast.tonight], ["tomorrow", forecast.tomorrow]];
  const selected = candidates.find(([, copy]) => Boolean(String(copy ?? "").trim()));
  return selected ? { period: selected[0], copy: selected[1] } : null;
};

const metForecastCache = new Map();

export const resetMetForecastCache = () => metForecastCache.clear();

export const fetchMetForecast = async ({ now = Date.now(), fetcher = fetch } = {}) => {
  const cached = metForecastCache.get(MET_FORECAST_ENDPOINT);
  if (cached && now - cached.fetchedAt >= 0 && now - cached.fetchedAt < MET_FORECAST_CACHE_MS) {
    return { ...cached, cached: true };
  }
  const response = await fetcher(MET_FORECAST_ENDPOINT, {
    headers: { accept: "application/json" }
  });
  if (!response.ok) {
    await readBoundedResponseBytes(response, "met-forecast", MET_FORECAST_BODY_LIMIT);
    throw new Error(`Met Éireann forecast returned ${response.status}`);
  }
  const bounded = await readBoundedJsonResponse(response, "met-forecast", MET_FORECAST_BODY_LIMIT);
  const assessed = assessMetForecast(bounded.body, now);
  if (!assessed.forecast) throw new Error(`Met Éireann forecast ${assessed.reason ?? "unavailable"}`);
  const result = { ...assessed, fetchedAt: now, bodyBytes: bounded.bodyBytes, cached: false };
  metForecastCache.set(MET_FORECAST_ENDPOINT, result);
  return result;
};

export const acceptClientSolar = (value, now = Date.now()) => {
  if (!value || typeof value !== "object") return null;
  const row = value;
  const date = typeof row.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(row.date) ? row.date : null;
  const currentDate = dublinDateKey(now);
  const dateTimestamp = Date.parse(`${date ?? ""}T12:00:00Z`);
  if (!date || !Number.isFinite(dateTimestamp) || new Date(dateTimestamp).toISOString().slice(0, 10) !== date || date !== currentDate || row.tzid !== IRELAND_TIME_ZONE) return null;
  const event = (key) => eventWithinDate(row[key], date);
  const phase = number(row.moonPhase);
  const illumination = number(row.moonIllumination);
  const position = row.solarPosition && typeof row.solarPosition === "object" ? row.solarPosition : null;
  const azimuth = number(position?.azimuth);
  const elevation = number(position?.elevation);
  if (phase !== null && (phase < 0 || phase > 1)) return null;
  if (illumination !== null && (illumination < 0 || illumination > 1)) return null;
  if (azimuth !== null && (azimuth < -360 || azimuth > 360)) return null;
  if (elevation !== null && (elevation < -90 || elevation > 90)) return null;
  return {
    date,
    tzid: IRELAND_TIME_ZONE,
    sunrise: event("sunrise"), sunset: event("sunset"), dawn: event("dawn"), dusk: event("dusk"),
    firstLight: event("firstLight"), lastLight: event("lastLight"),
    goldenHourMorning: event("goldenHourMorning"), goldenHourEvening: event("goldenHourEvening"),
    blueHourMorning: event("blueHourMorning"), blueHourEvening: event("blueHourEvening"),
    solarPosition: azimuth !== null && elevation !== null ? { azimuth, elevation } : null,
    moonrise: event("moonrise"), moonset: event("moonset"),
    moonPhase: phase,
    moonPhaseName: typeof row.moonPhaseName === "string" ? row.moonPhaseName.slice(0, 60) : null,
    moonIllumination: illumination,
    source: SUNRISE_SUNSET_ATTRIBUTION,
    attributionUrl: SUNRISE_SUNSET_ATTRIBUTION_URL
  };
};

export const acceptClientForecast = (value, now = Date.now()) => {
  if (!value || typeof value !== "object") return null;
  const row = value;
  const issued = typeof row.issued === "string" ? Date.parse(row.issued) : Number.NaN;
  if (!Number.isFinite(issued) || now - issued < -10 * 60_000 || now - issued > 36 * 60 * 60_000) return null;
  const copy = (key) => {
    const candidate = row[key];
    if (candidate === null || candidate === undefined) return "";
    return typeof candidate === "string" && candidate.length <= 8_000 ? candidate : null;
  };
  const region = copy("region");
  const today = copy("today");
  const tonight = copy("tonight");
  const tomorrow = copy("tomorrow");
  const outlook = copy("outlook");
  if ([region, today, tonight, tomorrow, outlook].some((item) => item === null)) return null;
  const normalizedRegion = region ?? "";
  const normalizedToday = today ?? "";
  const normalizedTonight = tonight ?? "";
  const normalizedTomorrow = tomorrow ?? "";
  const normalizedOutlook = outlook ?? "";
  if (!normalizedRegion && !normalizedToday && !normalizedTonight && !normalizedTomorrow && !normalizedOutlook) return null;
  return {
    region: normalizedRegion, issued: new Date(issued).toISOString(), today: normalizedToday, tonight: normalizedTonight,
    tomorrow: normalizedTomorrow, outlook: normalizedOutlook, source: MET_FORECAST_ATTRIBUTION,
    sourceUrl: MET_FORECAST_ENDPOINT,
    datasetUrl: MET_FORECAST_DATASET_URL
  };
};
