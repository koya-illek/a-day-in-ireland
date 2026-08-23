// Machine-readable description of the public read-only HTTP API, served at
// /api/openapi.json on every adapter. This file is the single source of truth
// for the documented contract; the response shapes below mirror what
// api-core.js and history-store.js actually emit (pinned by tests that compare
// this document against live payload fixtures).
//
// Versioning policy: the deployed paths (/api/living, /api/contexts, …) are
// the stable v1 surface consumed by the shipped frontend. Breaking changes
// will ship under a new path prefix rather than mutating these contracts;
// additive fields may appear at any time, so clients must ignore unknown
// properties.

export const OPENAPI_PATH = "/api/openapi.json";
export const OPENAPI_VERSION = "1.0.0";

// The public context-source names after api-core's publicName() mapping
// (bathingAlerts→bathing, issTle→iss). Pinned against CONTEXT_SOURCE_POLICIES
// by tests/free-review.test.mjs so drift here fails loudly.
export const CONTEXT_SOURCE_NAMES = Object.freeze([
  "marine", "radar", "grid", "measuredAir", "modelledAir", "aurora",
  "tides", "bathing", "satellite", "earthquakes", "iss", "warnings",
  "solar", "forecast"
]);

const SOURCE_STATUS_VALUES = ["live", "partial", "fallback", "stale", "unavailable", "credential-required"];

const sourceStatusSchema = {
  type: "string",
  description: "Honest delivery status for one upstream source.",
  enum: SOURCE_STATUS_VALUES
};

const provenanceSchema = {
  type: "object",
  description: "Per-source delivery metadata.",
  properties: {
    status: sourceStatusSchema,
    fetchedAt: { type: ["string", "null"], format: "date-time" },
    lastSuccessAt: { type: ["string", "null"], format: "date-time" },
    ageSeconds: { type: ["integer", "null"], minimum: 0 },
    staleSince: { type: ["string", "null"], format: "date-time" },
    errorCode: { type: ["string", "null"] }
  },
  required: ["status"]
};

const latLon = {
  latitude: { type: "number", minimum: -90, maximum: 90 },
  longitude: { type: "number", minimum: -180, maximum: 180 }
};

const trainPositionSchema = {
  type: "object",
  properties: {
    id: { type: "string" },
    ...latLon,
    status: { type: "string", enum: ["running", "not-started"] },
    direction: { type: "string" },
    message: { type: "string" },
    observedAt: { type: "string", format: "date-time" },
    speedKmh: { type: ["number", "null"] },
    speedSource: { type: ["string", "null"] }
  },
  required: ["id", "latitude", "longitude", "status", "observedAt"]
};

const transitVehicleSchema = {
  type: "object",
  properties: {
    id: { type: "string" },
    ...latLon,
    tripId: { type: "string" },
    route: { type: "string" },
    label: { type: "string" },
    bearing: { type: ["number", "null"], minimum: 0, maximum: 360 },
    speedKmh: { type: ["number", "null"] },
    speedSource: { type: ["string", "null"] },
    observedAt: { type: "string", format: "date-time" }
  },
  required: ["id", "latitude", "longitude", "observedAt"]
};

const riverReadingSchema = {
  type: "object",
  properties: {
    id: { type: "string" },
    name: { type: "string" },
    ...latLon,
    level: { type: "number", description: "Water level in metres at the gauge reference datum." },
    observedAt: { type: "string", format: "date-time" }
  },
  required: ["id", "name", "latitude", "longitude", "level", "observedAt"]
};

const errorResponseRef = { $ref: "#/components/schemas/ErrorResponse" };

const commonJsonHeaders = {
  "Cache-Control": {
    schema: { type: "string" },
    description: "Explicit cache posture; varies per response tier as noted per operation."
  },
  "Access-Control-Allow-Origin": { schema: { type: "string" }, description: "Always * — the API is public." },
  "X-Robots-Tag": { schema: { type: "string" }, description: "noindex, nofollow — API responses stay out of search indexes." }
};

const jsonResponse = (description, cacheControl) => ({
  description: `${description} Served with Cache-Control: ${cacheControl}.`,
  headers: commonJsonHeaders,
  content: { "application/json": {} }
});

const schemaResponse = (schemaRef) => ({
  headers: commonJsonHeaders,
  content: { "application/json": { schema: schemaRef } }
});

