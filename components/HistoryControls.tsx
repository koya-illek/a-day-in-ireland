"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import {
  formatIrelandHistoryTime,
  irelandInputParts,
  irelandWallTimeCandidates,
  type HistoryEnvelope,
  type HistoryRange
} from "../lib/history";
import type { HistoryComparisonState, HistoryLoadState, TimeMode } from "./experience-model";

export const historyResolutionLabel = (minutes: number) => minutes >= 1440
  ? "daily summary"
  : minutes >= 60
    ? `${Math.round(minutes / 60)}-hour representative snapshot`
    : `${minutes}-minute snapshot`;

const historySummaryMetric = (value: number | null, suffix = "") => value === null
  ? "Unavailable"
  : `${Number.isInteger(value) ? value.toLocaleString("en-IE") : value.toFixed(1)}${suffix}`;

const historyMetricRows = (past: HistoryEnvelope, comparison: HistoryEnvelope) => {
  const metric = (value: number | null | undefined, suffix = "") => value === null || value === undefined
    ? "Unavailable"
    : `${Number.isInteger(value) ? value.toLocaleString("en-IE") : value.toFixed(1)}${suffix}`;
  return [
    {
      label: "Warmest station",
      past: metric(past.snapshot?.summary.warmest?.temperature, " °C"),
      comparison: metric(comparison.snapshot?.summary.warmest?.temperature, " °C")
    },
    {
      label: "Grid wind share",
      past: metric(past.snapshot?.grid?.windSharePercent, "%"),
      comparison: metric(comparison.snapshot?.grid?.windSharePercent, "%")
    },
    {
      label: "Rail services represented",
      past: metric(past.movementSummary.rail?.total),
      comparison: metric(comparison.movementSummary.rail?.total)
    },
    {
      label: "Official notices",
      past: past.snapshot ? metric(past.snapshot.warnings.length) : "Unavailable",
      comparison: comparison.snapshot ? metric(comparison.snapshot.warnings.length) : "Unavailable"
    },
    {
      label: "Bathing-water alerts",
      past: past.snapshot ? metric(past.snapshot.bathingAlerts.length) : "Unavailable",
      comparison: comparison.snapshot ? metric(comparison.snapshot.bathingAlerts.length) : "Unavailable"
    }
  ];
};

