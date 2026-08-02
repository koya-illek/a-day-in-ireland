import type { LiveSnapshot } from "./types";

export type ActivityId = "outdoor-walk" | "coast" | "stargazing" | "travel";
export type ActivityStatus = "favourable" | "mixed" | "caution" | "unavailable";

export type ActivityGuidance = {
  id: ActivityId;
  title: string;
  place: string;
  reason: string;
  caveat: string;
  status: ActivityStatus;
};

const ACTIVITY_ORDER: ActivityId[] = ["outdoor-walk", "coast", "stargazing", "travel"];
const MARINE_MAX_AGE_MS = 6 * 60 * 60 * 1000;
const AIR_MAX_AGE_MS = 6 * 60 * 60 * 1000;
const MOVEMENT_MAX_AGE_MS = 30 * 60 * 1000;

const clamp = (value: number, minimum = 0, maximum = 100) =>
  Math.max(minimum, Math.min(maximum, Math.round(value)));

const validDate = (value: string | null | undefined) => {
  if (!value) return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : null;
};

const recent = (value: string | null | undefined, now: number, maximumAge: number) => {
  const time = validDate(value);
  return time !== null && time <= now && now - time <= maximumAge;
};

const median = (values: number[]) => {
  if (!values.length) return null;
  const ordered = [...values].sort((a, b) => a - b);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 ? ordered[middle] : (ordered[middle - 1] + ordered[middle]) / 2;
};

const rangeText = (values: number[], unit: string, digits = 0) => {
  if (!values.length) return null;
  const minimum = Math.min(...values).toFixed(digits);
  const maximum = Math.max(...values).toFixed(digits);
  return minimum === maximum ? `${minimum}${unit}` : `${minimum}${unit} to ${maximum}${unit}`;
};

const formatNumber = (value: number, digits = 0) => value.toFixed(digits);

const activeWarnings = (snapshot: LiveSnapshot, now: number) =>
  snapshot.warnings
    .filter((warning) => {
      const onset = validDate(warning.onset);
      const expiry = validDate(warning.expiry);
      return expiry !== null && expiry > now && (onset === null || onset <= now);
    })
    .sort((a, b) =>
      `${a.expiry}\u0000${a.level}\u0000${a.headline}`.localeCompare(
        `${b.expiry}\u0000${b.level}\u0000${b.headline}`
      )
    );

const activeBathingAlerts = (snapshot: LiveSnapshot, now: number) =>
  snapshot.bathingAlerts
    .filter((alert) => {
      const startedAt = validDate(alert.startedAt);
      return startedAt === null || startedAt <= now;
    })
    .sort((a, b) => `${a.county}\u0000${a.name}\u0000${a.id}`.localeCompare(`${b.county}\u0000${b.name}\u0000${b.id}`));

const statusFor = (score: number, caution: boolean): ActivityStatus => {
  if (caution) return "caution";
  return score >= 70 ? "favourable" : "mixed";
};

const signalStatus = (caution: boolean): ActivityStatus => caution ? "caution" : "mixed";

const unavailable = (
  id: ActivityId,
  title: string,
  place: string,
  reason: string,
  caveat: string
): ActivityGuidance => ({ id, title, place, reason, caveat, status: "unavailable" });