export const openApiDocument = () => ({
  openapi: "3.1.0",
  info: {
    title: "A Day in Ireland — public data API",
    version: OPENAPI_VERSION,
    summary: "Read-only live and historical observations for the island of Ireland.",
    description: [
      "Every endpoint is public, read-only, CORS-enabled (*) and excluded from search indexes.",
      "Responses carry per-source honesty metadata: never assume a value is fresh — read the",
      "status/provenance fields alongside it. Data is aggregated from Met Éireann, OPW, Irish Rail,",
      "NTA, EirGrid, EPA and other open providers; attribution stays with those providers.",
      "",
      "A machine-readable copy of this document is always at /api/openapi.json; human documentation",
      "lives at /developers."
    ].join("\n"),
    license: { name: "CC-BY-4.0 (data © the originating providers)" }
  },
  servers: [{ url: "/", description: "Current host" }],
  tags: [
    { name: "status", description: "Build and storage health." },
    { name: "live", description: "Right-now observations refreshed every few seconds to minutes." },
    { name: "history", description: "Snapshots captured every 15 minutes and rolled up hourly and daily." },
    { name: "meta", description: "API self-description." }
  ],
  paths: {
    "/api/health": {
      get: {
        tags: ["status"],
        summary: "Build and storage health.",
        description: "Reports the running build commit and which storage bindings (history D1, NTA and river coordinators) are wired on this deployment.",
        responses: {
          200: {
            description: "Health envelope. Always answers 200 while the Worker runs; degraded bindings show as false flags.",
            headers: commonJsonHeaders,
            content: { "application/json": { schema: { $ref: "#/components/schemas/HealthPayload" } } }
          }
        }
      }
    },
    "/api/living": {
      get: {
        tags: ["live"],
        summary: "Irish Rail train positions and OPW river-gauge readings.",
        description: "Coordinated through Durable Objects in production so upstream rate limits are honoured. Cache tier degrades to no-store when neither source is usable.",
        responses: {
          200: {
            description: "Trains and rivers with per-source status and provenance. Served with Cache-Control: public, max-age=15 tiers when any source is usable; no-store when none are.",
            ...schemaResponse({ $ref: "#/components/schemas/LivingPayload" })
          },
          503: {
            description: "Both upstreams failed.",
            headers: commonJsonHeaders,
            content: { "application/json": { schema: errorResponseRef } }
          }
        }
      }
    },
    "/api/contexts": {
      get: {
        tags: ["live"],
        summary: "All island context layers in one payload.",
        description: "Weather warnings, radar frames, grid demand, air quality, aurora activity, tides, bathing alerts, satellite imagery availability, earthquakes, ISS orbit elements, solar day and official forecast — each with honest per-source status and provenance. Sources refresh on independent TTL state machines (5–360 minute policies) with stale-if-error windows.",
        responses: {
          200: jsonResponse(
            "Context layers plus contextStatus/contextProvenance maps keyed by source name.",
            "public, max-age=30, s-maxage=30, stale-while-revalidate=120 when any source is usable; no-store otherwise"
          )
        }
      }
    },
    "/api/transit": {
      get: {
        tags: ["live"],
        summary: "All-island licensed public-transit vehicle positions (NTA GTFS-RT).",
        description: "Positions older than 30 minutes are dropped; estimated speeds are added by the coordinator when the provider omits them.",
        responses: {
          200: {
            description: "Vehicle positions plus transitStatus. Served with Cache-Control: public, max-age=15 tiers; no-store when unavailable.",
            ...schemaResponse({ $ref: "#/components/schemas/TransitPayload" })
          },
          503: {
            description: "Transit refresh failed.",
            headers: commonJsonHeaders,
            content: { "application/json": { schema: errorResponseRef } }
          }
        }
      }
    },
    "/api/history": {
      get: {
        tags: ["history"],
        summary: "Nearest stored snapshot at or before a moment.",
        description: "Resolves across retention tiers (raw 15-minute snapshots within 7 days, hourly within 90 days, daily beyond). A miss returns snapshot:null plus the available window and gap detail rather than inventing data. Requires the history D1 database to be provisioned.",
        parameters: [{
          name: "at",
          in: "query",
          required: true,
          description: "RFC 3339 timestamp; future values are rejected.",
          schema: { type: "string", format: "date-time" },
          example: "2026-08-23T09:00:00Z"
        }],
        responses: {
          200: jsonResponse(
            "History envelope with the resolved snapshot. Cache-Control: public, max-age=60, s-maxage=300 on hits; max-age=15, s-maxage=30 on misses.",
            "tiered, see description"
          ),
          400: {
            description: "Missing or invalid at parameter.",
            headers: commonJsonHeaders,
            content: { "application/json": { schema: errorResponseRef } }
          },
          503: {
            description: "History storage unavailable or not provisioned.",
            headers: commonJsonHeaders,
            content: { "application/json": { schema: errorResponseRef } }
          }
        }
      }
    },
    "/api/history/range": {
      get: {
        tags: ["history"],
        summary: "Stored history availability window.",
        description: "Per-resolution coverage (raw/hour/day) with snapshot counts, so clients can offer a time-travel picker without probing.",
        responses: {
          200: jsonResponse(
            "Availability envelope.",
            "public, max-age=60, s-maxage=60"
          ),
          503: {
            description: "History storage unavailable or not provisioned.",
            headers: commonJsonHeaders,
            content: { "application/json": { schema: errorResponseRef } }
          }
        }
      }
    },
    "/api/openapi.json": {
      get: {
        tags: ["meta"],
        summary: "This document.",
        responses: {
          200: jsonResponse("The OpenAPI description.", "public, max-age=3600, s-maxage=86400")
        }
      }
    }
  },
  components: {
    schemas: {
      ErrorResponse: {
        type: "object",
        properties: { error: { type: "string" } },
        required: ["error"]
      },
      HealthPayload: {
        type: "object",
        properties: {
          status: { type: "string", const: "ok" },
          service: { type: "string", const: "a-day-in-ireland" },
          runtime: { type: "string", examples: ["cloudflare-worker", "local-worker"] },
          build: {
            type: "object",
            properties: {
              commitSha: { type: "string" },
              builtAt: { type: "string" },
              configSha256: { type: "string" },
              transitDataSha256: { type: "string" },
              deploymentId: { type: "string" }
            }
          },
          storage: {
            type: "object",
            properties: {
              historyDb: { type: "boolean" },
              ntaCoordinator: { type: "boolean" },
              riverCoordinator: { type: "boolean" }
            }
          }
        },
        required: ["status", "service", "runtime", "build", "storage"]
      },
      SourceStatus: sourceStatusSchema,
      SourceProvenance: provenanceSchema,
      TrainPosition: trainPositionSchema,
      TransitVehicle: transitVehicleSchema,
      RiverReading: riverReadingSchema,
      LivingPayload: {
        type: "object",
        properties: {
          generatedAt: { type: "string", format: "date-time" },
          trains: { type: "array", items: { $ref: "#/components/schemas/TrainPosition" } },
          rivers: { type: "array", items: { $ref: "#/components/schemas/RiverReading" } },
          sourceStatus: {
            type: "object",
            properties: { trains: sourceStatusSchema, rivers: sourceStatusSchema },
            required: ["trains", "rivers"]
          },
          sourceProvenance: {
            type: "object",
            properties: { trains: provenanceSchema, rivers: provenanceSchema }
          }
        },
        required: ["generatedAt", "trains", "rivers", "sourceStatus", "sourceProvenance"]
      },
      TransitPayload: {
        type: "object",
        properties: {
          generatedAt: { type: "string", format: "date-time" },
          transit: { type: "array", items: { $ref: "#/components/schemas/TransitVehicle" } },
          transitStatus: sourceStatusSchema
        },
        required: ["generatedAt", "transit", "transitStatus"]
      },
      ContextStatusMap: {
        type: "object",
        description: `Delivery status per source. Keys: ${CONTEXT_SOURCE_NAMES.join(", ")}.`,
        propertyNames: { enum: CONTEXT_SOURCE_NAMES },
        additionalProperties: false
      },
      HistoryResolution: {
        type: "object",
        properties: {
          name: { type: "string", enum: ["raw", "hour", "day"] },
          resolutionMinutes: { type: "integer", enum: [15, 60, 1440] },
          availableFrom: { type: ["string", "null"], format: "date-time" },
          availableTo: { type: ["string", "null"], format: "date-time" },
          snapshotCount: { type: "integer", minimum: 0 }
        },
        required: ["name", "resolutionMinutes", "availableFrom", "availableTo", "snapshotCount"]
      },
      HistoryRangePayload: {
        type: "object",
        properties: {
          schemaVersion: { type: "integer", const: 1 },
          availableFrom: { type: ["string", "null"], format: "date-time" },
          availableTo: { type: ["string", "null"], format: "date-time" },
          resolutionMinutes: { type: ["integer", "null"], enum: [15, 60, 1440, null] },
          resolutions: { type: "array", items: { $ref: "#/components/schemas/HistoryResolution" } },
          snapshotCount: { type: "integer", minimum: 0 }
        },
        required: ["schemaVersion", "resolutions", "snapshotCount"]
      },
      HistorySnapshot: {
        type: "object",
        description: "Captured island state. Array fields mirror the corresponding live payloads; unknown future fields may appear and must be ignored.",
        properties: {
          generatedAt: { type: "string", format: "date-time" },
          lastSuccessAt: { type: ["string", "null"], format: "date-time" },
          sourceStatus: { type: "object", additionalProperties: sourceStatusSchema },
          stations: { type: "array", items: { type: "object" } },
          warnings: { type: "array", items: { type: "object" } },
          marine: { type: "array", items: { type: "object" } },
          trains: { type: "array", items: { $ref: "#/components/schemas/TrainPosition" } },
          rivers: { type: "array", items: { $ref: "#/components/schemas/RiverReading" } },
          transit: { type: "array", items: { $ref: "#/components/schemas/TransitVehicle" } },
          transitStatus: sourceStatusSchema,
          contextStatus: { type: "object", additionalProperties: sourceStatusSchema },
          summary: { type: "object" },
          timeline: { type: "array", items: { type: "object" } }
        },
        additionalProperties: true
      },
      HistoryGap: {
        type: "object",
        properties: {
          source: { type: "string" },
          scope: { type: "string" },
          reason: { type: "string" },
          detail: { type: "string" }
        },
        required: ["source", "scope", "reason", "detail"]
      },
      HistoryEnvelope: {
        type: "object",
        properties: {
          schemaVersion: { type: "integer", const: 1 },
          requestedAt: { type: "string", format: "date-time" },
          resolvedAt: { type: ["string", "null"], format: "date-time" },
          periodStartAt: { type: ["string", "null"], format: "date-time" },
          periodEndAt: { type: ["string", "null"], format: "date-time" },
          availableFrom: { type: ["string", "null"], format: "date-time" },
          availableTo: { type: ["string", "null"], format: "date-time" },
          previousAt: { type: ["string", "null"], format: "date-time" },
          nextAt: { type: ["string", "null"], format: "date-time" },
          resolutionMinutes: { type: ["integer", "null"], enum: [15, 60, 1440, null] },
          snapshot: { oneOf: [{ $ref: "#/components/schemas/HistorySnapshot" }, { type: "null" }] },
          movementSummary: { type: "object" },
          periodSummary: { type: ["object", "null"] },
          gaps: { type: "array", items: { $ref: "#/components/schemas/HistoryGap" } }
        },
        required: ["schemaVersion", "requestedAt", "resolvedAt", "snapshot", "gaps"]
      }
    }
  },
  // Documented per-operation above; kept out of the machine schemas because
  // cache tiers vary deliberately by response state.
  "x-cache-policy": {
    "/api/health": "no-store",
    "/api/living": "public, max-age=15, s-maxage=15 when usable; +stale-while-revalidate=0 partial; no-store when nothing usable",
    "/api/contexts": "public, max-age=30, s-maxage=30, stale-while-revalidate=120 when usable; no-store otherwise",
    "/api/transit": "public, max-age=15, s-maxage=60 live; max-age=15, s-maxage=15 partial; no-store otherwise",
    "/api/history": "public, max-age=60, s-maxage=300 hit; public, max-age=15, s-maxage=30 miss",
    "/api/history/range": "public, max-age=60, s-maxage=60",
    "/api/openapi.json": "public, max-age=3600, s-maxage=86400"
  }
});

export const openApiResponse = () =>
  new Response(JSON.stringify(openApiDocument()), {
    status: 200,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "public, max-age=3600, s-maxage=86400",
      "access-control-allow-origin": "*",
      "x-robots-tag": "noindex, nofollow"
    }
  });
