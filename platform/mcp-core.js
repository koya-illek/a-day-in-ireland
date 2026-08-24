// Model Context Protocol surface over the existing read-only data routes.
//
// Scope decision: this app's capability (honest live + historical observations
// of Ireland) is genuinely useful to AI agents, so we expose it as MCP tools
// rather than inventing a bespoke agent API. The server is STATELESS and
// implements the Streamable HTTP transport's single-response mode: every POST
// gets exactly one application/json response, never an SSE stream, and no
// session identifier is issued because no per-client state exists. Tools are
// thin views over the same route handlers the site's own frontend polls, so
// acquisition, coordination and caching semantics cannot drift between the
// human product and the agent surface.

import { CONTEXT_SOURCE_NAMES } from "./openapi.js";

export const MCP_PATHS = Object.freeze(["/mcp", "/api/mcp"]);
export const MCP_PROTOCOL_VERSIONS = Object.freeze(["2025-06-18", "2025-03-26"]);
const LATEST_PROTOCOL_VERSION = MCP_PROTOCOL_VERSIONS[0];
// Absent header means the client predates the versioned-header requirement;
// the transport spec pins that assumption to 2025-03-26.
const DEFAULT_PROTOCOL_VERSION = "2025-03-26";
const MAX_REQUEST_BODY_BYTES = 256_000;
// Vehicle lists can run into thousands during peak service; an unfiltered
// dump would flood an agent's context window, so results are capped with an
// explicit truncation marker instead.
export const TRANSIT_TOOL_LIMIT_DEFAULT = 250;

const jsonResponse = (body, status = 200) =>
  new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "access-control-allow-origin": "*",
      "x-robots-tag": "noindex, nofollow"
    }
  });

const emptyResponse = (status) =>
  new Response(null, {
    status,
    headers: {
      "cache-control": "no-store",
      "access-control-allow-origin": "*",
      "x-robots-tag": "noindex, nofollow"
    }
  });

// The transport caps request bodies, but reading one fully and checking after
// would still buffer an unbounded upload inside the isolate. Stream with a
// byte ceiling instead; string .length counts UTF-16 units, not bytes.
const readBoundedRequestText = async (request, limitBytes) => {
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks = [];
  let received = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > limitBytes) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const body = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(body);
};

const oversizedBodyResponse = () =>
  jsonResponse(rpcError(null, ERROR_CODES.invalidRequest, "Request body too large."), 413);

const rpcResult = (id, result) => ({ jsonrpc: "2.0", id, result });
const rpcError = (id, code, message) => ({ jsonrpc: "2.0", id, error: { code, message } });

const ERROR_CODES = {
  parse: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internal: -32603
};

class ToolInputError extends Error {}

// ---------------------------------------------------------------------------
// Tool definitions: names, descriptions and input schemas exposed via
// tools/list. Implementations live in buildToolImplementations below.
// ---------------------------------------------------------------------------

const contextSourcesDescription = `Optional filter. Omit for every source, or list any of: ${CONTEXT_SOURCE_NAMES.join(", ")}.`;
// Public source names map onto the /api/contexts payload keys, which follow
// the internal acquisition names (bathingAlerts, issTle) or merge two sources
// into one array (airQuality holds both measured and modelled rows, split by
// each row's source field). Without this mapping a filtered call for bathing,
// iss, measuredAir or modelledAir matched no data key at all and returned
// status/provenance with an absent body.
export const CONTEXT_TOOL_DATA_KEYS = Object.freeze(Object.fromEntries(
  CONTEXT_SOURCE_NAMES.map((name) => [name, name === "bathing"
    ? ["bathingAlerts"]
    : name === "iss" ? ["issTle"]
      : name === "measuredAir" || name === "modelledAir" ? ["airQuality"]
        : [name]])
));

const AIR_ROW_KINDS = { measuredAir: "measured", modelledAir: "modelled" };

