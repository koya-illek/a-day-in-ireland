"use client";

import {
  type FocusEvent as ReactFocusEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  useEffect,
  useState
} from "react";
import { geoMercator } from "d3-geo";
import type { LiveSnapshot, StationReading } from "../lib/types";
import { maskRadarNoDataPixels } from "../lib/radar-tiles";
import { formatDate, formatTime } from "./experience-model";

export type MarkerInteraction = {
  markerId: string;
  ariaLabel: string;
  tabIndex: number;
  onFocus: (event: ReactFocusEvent<SVGGElement>) => void;
  onKeyDown: (event: ReactKeyboardEvent<SVGGElement>) => void;
  onKeyUp: (event: ReactKeyboardEvent<SVGGElement>) => void;
  onPointerActivate?: (element: SVGElement) => void;
};

export function MapMarker({
  className,
  transform,
  interaction,
  focusRadius,
  onActivate,
  additionalHitCentres,
  dataMovementMembers,
  dataClusterSize,
  children
}: {
  className: string;
  transform: string;
  interaction: MarkerInteraction;
  focusRadius: number;
  onActivate: () => void;
  additionalHitCentres?: ReadonlyArray<{ x: number; y: number }>;
  dataMovementMembers?: string;
  dataClusterSize?: number;
  children: ReactNode;
}) {
  return (
    <g
      className={className}
      data-map-marker="true"
      data-marker-id={interaction.markerId}
      data-movement-members={dataMovementMembers}
      data-cluster-size={dataClusterSize}
      data-marker-pointer-target="true"
      transform={transform}
      role="button"
      tabIndex={interaction.tabIndex}
      aria-label={interaction.ariaLabel}
      onClick={(event) => {
        interaction.onPointerActivate?.(event.currentTarget);
        onActivate();
      }}
      onFocus={interaction.onFocus}
      onKeyDown={interaction.onKeyDown}
      onKeyUp={interaction.onKeyUp}
    >
      <circle
        className="map-marker-hit-target"
        r="1"
        aria-hidden="true"
        vectorEffect="non-scaling-stroke"
      />
      {additionalHitCentres?.map(({ x, y }) => (
        <circle
          className="map-marker-hit-target"
          cx={x}
          cy={y}
          key={`${x}:${y}`}
          r="1"
          aria-hidden="true"
          vectorEffect="non-scaling-stroke"
        />
      ))}
      <circle className="map-marker-focus-ring" r={focusRadius} aria-hidden="true" />
      {children}
    </g>
  );
}

// Null for unrecognised provider text: an unknown direction must not render
// as an arrow asserting northerly flow.
export const windDirectionDegrees = (direction: string) => {
  const points = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"];
  const index = points.indexOf(direction.toUpperCase());
  return index < 0 ? null : index * 22.5;
};

export function StationMarker({
  station,
  projection,
  active,
  showWind,
  onSelect,
  interaction
}: {
  station: StationReading;
  projection: ReturnType<typeof geoMercator>;
  active: boolean;
  showWind: boolean;
  onSelect: (station: StationReading) => void;
  interaction: MarkerInteraction;
}) {
  const point = projection([station.longitude, station.latitude]);
  if (!point) return null;
  const [x, y] = point;
  const wet = (station.rainfall ?? 0) > 0;
  const hasWindGlyph = showWind && station.windSpeed !== null;
  return (
    <MapMarker
      className={`station-marker ${active ? "is-active" : ""} ${wet ? "is-wet" : ""}`}
      transform={`translate(${x} ${y})`}
      interaction={interaction}
      focusRadius={19}
      onActivate={() => onSelect(station)}
      additionalHitCentres={hasWindGlyph ? [{ x: 14, y: 12 }] : undefined}
    >
      {wet && <circle className="rain-ring" r="17" />}
      <circle className="station-halo" r="11" />
      <circle className="station-core" r="4" />
      <text aria-hidden="true" x="10" y="-7">{station.temperature == null ? "Unavailable" : `${station.temperature}°`}</text>
    </MapMarker>
  );
}

