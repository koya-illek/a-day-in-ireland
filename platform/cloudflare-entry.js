import {
  apiErrorResponse,
  createProvenanceLoader,
  dedupedFetchTrains,
  fetchRiversResult,
  fetchTransit,
  handleApiRequest,
  healthResponse,
  livingResponse as sharedLivingResponse,
  methodResponse,
  transitResponse
} from "./api-core.js";
import { makeRiverProvenance, makeSourceProvenance, normalizeRiverReadings } from "./river-source.js";
import { captureHistory, handleHistoryRequest, maintainHistory } from "./history.js";
import { summarizeTransit } from "./history-sources.js";
import { addEstimatedSpeeds } from "./live-normalize.js";

const NTA_REFRESH_MS = 65_000;
const RIVER_REFRESH_MS = 15 * 60_000;

const transitUsable = (status) => status === "live" || status === "partial";

export class NtaFeedCoordinator {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.refreshPromise = null;
  }

  staleResult(snapshot, errorCode = "provider-rate-limit-stale") {
    return snapshot?.result?.vehicles?.length
      ? { ...snapshot.result, status: "stale", errorCode }
      : { vehicles: [], status: "unavailable", errorCode };
  }

  async refresh(snapshot) {
    const startedAt = Date.now();
    await this.state.storage.put("nextAllowedAt", startedAt + NTA_REFRESH_MS);
    try {
      const value = await fetchTransit(this.env, fetch, startedAt);
      if (!transitUsable(value.status) || !value.vehicles?.length) return value;
      const result = {
        ...value,
        vehicles: addEstimatedSpeeds(value.vehicles, snapshot?.result?.vehicles ?? [])
      };
      await this.state.storage.put("snapshot", { expiresAt: startedAt + NTA_REFRESH_MS, result });
      return result;
    } catch (error) {
      console.error("NTA coordinated refresh failed", error);
      return this.staleResult(snapshot, String(error?.message ?? error));
    }
  }

  async current(snapshot, now) {
    if (snapshot?.expiresAt > now && transitUsable(snapshot.result?.status) && snapshot.result.vehicles?.length) {
      return snapshot.result;
    }
    if (this.refreshPromise) return this.refreshPromise;
    const nextAllowedAt = await this.state.storage.get("nextAllowedAt");
    if (this.refreshPromise) return this.refreshPromise;
    if (typeof nextAllowedAt === "number" && nextAllowedAt > now) return this.staleResult(snapshot);
    if (!this.refreshPromise) {
      this.refreshPromise = this.refresh(snapshot).finally(() => { this.refreshPromise = null; });
    }
    return this.refreshPromise;
  }

  async fetch(request) {
    const requestUrl = new URL(request?.url ?? "https://internal/transit");
    const path = requestUrl.pathname;
    const now = Date.now();
    const cutoffMs = captureCutoff(requestUrl, now);
    const snapshot = await this.state.storage.get("snapshot");
    const result = await this.current(snapshot, now);
    if (path === "/history-summary") {
      const availableVehicles = Array.isArray(result.vehicles) ? result.vehicles : [];
      const vehicles = availableVehicles.filter((vehicle) => {
        const observedAt = Date.parse(vehicle.observedAt);
        const age = cutoffMs - observedAt;
        return Number.isFinite(observedAt) && age >= 0 && age < 30 * 60_000;
      });
      const filteredSubset = vehicles.length < availableVehicles.length;
      const status = transitUsable(result.status) && vehicles.length
        ? filteredSubset ? "partial" : result.status
        : result.status === "credential-required" ? "credential-required"
          : result.status === "stale" ? "stale" : "unavailable";
      return Response.json({
        transit: [],
        transitStatus: status,
        aggregate: transitUsable(status) ? summarizeTransit(vehicles, status, new Date(cutoffMs).toISOString()) : null,
        latestObservedAt: transitUsable(status) ? vehicles.map((vehicle) => vehicle.observedAt).sort().at(-1) ?? null : null,
        errorCode: result.errorCode ?? null
      });
    }
    return transitResponse(result);
  }
}

