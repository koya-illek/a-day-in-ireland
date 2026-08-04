import assert from "node:assert/strict";
import test from "node:test";

const { getActivityGuidance } = await import("../lib/activity-guidance.ts");
const {
  normalizeOfficialWeatherWarnings,
  sortOfficialWeatherWarnings
} = await import("../platform/river-source.js");

const now = new Date("2026-08-02T21:00:00.000Z");
const observedAt = "2026-08-02T20:30:00.000Z";

const station = (overrides = {}) => ({
  id: "athenry",
  name: "Athenry",
  latitude: 53.289,
  longitude: -8.786,
  temperature: 16,
  rainfall: 0,
  windSpeed: 12,
  windDirection: "W",
  description: "Clear",
  observedAt,
  fresh: true,
  ...overrides
});

const warning = (overrides = {}) => ({
  id: "warning-1",
  capId: "cap-1",
  type: "yellow; Moderate",
  severity: "Moderate",
  certainty: "Likely",
  regions: [],
  status: "Warning",
  issued: observedAt,
  updated: observedAt,
  level: "Yellow",
  headline: "Rain warning",
  description: "Heavy rain",
  onset: "2026-08-02T20:00:00.000Z",
  expiry: "2026-08-03T02:00:00.000Z",
  ...overrides
});

const baseSnapshot = (overrides = {}) => ({
  generatedAt: observedAt,
  lastSuccessAt: observedAt,
  sourceStatus: "live",
  stations: [station()],
  warnings: [],
  marine: [],
  trains: [],
  rivers: [],
  radar: [],
  grid: null,
  airQuality: [],
  aurora: null,
  tides: [],
  bathingAlerts: [],
  iss: null,
  issTle: null,
  satellite: null,
  earthquakes: [],
  transit: [],
  transitStatus: "credential-required",
  contextStatus: {
    marine: "unavailable",
    radar: "unavailable",
    grid: "unavailable",
    measuredAir: "unavailable",
    modelledAir: "unavailable",
    aurora: "unavailable",
    tides: "unavailable",
    bathing: "unavailable",
    satellite: "unavailable",
    earthquakes: "unavailable",
    iss: "unavailable",
    warnings: "live"
  },
  sourceProvenance: {
    trains: { provider: "Irish Rail", endpoint: "", status: "unavailable", fetchedAt: observedAt, latestObservedAt: null, fallback: null },
    rivers: { provider: "OPW", endpoint: "", status: "unavailable", fetchedAt: observedAt, latestObservedAt: null, fallback: null }
  },
  summary: {
    warmest: null,
    wettest: null,
    windiest: null,
    reporting: 1,
    runningTrains: 0,
    riverStations: 0
  },
  timeline: [],
  ...overrides
});

const cork = { id: "cork", name: "Cork", latitude: 51.8985, longitude: -8.4756 };
const dublin = { id: "dublin", name: "Dublin", latitude: 53.3498, longitude: -6.2603 };
const mayo = { id: "mayo", name: "Mayo", latitude: 53.76, longitude: -9.25 };
const byId = (guidance, id) => guidance.find((item) => item.id === id);

