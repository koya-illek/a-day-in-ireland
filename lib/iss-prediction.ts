import type { LiveSnapshot } from "./types";
import {
  degreesLat,
  degreesLong,
  ecfToLookAngles,
  eciToEcf,
  eciToGeodetic,
  gstime,
  propagate,
  twoline2satrec
} from "satellite.js";
const compassDirection = (azimuth: number) => {
  const points = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
  return points[Math.round((azimuth * 180 / Math.PI) / 45) % 8];
};

type IssPassList = NonNullable<LiveSnapshot["iss"]>["passes"];

const issDublinHourFormatter = new Intl.DateTimeFormat("en-IE", {
  hour: "2-digit", hour12: false, timeZone: "Europe/Dublin"
});

let issPassScan: { key: string; scannedAtMs: number; passes: IssPassList } | null = null;

const scanIssPasses = (
  satrec: ReturnType<typeof twoline2satrec>,
  observer: { longitude: number; latitude: number; height: number },
  from: Date
): IssPassList => {
  const passes: IssPassList = [];
  let active: { startsAt: Date; peaksAt: Date; maxElevation: number; azimuth: number } | null = null;
  for (let offset = 0; offset <= 48 * 60 * 60 * 1000; offset += 30_000) {
    const time = new Date(from.getTime() + offset);
    const position = propagate(satrec, time)?.position;
    if (!position || typeof position === "boolean") continue;
    const look = ecfToLookAngles(observer, eciToEcf(position, gstime(time)));
    const elevation = look.elevation * 180 / Math.PI;
    if (elevation >= 10) {
      if (!active) active = { startsAt: time, peaksAt: time, maxElevation: elevation, azimuth: look.azimuth };
      if (elevation > active.maxElevation) {
        active.maxElevation = elevation;
        active.peaksAt = time;
      }
    } else if (active) {
      const localHour = Number(issDublinHourFormatter.format(active.peaksAt)) % 24;
      passes.push({
        startsAt: active.startsAt.toISOString(),
        peaksAt: active.peaksAt.toISOString(),
        endsAt: time.toISOString(),
        maxElevation: active.maxElevation,
        visible: localHour >= 21 || localHour < 6,
        direction: compassDirection(active.azimuth)
      });
      active = null;
      if (passes.length >= 5) break;
    }
  }
  return passes;
};

export function predictIss(line1: string, line2: string): LiveSnapshot["iss"] {
  try {
    const satrec = twoline2satrec(line1, line2);
    const observer = {
      longitude: -8 * Math.PI / 180,
      latitude: 53.4 * Math.PI / 180,
      height: .05
    };
    const now = new Date();
    const currentPosition = propagate(satrec, now)?.position;
    if (!currentPosition || typeof currentPosition === "boolean") return null;
    const currentGeo = eciToGeodetic(currentPosition, gstime(now));
    // A malformed element set can parse into NaN geometry instead of throwing;
    // a non-finite position is not a usable observation.
    if (![currentGeo.latitude, currentGeo.longitude, currentGeo.height].every(Number.isFinite)) return null;
    // Pass windows depend only on the element set, so run the 48-hour scan once
    // per TLE and keep serving it until every listed pass has ended.
    const key = `${line1}\n${line2}`;
    const scanUsable = issPassScan &&
      issPassScan.key === key &&
      now.getTime() - issPassScan.scannedAtMs < 24 * 60 * 60_000 &&
      issPassScan.passes.some((pass) => Date.parse(pass.endsAt) > now.getTime());
    if (!scanUsable) {
      issPassScan = { key, scannedAtMs: now.getTime(), passes: scanIssPasses(satrec, observer, now) };
    }
    return {
      observedAt: now.toISOString(),
      latitude: degreesLat(currentGeo.latitude),
      longitude: degreesLong(currentGeo.longitude),
      altitudeKm: currentGeo.height,
      passes: issPassScan!.passes.filter((pass) => Date.parse(pass.endsAt) > now.getTime())
    };
  } catch {
    return null;
  }
}