export const mcpTools = ({ history = true } = {}) => [
  {
    name: "get_living_layers",
    description: "Current Irish Rail train positions and OPW river-gauge readings for the island of Ireland. Each source carries an honest status (live/partial/fallback/stale/unavailable) and provenance timestamps; report those alongside any values you quote.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true }
  },
  {
    name: "get_transit_positions",
    description: "All-island licensed public-transit vehicle positions from the NTA feed (bus, luas, rail operators). Positions older than 30 minutes are excluded upstream.",
    inputSchema: {
      type: "object",
      properties: {
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 1000,
          default: TRANSIT_TOOL_LIMIT_DEFAULT,
          description: "Maximum vehicles returned; when more exist the result is truncated and totalVehicles states the true count."
        }
      },
      additionalProperties: false
    },
    annotations: { readOnlyHint: true }
  },
  {
    name: "get_island_contexts",
    description: "Island-wide context layers: official weather warnings, rain radar frames, electricity grid demand, measured and modelled air quality, aurora activity, tide predictions, bathing-water alerts, satellite imagery availability, recent earthquakes, ISS orbital elements, sunrise/sunset for today, and Met Éireann's national forecast. Includes per-source status and provenance; measuredAir and modelledAir select rows of the merged air-quality array by their recorded origin.",
    inputSchema: {
      type: "object",
      properties: {
        sources: {
          type: "array",
          items: { type: "string", enum: [...CONTEXT_SOURCE_NAMES] },
          description: contextSourcesDescription
        }
      },
      additionalProperties: false
    },
    annotations: { readOnlyHint: true }
  },
  ...(history ? [
    {
      name: "get_history_snapshot",
      description: "The nearest stored island snapshot at or before a given moment. Snapshots are captured every 15 minutes and rolled up hourly and daily; a miss returns snapshot:null plus gap detail rather than invented data.",
      inputSchema: {
        type: "object",
        properties: {
          at: {
            type: "string",
            format: "date-time",
            description: "RFC 3339 timestamp, e.g. 2026-08-23T09:00:00Z. Future timestamps are rejected."
          }
        },
        required: ["at"],
        additionalProperties: false
      },
      annotations: { readOnlyHint: true }
    },
    {
      name: "get_history_range",
      description: "Which history is stored: overall availability window plus per-resolution (raw/hour/day) coverage and snapshot counts.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: true }
    }
  ] : [])
];

// ---------------------------------------------------------------------------
// Tool implementations: thin, honest views over the shared route handlers.
// ---------------------------------------------------------------------------

const readRouteJson = async (response) => {
  if (!response.ok) {
    let detail = "";
    try {
      const body = await response.json();
      if (body && typeof body.error === "string") detail = `: ${body.error}`;
    } catch {
      // Keep the status-code detail only.
    }
    throw new ToolInputError(`Upstream route answered ${response.status}${detail}`);
  }
  return response.json();
};

const finiteInteger = (value) => typeof value === "number" && Number.isInteger(value);

