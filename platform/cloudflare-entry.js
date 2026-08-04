import apiWorker, { fetchRiversResult, fetchTrains, fetchTransit } from "./server-entry.js";
import { makeRiverProvenance, makeSourceProvenance, normalizeRiverReadings } from "./river-source.js";
import { captureHistory, handleHistoryRequest, maintainHistory } from "./history.js";

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

const transitResponse = (value) => new Response(JSON.stringify({
  generatedAt: new Date().toISOString(),
  transit: value.status === "live" ? value.vehicles : [],
  transitStatus: value.status
}), { headers: value.status === "live" ? transitLiveHeaders : transitUnavailableHeaders });

export class NtaFeedCoordinator {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.refreshPromise = null;
  }

  async refresh(stale) {
    const startedAt = Date.now();
    await this.state.storage.put("nextAllowedAt", startedAt + NTA_REFRESH_MS);
    try {
      const result = await fetchTransit(this.env);
      if (result.status !== "live" || !result.vehicles.length) return { vehicles: [], status: "unavailable" };
      result.vehicles = addEstimatedSpeeds(result.vehicles, stale?.result?.vehicles ?? []);
      const snapshot = { expiresAt: startedAt + NTA_REFRESH_MS, result };
      await this.state.storage.put("snapshot", snapshot);
      return result;
    } catch (error) {
      console.error("NTA coordinated refresh failed", error);
      return { vehicles: [], status: "unavailable" };
    }
  }

  async fetch() {
    const now = Date.now();
    const snapshot = await this.state.storage.get("snapshot");
    if (snapshot?.expiresAt > now && snapshot.result?.status === "live" && snapshot.result.vehicles?.length) {
      return transitResponse(snapshot.result);
    }

    if (!this.refreshPromise) {
      this.refreshPromise = (async () => {
        const nextAllowedAt = await this.state.storage.get("nextAllowedAt");
        if (typeof nextAllowedAt === "number" && nextAllowedAt > Date.now()) {
          return { vehicles: [], status: "unavailable" };
        }
        return this.refresh(snapshot);
      })().finally(() => {
        this.refreshPromise = null;
      });
    }
    return transitResponse(await this.refreshPromise);
  }
}

export class RiverFeedCoordinator {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.refreshPromise = null;
  }

  async refresh(stale) {
    const startedAt = Date.now();
    await this.state.storage.put("nextAllowedAt", startedAt + RIVER_REFRESH_MS);
    try {
      const result = await fetchRiversResult(this.env);
      const rivers = normalizeRiverReadings(result.rivers, startedAt);
      if (!rivers.length) throw new Error("OPW returned no valid fresh river gauges");
      const snapshot = {
        expiresAt: startedAt + RIVER_REFRESH_MS,
        rivers,
        provenance: result.provenance
      };
      await this.state.storage.put("snapshot", snapshot);
      return { rivers, status: result.provenance.status, provenance: result.provenance };
    } catch (error) {
      console.error("OPW coordinated refresh failed", error);
      const freshRivers = normalizeRiverReadings(stale?.rivers ?? [], Date.now());
      const provenance = stale?.provenance
        ? { ...stale.provenance, status: freshRivers.length ? "stale" : "unavailable", fetchedAt: new Date().toISOString(), fallback: "Cached coordinator snapshot" }
        : makeRiverProvenance({
            status: freshRivers.length ? "stale" : "unavailable",
            readings: freshRivers,
            fallback: freshRivers.length ? "Cached coordinator snapshot" : null
          });
      return {
        rivers: freshRivers,
        status: provenance.status,
        provenance
      };
    }
  }

  async fetch() {
    const now = Date.now();
    const snapshot = await this.state.storage.get("snapshot");
    const snapshotRivers = normalizeRiverReadings(snapshot?.rivers ?? [], now);
    if (snapshot?.expiresAt > now && snapshotRivers.length) {
      return Response.json({
        rivers: snapshotRivers,
        status: snapshot.provenance?.status ?? "live",
        provenance: snapshot.provenance ?? makeRiverProvenance({ status: "live", readings: snapshotRivers })
      });
    }
    if (!this.refreshPromise) {
      this.refreshPromise = (async () => {
        const nextAllowedAt = await this.state.storage.get("nextAllowedAt");
        if (typeof nextAllowedAt === "number" && nextAllowedAt > Date.now()) {
          const freshRivers = normalizeRiverReadings(snapshot?.rivers ?? [], Date.now());
          const status = freshRivers.length ? "stale" : "unavailable";
          return {
            rivers: freshRivers,
            status,
            provenance: snapshot?.provenance
              ? { ...snapshot.provenance, status, fetchedAt: new Date().toISOString(), fallback: "Cached coordinator snapshot" }
              : makeRiverProvenance({ status, readings: freshRivers, fallback: freshRivers.length ? "Cached coordinator snapshot" : null })
          };
        }
        return this.refresh(snapshot);
      })().finally(() => {
        this.refreshPromise = null;
      });
    }
    return Response.json(await this.refreshPromise);
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
export const historyLivingSnapshot = async (env) => {
  const riverCoordinator = env.RIVER_FEED.getByName("opw-all-island-gauges");
  try {
    const response = await riverCoordinator.fetch("https://internal/rivers");
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
      const coordinator = env.NTA_FEED.getByName("all-island-vehicles");
      ctx.waitUntil(captureHistory(env, controller.scheduledTime, {
        loadLiving: () => env.HISTORY_INCLUDE_IRISH_RAIL === "true"
          ? livingResponse(env)
          : historyLivingSnapshot(env),
        loadTransit: () => coordinator.fetch("https://internal/transit")
      }));
      return;
    }
    if (controller.cron === "7 * * * *") {
      ctx.waitUntil(maintainHistory(env, controller.scheduledTime));
    }
  }
};

export default cloudflareWorker;
