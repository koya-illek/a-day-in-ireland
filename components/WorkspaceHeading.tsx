import { formatDate, formatTime, type HeroFactDraft, type TimeMode } from "./experience-model";

export function WorkspaceHeading({
  now,
  timeMode,
  heroSentence,
  heroSecondary,
  facts,
  onFact
}: {
  now: Date;
  timeMode: TimeMode;
  heroSentence: string;
  heroSecondary: string;
  facts: HeroFactDraft[];
  onFact: (action: HeroFactDraft["action"]) => void;
}) {
  return (
    <div className="workspace-heading" id="ireland-now">
      <div className="workspace-copy">
        <p className="utility-label">{formatDate(now)}<span className="moment-time"> · {formatTime(now)} Irish time</span></p>
        <h1 id="moment-heading">Ireland {timeMode === "past" ? "then" : "now"}.</h1>
        <p className="hero-sentence">{heroSentence}</p>
        <p className="moment-summary">{heroSecondary}</p>
      </div>
      <div className="workspace-facts" role="group" aria-label={`${timeMode === "past" ? "Historical" : "Current"} national highlights across Ireland`}>
        {facts.length ? facts.map((fact) => (
          <button
            type="button"
            key={fact.key}
            className={`hero-fact ${fact.family}`}
            onClick={() => onFact(fact.action)}
          >
            <span>{fact.label}</span>
            <b>{fact.value}</b>
            <small>{fact.detail}</small>
          </button>
        )) : (
          <p className="workspace-facts-empty">Awaiting fresh island-wide signals.</p>
        )}
      </div>
    </div>
  );
}
