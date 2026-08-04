import assert from "node:assert/strict";
import test from "node:test";

const {
  clusterProjectedPoints,
  projectToViewport,
  selectDeclutteredPoints
} = await import("../lib/map-density.ts");

const viewport = (overrides = {}) => ({
  scale: 1,
  x: 0,
  y: 0,
  width: 1000,
  height: 900,
  ...overrides
});

const point = (key, x, priority = 0) => ({ key, x, y: 450, item: key, priority });

test("screen projection responds to rendered size, pan, and zoom", () => {
  assert.deepEqual(
    projectToViewport({ x: 500, y: 450 }, viewport({ scale: 2, x: -500, y: -450, width: 500, height: 450 })),
    { x: 250, y: 225 }
  );
});

test("movement clusters are deterministic across provider permutations", () => {
  const points = [point("vehicle-b", 520), point("vehicle-a", 500), point("vehicle-c", 620)];
  const first = clusterProjectedPoints(points, viewport(), 48);
  const second = clusterProjectedPoints([...points].reverse(), viewport(), 48);

  assert.deepEqual(second, first);
  assert.deepEqual(first.map((cluster) => cluster.items.map((item) => item.key)), [
    ["vehicle-a", "vehicle-b"],
    ["vehicle-c"]
  ]);
});

test("the focused constituent remains the cluster identity while membership changes", () => {
  const clustered = clusterProjectedPoints(
    [point("vehicle-a", 500), point("vehicle-b", 520)],
    viewport(),
    48,
    "vehicle-b"
  );
  const split = clusterProjectedPoints(
    [point("vehicle-a", 500), point("vehicle-b", 520)],
    viewport({ scale: 4, x: -1500, y: -1350 }),
    48,
    "vehicle-b"
  );

  assert.equal(clustered[0].key, "vehicle-b");
  assert.ok(split.some((cluster) => cluster.key === "vehicle-b"));
});

test("decluttering keeps priority signals and reveals more points as users zoom", () => {
  const points = [
    point("ordinary-a", 500, 1),
    point("official-alert", 510, 100),
    point("ordinary-b", 520, 1)
  ];
  const island = selectDeclutteredPoints(points, viewport(), 48);
  const zoomed = selectDeclutteredPoints(points, viewport({ scale: 4, x: -1500, y: -1350 }), 48);

  assert.deepEqual(island.map((item) => item.key), ["official-alert"]);
  assert.deepEqual(zoomed.map((item) => item.key), ["official-alert", "ordinary-a", "ordinary-b"]);
});

test("decluttering never drops the currently focused marker", () => {
  const selected = selectDeclutteredPoints(
    [point("higher-priority", 500, 10), point("focused", 510, 0)],
    viewport(),
    48,
    "focused"
  );

  assert.deepEqual(selected.map((item) => item.key), ["focused"]);
});
