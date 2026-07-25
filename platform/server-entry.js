const json = (body, status = 200, cacheSeconds = 60) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": `public, max-age=${cacheSeconds}, s-maxage=${cacheSeconds}, stale-while-revalidate=${cacheSeconds * 2}`,
      "access-control-allow-origin": "*"
    }
  });

const value = (xml, name) =>
  (new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(xml)?.[1] ?? "")
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", "\"")
    .replaceAll("&#39;", "'")
    .trim();

const fetchTrains = async () => {
  const response = await fetch(
    "https://api.irishrail.ie/realtime/realtime.asmx/getCurrentTrainsXML",
    { cf: { cacheEverything: true, cacheTtl: 60 } }
  );
  if (!response.ok) throw new Error(`Irish Rail returned ${response.status}`);
  const xml = await response.text();
  const observedAt = new Date().toISOString();
  return [...xml.matchAll(/<objTrainPositions>([\s\S]*?)<\/objTrainPositions>/g)]
    .map((match) => {
      const latitude = Number.parseFloat(value(match[1], "TrainLatitude"));
      const longitude = Number.parseFloat(value(match[1], "TrainLongitude"));
      if (
        !Number.isFinite(latitude) ||
        !Number.isFinite(longitude) ||
        latitude < 51.2 ||
        latitude > 55.6 ||
        longitude < -10.8 ||
        longitude > -5.2
      ) return null;
      return {
        id: value(match[1], "TrainCode"),
        latitude,
        longitude,
        status: value(match[1], "TrainStatus") === "R" ? "running" : "not-started",
        direction: value(match[1], "Direction"),
        message: value(match[1], "PublicMessage").replaceAll("\\n", " · "),
        observedAt
      };
    })
    .filter(Boolean);
};

const fetchRivers = async () => {
  const response = await fetch("https://waterlevel.ie/geojson/latest/", {
    headers: {
      "accept": "application/json",
      "referer": "https://waterlevel.ie/",
      "user-agent": "A-Day-in-Ireland/2.0 (+https://a-day-in-ireland.koya-illek.chatgpt.site)"
    }
  });
  if (!response.ok) throw new Error(`OPW returned ${response.status}`);
  const body = await response.json();
  const cells = new Map();
  for (const item of body.features ?? []) {
    if (item.properties?.sensor_ref !== "0001") continue;
    const [longitude, latitude] = item.geometry?.coordinates ?? [];
    const level = Number.parseFloat(item.properties?.value);
    const observedAt = String(item.properties?.datetime ?? "");
    const stationNumber = Number.parseInt(String(item.properties?.station_ref ?? ""), 10);
    const fresh = Date.now() - new Date(observedAt).getTime() < 3 * 60 * 60 * 1000;
    if (
      !Number.isFinite(latitude) ||
      !Number.isFinite(longitude) ||
      !Number.isFinite(level) ||
      !observedAt ||
      stationNumber > 41000 ||
      !fresh
    ) continue;
    const reading = {
      id: String(item.properties?.station_ref ?? ""),
      name: String(item.properties?.station_name ?? "River gauge"),
      latitude,
      longitude,
      level,
      observedAt,
      fresh
    };
    const key = `${Math.round(longitude * 4)}:${Math.round(latitude * 5)}`;
    const current = cells.get(key);
    if (!current || new Date(reading.observedAt) > new Date(current.observedAt)) {
      cells.set(key, reading);
    }
  }
  return [...cells.values()].slice(0, 90);
};

const numeric = (value) => {
  const parsed = Number.parseFloat(String(value ?? ""));
  return Number.isFinite(parsed) ? parsed : null;
};

const freshEnough = (value, hours = 6) =>
  Date.now() - new Date(value).getTime() < hours * 60 * 60 * 1000;

const fetchWeatherBuoys = async () => {
  const since = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const query = `station_id,longitude,latitude,time,WindSpeed,WaveHeight,WavePeriod,SeaTemperature&time>=${since}T00:00:00Z&orderByMax("station_id,time")`;
  const response = await fetch(
    `https://erddap.marine.ie/erddap/tabledap/IWBNetwork.json?${encodeURI(query)}`,
    { cf: { cacheEverything: true, cacheTtl: 900 } }
  );
  if (!response.ok) throw new Error(`Marine weather buoys returned ${response.status}`);
  const body = await response.json();
  return (body.table?.rows ?? []).map((row) => ({
    id: String(row[0]),
    name: `Offshore buoy ${String(row[0])}`,
    kind: "weather-buoy",
    longitude: Number(row[1]),
    latitude: Number(row[2]),
    observedAt: String(row[3]),
    windSpeedKnots: numeric(row[4]),
    waveHeight: numeric(row[5]),
    wavePeriod: numeric(row[6]),
    seaTemperature: numeric(row[7])
  })).filter((reading) => freshEnough(reading.observedAt));
};

