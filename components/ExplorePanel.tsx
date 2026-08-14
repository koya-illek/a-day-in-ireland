"use client";

import { type RefObject, useEffect, useRef, useState } from "react";
import type { LiveSnapshot } from "../lib/types";
import type { HistoryEnvelope, HistoryGap } from "../lib/history";
import type { Layer, LayerGroup, Preset, TimeMode } from "./experience-model";
import { provenanceLabel } from "./experience-model";
import { historyResolutionLabel } from "./HistoryControls";

const historicalLayerDetail = (layer: Layer, detail: string) => {
  if (layer === "trains") return "Historical rail positions are not retained; only an aggregate appears when permission and coverage allow.";
  if (layer === "transit") return "Historical vehicle positions are not retained; only route and national aggregates appear when available.";
  if (layer === "radar" || layer === "satellite") return "Imagery pixels are not archived in D1; the historical record exposes this as a gap rather than a blank live tile.";
  return detail
    .replace(/\bcurrent\b/gi, "stored")
    .replace(/\blive\b/gi, "retained");
};

const FOCUSABLE_SELECTOR = [
  "button:not([disabled])",
  "a[href]",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "summary",
  "[tabindex]:not([tabindex=\"-1\"])"
].join(", ");

export function ExplorePanel({
  open,
  onOpenChange,
  openerRef,
  timeMode,
  activePreset,
  layers,
  layerGroups,
  onShowPreset,
  onToggleLayer,
  snapshot,
  historyEnvelope,
  historyGaps
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  openerRef: RefObject<HTMLButtonElement | null>;
  timeMode: TimeMode;
  activePreset: Preset;
  layers: Set<Layer>;
  layerGroups: LayerGroup[];
  onShowPreset: (preset: Exclude<Preset, "custom">) => void;
  onToggleLayer: (layer: Layer) => void;
  snapshot: LiveSnapshot;
  historyEnvelope: HistoryEnvelope | null;
  historyGaps: HistoryGap[];
}) {
  const panelRef = useRef<HTMLElement | null>(null);
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const [openLayerGroups, setOpenLayerGroups] = useState<Set<string>>(() => new Set(["weather"]));

  useEffect(() => {
    if (!open) return;
    const panel = panelRef.current;
    const opener = openerRef.current;
    if (!panel) return;

    closeRef.current?.focus();
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onOpenChange(false);
        return;
      }
      if (event.key !== "Tab") return;

      const focusable = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR))
        .filter((element) => element.getAttribute("aria-hidden") !== "true" && element.getClientRects().length > 0);
      if (!focusable.length) {
        event.preventDefault();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;
      if (event.shiftKey && (active === first || !panel.contains(active))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (active === last || !panel.contains(active))) {
        event.preventDefault();
        first.focus();
      }
    };

    panel.addEventListener("keydown", handleKeyDown);
    document.body.style.overflow = "hidden";
    return () => {
      panel.removeEventListener("keydown", handleKeyDown);
      if (opener?.isConnected) opener.focus();
      document.body.style.overflow = "";
    };
  }, [onOpenChange, open, openerRef]);

  return (
    <>
      {open && (
        <button
          className="panel-backdrop"
          aria-label="Close layer panel backdrop"
          onClick={() => onOpenChange(false)}
        />
      )}
      <aside
        ref={panelRef}
        className={`explore-panel ${open ? "is-open" : ""}`}
        aria-hidden={!open}
        aria-modal={open}
        role="dialog"
        aria-label={`Explore ${timeMode === "past" ? "historical" : "live"} map layers`}
        inert={!open}
      >
        <div className="panel-heading">
          <div><p className="eyebrow">Explore the moment</p><h2>Live layers</h2></div>
          <button ref={closeRef} onClick={() => onOpenChange(false)} aria-label="Close explore panel">×</button>
        </div>
        <div className="panel-layer-state" role="status">
          <strong>{activePreset === "custom"
            ? `Custom · ${layers.size} layers`
            : `${activePreset === "all" ? "All layers" : `${activePreset[0]!.toUpperCase()}${activePreset.slice(1)}`} preset · ${layers.size} layers`}</strong>
          <small>Named presets reset the map. Individual switches create a shareable custom view.</small>
        </div>
        <nav className="panel-presets" aria-label="Layer panel presets">
          {(["weather", "movement", "water", "all"] as const).map((preset) => (
            <button
              type="button"
              key={preset}
              className={activePreset === preset ? "active" : ""}
              aria-pressed={activePreset === preset}
              onClick={() => onShowPreset(preset)}
            >
              {preset === "all" ? "All layers" : `${preset[0]!.toUpperCase()}${preset.slice(1)}`}
            </button>
          ))}
        </nav>
        <div className="layer-list" role="group" aria-label="Explore layer categories">
          {layerGroups.map((group) => (
            <details
              className="layer-group"
              data-layer-group={group.id}
              key={group.id}
              open={openLayerGroups.has(group.id)}
              onToggle={(event) => {
                const isOpen = event.currentTarget.open;
                setOpenLayerGroups((current) => {
                  if (current.has(group.id) === isOpen) return current;
                  const next = new Set(current);
                  if (isOpen) next.add(group.id);
                  else next.delete(group.id);
                  return next;
                });
              }}
            >
              <summary className="layer-group-heading">
                <h3 id={`layer-group-${group.id}`}>{group.label}</h3>
                <p>{group.detail}</p>
              </summary>
              <div className="layer-group-controls">
                {group.layers.map(([id, label, detail]) => (
                  <button
                    key={id}
                    data-layer-id={id}
                    className={layers.has(id) ? "active" : ""}
                    onClick={() => onToggleLayer(id)}
                    aria-pressed={layers.has(id)}
                  >
                    <span className="layer-toggle" /><span><b>{label}</b><small>{timeMode === "past" ? historicalLayerDetail(id, detail) : detail}</small></span>
                  </button>
                ))}
              </div>
            </details>
          ))}
        </div>
        <div className="source-note">
          <p className="eyebrow">About the data</p>
          <p>{timeMode === "past" ? "This view uses retained observations, representative rollups and explicit collector gaps. Raw rail or TFI positions and radar or satellite pixels are not archived. Missing history is never replaced with newer data or shown as zero." : "Weather, radar, rail, marine, grid and public signals refresh automatically. Air markers explicitly distinguish delayed station measurements from model output. Solar events and official forecast copy retain their provider meaning. Missing data is never shown as zero."}</p>
          <p>{timeMode === "past" ? `Stored record: ${historyEnvelope?.resolutionMinutes ? historyResolutionLabel(historyEnvelope.resolutionMinutes) : "resolution unavailable"}; ${historyGaps.length} recorded gap${historyGaps.length === 1 ? "" : "s"}.` : <>Provider status: rail {provenanceLabel(snapshot.sourceProvenance?.trains.status ?? "unavailable")}; rivers {provenanceLabel(snapshot.sourceProvenance?.rivers.status ?? "unavailable")}{snapshot.sourceProvenance?.rivers.fallback ? ` via temporary ${snapshot.sourceProvenance.rivers.fallback} path` : ""}.</>}</p>
          <a href="https://www.met.ie/about-us/specialised-services/open-data" target="_blank" rel="noreferrer">Met Éireann open data ↗</a>
          <a href="https://waterlevel.ie/page/api/" target="_blank" rel="noreferrer">OPW water levels ↗</a>
          <a href="https://www.smartgriddashboard.com/" target="_blank" rel="noreferrer">EirGrid Smart Grid Dashboard ↗</a>
          <a href="https://open-meteo.com/en/docs/air-quality-api" target="_blank" rel="noreferrer">Open-Meteo air quality ↗</a>
          <a href="https://www.swpc.noaa.gov/products/aurora-30-minute-forecast" target="_blank" rel="noreferrer">NOAA aurora guidance ↗</a>
          <a href="https://aqportal.discomap.eea.europa.eu/" target="_blank" rel="noreferrer">EEA measured air quality ↗</a>
          <a href="https://data.epa.ie/api-list/bathing-water-open-data/" target="_blank" rel="noreferrer">EPA bathing-water alerts ↗</a>
          <a href="https://earthdata.nasa.gov/gibs/" target="_blank" rel="noreferrer">NASA satellite imagery ↗</a>
          <a href="https://earthquake.usgs.gov/earthquakes/feed/v1.0/" target="_blank" rel="noreferrer">USGS earthquake feed ↗</a>
          <a href="https://celestrak.org/NORAD/elements/" target="_blank" rel="noreferrer">CelesTrak orbital elements ↗</a>
          <a href="https://developer.nationaltransport.ie/" target="_blank" rel="noreferrer">NTA developer portal ↗</a>
          <a href="https://sunrise-sunset.org/" target="_blank" rel="noreferrer">Sunrise-Sunset.org solar events ↗</a>
          <a href="https://www.met.ie/Open_Data/json/National.json" target="_blank" rel="noreferrer">Met Éireann live text forecast ↗</a>
        </div>
      </aside>
    </>
  );
}
