import type { GridReading, WeatherWarning } from "./types";
import { normalizeOfficialWeatherWarnings } from "../platform/river-source.js";
import {
  fetchGrid as fetchSharedGrid,
  fetchGridRows as fetchSharedGridRows,
  EIRGRID_BODY_LIMIT
} from "../platform/live-normalize.js";

export const normalizeWeatherWarnings = (
  rows: Array<Record<string, unknown>>,
  now = Date.now()
): WeatherWarning[] => normalizeOfficialWeatherWarnings(rows, now);

const browserGridOptions = {
  maximumBytes: EIRGRID_BODY_LIMIT,
  requestInit: (chartType: string) => ({
    next: { revalidate: chartType === "frequency" ? 60 : 300 },
    signal: AbortSignal.timeout(8000)
  })
};

export const fetchGridRows = (
  chartType: string,
  areas: string,
  fetcher: typeof fetch = fetch,
  now = Date.now()
) => fetchSharedGridRows(chartType, areas, fetcher, now, browserGridOptions);

export const fetchGrid = (
  fetcher: typeof fetch = fetch,
  now = Date.now()
): Promise<{ reading: GridReading | null; status: "live" | "partial" | "unavailable" }> =>
  fetchSharedGrid(fetcher, now, browserGridOptions);