const tileLatitude = (y: number, zoom: number) =>
  Math.atan(Math.sinh(Math.PI * (1 - 2 * y / 2 ** zoom))) * 180 / Math.PI;

export const IRELAND_RADAR_TILES = [
  [30, 20], [31, 20], [30, 21], [31, 21]
] as const;
export type RadarTileStatus = "loading" | "ready" | "unavailable";
export type RadarPresentationState = "unchecked" | "loading" | "partial" | "live" | "cached" | "unavailable";
export type RadarTileStatusReporter = (
  frameKey: string,
  tileKey: string,
  status: RadarTileStatus
) => void;
export const createRadarTileStatusRecord = (): Record<string, RadarTileStatus> => Object.fromEntries(
  IRELAND_RADAR_TILES.map(([x, y]) => [`${x}-${y}`, "loading" as const])
);

// Producing one tile costs a network round trip plus decode, canvas masking
// and re-encode. Radar replay re-shows the same few frames every ~850 ms, so
// finished results are kept in a small ref-counted cache: tiles currently
// displayed hold a reference and are never evicted, while unreferenced tiles
// expire oldest-first once the cache exceeds its bound. Seven retained frames
// across four tiles fit comfortably, so a full replay loop does no repeated
// bitmap work after its first pass.
type ProcessedTile = { url: string; refs: number };
const PROCESSED_TILE_CACHE_LIMIT = 32;
const processedTileCache = new Map<string, ProcessedTile>();

const acquireProcessedTile = (href: string) => {
  const cached = processedTileCache.get(href);
  if (!cached) return null;
  processedTileCache.delete(href);
  processedTileCache.set(href, cached);
  cached.refs += 1;
  return cached.url;
};

const rememberProcessedTile = (href: string, url: string) => {
  const existing = processedTileCache.get(href);
  if (existing) {
    existing.refs += 1;
    return;
  }
  processedTileCache.set(href, { url, refs: 1 });
  while (processedTileCache.size > PROCESSED_TILE_CACHE_LIMIT) {
    let evicted = false;
    for (const [key, entry] of processedTileCache) {
      if (entry.refs > 0) continue;
      URL.revokeObjectURL(entry.url);
      processedTileCache.delete(key);
      evicted = true;
      break;
    }
    if (!evicted) break;
  }
};

const releaseProcessedTile = (href: string) => {
  const entry = processedTileCache.get(href);
  if (entry) entry.refs = Math.max(0, entry.refs - 1);
};

function RadarTileImage({
  href,
  frameKey,
  tileKey,
  onStatus,
  x,
  y,
  width,
  height
}: {
  href: string;
  frameKey: string;
  tileKey: string;
  onStatus: RadarTileStatusReporter;
  x: number;
  y: number;
  width: number;
  height: number;
}) {
  const [tile, setTile] = useState<{ href: string | null; status: "loading" | "ready" | "unavailable" }>({
    href: null,
    status: "loading"
  });

  useEffect(() => {
    const controller = new AbortController();
    setTile({ href: null, status: "loading" });

    const cachedUrl = acquireProcessedTile(href);
    if (cachedUrl) {
      setTile({ href: cachedUrl, status: "ready" });
      onStatus(frameKey, tileKey, "ready");
      return () => releaseProcessedTile(href);
    }

    onStatus(frameKey, tileKey, "loading");
    let prepared = false;
    const prepare = async () => {
      try {
        const response = await fetch(href, {
          cache: "force-cache",
          mode: "cors",
          signal: controller.signal
        });
        if (!response.ok || !response.headers.get("content-type")?.toLowerCase().startsWith("image/png")) {
          throw new Error(`Radar tile returned ${response.status}`);
        }
        const bitmap = await createImageBitmap(await response.blob());
        try {
          if (!bitmap.width || !bitmap.height || bitmap.width > 1024 || bitmap.height > 1024) {
            throw new Error("Radar tile dimensions are invalid");
          }
          const canvas = document.createElement("canvas");
          canvas.width = bitmap.width;
          canvas.height = bitmap.height;
          const context = canvas.getContext("2d", { willReadFrequently: true });
          if (!context) throw new Error("Radar tile canvas is unavailable");
          context.drawImage(bitmap, 0, 0);
          const image = context.getImageData(0, 0, bitmap.width, bitmap.height);
          maskRadarNoDataPixels(image.data);
          context.putImageData(image, 0, 0);
          const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
          if (!blob) throw new Error("Radar tile could not be encoded");
          const objectUrl = URL.createObjectURL(blob);
          // The cache owns one reference from production; this instance holds
          // the other until its cleanup runs. An abort after completion still
          // leaves a valid cached copy for the next replay pass.
          rememberProcessedTile(href, objectUrl);
          prepared = true;
          if (controller.signal.aborted) return;
          setTile({ href: objectUrl, status: "ready" });
          onStatus(frameKey, tileKey, "ready");
        } finally {
          bitmap.close();
        }
      } catch {
        if (!controller.signal.aborted) {
          setTile({ href: null, status: "unavailable" });
          onStatus(frameKey, tileKey, "unavailable");
        }
      }
    };
    void prepare();
    return () => {
      controller.abort();
      if (prepared) releaseProcessedTile(href);
    };
  }, [frameKey, href, onStatus, tileKey]);

  return (
    <image
      className="radar-tile"
      data-radar-tile-state={tile.status}
      href={tile.href ?? undefined}
      x={x}
      y={y}
      width={width}
      height={height}
      preserveAspectRatio="none"
      aria-hidden="true"
    />
  );
}

