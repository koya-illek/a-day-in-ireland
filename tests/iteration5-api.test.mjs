import assert from "node:assert/strict";
import test from "node:test";

test("Cloudflare transit failures keep the JSON/CORS/no-store error contract", async () => {
  const { default: worker } = await import("../platform/cloudflare-entry.js?iteration5-transit-fault");
  const rejectingCoordinator = {
    fetch: () => Promise.reject(new Error("durable object storage fault"))
  };
  const env = { NTA_FEED: { getByName: () => rejectingCoordinator } };
  const response = await worker.fetch(new Request("https://day.illek.ie/api/transit"), env);
  assert.equal(response.status, 503);
  const body = await response.json();
  assert.match(body.error, /temporarily unavailable/);
  assert.equal(response.headers.get("content-type"), "application/json; charset=utf-8");
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("access-control-allow-origin"), "*");
  assert.equal(response.headers.get("x-robots-tag"), "noindex, nofollow");
});

test("alternate adapter answers unknown API paths with JSON instead of crashing or soft-200ing", async () => {
  const { default: worker } = await import("../platform/server-entry.js?iteration5-unknown-api");
  // No ASSETS binding at all: the former fallthrough raised a TypeError.
  for (const path of ["/api/history", "/api/nonsense"]) {
    const response = await worker.fetch(new Request(`https://day.illek.ie${path}`), {});
    assert.equal(response.status, 404, path);
    const body = await response.json();
    assert.ok(body.error, path);
    assert.equal(response.headers.get("content-type"), "application/json; charset=utf-8");
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(response.headers.get("access-control-allow-origin"), "*");
    assert.equal(response.headers.get("x-robots-tag"), "noindex, nofollow");
  }
});
