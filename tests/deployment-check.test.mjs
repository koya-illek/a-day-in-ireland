import assert from "node:assert/strict";
import test from "node:test";

import { verifyDeployment } from "../scripts/check-deployment.mjs";

const expected = {
  commitSha: "abc123def456",
  configSha256: "config-sha",
  transitDataSha256: "data-sha"
};

const responseFor = ({
  commitSha = expected.commitSha,
  cspUnsafe = false,
  branded404 = true,
  specMissing = false,
  mcpBroken = false
} = {}) => async (url, init = {}) => {
  const path = new URL(url).pathname;
  if (path === "/api/health") {
    return Response.json({
      status: "ok",
      build: {
        commitSha,
        builtAt: "2026-08-23T15:00:00.000Z",
        configSha256: expected.configSha256,
        transitDataSha256: expected.transitDataSha256,
        deploymentId: "deployment-1"
      }
    }, { headers: { "x-robots-tag": "noindex, nofollow" } });
  }
  if (path === "/") {
    const scriptSrc = cspUnsafe
      ? "script-src 'self' 'unsafe-inline'"
      : "script-src 'self' 'sha256-QUJDRA=='";
    return new Response("<html>home</html>", {
      status: 200,
      headers: { "content-type": "text/html", "content-security-policy": `default-src 'self'; ${scriptSrc}` }
    });
  }
  if (path === "/api/openapi.json") {
    if (specMissing) return new Response("not found", { status: 404, headers: { "content-type": "text/plain" } });
    return Response.json({
      openapi: "3.1.0",
      paths: { "/api/living": {}, "/api/transit": {}, "/api/history": {} }
    }, { headers: { "content-type": "application/json" } });
  }
  if (path === "/mcp" && init.method === "POST") {
    if (mcpBroken) {
      return new Response("<html>worker error</html>", { status: 500, headers: { "content-type": "text/html" } });
    }
    return Response.json({
      jsonrpc: "2.0",
      id: 1,
      result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "a-day-in-ireland", version: "1.0.0" } }
    }, { headers: { "content-type": "application/json" } });
  }
  return new Response(branded404
    ? '<html><head><meta name="robots" content="noindex, follow"></head><body>That address is off the map.</body></html>'
    : "", {
    status: 404,
    headers: { "content-type": "text/html; charset=utf-8" }
  });
};

test("deployment check pins provenance, hashed CSP, branded 404 behavior, and the agent surface", async () => {
  const result = await verifyDeployment({
    origin: "https://day.illek.ie",
    expected,
    fetcher: responseFor()
  });
  assert.equal(result.commitSha, expected.commitSha);
  assert.equal(result.cspScriptHashes, 1);
  assert.equal(result.openapiPaths, 3);
  assert.equal(result.mcpServer, "a-day-in-ireland");
  assert.equal(result.branded404, true);
});

test("deployment check rejects a different live commit", async () => {
  await assert.rejects(
    verifyDeployment({ origin: "https://day.illek.ie", expected, fetcher: responseFor({ commitSha: "old" }) }),
    /commit mismatch/
  );
});

test("deployment check rejects unsafe-inline and a blank 404", async () => {
  await assert.rejects(
    verifyDeployment({ origin: "https://day.illek.ie", expected, fetcher: responseFor({ cspUnsafe: true }) }),
    /unsafe-inline/
  );
  await assert.rejects(
    verifyDeployment({ origin: "https://day.illek.ie", expected, fetcher: responseFor({ branded404: false }) }),
    /branded 404/
  );
});

test("deployment check rejects a deploy that half-landed the API or MCP surfaces", async () => {
  await assert.rejects(
    verifyDeployment({ origin: "https://day.illek.ie", expected, fetcher: responseFor({ specMissing: true }) }),
    /OpenAPI document is missing/
  );
  await assert.rejects(
    verifyDeployment({ origin: "https://day.illek.ie", expected, fetcher: responseFor({ mcpBroken: true }) }),
    /MCP initialize returned HTTP 500/
  );
});
