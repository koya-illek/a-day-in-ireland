export type RoadFeature = {
  properties?: {
    class?: string;
    ref?: string;
  };
};

// Decorative road geometry loads as a same-origin static asset instead of
// riding in the JavaScript bundle, so its shape is checked here rather than
// trusted from a build-time import.
export const parseRoadFeatures = (value: unknown): RoadFeature[] | null => {
  if (typeof value !== "object" || value === null) return null;
  const features = (value as { features?: unknown }).features;
  if (!Array.isArray(features)) return null;
  return features.filter((feature): feature is RoadFeature =>
    typeof feature === "object" && feature !== null
  );
};

// The version query comes from a content hash computed at configure time, so
// an immutable cache rule stays correct whenever the geometry is regenerated.
export const roadAssetUrl = (version: string | undefined | null) =>
  version ? `/map/major-roads.json?v=${encodeURIComponent(version)}` : "/map/major-roads.json";