export function RadarTiles({
  frame,
  frameKey,
  projection,
  onTileStatus
}: {
  frame: LiveSnapshot["radar"][number];
  frameKey: string;
  projection: ReturnType<typeof geoMercator>;
  onTileStatus: RadarTileStatusReporter;
}) {
  const zoom = 6;
  return (
    <g className="radar-tiles" role="img" aria-label={`${frame.provider ?? "Met Éireann"} rainfall radar tiles for ${formatTime(new Date(frame.observedAt))}`}>
      {IRELAND_RADAR_TILES.map(([x, y]) => {
        const west = x / 2 ** zoom * 360 - 180;
        const east = (x + 1) / 2 ** zoom * 360 - 180;
        const north = tileLatitude(y, zoom);
        const south = tileLatitude(y + 1, zoom);
        const topLeft = projection([west, north]);
        const bottomRight = projection([east, south]);
        if (!topLeft || !bottomRight) return null;
        const tileKey = `${x}-${y}`;
        return <RadarTileImage
          key={tileKey}
          href={frame.tileTemplate
            .replace("{x}", String(x))
            .replace("{y}", String(y))
            .replace("{z}", String(zoom))}
          frameKey={frameKey}
          tileKey={tileKey}
          onStatus={onTileStatus}
          x={topLeft[0]}
          y={topLeft[1]}
          width={bottomRight[0] - topLeft[0]}
          height={bottomRight[1] - topLeft[1]}
        />;
      })}
    </g>
  );
}

export function SatelliteTiles({
  frame,
  projection
}: {
  frame: NonNullable<LiveSnapshot["satellite"]>;
  projection: ReturnType<typeof geoMercator>;
}) {
  const zoom = 6;
  return (
    <g className="satellite-tiles" role="img" mask="url(#satelliteContextMask)" aria-label={`${frame.label}, ${formatDate(new Date(frame.observedAt))}`}>
      {[30, 31].flatMap((x) => [20, 21].map((y) => {
        const west = x / 2 ** zoom * 360 - 180;
        const east = (x + 1) / 2 ** zoom * 360 - 180;
        const north = tileLatitude(y, zoom);
        const south = tileLatitude(y + 1, zoom);
        const topLeft = projection([west, north]);
        const bottomRight = projection([east, south]);
        if (!topLeft || !bottomRight) return null;
        return (
          <image
            key={`${x}-${y}`}
            href={frame.tileTemplate
              .replace("{x}", String(x))
              .replace("{y}", String(y))
              .replace("{z}", String(zoom))}
            x={topLeft[0]}
            y={topLeft[1]}
            width={bottomRight[0] - topLeft[0]}
            height={bottomRight[1] - topLeft[1]}
            preserveAspectRatio="none"
          />
        );
      }))}
    </g>
  );
}
