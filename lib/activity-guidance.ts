import type { LiveSnapshot, WeatherWarning } from "./types";
import {
  isActivityRelevantWeatherWarning,
  warningTiming
} from "../platform/river-source.js";

export type ActivityId = "outdoor-walk" | "coast" | "stargazing" | "travel";

// These are descriptive data states. They deliberately do not imply a
// recommendation, safety judgement, or forecast.
export type ActivityStatus =
  | "live-observations"
  | "relevant-notice"
  | "localized-notice"
  | "limited-context"
  | "live-coverage"
  | "no-current-signal"
  | "unavailable";

export type GuidancePlace = {
  id: string;
  name: string;
  latitude: number;
  longitude: number;
};

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
const WEATHER_NEARBY_RADIUS_KM = 50;
const COAST_NEARBY_RADIUS_KM = 100;

const validDate = (value: string | null | undefined) => {
  if (!value) return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : null;
};

const recent = (value: string | null | undefined, now: number, maximumAge: number) => {
  const time = validDate(value);
  return time !== null && time <= now && now - time <= maximumAge;
};

const rangeText = (values: number[], unit: string, digits = 0) => {
  if (!values.length) return null;
  const minimum = Math.min(...values).toFixed(digits);
  const maximum = Math.max(...values).toFixed(digits);
  return minimum === maximum ? `${minimum}${unit}` : `${minimum}${unit} to ${maximum}${unit}`;
};

const formatNumber = (value: number, digits = 0) => value.toFixed(digits);

const distanceKm = (
  first: { latitude: number; longitude: number },
  second: { latitude: number; longitude: number }
) => {
  const radians = Math.PI / 180;
  const latitudeDelta = (second.latitude - first.latitude) * radians;
  const longitudeDelta = (second.longitude - first.longitude) * radians;
  const firstLatitude = first.latitude * radians;
  const secondLatitude = second.latitude * radians;
  const haversine =
    Math.sin(latitudeDelta / 2) ** 2 +
    Math.cos(firstLatitude) * Math.cos(secondLatitude) * Math.sin(longitudeDelta / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(haversine), Math.sqrt(1 - haversine));
};

const isIsland = (place: GuidancePlace) => place.id === "island";

const nearby = <T extends { latitude: number; longitude: number }>(
  values: T[],
  place: GuidancePlace,
  radiusKm: number
) => isIsland(place)
  ? values
  : values
    .map((item) => ({ item, distance: distanceKm(item, place) }))
    .filter(({ distance }) => distance <= radiusKm)
    .sort((first, second) => first.distance - second.distance)
    .map(({ item }) => item);

const placeTerms = (place: GuidancePlace) => [place.name, place.id]
  .map((value) => value.trim().toLowerCase())
  .filter((value) => value.length >= 3 && value !== "island" && value !== "ireland");

const warningScope = (warning: WeatherWarning, place: GuidancePlace): "island" | "localized" | "place" | "unknown" => {
  const text = [warning.headline, warning.description, warning.type, ...(warning.regions ?? [])]
    .join(" ")
    .toLowerCase();
  if (isIsland(place)) return /\bireland\b|all[- ]island|national/.test(text) ? "island" : "localized";
  return placeTerms(place).some((term) => text.includes(term)) ? "place" : "unknown";
};

const warningAppliesToPlace = (warning: WeatherWarning, place: GuidancePlace) => {
  // The island view may summarize a regional notice, but the returned scope
  // keeps it from being presented as an island-wide hazard.
  return isIsland(place) || warningScope(warning, place) === "place";
};

const activeWarnings = (snapshot: LiveSnapshot, now: number) => snapshot.contextStatus.warnings === "live"
  ? snapshot.warnings.filter((warning) => warningTiming(warning, now) === "active")
  : [];

const activeRelevantWarnings = (snapshot: LiveSnapshot, now: number, place: GuidancePlace) =>
  activeWarnings(snapshot, now)
    .filter((warning) => isActivityRelevantWeatherWarning(warning) && warningAppliesToPlace(warning, place));

const activeUnknownWarnings = (snapshot: LiveSnapshot, now: number) =>
  activeWarnings(snapshot, now).filter((warning) => !isActivityRelevantWeatherWarning(warning));

const unavailable = (
  id: ActivityId,
  title: string,
  place: string,
  reason: string,
  caveat: string
): ActivityGuidance => ({ id, title, place, reason, caveat, status: "unavailable" });

