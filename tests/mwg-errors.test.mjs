import assert from "node:assert/strict";
import test from "node:test";
import { acquireRiverRaw, handleApiRequest } from "../platform/api-core.js";

const denied = async () => new Response("blocked", { status: 403 });
test("river browser wrapping retains causes without changing the outer message", async () => {
  const inner = new Error("fixture browser failure");
  await assert.rejects(acquireRiverRaw({ EDGE_RUNTIME: "cloudflare", BROWSER: { quickAction: async () => { throw inner; } } }, denied), error => {
    assert.equal(error.message, "OPW returned 403: blocked; Browser Run fallback failed: fixture browser failure");
    assert.equal(error.cause, inner);
    return true;
  });
});
test("malformed browser JSON keeps its parse cause through both wrappers", async () => {
  await assert.rejects(acquireRiverRaw({ EDGE_RUNTIME: "cloudflare", BROWSER: { quickAction: async () => new Response("<pre>not JSON</pre>") } }, denied), error => {
    assert.match(error.message, /OPW returned 403: blocked; Browser Run fallback failed:/);
    assert.match(error.cause.message, /response starts "not JSON"/);
    assert.ok(error.cause.cause instanceof SyntaxError);
    return true;
  });
});
test("configured bridge wrapping preserves the original bounded message and cause", async () => {
  const inner = new Error("fixture bridge failure");
  await assert.rejects(acquireRiverRaw({ RIVER_BRIDGE_URL: "https://bridge.example/river" }, async url => String(url).includes("bridge.example") ? Promise.reject(inner) : denied()), error => {
    assert.equal(error.message, "OPW returned 403: blocked; fallback unavailable (fixture bridge failure)");
    assert.equal(error.cause, inner);
    return true;
  });
});
test("public API failure sanitization never emits internal wrapped causes", async () => {
  const original = console.error;
  console.error = () => {};
  try {
    const response = await handleApiRequest(new Request("https://day.example/api/living"), {}, { living: async () => { throw new Error("internal outer", { cause: new Error("private fixture cause") }); } });
    assert.equal(response.status, 503);
    const body = await response.text();
    assert.ok(!body.includes("internal outer"));
    assert.ok(!body.includes("private fixture cause"));
    assert.ok(!body.includes('"cause"'));
  } finally { console.error = original; }
});
