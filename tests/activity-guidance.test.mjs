import assert from "node:assert/strict";
import test from "node:test";

const { getActivityGuidance } = await import("../lib/activity-guidance.ts");

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

const baseSnapshot = (overrides = {}) => ({
  generatedAt: observedAt,
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
    measuredAir: "unavailable",
    tides: "unavailable",
    bathing: "unavailable",
    satellite: "unavailable",
    earthquakes: "unavailable",
    iss: "unavailable"
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

const byId = (guidance, id) => guidance.find((item) => item.id === id);

test("keeps the four intent cards in stable order and ignores input array order", () => {
  const snapshot = baseSnapshot({
    marine: [{
      id: "mace-head",
      name: "Mace Head",
      kind: "coastal-observatory",
      latitude: 53.33,
      longitude: -9.9,
      observedAt,
      windSpeedKnots: 8,
      waveHeight: 0.5,
      wavePeriod: 6,
      seaTemperature: 15
    }],
    contextStatus: {
      ...baseSnapshot().contextStatus,
      marine: "live",
      tides: "live",
      bathing: "live",
      iss: "live"
    },
    aurora: { observedAt, forecastAt: observedAt, probability: 80, kpIndex: 5 },
    iss: {
      observedAt,
      latitude: 53,
      longitude: -8,
      altitudeKm: 420,
      passes: [{
        startsAt: "2026-08-02T21:10:00.000Z",
        peaksAt: "2026-08-02T21:15:00.000Z",
        endsAt: "2026-08-02T21:20:00.000Z",
        maxElevation: 65,
        visible: true,
        direction: "SW to NE"
      }]
    },
    transitStatus: "live",
    trains: [{
      id: "train-1",
      latitude: 53.3,
      longitude: -7.2,
      status: "running",
      direction: "Dublin",
      message: "",
      observedAt,
      speedKmh: null,
      speedSource: null
    }],
    transit: [{
      id: "bus-1",
      latitude: 53.3,
      longitude: -6.2,
      route: "15",
      label: "15",
      bearing: null,
      speedKmh: null,
      speedSource: null,
      observedAt
    }]
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
  assert.equal(first.length, 4);
  assert.deepEqual(first.map((item) => item.id), ["outdoor-walk", "coast", "stargazing", "travel"]);
  assert.ok(first.every((item) => !Object.hasOwn(item, "score")));
  assert.ok(first.every((item) => item.status && item.reason && item.caveat));
  assert.match(byId(first, "coast").caveat, /quality recommendation/);
  assert.match(byId(first, "stargazing").caveat, /viewing conditions/);
  assert.match(byId(first, "travel").caveat, /not schedules/);
});

test("surfaces warnings and bathing alerts as caveats instead of safety claims", () => {
  const snapshot = baseSnapshot({
    warnings: [{
      level: "Orange",
      headline: "Wind warning",
      description: "Strong winds",
      onset: "2026-08-02T18:00:00.000Z",
      expiry: "2026-08-03T02:00:00.000Z"
    }],
    bathingAlerts: [{
      id: "alert-1",
      name: "Keem Beach",
      county: "Mayo",
      latitude: 53.93,
      longitude: -10.06,
      restriction: "Do not swim",
      description: "Test notice",
      startedAt: observedAt,
      updatedAt: observedAt,
      noticeUrl: null
    }],
    contextStatus: {
      ...baseSnapshot().contextStatus,
      bathing: "live"
    }
  });
  const guidance = getActivityGuidance(snapshot, now);
  const walk = byId(guidance, "outdoor-walk");
  const coast = byId(guidance, "coast");
  assert.equal(walk.status, "caution");
  assert.match(walk.caveat, /active Met Éireann notice/);
  assert.doesNotMatch(walk.caveat, /Wind warning/);
  assert.match(walk.caveat, /not a forecast or a safety assessment/);
  assert.equal(coast.status, "caution");
  assert.match(coast.caveat, /bathing-water alert/);
  assert.doesNotMatch(coast.reason, /safe|unsafe/i);
});

test("does not label a walk favourable when the official warning feed is unavailable", () => {
  const guidance = getActivityGuidance(baseSnapshot({
    contextStatus: {
      ...baseSnapshot().contextStatus,
      warnings: "unavailable"
    }
  }), now);
  const walk = byId(guidance, "outdoor-walk");
  assert.equal(walk.status, "caution");
  assert.match(walk.caveat, /notice feed is unavailable/);
  assert.match(walk.caveat, /warnings cannot be assessed/);
});

test("uses only current warnings and bathing alerts as evidence", () => {
  const guidance = getActivityGuidance(baseSnapshot({
    warnings: [
      {
        level: "Yellow",
        headline: "Current warning",
        description: "Active",
        onset: "2026-08-02T20:00:00.000Z",
        expiry: "2026-08-02T22:00:00.000Z"
      },
      {
        level: "Orange",
        headline: "Future warning",
        description: "Not started",
        onset: "2026-08-02T22:00:00.000Z",
        expiry: "2026-08-03T02:00:00.000Z"
      },
      {
        level: "Red",
        headline: "Expired warning",
        description: "Finished",
        onset: "2026-08-02T18:00:00.000Z",
        expiry: "2026-08-02T20:59:00.000Z"
      }
    ],
    bathingAlerts: [
      {
        id: "future-alert",
        name: "Future Beach",
        county: "Mayo",
        latitude: 53.9,
        longitude: -10,
        restriction: "Test notice",
        description: "Not started",
        startedAt: "2026-08-02T22:00:00.000Z",
        updatedAt: "2026-08-02T22:00:00.000Z",
        noticeUrl: null
      },
      {
        id: "current-alert",
        name: "Current Beach",
        county: "Mayo",
        latitude: 53.9,
        longitude: -10,
        restriction: "Test notice",
        description: "Active",
        startedAt: "2026-08-02T20:00:00.000Z",
        updatedAt: "2026-08-02T20:30:00.000Z",
        noticeUrl: null
      }
    ],
    contextStatus: {
      ...baseSnapshot().contextStatus,
      bathing: "live"
    }
  }), now);
  const walk = byId(guidance, "outdoor-walk");
  const coast = byId(guidance, "coast");
  assert.match(walk.caveat, /active Met Éireann notice/);
  assert.doesNotMatch(walk.caveat, /Future warning|Expired warning/);
  assert.match(coast.reason, /1 current bathing-water alert/);
  assert.match(coast.caveat, /1 bathing-water alert/);
  assert.doesNotMatch(`${coast.reason} ${coast.caveat}`, /Future Beach/);
});

test("returns truthful unavailable results when opportunity data is missing or stale", () => {
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
  assert.ok(guidance.every((item) => !Object.hasOwn(item, "score")));
  assert.match(byId(guidance, "stargazing").caveat, /ISS data is unavailable/);
  assert.match(byId(guidance, "coast").caveat, /bathing-alert feed is unavailable/);
  assert.ok(guidance.every((item) => !/safe|guarantee/i.test(`${item.reason} ${item.caveat}`)));
});

test("ignores residual observations when their providers are unavailable", () => {
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
