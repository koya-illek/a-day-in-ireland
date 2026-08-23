// Alternate hosting adapter (dist/server/index.js for the OpenAI hosting
// target). Every API semantic lives in ./api-core.js; this file contributes
// only what differs on this target: direct provider loaders instead of
// Durable Object coordinators, and static serving with an SPA fallback for
// extension-less document paths.
import {
  fetchRiversResult,
  fetchTrains,
  handleApiRequest,
  livingResponse,
  methodResponse
} from "./api-core.js";

const directLivingRoute = (env) => livingResponse({
  loadTrains: fetchTrains,
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
    const apiResponse = await handleApiRequest(request, env, { living: directLivingRoute });
    if (apiResponse) return apiResponse;
    if (request.method !== "GET" && request.method !== "HEAD") return methodResponse(request);
    const response = await env.ASSETS.fetch(request);
    if (response.status !== 404) return response;
    const url = new URL(request.url);
    if (url.pathname.includes(".")) return response;
    url.pathname = "/index.html";
    return env.ASSETS.fetch(new Request(url, request));
  }
};

export default worker;
