const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "public, max-age=60, s-maxage=60, stale-while-revalidate=300",
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

const fetchTraffic = async () => {
  const headers = {
    "content-type": "application/x-www-form-urlencoded",
    "x-requested-with": "XMLHttpRequest",
    "origin": "https://trafficdata.tii.ie",
    "referer": "https://trafficdata.tii.ie/publicmultinodemap.asp"
  };
  const sitesBody = new URLSearchParams();
  sitesBody.set("array", "0");
  sitesBody.set("hasLocation", "1");
  sitesBody.set("isPed", "0");
  ["id", "location", "name", "description", "parameters"].forEach((field) =>
    sitesBody.append("fields[]", field)
  );
  const [sitesResponse, aadtResponse] = await Promise.all([
    fetch("https://trafficdata.tii.ie/dataserver/public/sites", {
      method: "POST",
      headers,
      body: sitesBody,
      cf: { cacheEverything: true, cacheTtl: 21_600 }
    }),
    fetch("https://trafficdata.tii.ie/dataserver/public/aadt", {
      method: "POST",
      headers,
      body: new URLSearchParams({
        isSignedOff: "1",
        latestYear: "1",
        "siteCriteria[group]": "NRA"
      }),
      cf: { cacheEverything: true, cacheTtl: 21_600 }
    })
  ]);
  if (!sitesResponse.ok || !aadtResponse.ok) throw new Error("TII traffic request failed");
  const sites = await sitesResponse.json();
  const aadts = await aadtResponse.json();
  const cells = new Map();
  for (const site of Object.values(sites.data ?? {})) {
    const averageDailyTraffic = aadts.data?.[String(site.id)];
    if (
      !site.location ||
      !Number.isFinite(site.location.lat) ||
      !Number.isFinite(site.location.lng) ||
      !Number.isFinite(averageDailyTraffic) ||
      site.parameters?.state === "4"
    ) continue;
    const counter = {
      id: String(site.id),
      name: String(site.name ?? "Traffic counter"),
      description: String(site.description ?? ""),
      latitude: site.location.lat,
      longitude: site.location.lng,
      averageDailyTraffic,
      category: String(site.parameters?.category ?? "National road")
    };
    const key = `${Math.round(counter.longitude * 5)}:${Math.round(counter.latitude * 6)}`;
    const current = cells.get(key);
    if (!current || counter.averageDailyTraffic > current.averageDailyTraffic) {
      cells.set(key, counter);
    }
  }
  return [...cells.values()]
    .sort((a, b) => b.averageDailyTraffic - a.averageDailyTraffic)
    .slice(0, 90);
};

const livingLayers = async (request) => {
  const [trains, rivers, traffic] = await Promise.allSettled([
    fetchTrains(),
    fetchRivers(),
    fetchTraffic()
  ]);
  if (trains.status === "rejected") console.error("Irish Rail refresh failed", trains.reason);
  if (rivers.status === "rejected") console.error("OPW river refresh failed", rivers.reason);
  if (traffic.status === "rejected") console.error("TII traffic refresh failed", traffic.reason);
  return json({
    generatedAt: new Date().toISOString(),
    trains: trains.status === "fulfilled" ? trains.value : [],
    rivers: rivers.status === "fulfilled" ? rivers.value : [],
    traffic: traffic.status === "fulfilled" ? traffic.value : [],
    sourceStatus: {
      trains: trains.status === "fulfilled" ? "live" : "unavailable",
      rivers: rivers.status === "fulfilled" ? "live" : "unavailable",
      traffic: traffic.status === "fulfilled" ? "context" : "unavailable"
    }
  });
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/api/living") {
      try {
        return await livingLayers(request);
      } catch (error) {
        console.error("Living layers failed", error);
        return json({ error: "Live layers are temporarily unavailable." }, 503);
      }
    }

    const response = await env.ASSETS.fetch(request);
    if (response.status !== 404) return response;
    if (url.pathname.includes(".")) return response;
    url.pathname = "/index.html";
    return env.ASSETS.fetch(new Request(url, request));
  }
};
