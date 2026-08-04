export type MapViewport = {
  scale: number;
  x: number;
  y: number;
  width: number;
  height: number;
};

export type ProjectedPoint<T> = {
  key: string;
  x: number;
  y: number;
  item: T;
  priority?: number;
};

export type ProjectedCluster<T> = {
  key: string;
  x: number;
  y: number;
  items: ProjectedPoint<T>[];
};

const compareKeys = (first: string, second: string) =>
  first < second ? -1 : first > second ? 1 : 0;

const safeDimension = (value: number, fallback: number) =>
  Number.isFinite(value) && value > 0 ? value : fallback;

export function projectToViewport(
  point: Pick<ProjectedPoint<unknown>, "x" | "y">,
  viewport: MapViewport
) {
  const width = safeDimension(viewport.width, 1000);
  const height = safeDimension(viewport.height, 900);
  return {
    x: (point.x * viewport.scale + viewport.x) * width / 1000,
    y: (point.y * viewport.scale + viewport.y) * height / 900
  };
}

export function pointIsNearViewport(
  point: Pick<ProjectedPoint<unknown>, "x" | "y">,
  viewport: MapViewport,
  marginPixels = 72
) {
  const projected = projectToViewport(point, viewport);
  return projected.x >= -marginPixels &&
    projected.x <= viewport.width + marginPixels &&
    projected.y >= -marginPixels &&
    projected.y <= viewport.height + marginPixels;
}

/**
 * Keeps the highest-priority point in each screen-space cell. Screen-space
 * bucketing makes decluttering respond to both zoom and the rendered map size,
 * rather than assuming a particular desktop viewport.
 */
export function selectDeclutteredPoints<T>(
  points: readonly ProjectedPoint<T>[],
  viewport: MapViewport,
  minimumSpacingPixels: number,
  alwaysIncludeKey: string | null = null
) {
  if (minimumSpacingPixels <= 0) {
    return points
      .filter((point) => pointIsNearViewport(point, viewport))
      .sort((first, second) => compareKeys(first.key, second.key));
  }

  const ordered = [...points].sort((first, second) =>
    (second.priority ?? 0) - (first.priority ?? 0) || compareKeys(first.key, second.key)
  );
  const cells = new Map<string, ProjectedPoint<T>>();
  let forced: ProjectedPoint<T> | null = null;

  for (const point of ordered) {
    if (point.key === alwaysIncludeKey) {
      forced = point;
      continue;
    }
    if (!pointIsNearViewport(point, viewport)) continue;
    const screen = projectToViewport(point, viewport);
    const cell = `${Math.floor(screen.x / minimumSpacingPixels)}:${Math.floor(screen.y / minimumSpacingPixels)}`;
    if (!cells.has(cell)) cells.set(cell, point);
  }

  if (forced) {
    const screen = projectToViewport(forced, viewport);
    const cell = `${Math.floor(screen.x / minimumSpacingPixels)}:${Math.floor(screen.y / minimumSpacingPixels)}`;
    cells.set(cell, forced);
  }

  return [...cells.values()].sort((first, second) => compareKeys(first.key, second.key));
}

/**
 * Builds stable screen-space clusters. Membership is independent of provider
 * ordering; the lexicographically first constituent supplies cluster identity.
 */
export function clusterProjectedPoints<T>(
  points: readonly ProjectedPoint<T>[],
  viewport: MapViewport,
  radiusPixels: number,
  alwaysIncludeKey: string | null = null
): ProjectedCluster<T>[] {
  const visible = points
    .filter((point) => point.key === alwaysIncludeKey || pointIsNearViewport(point, viewport, Math.max(72, radiusPixels)))
    .sort((first, second) => compareKeys(first.key, second.key));
  const clusters: Array<{
    key: string;
    anchorX: number;
    anchorY: number;
    sumX: number;
    sumY: number;
    items: ProjectedPoint<T>[];
  }> = [];

  for (const point of visible) {
    const screen = projectToViewport(point, viewport);
    const candidate = clusters
      .map((cluster) => ({
        cluster,
        distance: Math.hypot(cluster.anchorX - screen.x, cluster.anchorY - screen.y)
      }))
      .filter(({ distance }) => distance < radiusPixels)
      .sort((first, second) =>
        first.distance - second.distance || compareKeys(first.cluster.key, second.cluster.key)
      )[0]?.cluster;

    if (!candidate) {
      clusters.push({
        key: point.key,
        anchorX: screen.x,
        anchorY: screen.y,
        sumX: point.x,
        sumY: point.y,
        items: [point]
      });
      continue;
    }
    candidate.items.push(point);
    candidate.sumX += point.x;
    candidate.sumY += point.y;
  }

  return clusters.map((cluster) => {
    const focusedItem = alwaysIncludeKey
      ? cluster.items.find((point) => point.key === alwaysIncludeKey)
      : null;
    return {
      key: focusedItem?.key ?? cluster.key,
      x: cluster.sumX / cluster.items.length,
      y: cluster.sumY / cluster.items.length,
      items: cluster.items
    };
  }).sort((first, second) => compareKeys(first.key, second.key));
}
