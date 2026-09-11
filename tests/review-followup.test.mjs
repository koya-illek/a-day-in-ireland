import assert from "node:assert/strict";
import test from "node:test";
import {
  CONTEXT_REFRESH_RATE,
  NTA_VEHICLE_CAP,
  acquireRiverRaw,
  allowContextRefresh,
  currentContexts,
  fetchTransit,
  handleApiRequest,
  healthResponse,
  parseContextSources,
  resetContextRefreshState
} from "../platform/api-core.js";
import { ContextFeedCoordinator, RiverFeedCoordinator } from "../platform/cloudflare-entry.js";

test("a 1,200-vehicle NTA payload is live after the raised cap", async () => {
  const now = Date.now();
  const entity = (index) => ({
    id: `vehicle-${index}`,
    vehicle: {
      vehicle: { id: `vehicle-${index}`, label: String(index) },
      trip: { routeId: "7" },
      position: { latitude: 53.3, longitude: -7.2 },
      timestamp: Math.floor(now / 1000)
    }
  });
  const result = await fetchTransit(
    { NTA_API_KEY: "test-key" },
    async () => Response.json({ entity: Array.from({ length: 1_200 }, (_, index) => entity(index)) }),
    now
  );
  assert.equal(result.status, "live");
  assert.equal(result.truncated, undefined);
  assert.equal(result.vehicles.length, 1_200);
  assert.ok(NTA_VEHICLE_CAP > 1_200);
});

test("an oversized NTA payload is labelled partial when truncated", async () => {
  const now = Date.now();
  const entity = (index) => ({
    id: `vehicle-${index}`,
    vehicle: {
      vehicle: { id: `vehicle-${index}`, label: String(index) },
      trip: { routeId: "7" },
      position: { latitude: 53.3, longitude: -7.2 },
      timestamp: Math.floor(now / 1000)
    }
  });
  const result = await fetchTransit(
    { NTA_API_KEY: "test-key" },
    async () => Response.json({ entity: Array.from({ length: NTA_VEHICLE_CAP + 5 }, (_, index) => entity(index)) }),
    now
  );
  assert.equal(result.status, "partial");
  assert.equal(result.truncated, true);
  assert.equal(result.vehicles.length, NTA_VEHICLE_CAP);
});

test("context sources query is parsed and rejected honestly", () => {
  assert.deepEqual(parseContextSources("https://day.illek.ie/api/contexts").names, null);
  assert.deepEqual(
    parseContextSources("https://day.illek.ie/api/contexts?sources=warnings,radar").names,
    ["warnings", "radar"]
  );
  const unknown = parseContextSources("https://day.illek.ie/api/contexts?sources=flights");
  assert.match(unknown.error, /Unknown source name/);
});

test("context sources filters fan-out before upstream refresh", async () => {
  resetContextRefreshState();
  const originalFetch = globalThis.fetch;
  const urls = [];
  globalThis.fetch = async (input) => {
    urls.push(String(input));
    return new Response("upstream unavailable", { status: 503 });
  };
  try {
    const response = await currentContexts({}, {
      request: new Request("https://day.illek.ie/api/contexts?sources=warnings")
    });
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.deepEqual(Object.keys(body.contextStatus), ["warnings"]);
    assert.equal(body.marine, undefined);
    assert.ok(urls.some((url) => url.includes("warning_IRELAND.json")));
    assert.equal(urls.some((url) => url.includes("earthquake.usgs.gov")), false);
    assert.equal(urls.some((url) => url.includes("erddap.marine.ie")), false);
  } finally {
    globalThis.fetch = originalFetch;
    resetContextRefreshState();
  }
});

test("expensive context misses are rate-limited per IP", () => {
  const rate = { windowStart: 0, byIp: new Map() };
  const now = 1_000_000;
  for (let index = 0; index < CONTEXT_REFRESH_RATE.maxPerIp; index += 1) {
    assert.equal(allowContextRefresh("203.0.113.9", now, rate), true);
  }
  assert.equal(allowContextRefresh("203.0.113.9", now, rate), false);
  assert.equal(allowContextRefresh("203.0.113.10", now, rate), true);
  assert.equal(allowContextRefresh("203.0.113.9", now + CONTEXT_REFRESH_RATE.windowMs, rate), true);
});

test("health reports Cloudflare version metadata as the deployment id from env", async () => {
  const response = healthResponse({
    EDGE_RUNTIME: "cloudflare",
    CF_VERSION_METADATA: { id: "7a6e1c88-d211-47e0-ae3b-10afe49c1142" }
  });
  const body = await response.json();
  assert.equal(body.build.deploymentId, "7a6e1c88-d211-47e0-ae3b-10afe49c1142");
  assert.equal(body.runtime, "cloudflare-worker");
  assert.equal(body.storage.contextCoordinator, false);
});

test("shared context coordinator coalesces cache across requests", async () => {
  resetContextRefreshState();
  const originalFetch = globalThis.fetch;
  let warningCalls = 0;
  globalThis.fetch = async (input) => {
    if (String(input).includes("warning_IRELAND.json")) {
      warningCalls += 1;
      return Response.json([]);
    }
    return new Response("upstream unavailable", { status: 503 });
  };
  const storage = new Map();
  const coordinator = new ContextFeedCoordinator({
    storage: {
      get: async (key) => storage.get(key),
      put: async (key, value) => storage.set(key, value)
    }
  }, {});
  try {
    const first = await coordinator.fetch(new Request("https://internal/contexts?sources=warnings"));
    const second = await coordinator.fetch(new Request("https://internal/contexts?sources=warnings"));
    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    assert.equal(warningCalls, 1);
    assert.ok(storage.has("sourceCache"));
  } finally {
    globalThis.fetch = originalFetch;
    resetContextRefreshState();
  }
});

test("OPW browser fallback is skipped when a fresh snapshot already exists", async () => {
  const originalFetch = globalThis.fetch;
  let browserCalls = 0;
  globalThis.fetch = async () => new Response("blocked", { status: 403 });
  const env = {
    EDGE_RUNTIME: "cloudflare",
    BROWSER: {
      quickAction: async () => {
        browserCalls += 1;
        return new Response("{}", { status: 200 });
      }
    }
  };
  try {
    await assert.rejects(
      () => acquireRiverRaw(env, fetch, { allowBrowserFallback: false }),
      /Browser Run fallback skipped/
    );
    assert.equal(browserCalls, 0);

    const observedAt = new Date().toISOString();
    const storage = new Map([["snapshot", {
      expiresAt: 0,
      rivers: [{ id: "g1", name: "Gauge", latitude: 53, longitude: -8, level: 1.2, observedAt }],
      status: "fallback",
      provenance: { status: "fallback", provider: "OPW waterlevel.ie" }
    }]]);
    const coordinator = new RiverFeedCoordinator({
      storage: {
        get: async (key) => storage.get(key),
        put: async (key, value) => storage.set(key, value)
      }
    }, env);
    const result = await coordinator.fetch(new Request("https://internal/rivers"));
    const body = await result.json();
    assert.equal(browserCalls, 0);
    assert.ok(
      ["stale", "fallback", "unavailable"].includes(body.status),
      `expected non-live status, got ${JSON.stringify(body)}`
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("POST /mcp is not dispatched as an API transport", async () => {
  const response = await handleApiRequest(
    new Request("https://day.illek.ie/mcp", { method: "POST", body: "{}" }),
    {},
    {}
  );
  assert.equal(response, undefined);
});