export const buildToolImplementations = (sources) => ({
  get_living_layers: async () => {
    const payload = await readRouteJson(await sources.living());
    return {
      generatedAt: payload.generatedAt,
      sourceStatus: payload.sourceStatus,
      sourceProvenance: payload.sourceProvenance,
      trains: payload.trains,
      rivers: payload.rivers
    };
  },
  get_transit_positions: async (args) => {
    const limit = args.limit ?? TRANSIT_TOOL_LIMIT_DEFAULT;
    if (!finiteInteger(limit) || limit < 1 || limit > 1000) {
      throw new ToolInputError("limit must be an integer between 1 and 1000.");
    }
    const payload = await readRouteJson(await sources.transit());
    const vehicles = Array.isArray(payload.transit) ? payload.transit : [];
    const total = vehicles.length;
    return {
      generatedAt: payload.generatedAt,
      transitStatus: payload.transitStatus,
      totalVehicles: total,
      truncated: total > limit,
      vehicles: vehicles.slice(0, limit)
    };
  },
  get_island_contexts: async (args) => {
    let requested = null;
    if (args.sources !== undefined) {
      if (!Array.isArray(args.sources)) throw new ToolInputError("sources must be an array of source names.");
      const unknown = args.sources.filter((name) => !CONTEXT_SOURCE_NAMES.includes(name));
      if (unknown.length) {
        throw new ToolInputError(`Unknown source name(s): ${unknown.join(", ")}. Valid names: ${CONTEXT_SOURCE_NAMES.join(", ")}.`);
      }
      requested = [...new Set(args.sources)];
    }
    const payload = await readRouteJson(await sources.contexts());
    // generatedAt always travels with the result: a filtered view without its
    // timestamp would let stale data masquerade as current.
    const result = { generatedAt: payload.generatedAt };
    const wantedDataKeys = requested
      ? new Set(requested.flatMap((name) => CONTEXT_TOOL_DATA_KEYS[name]))
      : null;
    const airKinds = requested
      ? new Set(requested.flatMap((name) => AIR_ROW_KINDS[name] ?? []))
      : null;
    for (const [key, value] of Object.entries(payload)) {
      if (key === "generatedAt") continue;
      // warningsStatus restates contextStatus.warnings for the unfiltered
      // shape; it travels with a warnings request and never alone.
      if (!requested || requested.includes(key) || (key === "warningsStatus" && requested.includes("warnings"))) {
        result[key] = value;
        continue;
      }
      if (wantedDataKeys?.has(key)) {
        // Measured and modelled air share one merged array; select rows by
        // their recorded origin so each public source returns only its own
        // observations. Requesting both (or either alongside no split) keeps
        // every row.
        if (key === "airQuality" && airKinds && airKinds.size === 1) {
          const [kind] = airKinds;
          result[key] = (Array.isArray(value) ? value : []).filter((row) => row?.source === kind);
          continue;
        }
        result[key] = value;
        continue;
      }
      if (requested) {
        if (key === "contextStatus") {
          result.contextStatus = Object.fromEntries(Object.entries(value ?? {}).filter(([name]) => requested.includes(name)));
          continue;
        }
        if (key === "contextProvenance") {
          result.contextProvenance = Object.fromEntries(Object.entries(value ?? {}).filter(([name]) => requested.includes(name)));
          continue;
        }
      }
    }
    return result;
  },
  get_history_snapshot: async (args) => {
    if (typeof args.at !== "string" || !Number.isFinite(Date.parse(args.at))) {
      throw new ToolInputError("at must be an RFC 3339 timestamp string.");
    }
    return readRouteJson(await sources.historySnapshot(args.at));
  },
  get_history_range: async () => readRouteJson(await sources.historyRange())
});

// ---------------------------------------------------------------------------
// Transport: one JSON-RPC message in, one JSON response out.
// ---------------------------------------------------------------------------

const negotiateProtocolVersion = (clientVersion) =>
  typeof clientVersion === "string" && MCP_PROTOCOL_VERSIONS.includes(clientVersion)
    ? clientVersion
    : LATEST_PROTOCOL_VERSION;

const validateProtocolHeader = (request) => {
  const header = request.headers.get("mcp-protocol-version");
  if (header === null) return DEFAULT_PROTOCOL_VERSION;
  return MCP_PROTOCOL_VERSIONS.includes(header) ? header : null;
};

const initializeResult = (message) => ({
  protocolVersion: negotiateProtocolVersion(message.params?.protocolVersion),
  capabilities: {
    tools: { listChanged: false }
  },
  serverInfo: {
    name: "a-day-in-ireland",
    title: "A Day in Ireland — live island data",
    version: "1.0.0"
  },
  instructions: [
    "Read-only public data for the island of Ireland: transit positions, weather, tides,",
    "rivers, sky and space conditions, plus 15-minute history snapshots.",
    "Every payload carries per-source status and provenance; quote them alongside values",
    "so consumers know whether data is live, stale or unavailable. Attribution for the",
    "underlying observations belongs to Met Éireann, OPW, Irish Rail, NTA, EirGrid, EPA",
    "and other open providers."
  ].join(" ")
});

const toolCallResult = (value) => ({
  content: [{ type: "text", text: JSON.stringify(value) }],
  isError: false
});

const toolErrorResult = (message) => ({
  content: [{ type: "text", text: message }],
  isError: true
});