test("keeps the four intent cards in stable order and uses descriptive states", () => {
  const snapshot = baseSnapshot({
    marine: [{
      id: "mace-head", name: "Mace Head", kind: "coastal-observatory", latitude: 53.33, longitude: -9.9,
      observedAt, windSpeedKnots: 8, waveHeight: 0.5, wavePeriod: 6, seaTemperature: 15
    }],
    contextStatus: { ...baseSnapshot().contextStatus, marine: "live", aurora: "live", tides: "live", bathing: "live", iss: "live" },
    aurora: { observedAt, forecastAt: observedAt, probability: 80, kpIndex: 5 },
    iss: {
      observedAt, latitude: 53, longitude: -8, altitudeKm: 420,
      passes: [{ startsAt: "2026-08-02T21:10:00.000Z", peaksAt: "2026-08-02T21:15:00.000Z", endsAt: "2026-08-02T21:20:00.000Z", maxElevation: 65, visible: true, direction: "SW to NE" }]
    },
    transitStatus: "live",
    trains: [
      { id: "train-1", latitude: 53.3, longitude: -7.2, status: "running", direction: "Dublin", message: "", observedAt, speedKmh: null, speedSource: null },
      { id: "train-2", latitude: 52.7, longitude: -6.8, status: "stopped", direction: "Cork", message: "", observedAt, speedKmh: null, speedSource: null }
    ],
    transit: [
      { id: "bus-1", latitude: 53.3, longitude: -6.2, route: "15", label: "15", bearing: null, speedKmh: null, speedSource: null, observedAt },
      { id: "bus-2", latitude: 51.9, longitude: -8.5, route: "202", label: "202", bearing: null, speedKmh: null, speedSource: null, observedAt }
    ]
  });

  const first = getActivityGuidance(snapshot, now);
  const second = getActivityGuidance({
    ...snapshot,
    stations: [...snapshot.stations].reverse(),
    marine: [...snapshot.marine].reverse(),
    trains: [...snapshot.trains].reverse(),
    transit: [...snapshot.transit].reverse()
  }, now);
  assert.deepEqual(first, second);
  assert.deepEqual(first.map((item) => item.id), ["outdoor-walk", "coast", "stargazing", "travel"]);
  assert.ok(first.every((item) => item.status && item.reason && item.caveat));
  assert.ok(first.every((item) => !["favourable", "mixed", "caution"].includes(item.status)));
  assert.match(byId(first, "coast").caveat, /quality recommendation/);
  assert.match(byId(first, "stargazing").caveat, /viewing conditions/);
  assert.match(byId(first, "travel").status, /live-coverage/);
});

test("an active Blight Advisory remains factual and does not create a walk notice state", () => {
  const guidance = getActivityGuidance(baseSnapshot({
    warnings: [warning({ id: "blight", capId: "cap-blight", type: "yellow; Moderate; Blight", headline: "Blight Advisory", description: "A potato blight advisory is in effect." })]
  }), now);
  const walk = byId(guidance, "outdoor-walk");
  assert.equal(walk.status, "live-observations");
  assert.match(walk.caveat, /official notice is displayed separately/);
  assert.doesNotMatch(`${walk.reason} ${walk.caveat}`, /caution|hazard/i);
});

test("an active generic Weather Advisory does not change activity state", () => {
  const guidance = getActivityGuidance(baseSnapshot({
    warnings: [warning({
      id: "generic-weather",
      capId: "cap-generic-weather",
      type: "Advisory",
      headline: "Weather Advisory",
      description: "General weather information is available."
    })]
  }), now);
  const walk = byId(guidance, "outdoor-walk");
  assert.equal(walk.status, "live-observations");
  assert.match(walk.caveat, /official notice is displayed separately/);
  assert.doesNotMatch(`${walk.reason} ${walk.caveat}`, /relevant|hazard|caution/i);
});

test("outdoor-walk AQI is scoped to the selected place", () => {
  const airReading = (place, europeanAqi) => ({
    id: `${place.id}-air`,
    name: place.name,
    latitude: place.latitude,
    longitude: place.longitude,
    observedAt,
    europeanAqi,
    pm25: null,
    pm10: null,
    nitrogenDioxide: null,
    ozone: null,
    uvIndex: null,
    grassPollen: null,
    source: "modelled",
    stationClassification: null
  });
  const snapshot = baseSnapshot({
    stations: [
      station({ id: "cork-weather", name: "Cork", latitude: cork.latitude, longitude: cork.longitude }),
      station({ id: "dublin-weather", name: "Dublin", latitude: dublin.latitude, longitude: dublin.longitude })
    ],
    airQuality: [airReading(cork, 180), airReading(dublin, 24)]
  });

  const corkReason = byId(getActivityGuidance(snapshot, now, cork), "outdoor-walk").reason;
  const dublinReason = byId(getActivityGuidance(snapshot, now, dublin), "outdoor-walk").reason;
  const islandReason = byId(getActivityGuidance(snapshot, now), "outdoor-walk").reason;
  assert.match(corkReason, /highest European AQI near Cork was 180/);
  assert.doesNotMatch(corkReason, /24/);
  assert.match(dublinReason, /highest European AQI near Dublin was 24/);
  assert.doesNotMatch(dublinReason, /180/);
  assert.match(islandReason, /highest European AQI across Ireland was 180/);
});

