import assert from "node:assert/strict";
import test from "node:test";
import { CONTEXT_SOURCE_NAMES, openApiDocument } from "../platform/openapi.js";
import {
  handleMcpRequest,
  MCP_PROTOCOL_VERSIONS,
  TRANSIT_TOOL_LIMIT_DEFAULT
} from "../platform/mcp-core.js";

const post = (body, headers = {}) => new Request("https://day.illek.ie/mcp", {
  method: "POST",
  headers: { "content-type": "application/json", ...headers },
  body: typeof body === "string" ? body : JSON.stringify(body)
});

const rpcCall = (sources, method, params, id = 1) =>
  handleMcpRequest(post({ jsonrpc: "2.0", id, method, params }), sources)
    .then((response) => response.json());

const stubSource = (payload) => async () => Response.json(payload);

const stubSources = () => ({
  living: stubSource({
    generatedAt: "2026-08-23T12:00:00Z",
    trains: [{ id: "A800", latitude: 53.35, longitude: -6.26, status: "running", observedAt: "2026-08-23T11:59:00Z" }],
    rivers: [],
    sourceStatus: { trains: "live", rivers: "unavailable" },
    sourceProvenance: { trains: { status: "live", fetchedAt: "2026-08-23T12:00:00Z" }, rivers: { status: "unavailable" } }
  }),
  transit: stubSource({
    generatedAt: "2026-08-23T12:00:00Z",
    transitStatus: "live",
    transit: Array.from({ length: 400 }, (_, index) => ({
      id: `nta-${index}`, latitude: 53.3, longitude: -6.2, observedAt: "2026-08-23T11:59:30Z"
    }))
  }),
  contexts: stubSource({
    generatedAt: "2026-08-23T12:00:00Z",
    marine: [{ reading: 1 }],
    radar: ["frame"],
    tides: [{ height: 2 }],
    warnings: [],
    airQuality: [
      { id: "measured-dub", source: "measured", europeanAqi: 30 },
      { id: "modelled-cork", source: "modelled", europeanAqi: 45 }
    ],
    bathingAlerts: [{ name: "Portmarnock" }],
    issTle: { line1: "1 25544U" },
    warningsStatus: "unavailable",
    contextStatus: { marine: "live", radar: "live", tides: "stale", warnings: "unavailable", measuredAir: "live", modelledAir: "live", bathing: "partial", iss: "live", aurora: "unavailable" },
    contextProvenance: {
      marine: { status: "live" }, radar: { status: "live" }, tides: { status: "stale" }, warnings: { status: "unavailable" },
      measuredAir: { status: "live" }, modelledAir: { status: "live" }, bathing: { status: "partial" }, iss: { status: "live" }
    }
  }),
  historySnapshot: stubSource({ schemaVersion: 1, requestedAt: "x", resolvedAt: null, snapshot: null, gaps: [] }),
  historyRange: stubSource({ schemaVersion: 1, resolutions: [], snapshotCount: 0 })
});

