import {
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type Ref,
  type WheelEvent as ReactWheelEvent
} from "react";
import type { TimeMode } from "./experience-model";

export function MapCanvas({
  mapRef,
  timeMode,
  mapView,
  isDenseView,
  markerCount,
  pointObservationCount,
  onClickCapture,
  onClick,
  onPointerDown,
  onPointerMove,
  onPointerUp,
  onPointerCancel,
  onWheel,
  onZoomIn,
  onZoomOut,
  onReset,
  children
}: {
  mapRef: Ref<SVGSVGElement>;
  timeMode: TimeMode;
  mapView: { scale: number; x: number; y: number };
  isDenseView: boolean;
  markerCount: number;
  pointObservationCount: number;
  onClickCapture: (event: ReactMouseEvent<SVGSVGElement>) => void;
  onClick: (event: ReactMouseEvent<SVGSVGElement>) => void;
  onPointerDown: (event: ReactPointerEvent<SVGSVGElement>) => void;
  onPointerMove: (event: ReactPointerEvent<SVGSVGElement>) => void;
  onPointerUp: (event: ReactPointerEvent<SVGSVGElement>) => void;
  onPointerCancel: (event: ReactPointerEvent<SVGSVGElement>) => void;
  onWheel: (event: ReactWheelEvent<SVGSVGElement>) => void;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onReset: () => void;
  children: ReactNode;
}) {
  return (
    <div className="map-canvas">
      <svg
        ref={mapRef}
        className={`ireland-map ${mapView.scale > 1 ? "is-zoomed" : ""} ${isDenseView ? "is-dense-map" : ""}`}
        data-visible-markers={markerCount}
        data-point-observations={pointObservationCount}
        viewBox="0 0 1000 900"
        role="group"
        aria-labelledby="map-title map-description"
        onClickCapture={onClickCapture}
        onClick={onClick}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerCancel}
        onWheel={onWheel}
      >
        <title id="map-title">{timeMode === "past" ? "Stored conditions across Ireland at the selected time" : "Near-real-time conditions across Ireland"}</title>
        <desc id="map-description">{timeMode === "past" ? "A map of retained historical observations across Ireland. Provider gaps and unavailable positions or imagery remain missing; daily summaries do not reconstruct point markers." : "A close map of Ireland showing weather, radar rain, observed wind, rail and public transport, river and tide gauges, sea conditions, measured and modelled air quality, bathing alerts, satellite imagery, seismic detections, ISS passes, aurora guidance and the live power grid."}</desc>
        <defs>
          <radialGradient id="sunGlow">
            <stop offset="0" stopColor="#f4d8a2" stopOpacity=".88" />
            <stop offset="1" stopColor="#c78f58" stopOpacity="0" />
          </radialGradient>
          <radialGradient id="rainMist">
            <stop offset="0" stopColor="#6d97b2" stopOpacity=".42" />
            <stop offset=".55" stopColor="#6d97b2" stopOpacity=".18" />
            <stop offset="1" stopColor="#6d97b2" stopOpacity="0" />
          </radialGradient>
          <radialGradient id="satelliteFade">
            <stop offset=".68" stopColor="white" stopOpacity="1" />
            <stop offset="1" stopColor="white" stopOpacity="0" />
          </radialGradient>
          <linearGradient id="ocean" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#1e3d42" />
            <stop offset="1" stopColor="#102326" />
          </linearGradient>
          <linearGradient id="land" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="#889a6b" />
            <stop offset=".45" stopColor="#5f7354" />
            <stop offset="1" stopColor="#31453f" />
          </linearGradient>
          <linearGradient id="auroraGlow" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#8fc9a0" stopOpacity=".62" />
            <stop offset=".5" stopColor="#6b86a2" stopOpacity=".22" />
            <stop offset="1" stopColor="#8fc9a0" stopOpacity="0" />
          </linearGradient>
          <filter id="landShadow" x="-30%" y="-30%" width="160%" height="160%">
            <feDropShadow dx="0" dy="10" stdDeviation="18" floodColor="#081413" floodOpacity=".38" />
          </filter>
          <clipPath id="viewportClip"><rect width="1000" height="900" rx="42" /></clipPath>
          <mask id="satelliteContextMask"><ellipse cx="520" cy="470" rx="315" ry="445" fill="url(#satelliteFade)" /></mask>
        </defs>
        <g clipPath="url(#viewportClip)">
          <rect className="map-ocean" width="1000" height="900" fill="url(#ocean)" />
          <g
            className="map-viewport"
            data-scale={mapView.scale.toFixed(2)}
            transform={`translate(${mapView.x} ${mapView.y}) scale(${mapView.scale})`}
          >
            {children}
          </g>
        </g>
      </svg>
      <nav className="map-navigation" aria-label="Map navigation">
        <button onClick={onZoomIn} disabled={mapView.scale >= 4} aria-label="Zoom in">+</button>
        <button onClick={onZoomOut} disabled={mapView.scale <= 1} aria-label="Zoom out">−</button>
        <button
          className="map-reset"
          onClick={onReset}
          disabled={mapView.scale === 1 && mapView.x === 0 && mapView.y === 0}
        >
          Reset
        </button>
        <output aria-label="Current map zoom">{Math.round(mapView.scale * 100)}%</output>
      </nav>
    </div>
  );
}