export function HistoryControls({
  mode,
  range,
  history,
  comparison,
  onNow,
  onPast,
  onRequest,
  onCompare
}: {
  mode: TimeMode;
  range: HistoryRange | null;
  history: HistoryLoadState;
  comparison: HistoryComparisonState;
  onNow: () => void;
  onPast: () => void;
  onRequest: (at: string) => void;
  onCompare: () => void;
}) {
  const selectedAt = history.envelope?.resolvedAt ?? history.requestedAt ?? range?.availableTo ?? null;
  const selectedParts = selectedAt ? irelandInputParts(selectedAt) : { date: "", time: "" };
  const [dateInput, setDateInput] = useState(selectedParts.date);
  const [timeInput, setTimeInput] = useState(selectedParts.time);
  const [wallTimeError, setWallTimeError] = useState("");
  const [ambiguousCandidates, setAmbiguousCandidates] = useState<string[]>([]);
  const [chosenCandidate, setChosenCandidate] = useState("");
  const selectedSeconds = selectedAt ? Math.floor(Date.parse(selectedAt) / 1000) : 0;
  const [scrubberSeconds, setScrubberSeconds] = useState(selectedSeconds);
  const submittedScrubberRef = useRef<number | null>(null);
  const scrubberTimerRef = useRef<number | null>(null);

  useEffect(() => {
    if (!selectedAt) return;
    const parts = irelandInputParts(selectedAt);
    setDateInput(parts.date);
    setTimeInput(parts.time);
    setScrubberSeconds(Math.floor(Date.parse(selectedAt) / 1000));
  }, [selectedAt]);

  useEffect(() => {
    if (history.status !== "loading") submittedScrubberRef.current = null;
  }, [history.status, selectedAt]);

  const submitWallTime = () => {
    const candidates = irelandWallTimeCandidates(dateInput, timeInput);
    if (!candidates.length) {
      setWallTimeError("That clock time does not exist in Ireland. Choose another time.");
      setAmbiguousCandidates([]);
      return;
    }
    if (candidates.length > 1 && !chosenCandidate) {
      setWallTimeError("This clock time occurs twice in Ireland. Choose the intended timezone below.");
      setAmbiguousCandidates(candidates);
      return;
    }
    const candidate = chosenCandidate && candidates.includes(chosenCandidate) ? chosenCandidate : candidates[0]!;
    const timestamp = Date.parse(candidate);
    const from = Date.parse(range?.availableFrom ?? "");
    const to = Date.parse(range?.availableTo ?? "");
    if ((Number.isFinite(from) && timestamp < from) || (Number.isFinite(to) && timestamp > to)) {
      setWallTimeError("Choose a time inside the available history range.");
      return;
    }
    setWallTimeError("");
    setAmbiguousCandidates([]);
    setChosenCandidate("");
    onRequest(candidate);
  };

  const submitScrubber = () => {
    // An explicit submission supersedes any pending keyboard-submit timer;
    // its stale closure would otherwise re-request the older instant after
    // this one.
    if (scrubberTimerRef.current !== null) {
      window.clearTimeout(scrubberTimerRef.current);
      scrubberTimerRef.current = null;
    }
    if (!Number.isFinite(scrubberSeconds)) return;
    // A tap that never moved the slider would resubmit the displayed instant,
    // and every request closes open detail cards and drops the comparison
    // table even when the answer cannot change.
    if (submittedScrubberRef.current === scrubberSeconds || scrubberSeconds === selectedSeconds) return;
    submittedScrubberRef.current = scrubberSeconds;
    onRequest(new Date(scrubberSeconds * 1000).toISOString());
  };

  // Sweeping the range with arrow keys would otherwise fetch a snapshot per
  // step; keyboard submissions coalesce, while blur always commits the value.
  const scheduleScrubberSubmit = () => {
    if (scrubberTimerRef.current !== null) window.clearTimeout(scrubberTimerRef.current);
    scrubberTimerRef.current = window.setTimeout(() => {
      scrubberTimerRef.current = null;
      submitScrubber();
    }, 300);
  };
  const flushScrubberSubmit = () => {
    if (scrubberTimerRef.current !== null) {
      window.clearTimeout(scrubberTimerRef.current);
      scrubberTimerRef.current = null;
    }
    submitScrubber();
  };

  useEffect(() => () => {
    if (scrubberTimerRef.current !== null) window.clearTimeout(scrubberTimerRef.current);
  }, []);

  const rangeStart = Date.parse(range?.availableFrom ?? "");
  const rangeEnd = Date.parse(range?.availableTo ?? "");
  const hasRange = Number.isFinite(rangeStart) && Number.isFinite(rangeEnd) && rangeEnd >= rangeStart;
  const resolutionMinutes = history.envelope?.resolutionMinutes ?? range?.resolutionMinutes ?? 15;
  const pickerResolutionMinutes = range?.resolutionMinutes ?? resolutionMinutes;
  const gaps = history.envelope?.gaps ?? [];
  const periodSummary = history.envelope?.periodSummary ?? null;
  const periodStartAt = history.envelope?.periodStartAt ?? history.envelope?.resolvedAt ?? null;
  const periodEndAt = history.envelope?.periodEndAt ?? null;
  const comparisonEligible = history.status === "ready" && resolutionMinutes < 1440;

  return (
    <section className="history-controls" aria-labelledby="history-controls-heading" aria-busy={history.status === "loading"}>
      <div className="history-mode-row">
        <div>
          <p className="utility-label">Time view</p>
          <h2 id="history-controls-heading">Now or past conditions</h2>
        </div>
        <div className="history-mode-toggle" role="group" aria-label="Choose current or historical conditions">
          <button type="button" aria-pressed={mode === "now"} onClick={onNow}>Now</button>
          <button type="button" aria-pressed={mode === "past"} onClick={onPast}>Past</button>
        </div>
      </div>

      {mode === "past" && (
        <>
          <div className="history-picker">
            <label>Date in Ireland<input type="date" aria-invalid={wallTimeError ? true : undefined} aria-describedby={wallTimeError ? "history-wall-time-error" : undefined} value={dateInput} min={range?.availableFrom ? irelandInputParts(range.availableFrom).date : undefined} max={range?.availableTo ? irelandInputParts(range.availableTo).date : undefined} onChange={(event) => { setDateInput(event.target.value); setChosenCandidate(""); }} /></label>
            <label>Time in Ireland<input type="time" step={Math.max(60, pickerResolutionMinutes * 60)} aria-invalid={wallTimeError ? true : undefined} aria-describedby={wallTimeError ? "history-wall-time-error" : undefined} value={timeInput} onChange={(event) => { setTimeInput(event.target.value); setChosenCandidate(""); }} /></label>
            <button type="button" className="history-apply" onClick={submitWallTime} disabled={!dateInput || !timeInput || history.status === "loading"}>Show past conditions</button>
          </div>
          {ambiguousCandidates.length > 1 && (
            <fieldset className="history-ambiguity">
              <legend>Which occurrence of {timeInput}?</legend>
              {ambiguousCandidates.map((candidate) => (
                <label key={candidate}><input type="radio" name="history-offset" value={candidate} checked={chosenCandidate === candidate} onChange={() => setChosenCandidate(candidate)} />{formatIrelandHistoryTime(candidate)}</label>
              ))}
            </fieldset>
          )}
          {wallTimeError && <p className="history-error" id="history-wall-time-error" role="alert">{wallTimeError}</p>}

          <label className="history-scrubber">
            <span>Browse stored snapshots</span>
            <input
              type="range"
              min={hasRange ? Math.floor(rangeStart / 1000) : 0}
              max={hasRange ? Math.floor(rangeEnd / 1000) : 0}
              step={Math.max(60, pickerResolutionMinutes * 60)}
              value={hasRange ? Math.min(Math.floor(rangeEnd / 1000), Math.max(Math.floor(rangeStart / 1000), scrubberSeconds || Math.floor(rangeEnd / 1000))) : 0}
              disabled={!hasRange || rangeStart === rangeEnd || history.status === "loading"}
              aria-valuetext={selectedAt ? `${formatIrelandHistoryTime(new Date((scrubberSeconds || selectedSeconds) * 1000))}; ${historyResolutionLabel(resolutionMinutes)}; ${gaps.length} recorded gap${gaps.length === 1 ? "" : "s"}` : "No stored snapshots available"}
              onChange={(event) => setScrubberSeconds(Number(event.target.value))}
              onPointerUp={submitScrubber}
              onKeyUp={scheduleScrubberSubmit}
              onBlur={flushScrubberSubmit}
            />
            <small>{hasRange ? `${formatIrelandHistoryTime(range!.availableFrom!)} to ${formatIrelandHistoryTime(range!.availableTo!)}` : "History has not collected a snapshot yet."}</small>
          </label>

          <div className={`history-result ${history.status}`} role="status" aria-live="polite" aria-atomic="true">
            {history.status === "loading" && <p>Loading the stored snapshot for {history.requestedAt ? formatIrelandHistoryTime(history.requestedAt) : "the selected time"}…</p>}
            {history.status === "error" && (
              <>
                <p>Historical conditions could not be loaded. {history.error}</p>
                {history.requestedAt && (
                  <button type="button" className="history-retry" onClick={() => onRequest(history.requestedAt!)}>
                    Try again
                  </button>
                )}
              </>
            )}
            {history.status === "gap" && <p>No stored snapshot exists at or before that time within the available resolution. Missing history remains missing.</p>}
            {history.status === "ready" && history.envelope?.resolvedAt && resolutionMinutes < 1440 && (
              <p><b>Showing {formatIrelandHistoryTime(history.envelope.resolvedAt)}</b> · {historyResolutionLabel(history.envelope.resolutionMinutes)}{history.envelope.requestedAt !== history.envelope.resolvedAt ? ` · nearest stored record at or before ${formatIrelandHistoryTime(history.envelope.requestedAt)}` : ""}.</p>
            )}
            {history.status === "ready" && history.envelope?.resolvedAt && resolutionMinutes >= 1440 && (
              <p><b>Showing the retained daily summary for {formatIrelandHistoryTime(periodStartAt ?? history.envelope.resolvedAt, false)}</b>{periodEndAt ? ` · full retained period ${formatIrelandHistoryTime(periodStartAt ?? history.envelope.resolvedAt)} to ${formatIrelandHistoryTime(periodEndAt)}` : ""}. This is a whole-day summary, not conditions at the selected clock time, and it can include representatives later than that time. Daily summaries do not reconstruct a point-by-point map.</p>
            )}
            {gaps.length > 0 && <p><b>Recorded gaps:</b> {gaps.map((gap) => gap.detail).join(" ")}</p>}
            {history.status === "ready" && <p><Link href="/data">Review sources, retention and attribution</Link>.</p>}
          </div>

          {history.status === "ready" && resolutionMinutes >= 1440 && periodSummary && (
            <section className="history-period-summary" aria-labelledby="history-period-summary-heading">
              <div>
                <p className="utility-label">Retained daily summary</p>
                <h3 id="history-period-summary-heading">Across {periodSummary.representedSamples.toLocaleString("en-IE")} retained hourly representative{periodSummary.representedSamples === 1 ? "" : "s"}</h3>
                <p>These values describe the retained hourly representatives only. They are not full-day extrema or a reconstructed point map.</p>
              </div>
              <dl>
                <div><dt>Highest represented temperature</dt><dd>{historySummaryMetric(periodSummary.weather.highestTemperatureC, " °C")}</dd></div>
                <div><dt>Highest represented wind speed</dt><dd>{historySummaryMetric(periodSummary.weather.highestWindSpeedKmh, " km/h")}</dd></div>
                <div><dt>Represented grid wind-share range</dt><dd>{periodSummary.grid.minWindSharePercent === null || periodSummary.grid.maxWindSharePercent === null ? "Unavailable" : `${historySummaryMetric(periodSummary.grid.minWindSharePercent, "%")}–${historySummaryMetric(periodSummary.grid.maxWindSharePercent, "%")}`}</dd></div>
                <div><dt>Highest represented TFI vehicle count</dt><dd>{historySummaryMetric(periodSummary.transit.maxVehicles)}</dd></div>
                <div><dt>Distinct official notices represented</dt><dd>{historySummaryMetric(periodSummary.distinctCounts.officialWarnings)}</dd></div>
              </dl>
            </section>
          )}

          <div className="history-compare-actions">
            <button type="button" onClick={onCompare} disabled={!comparisonEligible || comparison.status === "loading"}>{resolutionMinutes >= 1440 ? "Comparison unavailable for daily summary" : comparison.status === "loading" ? "Loading comparison…" : comparison.status === "ready" ? "Refresh latest stored comparison" : "Compare with latest stored"}</button>
            <small>{resolutionMinutes >= 1440 ? "Comparison is available for point-in-time and hourly records. Daily retained representatives are not compared with a single latest snapshot." : "Uses the newest retained snapshot and labels its capture time; it does not restart live refresh."}</small>
          </div>
          {comparison.status === "error" && <p className="history-error" role="alert">Comparison unavailable. {comparison.error}</p>}
          {comparison.status === "ready" && history.envelope && comparison.envelope?.resolvedAt && (
            <div className="history-comparison" role="region" aria-label="Selected historical conditions compared with the latest stored snapshot">
              <div className="history-comparison-heading"><b>Selected · {history.envelope.resolvedAt ? formatIrelandHistoryTime(history.envelope.resolvedAt) : "Unavailable"}</b><b>Latest stored · {formatIrelandHistoryTime(comparison.envelope.resolvedAt)}</b></div>
              <dl>
                {historyMetricRows(history.envelope, comparison.envelope).map((row) => (
                  <div key={row.label}><dt>{row.label}</dt><dd><span>{row.past}</span><span>{row.comparison}</span></dd></div>
                ))}
              </dl>
            </div>
          )}
        </>
      )}
    </section>
  );
}
