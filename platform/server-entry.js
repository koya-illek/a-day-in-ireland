// Alternate hosting adapter (dist/server/index.js for the OpenAI hosting
// target). Every API semantic lives in ./api-core.js; this file contributes
// only what differs on this target: direct provider loaders instead of
// Durable Object coordinators, and static serving that mirrors wrangler's
// not_found_handling = "404-page".
import {
  createProvenanceLoader,
  dedupedFetchTrains,
  fetchRiversResult,
  handleApiRequest,
  healthResponse,
  livingResponse,
  methodResponse
} from "./api-core.js";

const loadBuildProvenance = createProvenanceLoader();

const directLivingRoute = (env) => livingResponse({
  // The deduped loader keeps a burst of cold requests from multiplying Irish
  // Rail upstream calls, matching the production adapter's wiring.
  loadTrains: dedupedFetchTrains,
  loadRivers: async () => {
    const result = await fetchRiversResult(env);
    return {
      rivers: result.rivers,
      status: result.provenance?.status ?? "unavailable",
      provenance: result.provenance ?? null
    };
  }
});

const worker = {
  async fetch(request, env) {
    const apiResponse = await handleApiRequest(request, env, {
      health: async (boundEnv) => healthResponse(boundEnv, await loadBuildProvenance(boundEnv)),
      living: directLivingRoute
    });
    if (apiResponse) return apiResponse;
    if (request.method !== "GET" && request.method !== "HEAD") return methodResponse(request);
    const response = await env.ASSETS.fetch(request);
    if (response.status !== 404) return response;
    const url = new URL(request.url);
    if (url.pathname.includes(".")) return response;
    // Unknown document paths get the branded page with a true 404 status.
    // A soft-200 index.html fallback would let crawlers index arbitrary junk
    // paths as duplicates of home and break parity with production and the
    // local static server.
    const notFound = await env.ASSETS.fetch(new Request(new URL("/404.html", url), request));
    return new Response(notFound.body, { status: 404, headers: notFound.headers });
  }
};

export default worker;
