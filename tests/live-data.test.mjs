import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("project declares production scripts", async () => {
  const packageJson = await import("../package.json", { with: { type: "json" } });
  assert.match(packageJson.default.scripts.build, /^next build/);
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
});