// ---------------------------------------------------------------------------
// OpenAPI document
// ---------------------------------------------------------------------------

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
  // Every remaining $ref must still resolve.
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
  const { CONTEXT_SOURCE_POLICIES } = await import("../platform/api-core.js");
  const publicName = (name) => name === "bathingAlerts" ? "bathing"
    : name === "issTle" ? "iss" : name === "forecast" ? "forecast" : name;
  assert.deepEqual(
    [...CONTEXT_SOURCE_NAMES].sort(),
    Object.keys(CONTEXT_SOURCE_POLICIES).map(publicName).sort()
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

// ---------------------------------------------------------------------------
// MCP transport
// ---------------------------------------------------------------------------

test("initialize negotiates the protocol version honestly", async () => {
  const supported = await rpcCall(stubSources(), "initialize", { protocolVersion: "2025-03-26" });
  assert.equal(supported.result.protocolVersion, "2025-03-26");
  assert.equal(supported.id, 1);
  assert.equal(supported.result.serverInfo.name, "a-day-in-ireland");
  const unknown = await rpcCall(stubSources(), "initialize", { protocolVersion: "1999-01-01" });
  assert.equal(unknown.result.protocolVersion, MCP_PROTOCOL_VERSIONS[0]);
  const bare = await rpcCall(stubSources(), "initialize", {});
  assert.equal(bare.result.protocolVersion, MCP_PROTOCOL_VERSIONS[0]);
});

test("tools/list exposes read-only annotated schemas", async () => {
  const response = await rpcCall(stubSources(), "tools/list", {});
  assert.equal(response.result.tools.length, 5);
  for (const tool of response.result.tools) {
    assert.equal(tool.annotations.readOnlyHint, true, `${tool.name} must be read-only`);
    assert.equal(typeof tool.description, "string");
    assert.equal(tool.inputSchema.type, "object");
  }
});

test("notifications are acknowledged with an empty 202", async () => {
  const response = await handleMcpRequest(post({ jsonrpc: "2.0", method: "notifications/initialized" }), stubSources());
  assert.equal(response.status, 202);
  assert.equal(await response.text(), "");
  assert.equal(response.headers.get("access-control-allow-origin"), "*", "cross-origin browser clients must see the acknowledgement");
});

test("ping answers with an empty result object", async () => {
  const message = await rpcCall(stubSources(), "ping", {});
  assert.deepEqual(message.result, {});
});

test("protocol errors use the JSON-RPC error contract", async () => {
  assert.equal((await rpcCall(stubSources(), "no/such/method", {})).error.code, -32601);
  assert.equal((await rpcCall(stubSources(), "tools/call", { name: "not_a_tool" })).error.code, -32602);
  const parseError = await (await handleMcpRequest(post("{not json"), stubSources())).json();
  assert.equal(parseError.error.code, -32700);
  const batch = await (await handleMcpRequest(post([]), stubSources())).json();
  assert.equal(batch.error.code, -32600);
  const malformed = await (await handleMcpRequest(post({ jsonrpc: "1.0", id: 9, method: "tools/list" }), stubSources())).json();
  assert.equal(malformed.error.code, -32600);
  assert.equal(malformed.id, 9);
});

test("unsupported MCP-Protocol-Version headers answer 400 while absent ones pass", async () => {
  const bad = await handleMcpRequest(post({ jsonrpc: "2.0", id: 1, method: "tools/list" }, { "mcp-protocol-version": "1999-01-01" }), stubSources());
  assert.equal(bad.status, 400);
  const good = await handleMcpRequest(post({ jsonrpc: "2.0", id: 1, method: "tools/list" }, { "mcp-protocol-version": "2025-06-18" }), stubSources());
  assert.equal(good.status, 200);
  const legacy = await handleMcpRequest(post({ jsonrpc: "2.0", id: 1, method: "tools/list" }), stubSources());
  assert.equal(legacy.status, 200);
});

test("GET is refused and OPTIONS advertises POST on the transport", async () => {
  const get = await handleMcpRequest(new Request("https://day.illek.ie/mcp"), stubSources());
  assert.equal(get.status, 405);
  assert.match(get.headers.get("allow"), /POST/);
  const options = await handleMcpRequest(new Request("https://day.illek.ie/mcp", { method: "OPTIONS" }), stubSources());
  assert.equal(options.status, 204);
  assert.match(options.headers.get("access-control-allow-methods"), /POST/);
});

test("oversized request bodies answer 413 before parsing", async () => {
  const huge = `{"jsonrpc":"2.0","id":1,"method":"tools/list","pad":"${"x".repeat(300_000)}"}`;
  const response = await handleMcpRequest(new Request("https://day.illek.ie/mcp", { method: "POST", body: huge }), stubSources());
  assert.equal(response.status, 413);
});

test("the request-body cap counts bytes, not UTF-16 code units", async () => {
  // 130_000 two-byte characters: under the old .length check (130_000 <
  // 256_000) this parsed; at ~260k bytes it must be rejected.
  const twoByte = "é".repeat(130_000);
  const response = await handleMcpRequest(
    new Request("https://day.illek.ie/mcp", { method: "POST", body: `{"jsonrpc":"2.0","id":1,"method":"tools/list","pad":"${twoByte}"}` }),
    stubSources()
  );
  assert.equal(response.status, 413);
});

// ---------------------------------------------------------------------------
// Tool semantics
// ---------------------------------------------------------------------------

test("get_transit_positions caps results and reports the true total", async () => {
  const capped = await rpcCall(stubSources(), "tools/call", { name: "get_transit_positions", arguments: {} });
  const payload = JSON.parse(capped.result.content[0].text);
  assert.equal(capped.result.isError, false);
  assert.equal(payload.totalVehicles, 400);
  assert.equal(payload.truncated, true);
  assert.equal(payload.vehicles.length, TRANSIT_TOOL_LIMIT_DEFAULT);
  const small = await rpcCall(stubSources(), "tools/call", { name: "get_transit_positions", arguments: { limit: 5 } });
  assert.equal(JSON.parse(small.result.content[0].text).vehicles.length, 5);
});

test("transit limit validation surfaces as a readable tool error", async () => {
  const message = await rpcCall(stubSources(), "tools/call", { name: "get_transit_positions", arguments: { limit: 5000 } });
  assert.equal(message.result.isError, true);
  assert.match(message.result.content[0].text, /between 1 and 1000/);
});

test("get_living_layers carries the provenance its own instructions quote", async () => {
  const call = await rpcCall(stubSources(), "tools/call", { name: "get_living_layers", arguments: {} });
  const payload = JSON.parse(call.result.content[0].text);
  assert.deepEqual(payload.sourceProvenance.trains, { status: "live", fetchedAt: "2026-08-23T12:00:00Z" });
});

test("get_island_contexts filters layers and keeps their status maps aligned", async () => {
  const filtered = await rpcCall(stubSources(), "tools/call", {
    name: "get_island_contexts",
    arguments: { sources: ["tides", "warnings"] }
  });
  const payload = JSON.parse(filtered.result.content[0].text);
  assert.deepEqual(Object.keys(payload).sort(), ["contextProvenance", "contextStatus", "generatedAt", "tides", "warnings", "warningsStatus"]);
  assert.deepEqual(payload.contextStatus, { tides: "stale", warnings: "unavailable" });
  assert.deepEqual(payload.tides, [{ height: 2 }]);
  assert.deepEqual(payload.contextProvenance.tides, { status: "stale" });
  const everything = await rpcCall(stubSources(), "tools/call", { name: "get_island_contexts", arguments: {} });
  const full = JSON.parse(everything.result.content[0].text);
  assert.ok(full.marine.length > 0);
  assert.ok(full.radar.length > 0);
});

test("filtered context sources reach data stored under internal payload keys", async () => {
  // bathing -> bathingAlerts, iss -> issTle: without the mapping these calls
  // returned status and provenance with no data array at all.
  for (const [source, key, expected] of [
    ["bathing", "bathingAlerts", [{ name: "Portmarnock" }]],
    ["iss", "issTle", { line1: "1 25544U" }]
  ]) {
    const call = await rpcCall(stubSources(), "tools/call", {
      name: "get_island_contexts",
      arguments: { sources: [source] }
    });
    const payload = JSON.parse(call.result.content[0].text);
    assert.deepEqual(payload[key], expected, source);
    assert.deepEqual(payload.contextStatus, { [source]: stubContextStatus[source] });
    assert.ok(payload.contextProvenance[source]);
  }
});

const stubContextStatus = {
  bathing: "partial",
  iss: "live",
  measuredAir: "live",
  modelledAir: "live"
};

test("measuredAir and modelledAir select their rows from the merged air-quality array", async () => {
  const measured = JSON.parse((await rpcCall(stubSources(), "tools/call", {
    name: "get_island_contexts",
    arguments: { sources: ["measuredAir"] }
  })).result.content[0].text);
  assert.deepEqual(measured.airQuality, [{ id: "measured-dub", source: "measured", europeanAqi: 30 }]);
  assert.deepEqual(measured.contextStatus, { measuredAir: "live" });
  const modelled = JSON.parse((await rpcCall(stubSources(), "tools/call", {
    name: "get_island_contexts",
    arguments: { sources: ["modelledAir"] }
  })).result.content[0].text);
  assert.deepEqual(modelled.airQuality, [{ id: "modelled-cork", source: "modelled", europeanAqi: 45 }]);
  const both = JSON.parse((await rpcCall(stubSources(), "tools/call", {
    name: "get_island_contexts",
    arguments: { sources: ["measuredAir", "modelledAir"] }
  })).result.content[0].text);
  assert.equal(both.airQuality.length, 2);
});

test("unknown context source names fail with the valid vocabulary", async () => {
  const message = await rpcCall(stubSources(), "tools/call", {
    name: "get_island_contexts",
    arguments: { sources: ["weather"] }
  });
  assert.equal(message.result.isError, true);
  assert.match(message.result.content[0].text, /Valid names:/);
});

test("get_history_snapshot rejects arguments that cannot be timestamps", async () => {
  const message = await rpcCall(stubSources(), "tools/call", {
    name: "get_history_snapshot",
    arguments: { at: "not-a-time" }
  });
  assert.equal(message.result.isError, true);
  assert.match(message.result.content[0].text, /RFC 3339/);
});

test("upstream route failures become tool errors instead of transport errors", async () => {
  const failing = {
    living: async () => Response.json({ error: "Live layers are temporarily unavailable." }, { status: 503 }),
    transit: stubSource({ transit: [], transitStatus: "unavailable", generatedAt: "x" }),
    contexts: stubSource({ generatedAt: "x" }),
    historySnapshot: stubSource({ error: "nope" }),
    historyRange: stubSource({})
  };
  const message = await rpcCall(failing, "tools/call", { name: "get_living_layers", arguments: {} });
  assert.equal(message.result.isError, true);
  assert.match(message.result.content[0].text, /temporarily unavailable/);
});

test("get_history_range answers through tools/call with the stored-coverage payload", async () => {
  const message = await rpcCall(stubSources(), "tools/call", {
    name: "get_history_range",
    arguments: {}
  });
  assert.equal(message.result.isError, false);
  const payload = JSON.parse(message.result.content[0].text);
  assert.deepEqual(payload.resolutions, []);
  assert.equal(payload.snapshotCount, 0);
});

test("tools/call rejects non-object argument containers", async () => {
  for (const arguments_ of [42, "limit=5", [1, 2], null]) {
    const message = await rpcCall(stubSources(), "tools/call", {
      name: "get_transit_positions",
      arguments: arguments_
    });
    assert.equal(message.error?.code, -32602, String(arguments_));
    assert.match(message.error.message, /arguments must be an object/);
  }
});

test("initialize sent as a notification is an error, while ping notifications answer 202", async () => {
  const notification = (response) => response.status === 202 ? { status: 202 } : response.json();
  const init = await notification(await handleMcpRequest(post({ jsonrpc: "2.0", method: "initialize", params: {} }), stubSources()));
  assert.equal(init.status, undefined);
  assert.match(init.error.message, /initialize must carry an id/);

  const pong = await handleMcpRequest(post({ jsonrpc: "2.0", method: "ping" }), stubSources());
  assert.equal(pong.status, 202);

  const unknown = await handleMcpRequest(post({ jsonrpc: "2.0", method: "notifications/does-not-exist" }), stubSources());
  assert.equal(unknown.status, 202);
});

test("unexpected tool crashes become isError results without leaking the transport", async () => {
  const exploding = {
    ...stubSources(),
    living: async () => {
      throw new TypeError("cannot read properties of undefined");
    }
  };
  const message = await rpcCall(exploding, "tools/call", { name: "get_living_layers", arguments: {} });
  assert.equal(message.result.isError, true);
  assert.match(message.result.content[0].text, /Tool execution failed/);
});

// ---------------------------------------------------------------------------
// Dispatcher wiring
// ---------------------------------------------------------------------------

const dispatchAdapters = () => ({
  living: stubSource({ generatedAt: "x", trains: [], rivers: [], sourceStatus: {}, sourceProvenance: {} }),
  history: async (request) => Response.json({ receivedPath: new URL(request.url).pathname + new URL(request.url).search })
});

test("the dispatcher routes MCP before the GET-only API method gate", async () => {
  const { handleApiRequest } = await import("../platform/api-core.js");
  const adapters = dispatchAdapters();
  const response = await handleApiRequest(
    new Request("https://day.illek.ie/mcp", { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) }),
    {}, adapters
  );
  assert.equal(response.status, 200);
  const listed = await response.json();
  assert.equal(listed.result.tools.length, 5);
});

