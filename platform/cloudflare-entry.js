import apiWorker, { fetchRiversResult, fetchTrains, fetchTransit } from "./server-entry.js";
import { makeRiverProvenance, makeSourceProvenance, normalizeRiverReadings } from "./river-source.js";
import { captureHistory, handleHistoryRequest, maintainHistory } from "./history.js";
import { summarizeTransit } from "./history-sources.js";

const NTA_REFRESH_MS = 65_000;
const RIVER_REFRESH_MS = 15 * 60_000;
const responseHeaders = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "public, max-age=15, s-maxage=15"
};
const partialHeaders = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "public, max-age=15, s-maxage=15, stale-while-revalidate=0"
};
const transitLiveHeaders = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "public, max-age=15, s-maxage=60, stale-while-revalidate=0"
};
const transitUnavailableHeaders = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store"
};

const captureCutoff = (url, fallback = Date.now()) => {
  const value = Number(url.searchParams.get("captureBucketStartMs"));
  return Number.isInteger(value) && value >= 0 ? value : fallback;
};

const distanceKm = (first, second) => {
  const radians = Math.PI / 180;
  const latitudeDelta = (second.latitude - first.latitude) * radians;
  const longitudeDelta = (second.longitude - first.longitude) * radians;
  const firstLatitude = first.latitude * radians;
  const secondLatitude = second.latitude * radians;
  const haversine =
    Math.sin(latitudeDelta / 2) ** 2 +
    Math.cos(firstLatitude) * Math.cos(secondLatitude) * Math.sin(longitudeDelta / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(haversine), Math.sqrt(1 - haversine));
};

export const addEstimatedSpeeds = (current, previous, maximumKmh = 130) => {
  const previousById = new Map(previous.map((item) => [item.id, item]));
  return current.map((item) => {
    if (item.speedKmh != null) return { ...item, speedSource: item.speedSource ?? "reported" };
    const earlier = previousById.get(item.id);
    if (!earlier) return item;
    const elapsedHours =
      (new Date(item.observedAt).getTime() - new Date(earlier.observedAt).getTime()) / 3_600_000;
    if (!Number.isFinite(elapsedHours) || elapsedHours <= 0 || elapsedHours > 10 / 60) return item;
    const speedKmh = distanceKm(earlier, item) / elapsedHours;
    if (!Number.isFinite(speedKmh) || speedKmh > maximumKmh) return item;
    return { ...item, speedKmh, speedSource: "calculated" };
  });
};

const transitUsable = (status) => status === "live" || status === "partial";

const transitResponse = (value) => new Response(JSON.stringify({
  generatedAt: new Date().toISOString(),
  transit: transitUsable(value.status) ? value.vehicles : [],
  transitStatus: value.status
}), { headers: value.status === "live" ? transitLiveHeaders : value.status === "partial" ? partialHeaders : transitUnavailableHeaders });

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

let trainsInFlight = null;
const dedupedFetchTrains = () => {
  if (!trainsInFlight) {
    trainsInFlight = fetchTrains().finally(() => { trainsInFlight = null; });
  }
  return trainsInFlight;
};

const livingResponse = async (env) => {
  const riverCoordinator = env.RIVER_FEED.getByName("opw-all-island-gauges");
  const [trains, riverResponse] = await Promise.allSettled([
    dedupedFetchTrains(),
    riverCoordinator.fetch("https://internal/rivers")
  ]);
  const riverResult = riverResponse.status === "fulfilled"
    ? await riverResponse.value.json()
    : { rivers: [], status: "unavailable", provenance: makeRiverProvenance({ status: "unavailable" }) };
  if (trains.status === "rejected") console.error("Irish Rail refresh failed", trains.reason);
  if (riverResponse.status === "rejected") console.error("OPW coordinator failed", riverResponse.reason);
  const allLive = trains.status === "fulfilled" && trains.value.length && riverResult.status === "live";
  const anyLive = (trains.status === "fulfilled" && trains.value.length) || riverResult.status === "live";
  const headers = allLive ? responseHeaders : anyLive ? partialHeaders : transitUnavailableHeaders;
  return new Response(JSON.stringify({
    generatedAt: new Date().toISOString(),
    trains: trains.status === "fulfilled" ? trains.value : [],
    rivers: riverResult.rivers,
    sourceStatus: {
      trains: trains.status === "fulfilled" && trains.value.length ? "live" : "unavailable",
      rivers: riverResult.status
    },
    sourceProvenance: {
      trains: makeSourceProvenance({
        provider: "Irish Rail",
        endpoint: "https://api.irishrail.ie/realtime/realtime.asmx/getCurrentTrainsXML",
        status: trains.status === "fulfilled" && trains.value.length ? "live" : "unavailable",
        readings: trains.status === "fulfilled" ? trains.value : []
      }),
      rivers: riverResult.provenance ?? makeRiverProvenance({ status: riverResult.status ?? "unavailable", readings: riverResult.rivers ?? [] })
    }
  }), { headers });
};

// Historical rail retention is disabled unless reuse permission is explicitly
// recorded in configuration. Avoid even calling the Irish Rail upstream during
// the default scheduled capture; only the OPW half of /api/living is needed.
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

const staticResponse = async (request, env) => {
  const incoming = new URL(request.url);
  const pagesOrigin = env.PAGES_ORIGIN || "https://a-day-in-ireland.pages.dev";
  const origin = new URL(`${incoming.pathname}${incoming.search}`, pagesOrigin);
  return fetch(new Request(origin, request), {
    cf: {
      cacheEverything: true,
      cacheTtlByStatus: {
        "200-299": incoming.pathname.includes("/_next/static/") ? 31_536_000 : 300,
        "404": 30,
        "500-599": 0
      }
    }
  });
};

const cloudflareWorker = {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/api/history" || url.pathname === "/api/history/range") {
      return handleHistoryRequest(request, env);
    }
    if (url.pathname === "/api/transit") {
      const coordinator = env.NTA_FEED.getByName("all-island-vehicles");
      return coordinator.fetch("https://internal/transit");
    }
    if (url.pathname === "/api/living") {
      return livingResponse(env);
    }
    if (url.pathname === "/api/contexts") {
      return apiWorker.fetch(request, env);
    }
    if (request.method === "GET" || request.method === "HEAD") return staticResponse(request, env);
    return new Response("Method not allowed", {
      status: 405,
      headers: { allow: "GET, HEAD" }
    });
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