const coastalSources = [
  {
    dataset: "smartbay_metbuoy",
    name: "SmartBay Met Buoy",
    variables: ["time", "latitude", "longitude", "wind_speed"],
    map: (row) => ({
      observedAt: String(row[0]), latitude: Number(row[1]), longitude: Number(row[2]),
      windSpeedKnots: numeric(row[3]) === null ? null : numeric(row[3]) * 1.94384,
      waveHeight: null, wavePeriod: null, seaTemperature: null
    })
  },
  {
    dataset: "sentinel_lehanagh",
    name: "Lehanagh Pool Observatory",
    variables: ["time", "latitude", "longitude", "Wind_Speed", "SBE_Temp_Avg"],
    map: (row) => ({
      observedAt: String(row[0]), latitude: Number(row[1]), longitude: Number(row[2]),
      windSpeedKnots: numeric(row[3]) === null ? null : numeric(row[3]) * 1.94384,
      waveHeight: null, wavePeriod: null, seaTemperature: numeric(row[4])
    })
  },
  {
    dataset: "compass_mace_head",
    name: "Mace Head Observatory",
    variables: ["time", "latitude", "longitude", "wind_speed", "sbe_temp_avg", "SignificantWaveHeight", "MeanWavePeriod_Tm02"],
    map: (row) => ({
      observedAt: String(row[0]), latitude: Number(row[1]), longitude: Number(row[2]),
      windSpeedKnots: numeric(row[3]) === null ? null : numeric(row[3]) * 1.94384,
      waveHeight: numeric(row[5]), wavePeriod: numeric(row[6]), seaTemperature: numeric(row[4])
    })
  }
];

const fetchCoastalBuoy = async (source) => {
  const query = `${source.variables.join(",")}&orderByMax("time")`;
  const response = await fetch(
    `https://erddap.marine.ie/erddap/tabledap/${source.dataset}.json?${encodeURI(query)}`,
    { cf: { cacheEverything: true, cacheTtl: 900 } }
  );
  if (!response.ok) throw new Error(`${source.name} returned ${response.status}`);
  const body = await response.json();
  const row = body.table?.rows?.[0];
  if (!row) return null;
  const reading = source.map(row);
  if (!freshEnough(reading.observedAt)) return null;
  return { id: source.dataset, name: source.name, kind: "coastal-observatory", ...reading };
};

const fetchMarine = async () => {
  const results = await Promise.allSettled([
    fetchWeatherBuoys(),
    ...coastalSources.map(fetchCoastalBuoy)
  ]);
  const weather = results[0].status === "fulfilled" ? results[0].value : [];
  const coastal = results.slice(1).flatMap((result) =>
    result.status === "fulfilled" && result.value ? [result.value] : []
  );
  return [...weather, ...coastal];
};

const parseRadarTime = (id) => {
  const match = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})$/.exec(id);
  return match
    ? `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:00Z`
    : new Date().toISOString();
};

const fetchRadar = async () => {
  const response = await fetch("https://gdal.met.ie/api/maps/radar", {
    cf: { cacheEverything: true, cacheTtl: 300 }
  });
  if (!response.ok) throw new Error(`Met Éireann radar returned ${response.status}`);
  const rows = await response.json();
  return rows.slice(-7).flatMap((row) => {
    const id = String(row.src ?? "");
    const modifiedTime = Number(row.modifiedTime);
    if (!/^\d{12}$/.test(id) || !Number.isFinite(modifiedTime)) return [];
    const server = String(row.server ?? "https://gdal.met.ie").replace(/\/$/, "");
    return [{
      id,
      observedAt: parseRadarTime(id),
      modifiedTime,
      tileTemplate: `${server}/api/maps/radar/${id}/{x}/{y}/{z}/${modifiedTime}`
    }];
  });
};