const warningStatus = (warnings: WeatherWarning[], place: GuidancePlace): ActivityStatus => {
  if (!warnings.length) return "live-observations";
  return warnings.some((warning) => warningScope(warning, place) === "island" || warningScope(warning, place) === "place")
    ? "relevant-notice"
    : "localized-notice";
};

function scoreOutdoorWalk(snapshot: LiveSnapshot, now: number, place: GuidancePlace): ActivityGuidance {
  const weatherUsable = snapshot.sourceStatus === "live" || snapshot.sourceStatus === "partial";
  const allStations = weatherUsable ? snapshot.stations.filter((station) =>
    station.fresh && recent(station.observedAt, now, 3 * 60 * 60 * 1000)
  ) : [];
  const stations = nearby(allStations, place, WEATHER_NEARBY_RADIUS_KM);
  const temperatures = stations.flatMap((station) => station.temperature === null ? [] : [station.temperature]);
  const rainfall = stations.flatMap((station) => station.rainfall === null ? [] : [station.rainfall]);
  const wind = stations.flatMap((station) => station.windSpeed === null ? [] : [station.windSpeed]);
  const location = isIsland(place) ? "across Ireland" : `near ${place.name}`;
  if (!stations.length || (!temperatures.length && !rainfall.length && !wind.length)) {
    return unavailable(
      "outdoor-walk",
      "Outdoor walk",
      place.name,
      `No recent weather observation with a usable temperature, rainfall, or wind value is available ${location}.`,
      snapshot.contextStatus.warnings !== "live"
        ? "The Met Éireann notice feed is unavailable, and local observations cannot support a fuller context."
        : "The walk card reports observations only; it cannot assess conditions without a nearby usable record."
    );
  }

  const relevantWarnings = activeRelevantWarnings(snapshot, now, place);
  const unknownWarnings = activeUnknownWarnings(snapshot, now);
  const aqiLocation = isIsland(place) ? "across Ireland" : `near ${place.name}`;
  const highestAqi = nearby(
    snapshot.airQuality.filter((reading) => reading.europeanAqi !== null && recent(reading.observedAt, now, AIR_MAX_AGE_MS)),
    place,
    WEATHER_NEARBY_RADIUS_KM
  ).sort((a, b) =>
    (b.europeanAqi ?? -Infinity) - (a.europeanAqi ?? -Infinity) ||
    `${a.name}\u0000${a.id}`.localeCompare(`${b.name}\u0000${b.id}`)
  )[0] ?? null;
  const observationParts = [
    `${stations.length} recent station${stations.length === 1 ? "" : "s"} ${location}`,
    temperatures.length ? `temperature ${rangeText(temperatures, "°C")}` : null,
    rainfall.length ? `rainfall ${rangeText(rainfall, " mm", 1)}` : null,
    wind.length ? `wind ${rangeText(wind, " km/h")}` : null,
    highestAqi?.europeanAqi === null || highestAqi?.europeanAqi === undefined
      ? null
      : `highest European AQI ${aqiLocation} was ${highestAqi.europeanAqi}`
  ].filter((part): part is string => part !== null);
  const caveats = [
    relevantWarnings.length
      ? `${relevantWarnings.length} active activity-relevant Met Éireann notice${relevantWarnings.length === 1 ? "" : "s"} ${relevantWarnings.some((warning) => warningScope(warning, place) === "localized") ? "is localized to named areas" : "applies to this selected scope"}; review the official notice above.`
      : null,
    unknownWarnings.length
      ? `${unknownWarnings.length} active official notice${unknownWarnings.length === 1 ? " is" : "s are"} displayed separately; its category does not change this observation state.`
      : null,
    snapshot.contextStatus.warnings !== "live"
      ? "The Met Éireann notice feed is unavailable, so official notices cannot be assessed here."
      : null,
    highestAqi?.source === "modelled" ? `The strongest air-quality value ${aqiLocation} is modelled rather than measured.` : null,
    temperatures.length < stations.length || rainfall.length < stations.length || wind.length < stations.length
      ? "Some station fields are missing."
      : null,
    "These are recent observations, not a forecast or a safety assessment."
  ].filter((part): part is string => part !== null);
  return {
    id: "outdoor-walk",
    title: "Outdoor walk",
    place: place.name,
    reason: `Recent observations ${location}: ${observationParts.join(", ")}.`,
    caveat: caveats.join(" "),
    status: relevantWarnings.length
      ? warningStatus(relevantWarnings, place)
      : snapshot.contextStatus.warnings !== "live" ? "limited-context" : "live-observations"
  };
}