function scoreOutdoorWalk(snapshot: LiveSnapshot, now: number): ActivityGuidance {
  const stations = snapshot.sourceStatus === "fallback" ? [] : snapshot.stations.filter((station) =>
    station.fresh && recent(station.observedAt, now, 3 * 60 * 60 * 1000)
  );
  const temperatures = stations.flatMap((station) => station.temperature === null ? [] : [station.temperature]);
  const rainfall = stations.flatMap((station) => station.rainfall === null ? [] : [station.rainfall]);
  const wind = stations.flatMap((station) => station.windSpeed === null ? [] : [station.windSpeed]);
  if (!stations.length || (!temperatures.length && !rainfall.length && !wind.length)) {
    return unavailable(
      "outdoor-walk",
      "Outdoor walk",
      "Ireland",
      "Recent weather observations do not include a usable temperature, rainfall, or wind value.",
      "The walk opportunity cannot be assessed from the supplied observations."
    );
  }

  const temperature = median(temperatures);
  const rain = median(rainfall);
  const windSpeed = median(wind);
  let score = 50;
  if (temperature !== null) score += temperature >= 8 && temperature <= 22 ? 18 : temperature >= 2 && temperature <= 28 ? 8 : -4;
  if (rain !== null) score += rain <= 0.5 ? 16 : rain <= 2 ? 7 : -10;
  if (windSpeed !== null) score += windSpeed <= 20 ? 16 : windSpeed <= 35 ? 7 : -12;

  const air = snapshot.airQuality
    .filter((reading) => reading.europeanAqi !== null && recent(reading.observedAt, now, AIR_MAX_AGE_MS))
    .sort((a, b) => `${a.name}\u0000${a.id}`.localeCompare(`${b.name}\u0000${b.id}`));
  const highestAqi = air.reduce<typeof air[number] | null>(
    (highest, reading) => !highest || (reading.europeanAqi ?? -Infinity) > (highest.europeanAqi ?? -Infinity) ? reading : highest,
    null
  );
  if (highestAqi?.europeanAqi !== null && highestAqi?.europeanAqi !== undefined) {
    score += highestAqi.europeanAqi <= 50 ? 8 : highestAqi.europeanAqi <= 100 ? 2 : -12;
  }

  const warnings = activeWarnings(snapshot, now);
  const warning = warnings[0];
  const warningsUnavailable = snapshot.contextStatus.warnings === "unavailable";
  if (warning) score -= 25;
  const caution = Boolean(warning) || warningsUnavailable || (windSpeed !== null && windSpeed > 35) || (rain !== null && rain > 2);
  const observationParts = [
    `${stations.length} recent station${stations.length === 1 ? "" : "s"}`,
    temperature === null ? null : `temperature ${rangeText(temperatures, "°C")}`,
    rain === null ? null : `rainfall ${rangeText(rainfall, " mm", 1)}`,
    windSpeed === null ? null : `wind ${rangeText(wind, " km/h")}`
  ].filter((part): part is string => part !== null);
  const caveats = [
    warning ? "An active Met Éireann notice applies; review the official notice above." : null,
    warningsUnavailable ? "The Met Éireann notice feed is unavailable, so current warnings cannot be assessed here." : null,
    highestAqi?.source === "modelled" ? "The strongest air-quality value is modelled rather than measured." : null,
    temperatures.length < stations.length || rainfall.length < stations.length || wind.length < stations.length
      ? "Some station fields are missing." : null,
    "These are recent observations, not a forecast or a safety assessment."
  ].filter((part): part is string => part !== null);
  return {
    id: "outdoor-walk",
    title: "Outdoor walk",
    place: "Ireland",
    reason: `Recent observations: ${observationParts.join(", ")}.`,
    caveat: caveats.join(" "),
    status: statusFor(clamp(score), caution)
  };
}

function describeCoast(snapshot: LiveSnapshot, now: number): ActivityGuidance {
  const marine = snapshot.contextStatus.marine === "live" ? snapshot.marine
    .filter((reading) => recent(reading.observedAt, now, MARINE_MAX_AGE_MS))
    .sort((a, b) => `${a.name}\u0000${a.id}`.localeCompare(`${b.name}\u0000${b.id}`)) : [];
  const tides = snapshot.contextStatus.tides === "live"
    ? snapshot.tides.filter((tide) => recent(tide.observedAt, now, MARINE_MAX_AGE_MS))
      .sort((a, b) => `${a.name}\u0000${a.id}`.localeCompare(`${b.name}\u0000${b.id}`))
    : [];
  const alerts = snapshot.contextStatus.bathing === "unavailable" ? [] : activeBathingAlerts(snapshot, now);
  if (!marine.length && !tides.length && !alerts.length) {
    return unavailable(
      "coast",
      "Coast",
      "Coastal areas",
      "No recent marine, tide, or bathing-alert record is available for a coastal opportunity.",
      snapshot.contextStatus.bathing === "unavailable"
        ? "The bathing-alert feed is unavailable, so current restrictions cannot be assessed."
        : "No recent marine or tide record is available, and no current bathing-water alert is represented in this snapshot."
    );
  }

  const waveHeights = marine.flatMap((reading) => reading.waveHeight === null ? [] : [reading.waveHeight]);
  const marineWind = marine.flatMap((reading) => reading.windSpeedKnots === null ? [] : [reading.windSpeedKnots]);
  const unusualTide = tides
    .filter((tide) => tide.surge !== null && Math.abs(tide.surge) >= 0.2)
    .sort((a, b) => `${a.name}\u0000${a.id}`.localeCompare(`${b.name}\u0000${b.id}`))[0];

  const reference = marine[0]?.name ?? tides[0]?.name ?? alerts[0]?.county ?? "Coastal areas";
  const details = [
    marine.length ? `${marine.length} recent marine observation${marine.length === 1 ? "" : "s"}` : null,
    waveHeights.length ? `wave height ${rangeText(waveHeights, " m", 1)}` : null,
    marineWind.length ? `marine wind ${rangeText(marineWind, " knots")}` : null,
    tides.length ? `${tides.length} recent tide-gauge observation${tides.length === 1 ? "" : "s"}` : null,
    alerts.length ? `${alerts.length} current bathing-water alert${alerts.length === 1 ? "" : "s"}` : null
  ].filter((part): part is string => part !== null);
  const caveats = [
    alerts.length ? `${alerts.length} bathing-water alert${alerts.length === 1 ? "" : "s"} is represented in the snapshot; check the official notice for its named area.` : null,
    unusualTide ? `A tide-gauge surge difference of ${formatNumber(Math.abs(unusualTide.surge as number), 2)} m is represented at ${unusualTide.name}.` : null,
    snapshot.contextStatus.bathing === "unavailable" ? "The bathing-alert feed is unavailable, so current restrictions cannot be assessed." : null,
    snapshot.contextStatus.bathing === "live" && !alerts.length ? "No current bathing-water alert is represented in this snapshot." : null,
    "Marine and tide records describe measured conditions at named locations; they do not establish conditions along the whole coast or a quality recommendation."
  ].filter((part): part is string => part !== null);
  return {
    id: "coast",
    title: "Coast",
    place: reference,
    reason: details.length ? `Current coastal signals: ${details.join(", ")}.` : "A current bathing-water alert is represented for a named coastal area.",
    caveat: caveats.join(" "),
    status: signalStatus(Boolean(alerts.length || unusualTide || (marineWind.length && (median(marineWind) as number) > 25)))
  };
}