const eirMonths = {
  Jan: "01", Feb: "02", Mar: "03", Apr: "04", May: "05", Jun: "06",
  Jul: "07", Aug: "08", Sep: "09", Oct: "10", Nov: "11", Dec: "12"
};

const eirTimestamp = (value) => {
  const match = /^(\d{2})-([A-Za-z]{3})-(\d{4}) (\d{2}:\d{2}:\d{2})$/.exec(value);
  return match && eirMonths[match[2]]
    ? `${match[3]}-${eirMonths[match[2]]}-${match[1]}T${match[4]}Z`
    : null;
};

const fetchGridRows = async (chartType, areas) => {
  const day = new Date().toISOString().slice(0, 10);
  const url = new URL("https://www.smartgriddashboard.com/api/chart/");
  url.search = new URLSearchParams({
    region: "ALL", chartType, dateRange: chartType === "frequency" ? "hour" : "day", dateFrom: day, dateTo: day, areas
  }).toString();
  const response = await fetch(url, {
    cf: { cacheEverything: true, cacheTtl: chartType === "frequency" ? 60 : 300 }
  });
  if (!response.ok) throw new Error(`EirGrid ${chartType} returned ${response.status}`);
  return (await response.json()).Rows ?? [];
};

const latestGridValue = (rows, field) => {
  const row = [...rows].reverse().find(
    (item) =>
      String(item.FieldName) === field &&
      item.Value !== null &&
      item.Value !== undefined &&
      item.Value !== "" &&
      Number.isFinite(Number(item.Value))
  );
  return row ? { value: Number(row.Value), observedAt: eirTimestamp(String(row.EffectiveTime)) } : null;
};

const fetchGrid = async () => {
  const [demandRows, generationRows, windRows, carbonRows, frequencyRows, interconnectionRows] =
    await Promise.all([
      fetchGridRows("demand", "demandactual"),
      fetchGridRows("generation", "generationactual"),
      fetchGridRows("wind", "windactual"),
      fetchGridRows("co2", "co2intensity,co2emission"),
      fetchGridRows("frequency", "frequency"),
      fetchGridRows("interconnection", "interconnection")
    ]);
  const demand = latestGridValue(demandRows, "SYSTEM_DEMAND");
  const generation = latestGridValue(generationRows, "GEN_EXP");
  const wind = latestGridValue(windRows, "WIND_ACTUAL");
  const intensity = latestGridValue(carbonRows, "CO2_INTENSITY");
  const emissions = latestGridValue(carbonRows, "CO2_EMISSIONS");
  const frequency = latestGridValue(frequencyRows, "SYS_FREQUENCY");
  const interconnector = latestGridValue(interconnectionRows, "INTER_NET");
  const timestamps = [demand, generation, wind, intensity, emissions, frequency, interconnector]
    .map((item) => item?.observedAt).filter(Boolean).sort();
  if (!timestamps.length) return null;
  return {
    observedAt: timestamps[0] ?? null,
    demandMW: demand?.value ?? null,
    generationMW: generation?.value ?? null,
    windMW: wind?.value ?? null,
    windSharePercent: wind && demand && demand.value > 0 ? wind.value / demand.value * 100 : null,
    carbonIntensity: intensity?.value ?? null,
    carbonEmissions: emissions?.value ?? null,
    frequencyHz: frequency?.value ?? null,
    interconnectorMW: interconnector?.value ?? null
  };
};

const airLocations = [
  ["dublin-air", "Dublin", 53.35, -6.26],
  ["belfast-air", "Belfast", 54.60, -5.93],
  ["cork-air", "Cork", 51.90, -8.48],
  ["galway-air", "Galway", 53.27, -9.06],
  ["limerick-air", "Limerick", 52.66, -8.63],
  ["waterford-air", "Waterford", 52.26, -7.11],
  ["derry-air", "Derry", 55.00, -7.31]
];

