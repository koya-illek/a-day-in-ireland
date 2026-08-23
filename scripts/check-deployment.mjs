import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const sha256File = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");

const requiredString = (value, field) => {
  if (typeof value !== "string" || !value || value === "unknown") {
    throw new Error(`Deployment provenance is missing ${field}`);
  }
  return value;
};

const expectEqual = (actual, expected, field) => {
  if (actual !== expected) {
    throw new Error(`Deployment ${field} mismatch: expected ${expected}, received ${actual ?? "missing"}`);
  }
};

const parseOrigin = (value) => {
  const origin = new URL(value);
  if (origin.protocol !== "https:" || origin.origin !== origin.href.replace(/\/$/, "")) {
    throw new Error("Deployment URL must be an HTTPS origin without a path, query, or fragment");
  }
  return origin.origin;
};

export const localDeploymentExpectation = () => ({
  commitSha: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  configSha256: sha256File("wrangler.api.toml"),
  transitDataSha256: sha256File("public/data/transit-destinations.json")
});

export async function verifyDeployment({
  origin,
  expected,
  fetcher = fetch
}) {
  const canonicalOrigin = parseOrigin(origin);
  const request = (path) => fetcher(new URL(path, canonicalOrigin), {
    cache: "no-store",
    redirect: "manual",
    headers: { accept: path.startsWith("/api/") ? "application/json" : "text/html" }
  });

  const health = await request("/api/health");
  if (health.status !== 200) throw new Error(`Deployment health returned HTTP ${health.status}`);
  if (!health.headers.get("content-type")?.toLowerCase().includes("application/json")) {
    throw new Error("Deployment health did not return JSON");
  }
  if (!health.headers.get("x-robots-tag")?.toLowerCase().includes("noindex")) {
    throw new Error("Deployment health is missing X-Robots-Tag: noindex");
  }
  const healthBody = await health.json();
  if (healthBody?.status !== "ok") throw new Error("Deployment health status is not ok");
  expectEqual(healthBody?.build?.commitSha, expected.commitSha, "commit");
  expectEqual(healthBody?.build?.configSha256, expected.configSha256, "config hash");
  expectEqual(healthBody?.build?.transitDataSha256, expected.transitDataSha256, "transit-data hash");
  const builtAt = requiredString(healthBody?.build?.builtAt, "build time");
  if (!Number.isFinite(Date.parse(builtAt))) throw new Error(`Deployment build time is invalid: ${builtAt}`);

  const home = await request("/");
  if (home.status !== 200) throw new Error(`Deployment homepage returned HTTP ${home.status}`);
  const csp = requiredString(home.headers.get("content-security-policy"), "Content-Security-Policy");
  const scriptSrc = csp.split(";").map((directive) => directive.trim())
    .find((directive) => directive.toLowerCase().startsWith("script-src ")) ?? "";
  if (scriptSrc.includes("'unsafe-inline'")) throw new Error("Deployment script-src still allows 'unsafe-inline'");
  if (!/'sha256-[A-Za-z0-9+/]+=*'/.test(scriptSrc)) {
    throw new Error("Deployment script-src has no inline-script SHA-256 hashes");
  }

  // The release gate also proves the public API documentation and MCP agent
  // surface shipped with this build, so a deploy can never half-land them.
  const spec = await request("/api/openapi.json");
  if (spec.status !== 200 || !spec.headers.get("content-type")?.toLowerCase().includes("application/json")) {
    throw new Error("Deployment OpenAPI document is missing or not JSON");
  }
  const specBody = await spec.json();
  if (specBody?.openapi !== "3.1.0" || !specBody?.paths?.["/api/living"] || !specBody?.paths?.["/api/history"]) {
    throw new Error("Deployment OpenAPI document does not describe the expected API surface");
  }

  const mcp = await fetcher(new URL("/mcp", canonicalOrigin), {
    method: "POST",
    cache: "no-store",
    headers: { "content-type": "application/json", "mcp-protocol-version": "2025-06-18" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } })
  });
  if (mcp.status !== 200) throw new Error(`Deployment MCP initialize returned HTTP ${mcp.status}`);
  if (!mcp.headers.get("content-type")?.toLowerCase().includes("application/json")) {
    throw new Error("Deployment MCP initialize did not return JSON");
  }
  const mcpBody = await mcp.json();
  if (mcpBody?.result?.serverInfo?.name !== "a-day-in-ireland") {
    throw new Error("Deployment MCP initialize did not identify the service");
  }

  const missingPath = `/release-verification-${expected.commitSha.slice(0, 12)}`;
  const missing = await request(missingPath);
  if (missing.status !== 404) throw new Error(`Unknown deployment route returned HTTP ${missing.status}`);
  if (!missing.headers.get("content-type")?.toLowerCase().includes("text/html")) {
    throw new Error("Unknown deployment route did not return HTML");
  }
  const missingBody = await missing.text();
  if (!missingBody.includes("That address is off the map.")) {
    throw new Error("Unknown deployment route did not return the branded 404 page");
  }
  if (!/<meta[^>]+name="robots"[^>]+content="[^"]*noindex/i.test(missingBody)) {
    throw new Error("Unknown deployment route is missing noindex metadata");
  }

  return {
    origin: canonicalOrigin,
    commitSha: expected.commitSha,
    builtAt,
    deploymentId: healthBody?.build?.deploymentId ?? "unknown",
    cspScriptHashes: [...scriptSrc.matchAll(/'sha256-[A-Za-z0-9+/]+=*'/g)].length,
    openapiPaths: Object.keys(specBody.paths).length,
    mcpServer: mcpBody.result.serverInfo.name,
    branded404: true
  };
}

const isMain = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (isMain) {
  const [origin = "https://day.illek.ie", commitSha] = process.argv.slice(2);
  const expected = localDeploymentExpectation();
  if (commitSha) expected.commitSha = commitSha;
  const result = await verifyDeployment({ origin, expected });
  console.log(JSON.stringify(result, null, 2));
}