test("an active relevant warning is scoped to a selected place", () => {
  const guidance = getActivityGuidance(baseSnapshot({
    stations: [station({ id: "cork", name: "Cork", latitude: cork.latitude, longitude: cork.longitude })],
    warnings: [warning({ headline: "Rain warning for Cork", description: "Heavy rain in Cork", regions: ["Cork"] })]
  }), now, cork);
  const walk = byId(guidance, "outdoor-walk");
  assert.equal(walk.status, "relevant-notice");
  assert.match(walk.caveat, /activity-relevant Met Éireann notice/);
  assert.match(walk.place, /Cork/);
});

test("future warning is useful notice data but does not affect current guidance", () => {
  const future = warning({
    id: "future-rain",
    onset: "2026-08-02T22:00:00.000Z",
    expiry: "2026-08-03T02:00:00.000Z"
  });
  const normalized = normalizeOfficialWeatherWarnings([future], now.getTime());
  assert.equal(normalized.length, 1);
  const guidance = getActivityGuidance(baseSnapshot({ warnings: normalized }), now);
  assert.equal(byId(guidance, "outdoor-walk").status, "live-observations");
});

test("warning feed unavailable maps to limited context, never caution", () => {
  const guidance = getActivityGuidance(baseSnapshot({
    contextStatus: { ...baseSnapshot().contextStatus, warnings: "unavailable" }
  }), now);
  const walk = byId(guidance, "outdoor-walk");
  assert.equal(walk.status, "limited-context");
  assert.match(walk.caveat, /notice feed is unavailable/);
  assert.notEqual(walk.status, "caution");
});

test("bathing alerts stay localized and do not affect an unrelated selected place", () => {
  const snapshot = baseSnapshot({
    marine: [{ id: "cork-buoy", name: "Cork coast", kind: "coastal-observatory", latitude: 51.9, longitude: -8.47, observedAt, windSpeedKnots: 6, waveHeight: null, wavePeriod: null, seaTemperature: 15 }],
    bathingAlerts: [{ id: "mayo-alert", name: "Mayo beach", county: "Mayo", latitude: mayo.latitude, longitude: mayo.longitude, restriction: "Advisory", description: "Test", startedAt: observedAt, updatedAt: observedAt, noticeUrl: null }],
    contextStatus: { ...baseSnapshot().contextStatus, marine: "live", bathing: "live" }
  });
  assert.equal(byId(getActivityGuidance(snapshot, now, cork), "coast").status, "live-observations");
  assert.equal(byId(getActivityGuidance(snapshot, now), "coast").status, "localized-notice");
});

test("future bathing alerts are ignored by current coast guidance", () => {
  const guidance = getActivityGuidance(baseSnapshot({
    bathingAlerts: [
      { id: "future-alert", name: "Future Beach", county: "Mayo", latitude: mayo.latitude, longitude: mayo.longitude, restriction: "Test notice", description: "Not started", startedAt: "2026-08-02T22:00:00.000Z", updatedAt: "2026-08-02T22:00:00.000Z", noticeUrl: null },
      { id: "current-alert", name: "Current Beach", county: "Mayo", latitude: mayo.latitude, longitude: mayo.longitude, restriction: "Test notice", description: "Active", startedAt: "2026-08-02T20:00:00.000Z", updatedAt: "2026-08-02T20:30:00.000Z", noticeUrl: null }
    ],
    contextStatus: { ...baseSnapshot().contextStatus, bathing: "live" }
  }), now);
  const coast = byId(guidance, "coast");
  assert.equal(coast.status, "localized-notice");
  assert.match(coast.reason, /1 current bathing-water alert/);
  assert.match(coast.caveat, /1 bathing-water alert/);
  assert.doesNotMatch(`${coast.reason} ${coast.caveat}`, /Future Beach/);
});

test("zero aurora probability is no current signal, not Mixed signals", () => {
  const guidance = getActivityGuidance(baseSnapshot({
    aurora: { observedAt, forecastAt: observedAt, probability: 0, kpIndex: 1 },
    contextStatus: { ...baseSnapshot().contextStatus, aurora: "live", iss: "live" }
  }), now);
  const stargazing = byId(guidance, "stargazing");
  assert.equal(stargazing.status, "no-current-signal");
  assert.match(stargazing.reason, /no aurora signal/i);
  assert.doesNotMatch(stargazing.status, /mixed/i);
});

