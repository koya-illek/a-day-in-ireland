import type { LiveSnapshot } from "../lib/types";
import { selectForecastPeriod } from "../platform/sky-source.js";
import { formatTime } from "./experience-model";

const skyEventDefinitions = [
  ["First light", "firstLight"],
  ["Morning blue hour", "blueHourMorning"],
  ["Dawn", "dawn"],
  ["Sunrise", "sunrise"],
  ["Morning golden hour", "goldenHourMorning"],
  ["Evening golden hour", "goldenHourEvening"],
  ["Sunset", "sunset"],
  ["Evening blue hour", "blueHourEvening"],
  ["Dusk", "dusk"],
  ["Last light", "lastLight"]
] as const;

function nextSolarTransition(solar: NonNullable<LiveSnapshot["solar"]> | null, now: Date) {
  if (!solar) return null;
  return skyEventDefinitions
    .map(([label, key]) => ({ label, at: solar[key] }))
    .filter((event) => event.at && Date.parse(event.at) > now.getTime())
    .sort((first, second) => Date.parse(first.at!) - Date.parse(second.at!))[0] ?? null;
}

function moonPhaseLabel(phase: number | null, name: string | null) {
  if (name) return name;
  if (phase === null || !Number.isFinite(phase)) return "Phase unavailable";
  if (phase < .0625 || phase >= .9375) return "New moon";
  if (phase < .1875) return "Waxing crescent";
  if (phase < .3125) return "First quarter";
  if (phase < .4375) return "Waxing gibbous";
  if (phase < .5625) return "Full moon";
  if (phase < .6875) return "Waning gibbous";
  if (phase < .8125) return "Last quarter";
  return "Waning crescent";
}

export function SkyLightStrip({ solar, status, now }: {
  solar: LiveSnapshot["solar"];
  status: LiveSnapshot["contextStatus"]["solar"];
  now: Date;
}) {
  if (!solar || status !== "live") {
    return (
      <section className="sky-light-strip unavailable" aria-labelledby="sky-light-heading">
        <div><p className="utility-label">Sky & light</p><h2 id="sky-light-heading">Solar events unavailable</h2></div>
        <p>{status === "stale" ? "The last Dublin event day is cached and is not shown as current." : "Sunrise-Sunset.org did not provide a valid Dublin event day, so no event times are inferred."}</p>
      </section>
    );
  }
  const next = nextSolarTransition(solar, now);
  const illumination = solar.moonIllumination === null
    ? "Unavailable"
    : solar.moonIllumination * 100 < 0.1
      ? "less than 0.1%"
      : `${solar.moonIllumination * 100 < 1
        ? (solar.moonIllumination * 100).toFixed(1)
        : Math.round(solar.moonIllumination * 100)}%`;
  return (
    <section className="sky-light-strip" aria-labelledby="sky-light-heading">
      <div className="sky-light-heading">
        <p className="utility-label">Sky & light · Dublin time</p>
        <h2 id="sky-light-heading">{next ? `${next.label} at ${formatTime(new Date(next.at!))}` : "No later light transition today"}</h2>
        <p>{next ? "The next authoritative change in Ireland’s light." : "The remaining event horizon has no later supplied transition."}</p>
      </div>
      <dl className="sky-light-facts">
        <div><dt>Sunset</dt><dd>{solar.sunset ? formatTime(new Date(solar.sunset)) : "Unavailable"}</dd></div>
        <div><dt>Dusk</dt><dd>{solar.dusk ? formatTime(new Date(solar.dusk)) : "Unavailable"}</dd></div>
        <div><dt>Moon</dt><dd>{moonPhaseLabel(solar.moonPhase, solar.moonPhaseName)} · {illumination}</dd></div>
        <div><dt>Moonrise / set</dt><dd>{solar.moonrise ? formatTime(new Date(solar.moonrise)) : "Unavailable"} / {solar.moonset ? formatTime(new Date(solar.moonset)) : "Unavailable"}</dd></div>
      </dl>
      <a href="https://sunrise-sunset.org/" target="_blank" rel="noreferrer">Source: Sunrise-Sunset.org ↗</a>
    </section>
  );
}

export function ForecastStrip({ forecast, status, now }: {
  forecast: LiveSnapshot["forecast"];
  status: LiveSnapshot["contextStatus"]["forecast"];
  now: Date;
}) {
  const selected = forecast && status === "live" ? selectForecastPeriod(forecast, now.getTime()) : null;
  if (!forecast || !selected) {
    return (
      <section className="forecast-strip unavailable" aria-labelledby="forecast-heading">
        <div><p className="utility-label">FORECAST · Met Éireann</p><h2 id="forecast-heading">Official forecast unavailable</h2></div>
        <p>{status === "stale" ? "The last official forecast is cached and is not shown as current." : "The official forecast and current warnings could not be confirmed together."}</p>
      </section>
    );
  }
  const firstSentenceEnd = selected.copy.search(/[.!?](?:["’”])?(?:\s|$)/);
  const sentence = firstSentenceEnd >= 0 ? selected.copy.slice(0, firstSentenceEnd + 1).trim() : "";
  const excerpt = sentence && sentence.length <= 360
    ? sentence
    : selected.copy.length <= 360
      ? selected.copy
      : `${selected.copy.slice(0, 357).replace(/\s+\S*$/, "").trimEnd()}…`;
  return (
    <section className="forecast-strip" aria-labelledby="forecast-heading">
      <div className="forecast-strip-heading">
        <p className="utility-label">FORECAST · Met Éireann · {selected.period}</p>
        <h2 id="forecast-heading">Next across Ireland</h2>
        <p>Issued {formatTime(new Date(forecast.issued))} Irish time · official copy</p>
      </div>
      <div className="forecast-copy-region">
        <p className="forecast-copy forecast-excerpt"><span className="sr-only">Official forecast excerpt: </span>{excerpt}</p>
        <details className="forecast-disclosure">
          <summary>Read full official {selected.period} forecast</summary>
          <p className="forecast-copy forecast-full-copy">{selected.copy}</p>
        </details>
      </div>
      <a href={forecast.sourceUrl} target="_blank" rel="noreferrer">Source: Met Éireann live text forecast ↗</a>
    </section>
  );
}
