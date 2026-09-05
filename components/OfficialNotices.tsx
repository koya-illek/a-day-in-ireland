import { humaniseWarningRegions } from "../lib/presentation.js";
import type { LiveSnapshot, WeatherWarning } from "../lib/types";
import type { HistoryGap } from "../lib/history";
import { warningTiming } from "../platform/river-source.js";
import type { Layer, TimeMode } from "./experience-model";

const OFFICIAL_WARNING_URL = "https://www.met.ie/warnings-today.html";

const warningScopeText = (warning: WeatherWarning) => humaniseWarningRegions(warning.regions);

const formatWarningDate = (value: string) => {
  const date = new Date(value);
  return Number.isFinite(date.getTime())
    ? date.toLocaleString("en-IE", {
      weekday: "short",
      day: "numeric",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
      timeZone: "Europe/Dublin"
    })
    : "time unavailable";
};

export function OfficialNotices({
  timeMode,
  compact,
  condensed = false,
  layers,
  visibleWarnings,
  activeWarning,
  warningsUnavailable,
  isConnectingWithoutSnapshot,
  online,
  snapshot,
  now,
  lastSuccessLabel,
  historyGaps,
  historyGapDetail
}: {
  timeMode: TimeMode;
  compact: boolean;
  condensed?: boolean;
  layers: ReadonlySet<Layer>;
  visibleWarnings: WeatherWarning[];
  activeWarning: WeatherWarning | null;
  warningsUnavailable: boolean;
  isConnectingWithoutSnapshot: boolean;
  online: boolean;
  snapshot: LiveSnapshot;
  now: Date;
  lastSuccessLabel: string;
  historyGaps: HistoryGap[];
  historyGapDetail: (gaps: HistoryGap[]) => string | undefined;
}) {
  // Present-tense provenance caveats belong to the live view only; a stored
  // record discloses its capture-time state through its own gap detail.
  const degradedCaveat = timeMode !== "past" && snapshot.contextStatus.warnings === "stale"
    ? `The notice feed could not be refreshed just now; these notices come from the last completed check, ${lastSuccessLabel}.`
    : timeMode !== "past" && (snapshot.contextStatus.warnings === "partial" || snapshot.contextStatus.warnings === "fallback")
      ? "The notice feed answered partially, so this list may be missing some notices."
      : null;

  return (
    <section
      id="official-notices"
      className={`official-notices ${compact ? "compact" : ""}`}
      data-scope="across-ireland"
      tabIndex={-1}
      aria-labelledby="official-notices-heading"
    >
      {compact ? (
        <div className="official-notices-compact-row">
          <span className="live-dot live" aria-hidden="true" />
          <h2 id="official-notices-heading">Official notices</h2>
          <p className="official-notices-empty">No current or upcoming Met Éireann notices.</p>
        </div>
      ) : (
        <>
          <div className="official-notices-heading">
            <div>
              <p className="utility-label">{timeMode === "past" ? "Stored official notices" : "Official notices"}</p>
              <h2 id="official-notices-heading">Official notices {timeMode === "past" ? "at the selected time" : "across Ireland"}</h2>
            </div>
            <p>{timeMode === "past" ? "Notices are evaluated against the selected capture time. Gaps remain explicit and the current warning page is not treated as an archive." : "Met Éireann notices are shown with their named scope and timing. Regional notices do not describe the whole island."}</p>
          </div>
          {layers.has("warnings") ? isConnectingWithoutSnapshot ? (
            <p className="official-notices-empty">{timeMode === "past" ? "Loading stored Met Éireann notices…" : "Connecting to the Met Éireann notice feed…"}</p>
          ) : visibleWarnings.length ? (
            <>
              {visibleWarnings.map((warning, warningIndex) => {
                const timing = warningTiming(warning, now.getTime());
                const isActive = timing === "active";
                const warningIdentity = warning.id || warning.capId || `${warning.headline}-${warningIndex}`;
                const NoticeContent = condensed ? "details" : "div";
                return (
                  <aside
                    id={isActive && warning === activeWarning ? "active-warning" : undefined}
                    key={warningIdentity}
                    className={`warning-strip official-notice ${(warning.level || "advisory").toLowerCase()} ${timing}`}
                    aria-label={`Official Met Éireann ${isActive ? "active" : "upcoming"} notice ${timeMode === "past" ? "at the selected time " : ""}for ${warningScopeText(warning)}`}
                  >
                    <span className="warning-badge">{timeMode === "past" ? isActive ? "Active at capture" : "Upcoming at capture" : isActive ? "Official notice" : "Upcoming notice"}</span>
                    <NoticeContent className="warning-copy" open={condensed && ["red", "orange"].includes(warning.level?.toLowerCase() ?? "") ? true : undefined}>
                      {condensed ? <summary><h3>{warning.headline}</h3></summary> : <h3>{warning.headline}</h3>}
                      <dl className="warning-key-facts">
                        <div><dt>Scope</dt><dd>{warningScopeText(warning)}</dd></div>
                        <div>
                          <dt>{isActive ? "Expires" : "Starts"}</dt>
                          <dd><time dateTime={isActive ? warning.expiry : warning.onset}>{formatWarningDate(isActive ? warning.expiry : warning.onset)}</time></dd>
                        </div>
                      </dl>
                      <p>{warning.description || "Met Éireann has not supplied a description for this notice."}</p>
                      <div className="warning-actions">
                        <a href={OFFICIAL_WARNING_URL} target="_blank" rel="noreferrer">{timeMode === "past" ? "Open current Met Éireann warning page" : "Check official Met Éireann notice"} <span aria-hidden="true">↗</span></a>
                        <details>
                          <summary>Source and issue details</summary>
                          <p>Met Éireann · {warning.level || "Unspecified"} level · severity {warning.severity || "not specified"} · issued {formatWarningDate(warning.issued)} · updated {formatWarningDate(warning.updated)}</p>
                        </details>
                      </div>
                    </NoticeContent>
                  </aside>
                );
              })}
              {degradedCaveat && <p className="official-notices-caveat">{degradedCaveat}</p>}
            </>
          ) : warningsUnavailable ? (
            <p className="official-notices-empty">{timeMode === "past"
              ? historyGapDetail(historyGaps) ?? "Official notices were not retained in this historical record; no zero or all-clear state is inferred."
              : !online ? `Offline. The notice feed cannot be refreshed; last success ${lastSuccessLabel}, so current warnings cannot be confirmed.` : "The Met Éireann notice feed is unavailable, so current warnings cannot be confirmed."}</p>
          ) : timeMode === "past" ? (
            <p className="official-notices-empty">No active or upcoming Met Éireann notices are represented in this stored record.</p>
          ) : snapshot.contextStatus.warnings === "stale" ? (
            <p className="official-notices-empty">The last notice check, {lastSuccessLabel}, recorded no notices; current warnings cannot be confirmed until the feed refreshes.</p>
          ) : snapshot.contextStatus.warnings !== "live" ? (
            <p className="official-notices-empty">The notice feed answered without a complete list, so no all-clear is inferred from the empty result.</p>
          ) : (
            <p className="official-notices-empty">No current or upcoming Met Éireann notices are represented in the current horizon.</p>
          ) : (
            <p className="official-notices-empty">Met Éireann notices are hidden in this map view. Enable them in Explore to review {timeMode === "past" ? "the stored notices" : "official notices across Ireland"}.</p>
          )}
        </>
      )}
    </section>
  );
}