export class RiverFeedCoordinator {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.refreshPromise = null;
  }

  staleResult(snapshot, now, errorCode = "provider-rate-limit-stale") {
    const rivers = normalizeRiverReadings(snapshot?.rivers ?? [], now);
    const status = rivers.length ? "stale" : "unavailable";
    const provenance = snapshot?.provenance
      ? { ...snapshot.provenance, status, fallback: rivers.length ? `Cached coordinator snapshot; provider error: ${errorCode}` : snapshot.provenance.fallback }
      : makeRiverProvenance({ status, readings: rivers, fallback: rivers.length ? "Cached coordinator snapshot" : null });
    return { rivers, status, provenance, errorCode };
  }

  async refresh(snapshot) {
    const startedAt = Date.now();
    await this.state.storage.put("nextAllowedAt", startedAt + RIVER_REFRESH_MS);
    try {
      const result = await fetchRiversResult(this.env, fetch, startedAt);
      const value = { rivers: result.rivers, status: result.provenance.status, provenance: result.provenance };
      await this.state.storage.put("snapshot", { expiresAt: startedAt + RIVER_REFRESH_MS, ...value });
      return value;
    } catch (error) {
      console.error("OPW coordinated refresh failed", error);
      return this.staleResult(snapshot, startedAt, String(error?.message ?? error));
    }
  }

  async current(snapshot, now) {
    const rivers = normalizeRiverReadings(snapshot?.rivers ?? [], now);
    if (snapshot?.expiresAt > now && rivers.length) {
      return { rivers, status: snapshot.provenance?.status ?? "live", provenance: snapshot.provenance };
    }
    if (this.refreshPromise) return this.refreshPromise;
    const nextAllowedAt = await this.state.storage.get("nextAllowedAt");
    if (this.refreshPromise) return this.refreshPromise;
    if (typeof nextAllowedAt === "number" && nextAllowedAt > now) return this.staleResult(snapshot, now);
    if (!this.refreshPromise) {
      this.refreshPromise = this.refresh(snapshot).finally(() => { this.refreshPromise = null; });
    }
    return this.refreshPromise;
  }

  async fetch(request) {
    const requestUrl = new URL(request?.url ?? "https://internal/rivers");
    const path = requestUrl.pathname;
    const now = Date.now();
    const cutoffMs = captureCutoff(requestUrl, now);
    const snapshot = await this.state.storage.get("snapshot");
    const result = await this.current(snapshot, now);
    if (path === "/history-summary") {
      const availableRivers = Array.isArray(result.rivers) ? result.rivers : [];
      const rivers = normalizeRiverReadings(availableRivers, cutoffMs);
      const filteredSubset = rivers.length < availableRivers.length;
      const usableStatus = result.status === "live" || result.status === "partial" || result.status === "fallback";
      const status = rivers.length
        ? filteredSubset && usableStatus ? "partial" : result.status
        : "unavailable";
      return Response.json({
        rivers,
        status,
        provenance: result.provenance
          ? { ...result.provenance, status, latestObservedAt: rivers.map((river) => river.observedAt).sort().at(-1) ?? null }
          : makeRiverProvenance({ status, readings: rivers }),
        errorCode: result.errorCode ?? null
      });
    }
    return Response.json(result);
  }
}

const captureCutoff = (url, fallback = Date.now()) => {
  const raw = url.searchParams.get("captureBucketStartMs");
  // Number(null) and Number("") are 0, which would silently filter every
  // reading out of a capture; only real, plausible timestamps may override
  // the caller's fallback.
  const value = raw === null || raw.trim() === "" ? Number.NaN : Number(raw);
  if (!Number.isInteger(value) || value < 0 || value > fallback + 60_000) return fallback;
  return value;
};

const loadBuildProvenance = createProvenanceLoader();

// Historical rail retention is disabled unless reuse permission is explicitly
// recorded in configuration. Avoid even calling the Irish Rail upstream during
// the default scheduled capture; only the OPW half of /api/living is needed.
const loadCoordinatedRivers = async (env) => {
  const response = await env.RIVER_FEED.getByName("opw-all-island-gauges").fetch("https://internal/rivers");
  try {
    return await response.json();
  } catch (parseError) {
    console.error("OPW coordinator body was unreadable", parseError);
    return { rivers: [], status: "unavailable", provenance: null };
  }
};

// Exported for tests, which inject loadTrains to avoid the live upstream.
export const livingResponse = (env, { loadTrains = dedupedFetchTrains, loadRivers } = {}) =>
  sharedLivingResponse({
    loadTrains,
    loadRivers: loadRivers ?? (() => loadCoordinatedRivers(env))
  });

