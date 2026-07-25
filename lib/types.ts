export type StationReading = {
  id: string;
  name: string;
  latitude: number;
  longitude: number;
  temperature: number | null;
  rainfall: number | null;
  windSpeed: number | null;
  windDirection: string;
  description: string;
  observedAt: string | null;
  fresh: boolean;
};

export type WeatherWarning = {
  level: string;
  headline: string;
  description: string;
  onset: string;
  expiry: string;
};

export type TrainPosition = {
  id: string;
  latitude: number;
  longitude: number;
  status: "running" | "not-started";
  direction: string;
  message: string;
  observedAt: string;
};

export type RiverReading = {
  id: string;
  name: string;
  latitude: number;
  longitude: number;
  level: number;
  observedAt: string;
  fresh: boolean;
};

export type MarineReading = {
  id: string;
  name: string;
  kind: "weather-buoy" | "coastal-observatory";
  latitude: number;
  longitude: number;
  observedAt: string;
  windSpeedKnots: number | null;
  waveHeight: number | null;
  wavePeriod: number | null;
  seaTemperature: number | null;
};

export type RadarFrame = {
  id: string;
  observedAt: string;
  modifiedTime: number;
  tileTemplate: string;
};

export type GridReading = {
  observedAt: string | null;
  demandMW: number | null;
  generationMW: number | null;
  windMW: number | null;
  windSharePercent: number | null;
  carbonIntensity: number | null;
  carbonEmissions: number | null;
  frequencyHz: number | null;
  interconnectorMW: number | null;
};

export type AirQualityReading = {
  id: string;
  name: string;
  latitude: number;
  longitude: number;
  observedAt: string;
  europeanAqi: number | null;
  pm25: number | null;
  pm10: number | null;
  nitrogenDioxide: number | null;
  ozone: number | null;
  uvIndex: number | null;
  grassPollen: number | null;
  source: "measured" | "modelled";
  stationClassification: string | null;
};

export type AuroraReading = {
  observedAt: string;
  forecastAt: string;
  probability: number;
  kpIndex: number | null;
};

export type TideReading = {
  id: string;
  name: string;
  latitude: number;
  longitude: number;
  observedAt: string;
  waterLevel: number | null;
  predictedLevel: number | null;
  surge: number | null;
  trend: "rising" | "falling" | "steady" | "unknown";
  nextHighAt: string | null;
  nextHighLevel: number | null;
  nextLowAt: string | null;
  nextLowLevel: number | null;
};

export type BathingAlert = {
  id: string;
  name: string;
  county: string;
  latitude: number;
  longitude: number;
  restriction: string;
  description: string;
  startedAt: string;
  updatedAt: string;
  noticeUrl: string | null;
};

export type IssPass = {
  startsAt: string;
  peaksAt: string;
  endsAt: string;
  maxElevation: number;
  visible: boolean;
  direction: string;
};

export type IssReading = {
  observedAt: string;
  latitude: number;
  longitude: number;
  altitudeKm: number;
  passes: IssPass[];
};

export type SatelliteFrame = {
  observedAt: string;
  label: string;
  tileTemplate: string;
};

export type EarthquakeReading = {
  id: string;
  latitude: number;
  longitude: number;
  magnitude: number;
  depthKm: number;
  place: string;
  observedAt: string;
  detailUrl: string;
};

export type TransitVehicle = {
  id: string;
  latitude: number;
  longitude: number;
  route: string;
  label: string;
  bearing: number | null;
  speedKmh: number | null;
  observedAt: string;
};

export type LiveSnapshot = {
  generatedAt: string;
  sourceStatus: "live" | "partial" | "fallback";
  stations: StationReading[];
  warnings: WeatherWarning[];
  marine: MarineReading[];
  trains: TrainPosition[];
  rivers: RiverReading[];
  radar: RadarFrame[];
  grid: GridReading | null;
  airQuality: AirQualityReading[];
  aurora: AuroraReading | null;
  tides: TideReading[];
  bathingAlerts: BathingAlert[];
  iss: IssReading | null;
  issTle: { line1: string; line2: string; observedAt: string } | null;
  satellite: SatelliteFrame | null;
  earthquakes: EarthquakeReading[];
  transit: TransitVehicle[];
  transitStatus: "live" | "credential-required" | "unavailable";
  contextStatus: {
    measuredAir: "live" | "unavailable";
    tides: "live" | "unavailable";
    bathing: "live" | "unavailable";
    satellite: "live" | "unavailable";
    earthquakes: "live" | "unavailable";
    iss: "live" | "unavailable";
  };
  summary: {
    warmest: StationReading | null;
    wettest: StationReading | null;
    windiest: StationReading | null;
    reporting: number;
    runningTrains: number;
    riverStations: number;
  };
  timeline: Array<{
    time: string;
    temperature: number | null;
    rainfall: number;
    windSpeed: number | null;
  }>;
};