const fetchAirQuality = async () => {
  const url = new URL("https://air-quality-api.open-meteo.com/v1/air-quality");
  url.search = new URLSearchParams({
    latitude: airLocations.map((item) => item[2]).join(","),
    longitude: airLocations.map((item) => item[3]).join(","),
    current: "european_aqi,pm2_5,pm10,nitrogen_dioxide,ozone,uv_index,grass_pollen",
    timezone: "GMT"
  }).toString();
  const response = await fetch(url, { cf: { cacheEverything: true, cacheTtl: 1800 } });
  if (!response.ok) throw new Error(`Open-Meteo air quality returned ${response.status}`);
  const bodies = await response.json();
  return airLocations.flatMap(([id, name, latitude, longitude], index) => {
    const current = bodies[index]?.current;
    if (!current?.time) return [];
    return [{
      id, name, latitude, longitude, observedAt: `${current.time}:00Z`,
      europeanAqi: numeric(current.european_aqi), pm25: numeric(current.pm2_5),
      pm10: numeric(current.pm10), nitrogenDioxide: numeric(current.nitrogen_dioxide),
      ozone: numeric(current.ozone), uvIndex: numeric(current.uv_index),
      grassPollen: numeric(current.grass_pollen)
    }];
  });
};

const fetchAurora = async () => {
  const [auroraResponse, kpResponse] = await Promise.all([
    fetch("https://services.swpc.noaa.gov/json/ovation_aurora_latest.json", {
      cf: { cacheEverything: true, cacheTtl: 900 }
    }),
    fetch("https://services.swpc.noaa.gov/json/planetary_k_index_1m.json", {
      cf: { cacheEverything: true, cacheTtl: 300 }
    })
  ]);
  if (!auroraResponse.ok) throw new Error(`NOAA aurora returned ${auroraResponse.status}`);
  const body = await auroraResponse.json();
  const probabilities = (body.coordinates ?? [])
    .filter((point) => point[0] >= 349 && point[0] <= 355 && point[1] >= 51 && point[1] <= 56)
    .map((point) => Number(point[2])).filter(Number.isFinite);
  if (!probabilities.length) return null;
  let kpIndex = null;
  if (kpResponse.ok) {
    const rows = await kpResponse.json();
    kpIndex = numeric(rows.at(-1)?.estimated_kp);
  }
  return {
    observedAt: String(body["Observation Time"] ?? ""),
    forecastAt: String(body["Forecast Time"] ?? ""),
    probability: Math.max(...probabilities),
    kpIndex
  };
};

const livingLayers = async () => {
  const [trains, rivers] = await Promise.allSettled([
    fetchTrains(),
    fetchRivers()
  ]);
  if (trains.status === "rejected") console.error("Irish Rail refresh failed", trains.reason);
  if (rivers.status === "rejected") console.error("OPW river refresh failed", rivers.reason);
  return json({
    generatedAt: new Date().toISOString(),
    trains: trains.status === "fulfilled" ? trains.value : [],
    rivers: rivers.status === "fulfilled" ? rivers.value : [],
    sourceStatus: {
      trains: trains.status === "fulfilled" ? "live" : "unavailable",
      rivers: rivers.status === "fulfilled" ? "live" : "unavailable"
    }
  });
};

const currentContexts = async () => {
  const [marine, radar, grid, airQuality, aurora] = await Promise.allSettled([
    fetchMarine(),
    fetchRadar(),
    fetchGrid(),
    fetchAirQuality(),
    fetchAurora()
  ]);
  for (const [name, result] of Object.entries({ marine, radar, grid, airQuality, aurora })) {
    if (result.status === "rejected") console.error(`${name} context refresh failed`, result.reason);
  }
  return json({
    generatedAt: new Date().toISOString(),
    marine: marine.status === "fulfilled" ? marine.value : [],
    radar: radar.status === "fulfilled" ? radar.value : [],
    grid: grid.status === "fulfilled" ? grid.value : null,
    airQuality: airQuality.status === "fulfilled" ? airQuality.value : [],
    aurora: aurora.status === "fulfilled" ? aurora.value : null
  }, 200, 300);
};

const worker = {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/api/living") {
      try {
        return await livingLayers();
      } catch (error) {
        console.error("Living layers failed", error);
        return json({ error: "Live layers are temporarily unavailable." }, 503);
      }
    }
    if (url.pathname === "/api/contexts") {
      try {
        return await currentContexts();
      } catch (error) {
        console.error("Current contexts failed", error);
        return json({ error: "Current island contexts are temporarily unavailable." }, 503);
      }
    }

    const response = await env.ASSETS.fetch(request);
    if (response.status !== 404) return response;
    if (url.pathname.includes(".")) return response;
    url.pathname = "/index.html";
    return env.ASSETS.fetch(new Request(url, request));
  }
};

export default worker;