test("adapters without history advertise only the tools and paths they serve", async () => {
  const { handleApiRequest } = await import("../platform/api-core.js");
  const toolsResponse = await handleApiRequest(
    new Request("https://day.illek.ie/mcp", {
      method: "POST",
      headers: { "mcp-protocol-version": "2025-06-18" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" })
    }),
    {}, {}
  );
  const listed = (await toolsResponse.json()).result.tools.map((tool) => tool.name);
  assert.deepEqual(listed.sort(), ["get_island_contexts", "get_living_layers", "get_transit_positions"]);
  const spec = await (await handleApiRequest(new Request("https://day.illek.ie/api/openapi.json"), {}, {})).json();
  assert.ok(!spec.paths["/api/history"]);
  // A direct call still fails honestly rather than pretending to work.
  const call = await handleApiRequest(
    new Request("https://day.illek.ie/mcp", {
      method: "POST",
      body: JSON.stringify({
        jsonrpc: "2.0", id: 2, method: "tools/call",
        params: { name: "get_history_range", arguments: {} }
      })
    }),
    {}, {}
  );
  const message = await call.json();
  assert.equal(message.result.isError, true);
  assert.match(message.result.content[0].text, /History storage is not wired on this deployment/);
});

test("both /mcp and /api/mcp serve the same transport", async () => {
  const { handleApiRequest } = await import("../platform/api-core.js");
  for (const path of ["/mcp", "/api/mcp"]) {
    const response = await handleApiRequest(
      new Request(`https://day.illek.ie${path}`, { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }) }),
      {}, {}
    );
    assert.equal(response.status, 200, path);
    assert.deepEqual((await response.json()).result, {});
  }
});

