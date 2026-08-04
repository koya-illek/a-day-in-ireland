import assert from "node:assert/strict";
import test from "node:test";
import { performance } from "node:perf_hooks";

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

test("a stable screen-space chain does not transitively swallow its tail", () => {
  const chain = [point("chain-c", 580), point("chain-a", 500), point("chain-b", 540)];
  const forward = clusterProjectedPoints(chain, viewport(), 48);
  const reversed = clusterProjectedPoints([...chain].reverse(), viewport(), 48);

  assert.deepEqual(reversed, forward);
  assert.deepEqual(forward.map((cluster) => cluster.items.map((item) => item.key)), [
    ["chain-a", "chain-b"],
    ["chain-c"]
  ]);
});

test("1,200 movement points remain deterministic inside an interaction-frame budget", () => {
  const points = Array.from({ length: 1_200 }, (_, index) => ({
    key: `vehicle-${String(index).padStart(4, "0")}`,
    x: 18 + (index % 40) * 24,
    y: 18 + Math.floor(index / 40) * 28,
    item: index
  }));
  const expected = clusterProjectedPoints(points, viewport(), 44);
  assert.deepEqual(clusterProjectedPoints([...points].reverse(), viewport(), 44), expected);

  for (let index = 0; index < 5; index += 1) clusterProjectedPoints(points, viewport(), 44);
  const durations = Array.from({ length: 25 }, () => {
    const started = performance.now();
    clusterProjectedPoints(points, viewport(), 44);
    return performance.now() - started;
  }).sort((first, second) => first - second);
  const median = durations[Math.floor(durations.length / 2)];
  const p95 = durations[Math.floor(durations.length * .95)];
  assert.ok(median < 8, `median clustering time ${median.toFixed(2)} ms exceeded 8 ms`);
  assert.ok(p95 < 16, `p95 clustering time ${p95.toFixed(2)} ms exceeded one 16 ms interaction frame`);
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

test("zero-spacing critical markers remain distinct and retain offscreen focus", () => {
  const selected = selectDeclutteredPoints(
    [point("alert-a", 500, 100), point("alert-b", 500, 100), point("focused-alert", 2_000, 100)],
    viewport(),
    0,
    "focused-alert"
  );

  assert.deepEqual(selected.map((item) => item.key), ["alert-a", "alert-b", "focused-alert"]);
});
