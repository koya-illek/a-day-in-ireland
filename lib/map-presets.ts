import type { Preset, Layer, LayerGroup } from "../components/experience-model";

export const PRESET_LAYERS: Record<Exclude<Preset, "custom">, Layer[]> = {
  weather: ["weather", "rain", "wind", "warnings", "places"],
  movement: ["trains", "transit", "places"],
  water: ["rain", "rivers", "sea", "tides", "bathing", "warnings", "places"],
  all: [
    "weather", "rain", "wind", "warnings", "places", "sea", "trains", "rivers",
    "radar", "grid", "air", "aurora", "tides", "bathing", "iss", "satellite",
    "earthquakes", "transit"
  ]
};

export const LAYER_GROUPS: LayerGroup[] = [
  {
    id: "weather",
    label: "Weather & official notices",
    detail: "Conditions, rain and Met Éireann notices",
    layers: [
      ["weather", "Weather stations", "Temperature and current conditions"],
      ["rain", "Observed rain", "Measured recent rainfall around stations"],
      ["wind", "Observed wind", "Met Éireann direction and speed in km/h"],
      ["warnings", "Met Éireann notices", "Current official Met Éireann warnings and advisories"],
      ["radar", "Rainfall radar", "Met Éireann precipitation tiles, checked when the layer is displayed"]
    ]
  },
  {
    id: "movement",
    label: "Movement",
    detail: "Rail and public transport positions",
    layers: [
      ["trains", "Moving trains", "Current Iarnród Éireann train positions"],
      ["transit", "Public transport", "TFI live bus, Luas and other vehicle positions when API access is configured"]
    ]
  },
  {
    id: "water",
    label: "Water & coast",
    detail: "Gauges, sea conditions and bathing alerts",
    layers: [
      ["rivers", "River levels", "Latest fresh OPW readings; stale gauges expire automatically"],
      ["sea", "Sea conditions", "Near-real-time Marine Institute buoys and coastal observatories"],
      ["tides", "Tides & surge", "Fresh gauges, predicted high and low water, and surge anomaly"],
      ["bathing", "Bathing alerts", "Current EPA restrictions and pollution advisories only"]
    ]
  },
  {
    id: "air-sky-earth",
    label: "Air, sky & earth",
    detail: "Exposure, space imagery and detected events",
    layers: [
      ["air", "Air & exposure", "EEA monitoring stations plus regional CAMS model estimates"],
      ["aurora", "Aurora probability", "NOAA OVATION overhead probability guidance"],
      ["iss", "ISS passes", "Current orbit and locally calculated passes over Ireland"],
      ["satellite", "Satellite image", "NASA VIIRS previous-day archive frame; not a live camera"],
      ["earthquakes", "Earthquakes", "USGS detections around Ireland during the past seven days"]
    ]
  },
  {
    id: "across-ireland",
    label: "Across Ireland",
    detail: "Whole-island operational context",
    layers: [
      ["grid", "Electricity grid", "Current all-island EirGrid demand, wind, carbon and frequency"]
    ]
  },
  {
    id: "places",
    label: "Places",
    detail: "Major towns and cities for map orientation",
    layers: [
      ["places", "Places", "Major towns and cities"]
    ]
  }
];