export const historyLivingSnapshot = async (env, captureBucketStartMs = Date.now()) => {
  const riverCoordinator = env.RIVER_FEED.getByName("opw-all-island-gauges");
  try {
    const response = await riverCoordinator.fetch(
      `https://internal/history-summary?captureBucketStartMs=${encodeURIComponent(captureBucketStartMs)}`
    );
    if (!response.ok) throw new Error(`river-coordinator-http-${response.status}`);
    const result = await response.json();
    const rivers = Array.isArray(result.rivers) ? result.rivers : [];
    const riverStatus = result.status ?? "unavailable";
    return {
      trains: [],
      rivers,
      sourceStatus: { trains: "unavailable", rivers: riverStatus },
      sourceProvenance: {
        trains: makeSourceProvenance({
          provider: "Irish Rail",
          endpoint: "https://api.irishrail.ie/realtime/realtime.asmx/getCurrentTrainsXML",
          status: "unavailable",
          readings: []
        }),
        rivers: result.provenance ?? makeRiverProvenance({ status: riverStatus, readings: rivers })
      }
    };
  } catch (error) {
    console.error("OPW history capture failed", error);
    return {
      trains: [], rivers: [],
      sourceStatus: { trains: "unavailable", rivers: "unavailable" },
      sourceProvenance: {
        trains: makeSourceProvenance({
          provider: "Irish Rail",
          endpoint: "https://api.irishrail.ie/realtime/realtime.asmx/getCurrentTrainsXML",
          status: "unavailable",
          readings: []
        }),
        rivers: makeRiverProvenance({ status: "unavailable", readings: [] })
      }
    };
  }
};

export const historyTransitSnapshot = async (env, captureBucketStartMs = Date.now()) => {
  const coordinator = env.NTA_FEED.getByName("all-island-vehicles");
  try {
    const response = await coordinator.fetch(
      `https://internal/history-summary?captureBucketStartMs=${encodeURIComponent(captureBucketStartMs)}`
    );
    if (!response.ok) throw new Error(`transit-coordinator-http-${response.status}`);
    return response.json();
  } catch (error) {
    console.error("NTA history capture failed", error);
    return {
      transit: [],
      transitStatus: env.NTA_API_KEY ? "unavailable" : "credential-required",
      aggregate: null,
      latestObservedAt: null
    };
  }
};

export const runPaidHistoryTick = async (env, scheduledTime, {
  capture = captureHistory,
  maintain = maintainHistory
} = {}) => {
  const operations = [["capture", () => capture(env, scheduledTime, {
    loadLiving: (captureBucketStartMs) => historyLivingSnapshot(env, captureBucketStartMs),
    loadTransit: (captureBucketStartMs) => historyTransitSnapshot(env, captureBucketStartMs)
  })]];
  if (new Date(scheduledTime).getUTCMinutes() === 15) operations.push([
    "maintenance",
    () => maintain(env, scheduledTime)
  ]);
  const settled = await Promise.allSettled(operations.map(([, operation]) => operation()));
  const failures = settled.flatMap((result, index) => result.status === "rejected"
    ? [{ operation: operations[index][0], reason: result.reason }]
    : []);
  if (failures.length) {
    const error = new AggregateError(
      failures.map((failure) => failure.reason),
      `Paid history tick failed: ${failures.map((failure) => failure.operation).join(", ")}`
    );
    error.failures = failures;
    throw error;
  }
  return settled[0].value;
};

// History responses carry their own headers from the store layer; keep the
// documented noindex posture on top without disturbing anything else.
const noIndexResponse = async (responsePromise) => {
  const response = await responsePromise;
  const headers = new Headers(response.headers);
  headers.set("x-robots-tag", "noindex, nofollow");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
};

const cloudflareWorker = {
  async fetch(request, env) {
    const apiResponse = await handleApiRequest(request, env, {
      health: async (boundEnv) => healthResponse(boundEnv, await loadBuildProvenance(boundEnv)),
      living: (boundEnv) => livingResponse(boundEnv),
      // Storage or coordinator failures must keep the JSON/CORS/no-store
      // error contract instead of escaping as a bare runtime (1101) page.
      history: async (boundRequest, boundEnv) => {
        try {
          return await noIndexResponse(handleHistoryRequest(boundRequest, boundEnv));
        } catch (error) {
          console.error("History request failed", error);
          return apiErrorResponse("Stored history is temporarily unavailable.");
        }
      }
    });
    if (apiResponse) return apiResponse;
    if (request.method !== "GET" && request.method !== "HEAD") return methodResponse(request);
    const response = await env.ASSETS.fetch(request);
    if (response.status !== 404) return response;
    const url = new URL(request.url);
    if (url.pathname.includes(".")) return response;
    // Do not depend on asset-binding not_found_handling for the recovery page.
    // The explicit fetch also keeps this contract stable when the Worker or
    // asset configuration is deployed independently.
    const notFound = await env.ASSETS.fetch(new Request(new URL("/404.html", url), request));
    return new Response(notFound.body, { status: 404, headers: notFound.headers });
  },

  async scheduled(controller, env, ctx) {
    if (!env.HISTORY_DB) {
      console.warn("Historical storage is not provisioned; scheduled history work was skipped.");
      return;
    }
    if (controller.cron === "*/15 * * * *") {
      ctx.waitUntil(runPaidHistoryTick(env, controller.scheduledTime));
    }
  }
};

export default cloudflareWorker;
