import assert from "node:assert/strict";
import test from "node:test";
import { CONTEXT_SOURCE_NAMES, openApiDocument } from "../platform/openapi.js";

test("the OpenAPI document is structurally valid and every $ref resolves", () => {
  const document = openApiDocument();
  assert.equal(document.openapi, "3.1.0");
  assert.ok(document.info.title.includes("A Day in Ireland"));
  const schemas = Object.keys(document.components.schemas);
  const resolve = (value) => {
    if (typeof value !== "object" || value === null) return;
    if (typeof value.$ref === "string") {
      assert.match(value.$ref, /^#\/components\/schemas\//);
      assert.ok(schemas.includes(value.$ref.split("/").at(-1)), `dangling ref ${value.$ref}`);
      return;
    }
    for (const child of Object.values(value)) resolve(child);
  };
  resolve(document.paths);
});

test("documented paths cover the deployed API surface exactly", () => {
  const paths = Object.keys(openApiDocument().paths);
  assert.deepEqual(
    [...paths].sort(),
    ["/api/contexts", "/api/health", "/api/history", "/api/history/range", "/api/living", "/api/openapi.json", "/api/transit"].sort()
  );
});

test("documents without history storage omit the history surface instead of advertising it", () => {
  const trimmed = openApiDocument({ history: false });
  const paths = Object.keys(trimmed.paths);
  assert.deepEqual(paths.sort(), ["/api/contexts", "/api/health", "/api/living", "/api/openapi.json", "/api/transit"].sort());
  assert.ok(!trimmed.tags.some((tag) => tag.name === "history"));
  const schemaNames = Object.keys(trimmed.components.schemas);
  for (const name of ["HistoryResolution", "HistoryRangePayload", "HistorySnapshot", "HistoryGap", "HistoryEnvelope"]) {
    assert.ok(!schemaNames.includes(name), `${name} should not be advertised`);
  }
  const resolve = (value) => {
    if (typeof value !== "object" || value === null) return;
    if (typeof value.$ref === "string") {
      assert.ok(schemaNames.includes(value.$ref.split("/").at(-1)), `dangling ref ${value.$ref}`);
      return;
    }
    for (const child of Object.values(value)) resolve(child);
  };
  resolve(trimmed.paths);
});

test("context source names in the spec match the refresh policies' public names", async () => {
  const { CONTEXT_SOURCE_POLICIES, publicContextName } = await import("../platform/api-core.js");
  assert.deepEqual(
    [...CONTEXT_SOURCE_NAMES].sort(),
    Object.keys(CONTEXT_SOURCE_POLICIES).map(publicContextName).sort()
  );
});

test("the history contract states the retention tiers the store enforces", async () => {
  const { RAW_RETENTION_MS, HOUR_RETENTION_MS } = await import("../platform/history-store.js");
  const day = (ms) => Math.round(ms / 86_400_000);
  const description = openApiDocument().paths["/api/history"].get.description;
  assert.ok(description.includes(`within ${day(RAW_RETENTION_MS)} days`), description);
  assert.ok(description.includes(`within ${day(HOUR_RETENTION_MS)} days`), description);
});

test("HistorySnapshot.sourceStatus is typed as the string captures actually store", () => {
  const schema = openApiDocument().components.schemas.HistorySnapshot.properties.sourceStatus;
  assert.equal(schema.type, "string");
});

test("HistorySnapshot does not advertise a retained rail trains array", () => {
  const properties = openApiDocument().components.schemas.HistorySnapshot.properties;
  assert.equal(properties.trains, undefined);
  assert.match(properties.transit.description, /not stored/i);
});

test("POST to read-only REST endpoints still answers 405 while /api/openapi.json serves", async () => {
  const { handleApiRequest } = await import("../platform/api-core.js");
  const spec = await handleApiRequest(new Request("https://day.illek.ie/api/openapi.json"), {}, {});
  assert.equal(spec.status, 200);
  assert.equal((await spec.json()).paths["/api/openapi.json"].get.tags[0], "meta");
  const post = await handleApiRequest(new Request("https://day.illek.ie/api/living", { method: "POST" }), {}, {});
  assert.equal(post.status, 405);
});

test("MCP paths are not part of the Worker API surface", async () => {
  const { handleApiRequest } = await import("../platform/api-core.js");
  for (const path of ["/mcp", "/api/mcp"]) {
    const post = await handleApiRequest(
      new Request(`https://day.illek.ie${path}`, {
        method: "POST",
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" })
      }),
      {},
      {}
    );
    if (path === "/api/mcp") {
      assert.equal(post.status, 405);
    } else {
      assert.equal(post, undefined, `${path} must fall through to static serving, not an API handler`);
    }
  }
});

test("HEAD on expensive data routes does not invoke adapters", async () => {
  const { handleApiRequest } = await import("../platform/api-core.js");
  let livingCalls = 0;
  const response = await handleApiRequest(
    new Request("https://day.illek.ie/api/living", { method: "HEAD" }),
    {},
    { living: async () => { livingCalls += 1; return Response.json({ generatedAt: "x" }); } }
  );
  assert.equal(response.status, 200);
  assert.equal(await response.text(), "");
  assert.equal(livingCalls, 0);
  assert.equal(response.headers.get("content-type"), "application/json; charset=utf-8");
});

test("adapters without history omit history paths from OpenAPI", async () => {
  const { handleApiRequest } = await import("../platform/api-core.js");
  const spec = await (await handleApiRequest(new Request("https://day.illek.ie/api/openapi.json"), {}, {})).json();
  assert.ok(!spec.paths["/api/history"]);
});
