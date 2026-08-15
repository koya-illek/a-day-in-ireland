import assert from "node:assert/strict";
import test from "node:test";

const methods = ["OPTIONS", "POST", "PUT", "DELETE"];

test("local API health rejects provider-invoking methods before dispatch", async () => {
  const { default: worker } = await import("../platform/server-entry.js?api-boundary=local");
  for (const method of methods) {
    const response = await worker.fetch(new Request("https://day.illek.ie/api/health", { method }), {});
    assert.equal(response.status, method === "OPTIONS" ? 204 : 405, method);
    assert.equal(response.headers.get("allow"), "GET, HEAD, OPTIONS");
  }
});

test("Cloudflare API health has a cheap method boundary", async () => {
  const { default: worker } = await import("../platform/cloudflare-entry.js?api-boundary=edge");
  for (const method of methods) {
    const response = await worker.fetch(new Request("https://day.illek.ie/api/health", { method }), {});
    assert.equal(response.status, method === "OPTIONS" ? 204 : 405, method);
    assert.equal(response.headers.get("allow"), "GET, HEAD, OPTIONS");
  }
});
