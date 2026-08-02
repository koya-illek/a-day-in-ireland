import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("project declares production scripts", async () => {
  const packageJson = await import("../package.json", { with: { type: "json" } });
  assert.match(packageJson.default.scripts.build, /^next build/);
  assert.match(packageJson.default.scripts.build, /river-source\.js/);
  assert.ok(packageJson.default.scripts["test:e2e"]);
  assert.ok(packageJson.default.scripts["deploy:cloudflare:api"]);
  assert.ok(packageJson.default.scripts["deploy:cloudflare:pages"]);
});

test("hosting project id is persisted", async () => {
  const hosting = await import("../.openai/hosting.json", { with: { type: "json" } });
  assert.match(hosting.default.project_id, /^appgprj_/);
});

test("Cloudflare configuration preserves the free-tier architecture", async () => {
  const config = await readFile(new URL("../wrangler.api.toml", import.meta.url), "utf8");
  assert.match(config, /pattern = "day\.illek\.ie", custom_domain = true/);
  assert.doesNotMatch(config, /cpu_ms\s*=/);
  assert.match(config, /new_sqlite_classes = \["NtaFeedCoordinator"\]/);
  assert.match(config, /new_sqlite_classes = \["RiverFeedCoordinator"\]/);
  assert.match(config, /\[browser\]\s+binding = "BROWSER"/);
  assert.match(config, /EDGE_RUNTIME = "cloudflare"/);
  assert.match(config, /PAGES_ORIGIN = "https:\/\/a-day-in-ireland\.pages\.dev"/);
});

test("NTA coordinator serves a fresh globally stored snapshot without refetching", async () => {
  const { NtaFeedCoordinator } = await import("../platform/cloudflare-entry.js");
  const stored = new Map([
    ["snapshot", {
      expiresAt: Date.now() + 60_000,
      result: {
        status: "live",
        vehicles: [{
          id: "test-vehicle",
          latitude: 53.3,
          longitude: -6.2,
          route: "15",
          label: "15",
          bearing: 180,
          speedKmh: null,
          observedAt: "2026-07-25T12:00:00.000Z"
        }]
      }
    }]
  ]);
  const coordinator = new NtaFeedCoordinator({
    storage: {
      get: async (key) => stored.get(key),
      put: async (key, value) => stored.set(key, value)
    }
  }, {});
  const response = await coordinator.fetch();
  const body = await response.json();
  assert.equal(body.transitStatus, "live");
  assert.equal(body.transit[0].id, "test-vehicle");
});

test("successive vehicle positions produce a bounded calculated speed", async () => {
  const { addEstimatedSpeeds } = await import("../platform/cloudflare-entry.js");
  const previous = [{
    id: "moving-bus",
    latitude: 53.3498,
    longitude: -6.2603,
    observedAt: "2026-07-25T12:00:00.000Z",
    speedKmh: null,
    speedSource: null
  }];
  const current = [{
    ...previous[0],
    latitude: 53.3598,
    observedAt: "2026-07-25T12:02:00.000Z"
  }];
  const [vehicle] = addEstimatedSpeeds(current, previous);
  assert.equal(vehicle.speedSource, "calculated");
  assert.ok(vehicle.speedKmh > 30 && vehicle.speedKmh < 40);

  const [implausible] = addEstimatedSpeeds([{ ...current[0], latitude: 54.3598 }], previous);
  assert.equal(implausible.speedKmh, null);
  assert.equal(implausible.speedSource, null);
});

test("river coordinator reuses a fresh snapshot without spending Browser Run time", async () => {
  const { RiverFeedCoordinator } = await import("../platform/cloudflare-entry.js");
  const stored = new Map([
    ["snapshot", {
      expiresAt: Date.now() + 60_000,
      rivers: [{
        id: "river-test",
        name: "Test gauge",
        latitude: 53.3,
        longitude: -7.2,
        level: 1.2,
        observedAt: new Date().toISOString(),
        fresh: true
      }]
    }]
  ]);
  const coordinator = new RiverFeedCoordinator({
    storage: {
      get: async (key) => stored.get(key),
      put: async (key, value) => stored.set(key, value)
    }
  }, {});
  const response = await coordinator.fetch();
  const body = await response.json();
  assert.equal(body.status, "live");
  assert.equal(body.rivers[0].id, "river-test");
  assert.equal(body.provenance.provider, "OPW waterlevel.ie");
  assert.equal(body.provenance.status, "live");
});

test("shared river parser keeps the newest fresh reading and drops stale or invalid data", async () => {
  const { parseRiverGeoJson } = await import("../platform/river-source.js");
  const now = Date.parse("2026-07-25T12:00:00.000Z");
  const body = {
    features: [
      {
        properties: { sensor_ref: "0001", station_ref: "100", station_name: "Older", value: "1.1", datetime: "2026-07-25T11:00:00.000Z" },
        geometry: { coordinates: [-7.2, 53.3] }
      },
      {
        properties: { sensor_ref: "0001", station_ref: "101", station_name: "Newer", value: "1.7", datetime: "2026-07-25T11:30:00.000Z" },
        geometry: { coordinates: [-7.2, 53.3] }
      },
      {
        properties: { sensor_ref: "0001", station_ref: "102", station_name: "Stale", value: "2.1", datetime: "2026-07-25T07:00:00.000Z" },
        geometry: { coordinates: [-8.2, 54.3] }
      },
      {
        properties: { sensor_ref: "0001", station_ref: "103", station_name: "Invalid", value: "not-a-level", datetime: "2026-07-25T11:00:00.000Z" },
        geometry: { coordinates: [-8.2, 54.3] }
      }
    ]
  };
  const rivers = parseRiverGeoJson(body, now);
  assert.deepEqual(rivers.map((river) => river.id), ["101"]);
  assert.equal(rivers[0].level, 1.7);
  assert.equal(rivers[0].fresh, true);
});
