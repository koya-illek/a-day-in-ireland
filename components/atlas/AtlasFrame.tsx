"use client";

import Link from "next/link";
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type Ref } from "react";
import type { MapSelection } from "../experience-model";
import styles from "./atlas.module.css";

type Reading = "today" | "place" | "observations" | "sources";
type Props = {
  experienceRef: Ref<HTMLElement>;
  comparisonHref: string;
  timeMode: "now" | "past";
  preset: string;
  placeName: string;
  placeId: string;
  dateLabel: string;
  timeLabel: string;
  statusLabel: string;
  summary: string;
  search: ReactNode;
  map: ReactNode;
  themes: ReactNode;
  place: ReactNode;
  history: ReactNode;
  freshness: ReactNode;
  notices: ReactNode;
  timeline: ReactNode;
  sky: ReactNode;
  national: ReactNode;
  changes: ReactNode;
  movement: ReactNode;
  detail: ReactNode;
  selected: MapSelection | null;
  observations: MapSelection[];
  onSelect: (selection: MapSelection | null) => void;
  onNow: () => void;
  onPast: () => void;
  onShare: () => void;
  onSave: () => void;
  shareLabel: string;
};

function observationName(selection: MapSelection): string {
  if (selection.type === "movement-stack") return `${selection.items.length} vehicles`;
  switch (selection.type) {
    case "train": return `Train ${selection.item.id}`;
    case "transit": return `${selection.item.route || "Public transport"} · ${selection.item.label || selection.item.id}`;
    case "earthquake": return selection.item.place;
    default: return selection.item.name;
  }
}

