import apiWorker, { fetchRivers, fetchTrains, fetchTransit } from "./server-entry.js";

const NTA_REFRESH_MS = 65_000;
const RIVER_REFRESH_MS = 15 * 60_000;
const responseHeaders = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "public, max-age=60, s-maxage=60, stale-while-revalidate=120"
};

const transitResponse = (value) => new Response(JSON.stringify({
  generatedAt: new Date().toISOString(),
  transit: value.vehicles,
  transitStatus: value.status
}), { headers: responseHeaders });

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
      if (result.status !== "live") throw new Error(`NTA feed status: ${result.status}`);
      const snapshot = { expiresAt: startedAt + NTA_REFRESH_MS, result };
      await this.state.storage.put("snapshot", snapshot);
      return result;
    } catch (error) {
      console.error("NTA coordinated refresh failed", error);
      return stale?.result ?? { vehicles: [], status: "unavailable" };
    }
  }

  async fetch() {
    const now = Date.now();
    const snapshot = await this.state.storage.get("snapshot");
    if (snapshot?.expiresAt > now) return transitResponse(snapshot.result);

    if (!this.refreshPromise) {
      const nextAllowedAt = await this.state.storage.get("nextAllowedAt");
      if (typeof nextAllowedAt === "number" && nextAllowedAt > now) {
        return transitResponse(snapshot?.result ?? { vehicles: [], status: "unavailable" });
      }
      this.refreshPromise = this.refresh(snapshot).finally(() => {
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
      const rivers = await fetchRivers(this.env);
      if (!rivers.length) throw new Error("OPW returned no fresh river gauges");
      const snapshot = {
        expiresAt: startedAt + RIVER_REFRESH_MS,
        rivers
      };
      await this.state.storage.put("snapshot", snapshot);
      return { rivers, status: "live" };
    } catch (error) {
      console.error("OPW coordinated refresh failed", error);
      const freshRivers = (stale?.rivers ?? []).filter((river) =>
        Date.now() - new Date(river.observedAt).getTime() < 3 * 60 * 60_000
      );
      return {
        rivers: freshRivers,
        status: freshRivers.length ? "stale" : "unavailable"
      };
    }
  }

  async fetch() {
    const now = Date.now();
    const snapshot = await this.state.storage.get("snapshot");
    if (snapshot?.expiresAt > now) {
      return Response.json({ rivers: snapshot.rivers, status: "live" });
    }
    if (!this.refreshPromise) {
      const nextAllowedAt = await this.state.storage.get("nextAllowedAt");
      if (typeof nextAllowedAt === "number" && nextAllowedAt > now) {
        const freshRivers = (snapshot?.rivers ?? []).filter((river) =>
          now - new Date(river.observedAt).getTime() < 3 * 60 * 60_000
        );
        return Response.json({
          rivers: freshRivers,
          status: freshRivers.length ? "stale" : "unavailable"
        });
      }
      this.refreshPromise = this.refresh(snapshot).finally(() => {
        this.refreshPromise = null;
      });
    }
    return Response.json(await this.refreshPromise);
  }
}

const livingResponse = async (env) => {
  const riverCoordinator = env.RIVER_FEED.getByName("opw-all-island-gauges");
  const [trains, riverResponse] = await Promise.allSettled([
    fetchTrains(),
    riverCoordinator.fetch("https://internal/rivers")
  ]);
  const riverResult = riverResponse.status === "fulfilled"
    ? await riverResponse.value.json()
    : { rivers: [], status: "unavailable" };
  if (trains.status === "rejected") console.error("Irish Rail refresh failed", trains.reason);
  if (riverResponse.status === "rejected") console.error("OPW coordinator failed", riverResponse.reason);
  return new Response(JSON.stringify({
    generatedAt: new Date().toISOString(),
    trains: trains.status === "fulfilled" ? trains.value : [],
    rivers: riverResult.rivers,
    sourceStatus: {
      trains: trains.status === "fulfilled" ? "live" : "unavailable",
      rivers: riverResult.status
    }
  }), { headers: responseHeaders });
};

const staticResponse = async (request) => {
  const incoming = new URL(request.url);
  const origin = new URL(`${incoming.pathname}${incoming.search}`, "https://a-day-in-ireland.pages.dev");
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

const withCacheHeaders = (response, maxAge, state) => {
  const headers = new Headers(response.headers);
  headers.set("cache-control", `public, max-age=${maxAge}`);
  headers.set("x-island-cache", state);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
};

const cachedApiResponse = async (name, freshSeconds, staleSeconds, context, producer) => {
  const cache = caches.default;
  const freshKey = new Request(`https://day.illek.ie/__edge-cache/${name}/fresh`);
  const staleKey = new Request(`https://day.illek.ie/__edge-cache/${name}/stale`);
  const fresh = await cache.match(freshKey);
  if (fresh) return withCacheHeaders(fresh, freshSeconds, "fresh");

  const refresh = async () => {
    const response = await producer();
    if (response.ok) {
      const freshCopy = withCacheHeaders(response.clone(), freshSeconds, "fresh");
      const staleCopy = withCacheHeaders(response.clone(), staleSeconds, "stale");
      await Promise.all([
        cache.put(freshKey, freshCopy),
        cache.put(staleKey, staleCopy)
      ]);
    }
    return response;
  };

  const stale = await cache.match(staleKey);
  if (stale) {
    context.waitUntil(refresh().catch((error) => console.error(`${name} background refresh failed`, error)));
    return withCacheHeaders(stale, 30, "stale");
  }
  return refresh();
};

const cloudflareWorker = {
  async fetch(request, env, context) {
    const url = new URL(request.url);
    if (url.pathname === "/api/transit") {
      const cache = caches.default;
      const cacheKey = new Request("https://day.illek.ie/__edge-cache/transit");
      const cached = await cache.match(cacheKey);
      if (cached) return cached;

      const coordinator = env.NTA_FEED.getByName("all-island-vehicles");
      const response = await coordinator.fetch("https://internal/transit");
      context.waitUntil(cache.put(cacheKey, response.clone()));
      return response;
    }
    if (url.pathname === "/api/living") {
      return cachedApiResponse("living", 60, 3_600, context, () => livingResponse(env));
    }
    if (url.pathname === "/api/contexts") {
      return cachedApiResponse("contexts", 300, 3_600, context, () => apiWorker.fetch(request, env));
    }
    if (request.method === "GET" || request.method === "HEAD") return staticResponse(request);
    return new Response("Method not allowed", {
      status: 405,
      headers: { allow: "GET, HEAD" }
    });
  }
};

export default cloudflareWorker;
