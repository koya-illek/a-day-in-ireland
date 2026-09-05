"use client";
import { useState } from "react";
import type { LiveSnapshot } from "../lib/types";
import { fetchHistorySnapshot, formatIrelandHistoryTime, irelandInputParts, irelandWallTimeCandidates } from "../lib/history";
import { compareBriefings } from "../lib/daily-briefing";

type Comparison = { kind: "idle" } | { kind: "loading" } | { kind: "ready"; lines: string[]; at: string; comparedAt: string; gaps: number } | { kind: "error"; message: string };
export function BriefingComparison({ snapshot, now, enabled }: { snapshot: LiveSnapshot; now: Date; enabled: boolean }) {
  const [result, setResult] = useState<Comparison>({ kind: "idle" });
  const compare = async () => {
    const { date, time } = irelandInputParts(now.toISOString());
    if (time < "07:00") { setResult({kind: "error", message: "Morning comparisons become available after 07:00 Irish time."}); return; }
    const at = irelandWallTimeCandidates(date, "06:00")[0];
    if (!at) return;
    setResult({ kind: "loading" });
    try {
      const earlier = await fetchHistorySnapshot(at);
      if (!earlier.snapshot || !earlier.resolvedAt || earlier.resolutionMinutes >= 1440 || Math.abs(Date.parse(earlier.resolvedAt) - Date.parse(at)) > 60 * 60_000) {
        setResult({ kind: "error", message: "No suitable morning snapshot was retained. Try the history picker to explore available records." }); return;
      }
      setResult({ kind: "ready", lines: compareBriefings(snapshot, earlier.snapshot), at: earlier.resolvedAt, comparedAt: now.toISOString(), gaps: earlier.gaps.length });
    } catch { setResult({ kind: "error", message: "The morning record could not be loaded. You can try again." }); }
  };
  return <div className="briefing-comparison">
    <button type="button" disabled={!enabled || result.kind === "loading"} onClick={() => void compare()}>{result.kind === "loading" ? "Loading morning record…" : "Compare with this morning"}</button>
    {!enabled && <p>Morning comparisons need current online observations.</p>}
    <div role="status">{result.kind === "error" && <p>{result.message}</p>}
      {result.kind === "ready" && <><p>Observations checked at {formatIrelandHistoryTime(result.comparedAt)}, compared with {formatIrelandHistoryTime(result.at)}. {result.gaps} recorded source gaps. Observation times and coverage vary; these are changes, not unusual-weather assessments.</p>
      {result.lines.length ? <ul>{result.lines.map((line) => <li key={line}>{line}</li>)}</ul> : <p>No matching observations support a comparison.</p>}</>}
    </div>
  </div>;
}