function describeCoast(snapshot: LiveSnapshot, now: number, place: GuidancePlace): ActivityGuidance {
  const marine = snapshot.contextStatus.marine === "live"
    ? nearby(snapshot.marine.filter((reading) => recent(reading.observedAt, now, MARINE_MAX_AGE_MS)), place, COAST_NEARBY_RADIUS_KM)
      .sort((a, b) => `${a.name}\u0000${a.id}`.localeCompare(`${b.name}\u0000${b.id}`))
    : [];
  const tides = snapshot.contextStatus.tides === "live"
    ? nearby(snapshot.tides.filter((tide) => recent(tide.observedAt, now, MARINE_MAX_AGE_MS)), place, COAST_NEARBY_RADIUS_KM)
      .sort((a, b) => `${a.name}\u0000${a.id}`.localeCompare(`${b.name}\u0000${b.id}`))
    : [];
  const alerts = snapshot.contextStatus.bathing === "live" || snapshot.contextStatus.bathing === "fallback"
    ? nearby(snapshot.bathingAlerts.filter((alert) => {
      const startedAt = validDate(alert.startedAt);
      return startedAt === null || startedAt <= now;
    }), place, COAST_NEARBY_RADIUS_KM)
    : [];
  const relevantWarnings = activeRelevantWarnings(snapshot, now, place);
  if (!marine.length && !tides.length && !alerts.length && !relevantWarnings.length) {
    return unavailable(
      "coast",
      "Coast",
      place.name,
      isIsland(place)
        ? "No recent marine, tide, or bathing-alert record is available for a coastal view."
        : `No recent marine, tide, or bathing-alert record is available near ${place.name}.`,
      snapshot.contextStatus.bathing !== "live" && snapshot.contextStatus.bathing !== "fallback"
        ? "The bathing-alert feed is unavailable, so current restrictions cannot be assessed."
        : "The coast card reports measurements at named locations; it does not fill gaps by assuming the whole coast is alike."
    );
  }

  const waveHeights = marine.flatMap((reading) => reading.waveHeight === null ? [] : [reading.waveHeight]);
  const marineWind = marine.flatMap((reading) => reading.windSpeedKnots === null ? [] : [reading.windSpeedKnots]);
  const tideMeasurement = tides.find((tide) => tide.surge !== null) ?? null;
  const details = [
    marine.length ? `${marine.length} recent marine observation${marine.length === 1 ? "" : "s"}` : null,
    waveHeights.length ? `wave height ${rangeText(waveHeights, " m", 1)}` : null,
    marineWind.length ? `marine wind ${rangeText(marineWind, " knots")}` : null,
    tides.length ? `${tides.length} recent tide-gauge observation${tides.length === 1 ? "" : "s"}` : null,
    tideMeasurement ? `tide difference ${formatNumber(Math.abs(tideMeasurement.surge as number), 2)} m at ${tideMeasurement.name}` : null,
    alerts.length ? `${alerts.length} current bathing-water alert${alerts.length === 1 ? "" : "s"} at named locations` : null
  ].filter((part): part is string => part !== null);
  const caveats = [
    alerts.length
      ? `${alerts.length} bathing-water alert${alerts.length === 1 ? " is" : "s are"} represented at named location${alerts.length === 1 ? "" : "s"}; review the official area before interpreting it.`
      : null,
    tideMeasurement ? "The tide difference is a measurement, not a safety threshold or hazard classification." : null,
    relevantWarnings.length
      ? `${relevantWarnings.length} active activity-relevant weather notice${relevantWarnings.length === 1 ? "" : "s"} is represented for this scope.`
      : null,
    snapshot.contextStatus.bathing !== "live" && snapshot.contextStatus.bathing !== "fallback"
      ? "The bathing-alert feed is unavailable, so current restrictions cannot be assessed."
      : snapshot.contextStatus.bathing === "live" && !alerts.length
        ? "No current bathing-water alert is represented for the selected scope."
        : null,
    "Marine and tide records describe measured conditions at named locations; they do not establish conditions along the whole coast or a quality recommendation."
  ].filter((part): part is string => part !== null);
  return {
    id: "coast",
    title: "Coast",
    place: isIsland(place) ? "Coastal areas" : place.name,
    reason: `Current coastal signals ${isIsland(place) ? "across the represented coast" : `near ${place.name}`}: ${details.join(", ")}.`,
    caveat: caveats.join(" "),
    status: alerts.length
      ? "localized-notice"
      : relevantWarnings.length
        ? warningStatus(relevantWarnings, place)
        : snapshot.contextStatus.bathing !== "live" && snapshot.contextStatus.bathing !== "fallback"
          ? "limited-context"
          : "live-observations"
  };
}

