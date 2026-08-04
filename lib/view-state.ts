export const DEFAULT_PLACE_ID = "island";

export const PRESET_IDS = ["weather", "movement", "water", "all", "custom"] as const;
export type PresetId = (typeof PRESET_IDS)[number];

// This order is part of the share format. Do not derive it from Set insertion order.
export const LAYER_ORDER = [
  "weather",
  "rain",
  "wind",
  "warnings",
  "places",
  "sea",
  "trains",
  "rivers",
  "radar",
  "grid",
  "air",
  "aurora",
  "tides",
  "bathing",
  "iss",
  "satellite",
  "earthquakes",
  "transit"
] as const;

export type ShareableLayer = (typeof LAYER_ORDER)[number];

export type ParsedViewState = {
  placeId: string;
  view: PresetId;
  layers: ShareableLayer[];
  zoom: number | null;
  panX: number | null;
  panY: number | null;
  at: string | null;
};

export type SerializableViewState = {
  placeId: string;
  view: PresetId;
  layers: Iterable<string>;
  zoom?: number;
  panX?: number;
  panY?: number;
  at?: string | null;
};

const isPreset = (value: string | null): value is PresetId =>
  value !== null && PRESET_IDS.includes(value as PresetId);

const validLayer = (value: string): value is ShareableLayer =>
  LAYER_ORDER.includes(value as ShareableLayer);

// Keep URL parsing self-contained: this module is also exercised as a small,
// standalone share-state utility outside the application bundle.
const canonicalHistoryAt = (value: unknown): string | null => {
  if (typeof value !== "string" ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/i.test(value.trim())) {
    return null;
  }
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
};

export function orderedLayers(layers: Iterable<string>): ShareableLayer[] {
  const selected = new Set(layers);
  return LAYER_ORDER.filter((layer) => selected.has(layer));
}

export function parseViewState(
  search: string,
  validPlaceIds: readonly string[]
): ParsedViewState {
  const params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  const requestedPlace = params.get("place");
  const placeId = requestedPlace && validPlaceIds.includes(requestedPlace)
    ? requestedPlace
    : DEFAULT_PLACE_ID;
  const requestedView = params.get("view");
  const view = isPreset(requestedView) ? requestedView : "weather";
  const layers = view === "custom"
    ? orderedLayers((params.get("layers") ?? "").split(",").filter(validLayer))
    : [];
  const requestedZoom = Number(params.get("zoom"));
  const zoom = Number.isFinite(requestedZoom) && requestedZoom >= 1 && requestedZoom <= 4
    ? requestedZoom
    : null;
  const requestedPanX = params.has("x") ? Number(params.get("x")) : Number.NaN;
  const requestedPanY = params.has("y") ? Number(params.get("y")) : Number.NaN;
  const panX = zoom !== null && zoom > 1 && Number.isFinite(requestedPanX)
    ? Math.min(0, Math.max(1000 * (1 - zoom), requestedPanX))
    : null;
  const panY = zoom !== null && zoom > 1 && Number.isFinite(requestedPanY)
    ? Math.min(0, Math.max(900 * (1 - zoom), requestedPanY))
    : null;
  const at = canonicalHistoryAt(params.get("at"));

  return { placeId, view, layers, zoom, panX, panY, at };
}

export function serializeViewState(
  currentUrl: string | URL,
  state: SerializableViewState
): string {
  const url = currentUrl instanceof URL
    ? new URL(currentUrl.href)
    : new URL(currentUrl, "https://day.illek.ie");
  const params = new URLSearchParams();
  const view = isPreset(state.view) ? state.view : "weather";

  // Only these explicit view controls are shareable. Never carry arbitrary
  // observations or coordinates from the existing query string. `at` is the
  // one explicit timestamp supported by the historical share format.
  params.set("place", state.placeId || DEFAULT_PLACE_ID);
  params.set("view", view);
  if (view === "custom") params.set("layers", orderedLayers(state.layers).join(","));
  if (state.zoom !== undefined && Number.isFinite(state.zoom) && state.zoom > 1 && state.zoom <= 4) {
    params.set("zoom", state.zoom.toFixed(2));
    if (state.panX !== undefined && Number.isFinite(state.panX)) params.set("x", state.panX.toFixed(1));
    if (state.panY !== undefined && Number.isFinite(state.panY)) params.set("y", state.panY.toFixed(1));
  }
  const at = canonicalHistoryAt(state.at);
  if (at) params.set("at", at);

  url.search = params.toString();
  url.hash = "";
  return url.toString();
}
