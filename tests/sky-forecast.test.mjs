import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  MET_FORECAST_BODY_LIMIT,
  MET_FORECAST_CACHE_MS,
  MET_FORECAST_ENDPOINT,
  SUNRISE_SUNSET_ENDPOINT,
  assessMetForecast,
  fetchMetForecast,
  fetchSolarWindow,
  findSolarDay,
  normalizeMetForecast,
  normalizeSolarYear,
  resetMetForecastCache,
  resetSolarCache,
  selectForecastPeriod
} from "../platform/sky-source.js";

const NOW = Date.parse("2026-08-12T12:00:00.000Z");
const PROJECT_ROOT = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));

const responseJson = (body, init = {}) => new Response(JSON.stringify(body), {
  headers: { "content-type": "application/json" },
  ...init
});

const sourceFiles = async (path) => {
  const entries = await readdir(path, { withFileTypes: true });
  return (await Promise.all(entries.map(async (entry) => {
    const target = join(path, entry.name);
    return entry.isDirectory() ? sourceFiles(target) : [target];
  }))).flat();
};

test("discarded flight integration is absent from production source, configuration and public copy", async () => {
  const roots = ["app", "components", "lib", "platform", "public", "scripts"];
  const files = [
    ...(await Promise.all(roots.map((root) => sourceFiles(join(PROJECT_ROOT, root))))).flat(),
    join(PROJECT_ROOT, "README.md"),
    join(PROJECT_ROOT, "package.json")
  ];
  const forbidden = new RegExp(`${["open", "sky"].join("")}|${["air", "craft"].join("")}`, "i");
  const matches = [];
  for (const file of files) {
    const content = await readFile(file, "utf8");
    if (forbidden.test(content)) matches.push(file.slice(PROJECT_ROOT.length + 1));
  }
  assert.deepEqual(matches, []);
});

const solarRow = (date = "2026-08-12") => ({
  date,
  tzid: "Europe/Dublin",
  sunrise: `${date}T05:30:00+01:00`,
  sunset: `${date}T21:15:00+01:00`,
  dawn: `${date}T04:40:00+01:00`,
  dusk: `${date}T22:05:00+01:00`,
  first_light: `${date}T04:05:00+01:00`,
  last_light: `${date}T22:40:00+01:00`,
  golden_hour: {
    morning: { begin: `${date}T06:15:00+01:00`, end: `${date}T07:15:00+01:00` },
    evening: { begin: `${date}T20:20:00+01:00`, end: `${date}T21:20:00+01:00` }
  },
  blue_hour: {
    morning: { begin: `${date}T05:00:00+01:00`, end: `${date}T05:30:00+01:00` },
    evening: { begin: `${date}T21:45:00+01:00`, end: `${date}T22:15:00+01:00` }
  },
  solar_position: { solar_noon_azimuth: 142, solar_noon_altitude: 32 },
  moonrise: null,
  moonset: `${date}T13:00:00+01:00`,
  moon_phase: 0.25,
  moon_illumination: 50
});

test("Sunrise-Sunset normalizer keeps Dublin/DST events, nullable moon fields, bounds and attribution", () => {
  const days = normalizeSolarYear({ tzid: "Europe/Dublin", days: [solarRow(), solarRow("2026-03-29")] }, { year: 2026, now: NOW });
  const august = findSolarDay(days, "2026-08-12");
  const dst = findSolarDay(days, "2026-03-29");

  assert.equal(days.length, 2);
  assert.equal(august.tzid, "Europe/Dublin");
  assert.match(august.sunrise, /^2026-08-12T04:30:00\.000Z$/);
  assert.equal(august.moonrise, null);
  assert.equal(august.moonPhase, 0.25);
  assert.equal(august.moonIllumination, 0.5);
  assert.deepEqual(august.solarPosition, { azimuth: 142, elevation: 32 });
  assert.equal(august.source, "Sunrise-Sunset.org");
  assert.equal(august.attributionUrl, "https://sunrise-sunset.org/");
  assert.equal(dst.date, "2026-03-29");

  const providerPercent = normalizeSolarYear({
    tzid: "Europe/Dublin",
    days: [{ ...solarRow(), solar_position: {
      sunrise_azimuth: 62.79, sunset_azimuth: 297.1, solar_noon_azimuth: 180, solar_noon_altitude: 51.45
    }, moon_illumination: 0.12 }]
  }, { year: 2026, now: NOW });
  assert.deepEqual(providerPercent[0].solarPosition, { azimuth: 180, elevation: 51.45 });
  assert.equal(providerPercent[0].moonIllumination, 0.0012);
});

