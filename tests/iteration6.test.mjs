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