const dispatchMessage = async (implementations, message, capabilities = {}) => {
  // Echo back any detectable id so clients can correlate the failure to
  // their request even when the envelope itself is malformed.
  const detectableId = message && typeof message === "object" && !Array.isArray(message) &&
      ("id" in message) && (typeof message.id === "string" || typeof message.id === "number" || message.id === null)
    ? message.id
    : null;
  if (!message || typeof message !== "object" || Array.isArray(message) || message.jsonrpc !== "2.0") {
    return rpcError(detectableId, ERROR_CODES.invalidRequest, "Requests must be JSON-RPC 2.0 objects.");
  }
  const isNotification = !("id" in message);
  const id = isNotification ? null : message.id;
  if (typeof message.method !== "string") {
    return rpcError(id, ERROR_CODES.invalidRequest, "Missing method.");
  }
  switch (message.method) {
    case "initialize":
      if (isNotification) return rpcError(id, ERROR_CODES.invalidRequest, "initialize must carry an id.");
      return rpcResult(id, initializeResult(message));
    case "notifications/initialized":
      // A notification; acknowledged by the transport layer with 202.
      return undefined;
    case "ping":
      return isNotification ? undefined : rpcResult(id, {});
    case "tools/list":
      return isNotification
        ? undefined
        : rpcResult(id, { tools: mcpTools(capabilities) });
    case "tools/call": {
      if (isNotification) return undefined;
      const name = message.params?.name;
      if (typeof name !== "string" || !(name in implementations)) {
        return rpcError(id, ERROR_CODES.invalidParams, typeof name === "string"
          ? `Unknown tool: ${name}.`
          : "tools/call requires params.name.");
      }
      const args = message.params?.arguments;
      if (args !== undefined && (typeof args !== "object" || args === null || Array.isArray(args))) {
        return rpcError(id, ERROR_CODES.invalidParams, "params.arguments must be an object.");
      }
      try {
        return rpcResult(id, toolCallResult(await implementations[name](args ?? {})));
      } catch (error) {
        if (error instanceof ToolInputError) {
          return rpcResult(id, toolErrorResult(error.message));
        }
        console.error(`MCP tool ${name} failed`, error);
        return rpcResult(id, toolErrorResult(`Tool execution failed: ${String(error?.message ?? error)}`));
      }
    }
    default:
      return isNotification ? undefined : rpcError(id, ERROR_CODES.methodNotFound, `Method not found: ${message.method}`);
  }
};

export const handleMcpRequest = async (request, sources, capabilities = {}) => {
  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        allow: "POST, OPTIONS",
        "access-control-allow-origin": "*",
        "access-control-allow-methods": "POST, OPTIONS",
        "access-control-allow-headers": "content-type, mcp-protocol-version",
        "x-robots-tag": "noindex, nofollow"
      }
    });
  }
  if (request.method !== "POST") {
    // Stateless server: no SSE stream to accept on GET, no session to delete.
    return new Response(JSON.stringify({
      error: `${request.method} is not supported; send JSON-RPC 2.0 messages by POST.`
    }), {
      status: 405,
      headers: {
        "content-type": "application/json; charset=utf-8",
        allow: "POST, OPTIONS",
        "cache-control": "no-store",
        "access-control-allow-origin": "*",
        "x-robots-tag": "noindex, nofollow"
      }
    });
  }
  // Clients only send MCP-Protocol-Version after initialization; an absent
  // header predates versioned headers and defaults to 2025-03-26.
  if (validateProtocolHeader(request) === null) {
    return jsonResponse(rpcError(null, ERROR_CODES.invalidRequest, `Unsupported MCP-Protocol-Version. Supported: ${MCP_PROTOCOL_VERSIONS.join(", ")}.`), 400);
  }
  const contentLength = Number(request.headers.get("content-length"));
  if (Number.isInteger(contentLength) && contentLength > MAX_REQUEST_BODY_BYTES) {
    return oversizedBodyResponse();
  }
  const raw = await readBoundedRequestText(request, MAX_REQUEST_BODY_BYTES);
  if (raw === null) {
    return oversizedBodyResponse();
  }
  let message;
  try {
    message = raw.length ? JSON.parse(raw) : null;
  } catch {
    return jsonResponse(rpcError(null, ERROR_CODES.parse, "Body was not valid JSON."));
  }
  if (Array.isArray(message)) {
    // Batching was removed in protocol revision 2025-06-18; answer legacy
    // batch attempts as one invalid-request error rather than faking support.
    return jsonResponse(rpcError(null, ERROR_CODES.invalidRequest, "Batch requests are not supported."));
  }
  const implementations = buildToolImplementations(sources);
  const responseMessage = await dispatchMessage(implementations, message, capabilities);
  // Notifications get no body, but browser-based cross-origin clients still
  // need the shared CORS posture or their POST never resolves at all.
  if (responseMessage === undefined) return emptyResponse(202);
  return jsonResponse(responseMessage);
};
