import type { LiveSnapshot } from "./types";

export function dailyBriefing(snapshot: LiveSnapshot, weatherUsable: boolean, gridUsable: boolean): string[] {
  const lines: string[] = [];
  const temperatures = weatherUsable ? snapshot.stations.flatMap((station) => station.temperature !== null && Number.isFinite(station.temperature) ? [station.temperature] : []) : [];
  if (temperatures.length) {
    const low = Math.min(...temperatures), high = Math.max(...temperatures);
    lines.push(`${temperatures.length} reporting weather stations show ${low === high ? `${low}°C` : `${low}–${high}°C`}.`);
  }
  if (gridUsable && snapshot.grid?.windSharePercent != null) lines.push(`Wind supplies ${snapshot.grid.windSharePercent.toFixed(0)}% of all-island electricity demand.`);
  return lines;
}

// Compare named stations, never changing national samples. Source states and
// timestamps must permit a comparison at both ends.
export function compareBriefings(current: LiveSnapshot, earlier: LiveSnapshot): string[] {
  const lines: string[] = [];
  const usable = (status: string) => status === "live" || status === "partial";
  if (usable(current.sourceStatus) && usable(earlier.sourceStatus)) {
    const previous = new Map(earlier.stations.map((station) => [station.id, station]));
    const pairs = current.stations.flatMap((station) => {
      const before = previous.get(station.id);
      return before && station.temperature !== null && before.temperature !== null &&
        Date.parse(station.observedAt ?? "") > Date.parse(before.observedAt ?? "")
        ? [{ name: station.name, change: station.temperature - before.temperature }] : [];
    });
    const largest = pairs.sort((a, b) => Math.abs(b.change) - Math.abs(a.change) || a.name.localeCompare(b.name))[0];
    if (largest) lines.push(`${largest.name}: ${Math.abs(largest.change).toFixed(1)}°C ${largest.change < 0 ? "cooler" : largest.change > 0 ? "warmer" : "change"}. Largest temperature change among ${pairs.length} matched stations.`);
  }
  if (usable(current.contextStatus.grid) && usable(earlier.contextStatus.grid) && current.grid?.windSharePercent != null && earlier.grid?.windSharePercent != null && Date.parse(current.grid.observedAt ?? "") > Date.parse(earlier.grid.observedAt ?? "")) {
    const delta = current.grid.windSharePercent - earlier.grid.windSharePercent;
    lines.push(`Wind's share of electricity demand: ${Math.abs(delta).toFixed(1)} percentage points ${delta < 0 ? "lower" : delta > 0 ? "higher" : "change"}.`);
  }
  const rivers = new Map(earlier.rivers.map((river) => [river.id, river]));
  if (usable(current.sourceProvenance?.rivers.status ?? "unavailable") && usable(earlier.sourceProvenance?.rivers.status ?? "unavailable")) {
    const matched = current.rivers.flatMap((river) => {
      const before = rivers.get(river.id);
      return before && Number.isFinite(river.level) && Number.isFinite(before.level) && Date.parse(river.observedAt ?? "") > Date.parse(before.observedAt ?? "") ? [{ name: river.name, change: river.level - before.level }] : [];
    }).sort((a,b) => Math.abs(b.change) - Math.abs(a.change) || a.name.localeCompare(b.name));
    const river = matched[0];
    if (river) lines.push(`${river.name}: river level ${Math.abs(river.change).toFixed(2)} m ${river.change < 0 ? "lower" : river.change > 0 ? "higher" : "change"}. Largest change among ${matched.length} matched gauges; this does not assess flood risk.`);
  }
  return lines;
}