function describeStargazing(snapshot: LiveSnapshot, now: number, place: GuidancePlace): ActivityGuidance {
  const aurora = snapshot.contextStatus.aurora === "live" || snapshot.contextStatus.aurora === "fallback"
    ? snapshot.aurora
    : null;
  const passes = (snapshot.contextStatus.iss !== "live" && snapshot.contextStatus.iss !== "fallback") || !snapshot.iss
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
      place.name,
      "No aurora signal or upcoming visible ISS pass is available in the supplied snapshot.",
      snapshot.contextStatus.iss !== "live" && snapshot.contextStatus.iss !== "fallback"
        ? "ISS data is unavailable, and no aurora signal is present. Cloud, darkness, and light-pollution context is also not supplied."
        : "Cloud, darkness, and light-pollution conditions are not supplied."
    );
  }

  const reasons = [
    aurora
      ? aurora.probability === 0
        ? "NOAA reports no aurora signal (0% probability directly over Ireland)"
        : `NOAA aurora probability is ${formatNumber(aurora.probability)}% directly over Ireland`
      : null,
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
    place: place.name,
    reason: `Current night-sky signals: ${reasons.join(" and ")}.`,
    caveat: caveats.join(" "),
    status: aurora?.probability === 0 && !passes.length ? "no-current-signal" : "live-observations"
  };
}

function describeTravel(snapshot: LiveSnapshot, now: number, place: GuidancePlace): ActivityGuidance {
  const trains = snapshot.sourceProvenance?.trains.status === "live"
    ? snapshot.trains.filter((train) => recent(train.observedAt, now, MOVEMENT_MAX_AGE_MS))
    : [];
  const transit = (snapshot.transitStatus === "live" || snapshot.transitStatus === "partial")
    ? snapshot.transit.filter((vehicle) => recent(vehicle.observedAt, now, MOVEMENT_MAX_AGE_MS))
    : [];
  if (!trains.length && !transit.length) {
    return unavailable(
      "travel",
      "Travel",
      place.name,
      "No recent train or public-transport position is available in the supplied snapshot.",
      snapshot.transitStatus === "credential-required"
        ? "Public-transport positions require credentials, and no recent train position is available."
        : "Live transport coverage is unavailable or too old to use."
    );
  }

  const relevantWarnings = activeRelevantWarnings(snapshot, now, place);
  const caveats = [
    snapshot.transitStatus === "partial" ? "TFI vehicle positions are only partially available in this snapshot."
      : snapshot.transitStatus !== "live" ? "TFI vehicle positions are not live in this snapshot." : null,
    snapshot.sourceProvenance?.trains.status !== "live" ? "Irish Rail position coverage is not live in this snapshot." : null,
    relevantWarnings.length
      ? `${relevantWarnings.length} active activity-relevant weather notice${relevantWarnings.length === 1 ? " is" : "s are"} represented for this scope; review the official notice above.`
      : null,
    "Positions show observed vehicles and coverage, not schedules, fares, delays, seat availability, or journey suitability."
  ].filter((part): part is string => part !== null);
  return {
    id: "travel",
    title: "Travel",
    place: place.name,
    reason: `Live coverage includes ${trains.length} train${trains.length === 1 ? "" : "s"} and ${transit.length} public-transport vehicle${transit.length === 1 ? "" : "s"}.`,
    caveat: caveats.join(" "),
    status: relevantWarnings.length ? warningStatus(relevantWarnings, place) : "live-coverage"
  };
}

export function getActivityGuidance(
  snapshot: LiveSnapshot,
  now: Date,
  selectedPlace: GuidancePlace = { id: "island", name: "Ireland", latitude: 53.45, longitude: -8.05 }
): ActivityGuidance[] {
  const nowMs = now.getTime();
  if (!Number.isFinite(nowMs)) throw new RangeError("now must be a valid Date");
  const guidance: Record<ActivityId, ActivityGuidance> = {
    "outdoor-walk": scoreOutdoorWalk(snapshot, nowMs, selectedPlace),
    coast: describeCoast(snapshot, nowMs, selectedPlace),
    stargazing: describeStargazing(snapshot, nowMs, selectedPlace),
    travel: describeTravel(snapshot, nowMs, selectedPlace)
  };
  return ACTIVITY_ORDER.map((id) => guidance[id]);
}