export default function AtlasFrame(props: Props) {
  const readingRef = useRef<HTMLDivElement>(null);
  const [mobile, setMobile] = useState(false);
  useEffect(() => {
    const media = window.matchMedia("(max-width: 760px)");
    const update = () => setMobile(media.matches);
    update(); media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  const selectedKey = props.selected ? props.selected.type === "movement-stack" ? `stack:${props.selected.index}` : `${props.selected.type}:${props.selected.item.id}` : null;
  const [reading, setReading] = useState<Reading>("today");
  const [expanded, setExpanded] = useState(false);
  useLayoutEffect(() => {
    if (readingRef.current) readingRef.current.scrollTop = 0;
  }, [reading, props.timeMode, props.placeId, selectedKey]);
  const [changesOpen, setChangesOpen] = useState(false);
  const [sharedReading, setSharedReading] = useState<string | null>(null);
  useEffect(() => {
    const reading = new URL(window.location.href).searchParams.get("reading");
    if (reading && /^[a-z-]+:.{1,128}$/.test(reading)) setSharedReading(reading);
  }, []);
  useEffect(() => {
    if (!sharedReading) return;
    const found = props.observations.find(reading => reading.type !== "movement-stack" && `${reading.type}:${reading.item.id}` === sharedReading);
    if (found) { props.onSelect(found); setSharedReading(null); }
  }, [sharedReading, props.observations, props.onSelect]);
  const [query, setQuery] = useState("");
  const [limit, setLimit] = useState(30);
  useEffect(() => { if (props.selected) setExpanded(true); }, [props.selected]);
  useEffect(() => {
    if (props.placeId !== "island") { setReading("place"); setExpanded(true); }
  }, [props.placeId]);
  useEffect(() => { if (props.timeMode === "past") setExpanded(true); }, [props.timeMode]);
  const isExpanded = expanded || Boolean(props.selected);
  const matches = props.observations.filter(item => observationName(item).toLocaleLowerCase("en-IE").includes(query.toLocaleLowerCase("en-IE")));
  const historicalMovement = props.timeMode === "past" && props.preset === "movement";
  const changeReading = (next: Reading) => { props.onSelect(null); setReading(next); setExpanded(true); };
  return <main ref={props.experienceRef} className={styles.atlas} data-preset={props.preset} data-time-mode={props.timeMode} data-expanded={isExpanded}>
    <a className="skip-link" href="#atlas-reading">Skip to observations</a>
    <header className={styles.header}>
      <div className={styles.identity}><Link href="/v2"><h1>A Day in Ireland</h1></Link><span>Living atlas · v2</span></div>
      <div className={styles.search}>{props.search}</div>
      <nav aria-label="View controls" className={styles.actions}>
        <button onClick={props.onShare} type="button">{props.shareLabel}</button>
        <Link href={props.comparisonHref} prefetch={false}>Original view ↗</Link>
      </nav>
    </header>
    <div className={styles.workspace}>
      <div className={styles.mapArea}>
        <div className={styles.timebar}>
          <div className={styles.timeSwitch} role="group" aria-label="Time mode">
            <button type="button" aria-pressed={props.timeMode === "now"} onClick={props.onNow}>Now</button>
            <button type="button" aria-pressed={props.timeMode === "past"} onClick={props.onPast}>History</button>
          </div>
          <span>{props.statusLabel}<small>{props.timeLabel} · Irish time</small></span>
        </div>
        <div className={styles.themes}>{props.themes}</div>
        <div className={styles.mapSurface} hidden={historicalMovement} inert={mobile && isExpanded ? true : undefined}>{props.map}</div>
        {historicalMovement && <section className={styles.historySummary} aria-labelledby="movement-history-title">
          <h2 id="movement-history-title">Movement, recorded</h2>
          <p>History retains feed totals. Individual vehicle positions and routes are not stored.</p>
          {props.movement}
          <p>Choose Weather or Water to explore retained observations on the map.</p>
          <button type="button" onClick={props.onNow}>Return to current positions</button>
        </section>}
        <div className={styles.mapFoot}><span>{props.dateLabel}</span><span>Select a reading to look closer</span></div>
      </div>
      <aside id="atlas-reading" className={styles.reading} tabIndex={-1} aria-label="Atlas reading panel">
        <button type="button" className={styles.sheetToggle} aria-expanded={isExpanded} aria-controls="atlas-reading-content" onClick={() => { if (isExpanded) props.onSelect(null); setExpanded(!isExpanded); }}>
          <span>{props.selected ? observationName(props.selected) : props.placeId !== "island" ? props.placeName : props.timeMode === "past" ? "Explore the archive" : "Across Ireland today"}</span>
          <b>{isExpanded ? "Collapse ↓" : "Read more ↑"}</b>
        </button>
        <div ref={readingRef} id="atlas-reading-content" className={styles.readingContent}>
          <nav className={styles.readingNav} aria-label="Reading panel">
            {([["today", "Ireland"], ["place", "Nearby"], ["observations", "Map list"], ["sources", "Sources"]] as const).map(([id, label]) => <button type="button" key={id} aria-pressed={!props.selected && reading === id} onClick={() => changeReading(id)}>{label}</button>)}
          </nav>
          {props.timeMode === "past" && <section className={styles.historyControls} aria-label="Historical time and coverage"><h2>Explore the archive</h2><p>Weather, water and electricity may retain observations. Transport retains totals; imagery and individual journeys are unavailable.</p>{props.history}</section>}
          {sharedReading && <p role="status">The shared reading is not available in this view yet. Feeds may have moved on. <button type="button" onClick={() => setSharedReading(null)}>Dismiss</button></p>}
          {props.selected ? <div className={styles.detail}>{props.detail}<button type="button" className={styles.shareStory} onClick={props.onShare}>Share this reading</button></div> : <>
            {reading === "today" && <div className={styles.edition}>
              <h2>{props.timeMode === "past" ? "Ireland, at that moment." : "An island in motion."}</h2>
              <p className={styles.summary}>{props.summary}</p>
              <p className={styles.caption}>Reporting locations describe their surroundings. Coverage varies across the island.</p>
              <div className={styles.notices}>{props.notices}</div>
              {props.timeMode === "now" && <details className={styles.story} onToggle={event => setChangesOpen(event.currentTarget.open)}><summary>What changed since morning?</summary>{changesOpen && props.changes}</details>}
              <section className={styles.national}><h2>Powering the island</h2>{props.national}</section>
              <div className={styles.sky}>{props.sky}</div>
              {props.timeMode === "past" ? props.timeline : <details className={styles.story}><summary>Weather through the day</summary>{props.timeline}</details>}
              <button type="button" className={styles.shareStory} onClick={props.onSave}>Save this briefing</button>
              <button type="button" className={styles.shareStory} onClick={props.onShare}>{props.shareLabel}</button>
            </div>}
            {reading === "place" && <div className={styles.place}>{props.place}</div>}
            {reading === "observations" && <section className={styles.observationList}><h2>Read the map as a list</h2><p>Readings in this map view. Change theme or zoom to explore others.</p>
              <label htmlFor="atlas-filter">Find a reading</label><input id="atlas-filter" type="search" value={query} onChange={event => { setQuery(event.target.value); setLimit(30); }} />
              <p role="status">{matches.length} matching readings</p>
              <ul>{matches.slice(0, limit).map(item => <li key={item.type === "movement-stack" ? `stack:${item.index}` : `${item.type}:${item.item.id}`}><button type="button" onClick={() => props.onSelect(item)}><span>{observationName(item)}</span><small>{item.type === "station" ? `${item.item.temperature ?? "Unavailable"}${item.item.temperature === null ? "" : "°C"} · ${item.item.description}` : item.type === "river" ? `${item.item.level.toFixed(2)} m · river gauge` : item.type === "transit" ? "Vehicle report" : item.type}</small></button></li>)}</ul>
              {!matches.length && <p>No matching observations are available in this view. Sources explains feed availability.</p>}
              {matches.length > limit && <button type="button" onClick={() => setLimit(value => value + 30)}>Show 30 more</button>}
            </section>}
            {reading === "sources" && <section className={styles.sources}><h2>Behind the observations</h2><p>Each feed has its own update time. Saved, modelled and unavailable readings keep their labels.</p>{props.freshness}<Link href="/data">Sources, licences and methodology ↗</Link></section>}
          </>}
          <footer className={styles.footer}><p>An independent portrait of Ireland, made from public observations.</p><nav aria-label="Project information"><Link href="/about">About</Link><Link href="/data">Data &amp; credits</Link><Link href="/privacy">Privacy</Link><Link href="/contact">Contact</Link></nav><p>For weather, travel and safety decisions, consult the official provider.</p></footer>
        </div>
        <p className={styles.collapsedSummary}>{props.summary}</p>
      </aside>
    </div>
  </main>;
}