test("travel positions are live coverage, not a quality verdict", () => {
  const guidance = getActivityGuidance(baseSnapshot({
    sourceProvenance: { ...baseSnapshot().sourceProvenance, trains: { ...baseSnapshot().sourceProvenance.trains, status: "live" } },
    trains: [{ id: "train-1", latitude: 53.3, longitude: -7.2, status: "running", direction: "Dublin", message: "", observedAt, speedKmh: null, speedSource: null }]
  }), now);
  const travel = byId(guidance, "travel");
  assert.equal(travel.status, "live-coverage");
  assert.match(travel.caveat, /journey suitability/);
  assert.doesNotMatch(`${travel.reason} ${travel.caveat}`, /favourable|mixed|caution/i);
});

test("stale or missing opportunity data yields unavailable states with limited context where applicable", () => {
  const guidance = getActivityGuidance(baseSnapshot({
    stations: [station({ fresh: false, observedAt: "2026-08-02T12:00:00.000Z" })],
    contextStatus: {
      ...baseSnapshot().contextStatus,
      bathing: "unavailable",
      tides: "unavailable",
      iss: "unavailable"
    }
  }), now);
  assert.deepEqual(guidance.map((item) => item.status), ["unavailable", "unavailable", "unavailable", "unavailable"]);
  assert.match(byId(guidance, "stargazing").caveat, /ISS data is unavailable/);
  assert.match(byId(guidance, "coast").caveat, /bathing-alert feed is unavailable/);
  assert.ok(guidance.every((item) => !/safe|guarantee/i.test(`${item.reason} ${item.caveat}`)));

  const limited = getActivityGuidance(baseSnapshot({
    contextStatus: { ...baseSnapshot().contextStatus, warnings: "unavailable" }
  }), now);
  assert.equal(byId(limited, "outdoor-walk").status, "limited-context");
  assert.match(byId(limited, "outdoor-walk").caveat, /notice feed is unavailable/);
});

test("residual observations from fallback or unavailable providers are ignored", () => {
  const snapshot = baseSnapshot({
    sourceStatus: "fallback",
    marine: [{
      id: "old-provider-value",
      name: "Residual observatory",
      kind: "coastal-observatory",
      latitude: 53,
      longitude: -9,
      observedAt,
      windSpeedKnots: 4,
      waveHeight: 0.2,
      wavePeriod: 5,
      seaTemperature: 15
    }],
    trains: [{
      id: "residual-train",
      latitude: 53,
      longitude: -8,
      status: "running",
      direction: "Dublin",
      message: "",
      observedAt,
      speedKmh: null,
      speedSource: null
    }],
    sourceProvenance: {
      trains: { provider: "Irish Rail", endpoint: "", status: "unavailable", fetchedAt: observedAt, latestObservedAt: null, fallback: null },
      rivers: { provider: "OPW", endpoint: "", status: "unavailable", fetchedAt: observedAt, latestObservedAt: null, fallback: null }
    },
    contextStatus: {
      ...baseSnapshot().contextStatus,
      marine: "unavailable"
    }
  });

  const guidance = getActivityGuidance(snapshot, now);
  assert.equal(byId(guidance, "outdoor-walk").status, "unavailable");
  assert.equal(byId(guidance, "coast").status, "unavailable");
  assert.equal(byId(guidance, "travel").status, "unavailable");
});

test("notice ordering is active first, then severity, onset, and stable identity", () => {
  const rows = [
    warning({ id: "upcoming-orange", level: "Orange", onset: "2026-08-02T22:00:00Z", expiry: "2026-08-03T02:00:00Z" }),
    warning({ id: "active-yellow", level: "Yellow", onset: "2026-08-02T20:00:00Z" }),
    warning({ id: "active-red", level: "Red", onset: "2026-08-02T20:30:00Z" }),
    warning({ id: "active-orange", level: "Orange", onset: "2026-08-02T20:45:00Z" })
  ];
  const sorted = sortOfficialWeatherWarnings(rows, now.getTime());
  assert.deepEqual(sorted.map((item) => item.id), ["active-red", "active-orange", "active-yellow", "upcoming-orange"]);
});