test("Sunrise-Sunset rejects malformed/provider-error/future rows without zero-filling events and reuses one solar-window fetch", async () => {
  resetSolarCache();
  const malformed = normalizeSolarYear({ status: "ERROR", results: [solarRow()] }, { year: 2026, now: NOW });
  const invalid = normalizeSolarYear({ results: [{ ...solarRow(), date: "2027-01-01", moon_phase: 2, moon_illumination: -1 }] }, { year: 2026, now: NOW });
  const missingIdentity = normalizeSolarYear({ results: [{ ...solarRow(), date: undefined, tzid: "UTC" }] }, { year: 2026, now: NOW });
  assert.deepEqual(malformed, []);
  assert.deepEqual(invalid, []);
  assert.deepEqual(missingIdentity, []);

  let calls = 0;
  const fetcher = async (input) => {
    calls += 1;
    const url = new URL(input);
    assert.equal(url.origin + url.pathname, SUNRISE_SUNSET_ENDPOINT);
    assert.equal(url.searchParams.get("date_start"), "2026-08-11");
    assert.equal(url.searchParams.get("date_end"), "2026-08-13");
    assert.equal(url.searchParams.get("tz"), "Europe/Dublin");
    assert.equal(url.searchParams.get("time_format"), "iso8601");
    assert.equal(url.searchParams.get("lat"), "53.4129");
    assert.equal(url.searchParams.get("lng"), "-8.2439");
    return responseJson({ status: "OK", results: [solarRow()] });
  };
  await fetchSolarWindow({ year: 2026, now: NOW, fetcher });
  await fetchSolarWindow({ year: 2026, now: NOW + 60_000, fetcher });
  assert.equal(calls, 1);

  resetSolarCache();
  await assert.rejects(
    fetchSolarWindow({ year: 2027, now: NOW, fetcher: async () => new Response("upstream", { status: 503 }) }),
    /returned 503/
  );
  const oversized = "{" + "\"x\":" + "\"" + "x".repeat(768_000) + "\"}";
  await assert.rejects(
    fetchSolarWindow({ year: 2028, now: NOW, fetcher: async () => new Response(oversized) }),
    /body-too-large/
  );
});

const metBody = (issued = "2026-08-12T10:00:00.000Z") => ({
  forecasts: [{
    regions: [{
      region: "National",
      issued,
      today: "Dry at first. Rain &amp; showers later.",
      tonight: "Cloudy with occasional rain.",
      tomorrow: "Bright spells.",
      outlook: "The official outlook copy remains unchanged."
    }]
  }]
});

test("Met Éireann singleton forecast is fresh, verbatim in meaning, and selects the Dublin period deterministically", () => {
  const forecast = normalizeMetForecast(metBody(), NOW);
  assert.ok(forecast);
  assert.equal(forecast.today, "Dry at first. Rain & showers later.");
  assert.equal(forecast.source, "Met Éireann");
  assert.equal(forecast.sourceUrl, MET_FORECAST_ENDPOINT);
  assert.equal(forecast.datasetUrl, "https://data.gov.ie/dataset/met-eireann-live-text-forecast-data");
  assert.equal(selectForecastPeriod(forecast, Date.parse("2026-08-12T11:00:00.000Z")).period, "today");
  assert.equal(selectForecastPeriod(forecast, Date.parse("2026-08-12T18:00:00.000Z")).period, "tonight");

  const singletonForecast = normalizeMetForecast({ forecasts: [{ regions: [
    { region: "National" }, { issued: "2026-08-12T10:00:00.000Z" },
    { today: "Exact singleton today." }, { tonight: "Exact singleton tonight." },
    { tomorrow: "Exact singleton tomorrow." }, { outlook: "Exact singleton outlook." }
  ] }] }, NOW);
  assert.ok(singletonForecast);
  assert.equal(singletonForecast.tonight, "Exact singleton tonight.");

  assert.equal(normalizeMetForecast({ forecasts: [{ regions: [] }] }, NOW), null);
  assert.equal(normalizeMetForecast(metBody("2026-08-11T17:59:59.000Z"), NOW), null);
  assert.equal(normalizeMetForecast(metBody("2026-08-12T12:11:00.000Z"), NOW), null);
  assert.equal(assessMetForecast(metBody("2026-08-11T17:59:59.000Z"), NOW).status, "stale");
  assert.equal(assessMetForecast(metBody("2026-08-12T12:11:00.000Z"), NOW).status, "unavailable");
});

test("Met Éireann fetch rejects provider errors and bounded oversized bodies", async () => {
  resetMetForecastCache();
  await assert.rejects(
    fetchMetForecast({ now: NOW, fetcher: async () => new Response("no", { status: 503 }) }),
    /returned 503/
  );
  const oversized = "{" + "\"forecasts\":[{" + "\"regions\":[{" + "\"issued\":\"2026-08-12T10:00:00Z\",\"today\":\"" + "x".repeat(MET_FORECAST_BODY_LIMIT) + "\"}]}]}";
  await assert.rejects(
    fetchMetForecast({ now: NOW, fetcher: async () => new Response(oversized) }),
    /body-too-large/
  );
  resetMetForecastCache();
  await fetchMetForecast({ now: NOW, fetcher: async () => responseJson(metBody()) });
  await assert.rejects(
    fetchMetForecast({ now: NOW + MET_FORECAST_CACHE_MS + 1, fetcher: async () => new Response("broken", { status: 503 }) }),
    /returned 503/
  );

  const overlong = metBody();
  overlong.forecasts[0].regions[0].today = "x".repeat(8_001);
  assert.equal(normalizeMetForecast(overlong, NOW), null);
});
