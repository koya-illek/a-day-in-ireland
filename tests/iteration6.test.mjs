import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const importRoadGeometry = async () => {
  const source = await readFile(new URL("../lib/road-geometry.ts", import.meta.url), "utf8");
  const output = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.ESNext }
  }).outputText;
  return import(`data:text/javascript,${encodeURIComponent(output)}`);
};

test("road geometry parser accepts a feature collection of objects", async () => {
  const { parseRoadFeatures } = await importRoadGeometry();
  const features = parseRoadFeatures({
    type: "FeatureCollection",
    features: [
      { type: "Feature", properties: { ref: "M7", class: "motorway" } },
      { type: "Feature" }
    ]
  });
  assert.equal(features.length, 2);
  assert.equal(features[0].properties?.ref, "M7");
});

test("road geometry parser rejects payloads without a feature array", async () => {
  const { parseRoadFeatures } = await importRoadGeometry();
  assert.equal(parseRoadFeatures(null), null);
  assert.equal(parseRoadFeatures("features"), null);
  assert.equal(parseRoadFeatures({}), null);
  assert.equal(parseRoadFeatures({ features: "M7" }), null);
});

test("road geometry parser drops non-object entries instead of throwing later", async () => {
  const { parseRoadFeatures } = await importRoadGeometry();
  const features = parseRoadFeatures({ features: [null, 7, { properties: {} }] });
  assert.equal(features.length, 1);
});

test("road asset URL appends an encoded version query only when provided", async () => {
  const { roadAssetUrl } = await importRoadGeometry();
  assert.equal(roadAssetUrl(undefined), "/map/major-roads.json");
  assert.equal(roadAssetUrl(""), "/map/major-roads.json");
  assert.equal(roadAssetUrl("abc123"), "/map/major-roads.json?v=abc123");
});

const importWorker = async (cacheCase) =>
  (await import(`../platform/cloudflare-entry.js?iteration6-health-${cacheCase}`)).default;

const provenanceFixture = {
  schemaVersion: 1,
  builtAt: "2026-08-22T10:00:00.000Z",
  source: { commitSha: "abc123", dirty: false, configSha256: "cfg" },
  generatedData: { sha256: "data-sha" },
  deploymentId: "not-deployed"
};

test("health reports build provenance from the deployed static assets", async () => {
  const worker = await importWorker("success");
  let assetFetches = 0;
  const env = {
    ASSETS: {
      fetch: async () => {
        assetFetches += 1;
        return new Response(JSON.stringify(provenanceFixture), { status: 200 });
      }
    }
  };
  const response = await worker.fetch(new Request("https://day.illek.ie/api/health"), env);
  const body = await response.json();
  assert.equal(body.build.commitSha, "abc123");
  assert.equal(body.build.builtAt, "2026-08-22T10:00:00.000Z");
  assert.equal(body.build.configSha256, "cfg");
  assert.equal(body.build.transitDataSha256, "data-sha");
  // The file records local builds as "not-deployed"; surfacing that label
  // from a deployed Worker would be misleading, so it degrades to unknown.
  assert.equal(body.build.deploymentId, "unknown");
  assert.equal(response.headers.get("cache-control"), "no-store");
  await worker.fetch(new Request("https://day.illek.ie/api/health"), env);
  assert.equal(assetFetches, 1);
});

test("health degrades to unknown provenance when the asset is missing or broken", async () => {
  const worker = await importWorker("failure");
  for (const assetFetch of [
    async () => new Response("nope", { status: 500 }),
    async () => { throw new Error("assets binding fault"); },
    async () => new Response("not json", { status: 200 })
  ]) {
    const response = await worker.fetch(new Request("https://day.illek.ie/api/health"), { ASSETS: { fetch: assetFetch } });
    const body = await response.json();
    assert.deepEqual(body.build, {
      commitSha: "unknown",
      builtAt: "unknown",
      configSha256: "unknown",
      transitDataSha256: "unknown",
      deploymentId: "unknown"
    });
    assert.equal(body.status, "ok");
    assert.equal(response.headers.get("content-type"), "application/json; charset=utf-8");
  }
});

test("health keeps explicit BUILD_* vars ahead of the shipped provenance file", async () => {
  const worker = await importWorker("vars");
  const env = {
    BUILD_COMMIT_SHA: "env-sha",
    ASSETS: { fetch: async () => new Response(JSON.stringify(provenanceFixture), { status: 200 }) }
  };
  const response = await worker.fetch(new Request("https://day.illek.ie/api/health"), env);
  const body = await response.json();
  assert.equal(body.build.commitSha, "env-sha");
});

test("health answers without an ASSETS binding instead of crashing", async () => {
  const worker = await importWorker("nobinding");
  const response = await worker.fetch(new Request("https://day.illek.ie/api/health"), {});
  const body = await response.json();
  assert.equal(body.status, "ok");
  assert.equal(body.build.commitSha, "unknown");
});
