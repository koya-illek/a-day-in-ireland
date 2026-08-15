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
  id: string;
  capId: string;
  type: string;
  severity: string;
  certainty: string;
  regions: string[];
  status: string;
  issued: string;
  updated: string;
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
  /** Last successful retrieval time. Irish Rail XML has no per-train observation clock. */
  observedAt: string;
  speedKmh: number | null;
  speedSource: "calculated" | null;
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
  provider?: string;
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
  endsAt?: string | null;
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
  tripId?: string;
  destination?: string;
  route: string;
  label: string;
  bearing: number | null;
  speedKmh: number | null;
  speedSource: "reported" | "calculated" | null;
  observedAt: string;
};

export type SolarReading = {
  date: string;
  tzid: string;
  sunrise: string | null;
  sunset: string | null;
  dawn: string | null;
  dusk: string | null;
  firstLight: string | null;
  lastLight: string | null;
  goldenHourMorning: string | null;
  goldenHourEvening: string | null;
  blueHourMorning: string | null;
  blueHourEvening: string | null;
  solarPosition: { azimuth: number; elevation: number } | null;
  moonrise: string | null;
  moonset: string | null;
  moonPhase: number | null;
  moonPhaseName: string | null;
  moonIllumination: number | null;
  source: "Sunrise-Sunset.org";
  attributionUrl: "https://sunrise-sunset.org/";
};

export type OfficialForecast = {
  region: string;
  issued: string;
  today: string;
  tonight: string;
  tomorrow: string;
  outlook: string;
  source: "Met Éireann";
  sourceUrl: "https://www.met.ie/Open_Data/json/National.json";
  datasetUrl: "https://data.gov.ie/dataset/met-eireann-live-text-forecast-data";
};

export type ProviderProvenance = {
  provider: string;
  endpoint: string;
  status: "live" | "partial" | "stale" | "fallback" | "unavailable";
  fetchedAt: string;
  latestObservedAt: string | null;
  fallback: string | null;
};

export type ObservationSourceStatus = "live" | "partial" | "stale" | "fallback" | "unavailable";
export type ContextSourceStatus = "live" | "partial" | "fallback" | "stale" | "credential-required" | "unavailable";
export type ContextSourceProvenance = {
  status: ContextSourceStatus;
  fetchedAt: string | null;
  lastSuccessAt: string | null;
  ageSeconds: number | null;
  staleSince: string | null;
  errorCode: string | null;
};
export type ContextSourceName =
  | "marine" | "radar" | "grid" | "measuredAir" | "modelledAir" | "aurora"
  | "tides" | "bathing" | "satellite" | "earthquakes" | "iss" | "warnings"
  | "solar" | "forecast";

export type LiveSnapshot = {
  generatedAt: string;
  lastSuccessAt: string | null;
  sourceStatus: ObservationSourceStatus;
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
  transitStatus: "live" | "partial" | "stale" | "credential-required" | "unavailable";
  solar: SolarReading | null;
  forecast: OfficialForecast | null;
  sourceProvenance?: {
    trains: ProviderProvenance;
    rivers: ProviderProvenance;
  };
  contextStatus: {
    marine: ContextSourceStatus;
    radar: ContextSourceStatus;
    grid: ContextSourceStatus;
    measuredAir: ContextSourceStatus;
    modelledAir: ContextSourceStatus;
    aurora: ContextSourceStatus;
    tides: ContextSourceStatus;
    bathing: ContextSourceStatus;
    satellite: ContextSourceStatus;
    earthquakes: ContextSourceStatus;
    iss: ContextSourceStatus;
    warnings: ContextSourceStatus;
    solar: ContextSourceStatus;
    forecast: ContextSourceStatus;
  };
  contextProvenance?: Partial<Record<ContextSourceName, ContextSourceProvenance>>;
  summary: {
    warmest: StationReading | null;
    wettest: StationReading | null;
    windiest: StationReading | null;
    reporting: number | null;
    runningTrains: number | null;
    riverStations: number | null;
  };
  timeline: Array<{
    time: string;
    temperature: number | null;
    rainfall: number | null;
    windSpeed: number | null;
  }>;
};
