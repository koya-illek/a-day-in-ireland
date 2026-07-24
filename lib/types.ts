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

export type LiveSnapshot = {
  generatedAt: string;
  sourceStatus: "live" | "partial" | "fallback";
  stations: StationReading[];
  warnings: WeatherWarning[];
  marine: Array<{
    id: string;
    latitude: number;
    longitude: number;
    observedAt: string;
    windSpeedKnots: number | null;
    waveHeight: number | null;
    seaTemperature: number | null;
  }>;
  summary: {
    warmest: StationReading | null;
    wettest: StationReading | null;
    windiest: StationReading | null;
    reporting: number;
  };
  timeline: Array<{
    time: string;
    temperature: number | null;
    rainfall: number;
    windSpeed: number | null;
  }>;
};