test("MCP tools reach the adapter-wired history handler with rewritten queries", async () => {
  const { handleApiRequest } = await import("../platform/api-core.js");
  const call = await handleApiRequest(
    new Request("https://day.illek.ie/mcp", {
      method: "POST",
      headers: { "mcp-protocol-version": "2025-03-26" },
      body: JSON.stringify({
        jsonrpc: "2.0", id: 7, method: "tools/call",
        params: { name: "get_history_snapshot", arguments: { at: "2026-08-23T09:00:00Z" } }
      })
    }),
    {}, dispatchAdapters()
  );
  const message = await call.json();
  const payload = JSON.parse(message.result.content[0].text);
  assert.equal(payload.receivedPath, "/api/history?at=2026-08-23T09%3A00%3A00Z");
  assert.equal(message.result.isError, false);
});

test("POST to read-only REST endpoints still answers 405 while /api/openapi.json serves", async () => {
  const { handleApiRequest } = await import("../platform/api-core.js");
  const spec = await handleApiRequest(new Request("https://day.illek.ie/api/openapi.json"), {}, {});
  assert.equal(spec.status, 200);
  assert.equal((await spec.json()).paths["/api/openapi.json"].get.tags[0], "meta");
  const post = await handleApiRequest(new Request("https://day.illek.ie/api/living", { method: "POST" }), {}, {});
  assert.equal(post.status, 405);
});