function describeStargazing(snapshot: LiveSnapshot, now: number): ActivityGuidance {
  const aurora = snapshot.aurora;
  const passes = snapshot.contextStatus.iss === "unavailable" || !snapshot.iss
    ? []
    : snapshot.iss.passes
      .filter((pass) => {
        const startsAt = validDate(pass.startsAt);
        const endsAt = validDate(pass.endsAt);
        return pass.visible && startsAt !== null && endsAt !== null && endsAt >= startsAt && endsAt >= now;
      })
      .sort((a, b) => `${a.startsAt}\u0000${a.peaksAt}`.localeCompare(`${b.startsAt}\u0000${b.peaksAt}`));
  if (!aurora && !passes.length) {
    return unavailable(
      "stargazing",
      "Stargazing",
      "Ireland",
      "No aurora guidance or upcoming visible ISS pass is available in the supplied snapshot.",
      snapshot.contextStatus.iss === "unavailable"
        ? "ISS data is unavailable, and no aurora guidance is present."
        : "Cloud, darkness, and light-pollution conditions are not supplied."
    );
  }

  const reasons = [
    aurora ? `NOAA aurora probability is ${formatNumber(aurora.probability)}% directly over Ireland` : null,
    passes.length ? `a calculated visible ISS pass is listed at up to ${formatNumber(passes[0].maxElevation)}° elevation` : null
  ].filter((part): part is string => part !== null);
  const caveats = [
    aurora ? "Aurora probability is guidance, not a guarantee of seeing aurora." : null,
    passes.length ? "The ISS pass is calculated from orbital data; it does not establish viewing conditions." : null,
    "Cloud, darkness, and light pollution are not represented."
  ].filter((part): part is string => part !== null);
  return {
    id: "stargazing",
    title: "Stargazing",
    place: "Ireland",
    reason: `Current night-sky signals: ${reasons.join(" and ")}.`,
    caveat: caveats.join(" "),
    status: signalStatus(false)
  };
}

function describeTravel(snapshot: LiveSnapshot, now: number): ActivityGuidance {
  const trains = snapshot.sourceProvenance?.trains.status === "unavailable"
    ? []
    : snapshot.trains.filter((train) => recent(train.observedAt, now, MOVEMENT_MAX_AGE_MS));
  const transit = snapshot.transitStatus === "live"
    ? snapshot.transit.filter((vehicle) => recent(vehicle.observedAt, now, MOVEMENT_MAX_AGE_MS))
    : [];
  if (!trains.length && !transit.length) {
    return unavailable(
      "travel",
      "Travel",
      "Ireland",
      "No recent train or public-transport position is available in the supplied snapshot.",
      snapshot.transitStatus === "credential-required"
        ? "Public-transport positions require credentials, and no recent train position is available."
        : "Live transport data is unavailable or too old to use."
    );
  }

  const caveats = [
    snapshot.transitStatus !== "live" ? "TFI vehicle positions are not live in this snapshot." : null,
    "Positions show observed vehicles, not schedules, fares, delays, seat availability, or a guaranteed service."
  ].filter((part): part is string => part !== null);
  return {
    id: "travel",
    title: "Travel",
    place: "Ireland",
    reason: `Current positions include ${trains.length} train${trains.length === 1 ? "" : "s"} and ${transit.length} public-transport vehicle${transit.length === 1 ? "" : "s"}.`,
    caveat: caveats.join(" "),
    status: signalStatus(false)
  };
}

export function getActivityGuidance(snapshot: LiveSnapshot, now: Date): ActivityGuidance[] {
  const nowMs = now.getTime();
  if (!Number.isFinite(nowMs)) throw new RangeError("now must be a valid Date");
  const guidance: Record<ActivityId, ActivityGuidance> = {
    "outdoor-walk": scoreOutdoorWalk(snapshot, nowMs),
    coast: describeCoast(snapshot, nowMs),
    stargazing: describeStargazing(snapshot, nowMs),
    travel: describeTravel(snapshot, nowMs)
  };
  return ACTIVITY_ORDER.map((id) => guidance[id]);
}
