import { expect, test, type Locator, type Page } from "@playwright/test";

async function enableExploreLayer(page: Page, name: RegExp) {
  await page.getByRole("button", { name: "Explore", exact: true }).click();
  const panel = page.locator(".explore-panel");
  const layer = panel.getByRole("button", { name, includeHidden: true });
  const group = layer.locator("xpath=ancestor::details[1]");
  if (await group.count() && !(await group.evaluate((element: HTMLDetailsElement) => element.open))) {
    await group.locator("summary").click();
  }
  await expect(layer).toBeVisible();
  if (await layer.getAttribute("aria-pressed") !== "true") await layer.click();
  await page.getByRole("button", { name: "Close explore panel" }).click();
}

async function openActivityContext(page: Page) {
  const details = page.locator("details.activity-context");
  if (!(await details.evaluate((element: HTMLDetailsElement) => element.open))) {
    await details.locator("summary").click();
  }
}

function metObservationTime(minutesAgo: number) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-IE", {
      timeZone: "Europe/Dublin",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23"
    }).formatToParts(new Date(Date.now() - minutesAgo * 60_000)).map((part) => [part.type, part.value])
  );
  return { date: `${parts.day}-${parts.month}-${parts.year}`, reportTime: `${parts.hour}:${parts.minute}` };
}

const RADAR_FIXTURE_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEUlEQVQImWN4+vTpf4aGQ/8BG9AF8KAHnA4AAAAASUVORK5CYII=",
  "base64"
);

async function installRadarTileAvailabilityFixture(
  page: Page,
  outcome: "valid" | "partial" | "unavailable"
) {
  const now = new Date().toISOString();
  await page.route("https://prodapi.metweb.ie/**", (route) => route.fulfill({
    contentType: "application/json",
    body: "[]"
  }));
  await page.route("https://www.met.ie/latest-reports/observations/download", (route) => route.fulfill({
    contentType: "text/csv",
    body: "Name,Temperature,Description,Wind,Unused,Direction,Unused,Rain,Unused\n"
  }));
  await page.route("**/api/living", (route) => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({ trains: [], rivers: [], sourceStatus: { trains: "unavailable", rivers: "unavailable" } })
  }));
  await page.route("**/api/transit", (route) => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({ transit: [], transitStatus: "unavailable" })
  }));
  await page.route("**/api/contexts", (route) => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({
      generatedAt: now,
      marine: [],
      radar: [{
        id: "202608041510", observedAt: now, modifiedTime: 1, provider: "Met Éireann",
        tileTemplate: "https://gdal.met.ie/api/maps/radar/202608041510/{x}/{y}/{z}/1"
      }],
      grid: null, airQuality: [], aurora: null, tides: [], bathingAlerts: [], warnings: [],
      warningsStatus: "live", issTle: null, satellite: null, earthquakes: [],
      contextStatus: {
        marine: "unavailable", radar: "live", grid: "unavailable", measuredAir: "unavailable",
        modelledAir: "unavailable", aurora: "unavailable", tides: "unavailable", bathing: "unavailable",
        satellite: "unavailable", earthquakes: "unavailable", iss: "unavailable", warnings: "live"
      }
    })
  }));
  await page.route("https://gdal.met.ie/api/maps/radar/**", (route) => {
    const path = new URL(route.request().url()).pathname.split("/");
    const x = path[5];
    const available = outcome === "valid" || (outcome === "partial" && x === "30");
    return available
      ? route.fulfill({ contentType: "image/png", body: RADAR_FIXTURE_PNG })
      : route.fulfill({ status: 503, contentType: "text/plain", body: "tile unavailable" });
  });
}

async function installMapMarkerFixtures(page: Page, { multipleSignals = false }: { multipleSignals?: boolean } = {}) {
  const stationNames = new Map([
    ["malin-head", "Malin Head"], ["finner", "Finner"], ["belmullet", "Belmullet"],
    ["athenry", "Athenry"], ["dublin", "Dublin Airport"], ["gurteen", "Gurteen"],
    ["valentia", "Valentia"], ["cork", "Cork"], ["johnstown-castle", "Johnstown Castle"]
  ]);
  const observation = metObservationTime(5);
  const observedAt = new Date(Date.now() - 60_000).toISOString();

  await page.route("https://prodapi.metweb.ie/observations/*/today", (route) => {
    const endpoint = new URL(route.request().url()).pathname.split("/")[2];
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify([{
        name: stationNames.get(endpoint) ?? "Unknown station",
        ...observation,
        temperature: "16",
        rainfall: multipleSignals ? "1.2" : "0.4",
        windSpeed: "12",
        cardinalWindDirection: "E",
        weatherDescription: "Bright intervals"
      }])
    });
  });
  await page.route("https://www.met.ie/latest-reports/observations/download", (route) => route.fulfill({
    contentType: "text/csv",
    body: "Name,Temperature,Description,Wind,Unused,Direction,Unused,Rain,Unused\n"
  }));
  await page.route("**/api/living", (route) => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({
      trains: [{
        id: "fixture-train", latitude: 52.15, longitude: -7.4, status: "running",
        direction: "South", message: "Fixture service", observedAt, speedKmh: null, speedSource: null
      }, {
        id: "fixture-stack-train", latitude: 54.1, longitude: -8, status: "running",
        direction: "North", message: "Fixture stacked service", observedAt, speedKmh: null, speedSource: null
      }],
      rivers: [{
        id: "fixture-river", name: "Fixture River", latitude: 53.1, longitude: -8.1,
        level: 1.42, observedAt
      }],
      sourceStatus: { trains: "live", rivers: "live" }
    })
  }));
  await page.route("**/api/contexts", (route) => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({
      marine: [{
        id: "fixture-buoy", name: "Fixture Buoy", kind: "weather-buoy", latitude: 53.8, longitude: -10.2,
        observedAt, windSpeedKnots: 8, waveHeight: 1.1, wavePeriod: 5, seaTemperature: 14
      }],
      radar: [],
      grid: multipleSignals ? {
        observedAt, demandMW: 1000, generationMW: 1000, windMW: 650,
        windSharePercent: 65, carbonIntensity: 190, carbonEmissions: 95,
        frequencyHz: 50, interconnectorMW: 0
      } : null,
      airQuality: [{
        id: "fixture-air", name: "Fixture Air", latitude: 53.4, longitude: -6.5, observedAt,
        europeanAqi: 32, pm25: 8, pm10: 14, nitrogenDioxide: 11, ozone: 80, uvIndex: 2,
        grassPollen: 1, source: "modelled", stationClassification: null
      }],
      aurora: null,
      tides: [{
        id: "fixture-tide", name: "Fixture Tide", latitude: 53.3, longitude: -9.7, observedAt,
        waterLevel: -1.48, predictedLevel: -1.58, surge: multipleSignals ? 0.3 : 0.1, trend: "falling",
        nextHighAt: "2026-08-04T21:10:00.000Z", nextHighLevel: 1.8,
        nextLowAt: "2026-08-04T15:10:00.000Z", nextLowLevel: -1.72
      }],
      bathingAlerts: [{
        id: "fixture-bathing", name: "Fixture Beach", county: "Clare", latitude: 52.7, longitude: -9.2,
        restriction: "Temporary advice", description: "Fixture bathing-water notice", startedAt: new Date(Date.now() - 60_000).toISOString(),
        updatedAt: observedAt, endsAt: new Date(Date.now() + 60 * 60_000).toISOString(), noticeUrl: null
      }],
      warnings: [],
      warningsStatus: "live",
      issTle: null,
      satellite: null,
      earthquakes: [{
        id: "fixture-quake", latitude: 53.5, longitude: -8.5, magnitude: 2.1, depthKm: 8,
        place: "Fixture event", observedAt, detailUrl: "https://example.test/quake"
      }],
      contextStatus: {
        marine: "live", grid: "live", measuredAir: "live", tides: "live", bathing: "live",
        satellite: "unavailable", earthquakes: "live", iss: "unavailable", warnings: "live"
      }
    })
  }));
  await page.route("**/api/transit", (route) => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({
      transit: [{
        id: "fixture-transit", label: "7100", route: "2 NX c a", latitude: 54.75, longitude: -7.1,
        bearing: 225, speedKmh: 18, speedSource: "reported", observedAt
      }, {
        id: "fixture-stack-transit", label: "121", route: "3 73 a", latitude: 54.1, longitude: -8,
        bearing: null, speedKmh: null, speedSource: null, observedAt
      }],
      transitStatus: "live"
    })
  }));
}

async function installAccessibilityContentFixtures(page: Page) {
  await installMapMarkerFixtures(page);
  await page.unroute("**/api/contexts");
  await page.unroute("**/api/transit");
  const observedAt = new Date(Date.now() - 3 * 60_000).toISOString();
  const issued = new Date(Date.now() - 45 * 60_000).toISOString();
  const expiry = new Date(Date.now() + 2 * 60 * 60_000).toISOString();

  await page.route("**/api/contexts", (route) => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({
      marine: [], radar: [], grid: null, airQuality: [], aurora: null, tides: [], bathingAlerts: [],
      warnings: [{
        id: "accessibility-warning",
        capId: "accessibility-warning-cap",
        type: "yellow; Moderate",
        severity: "Moderate",
        certainty: "Likely",
        regions: ["EI29"],
        status: "Warning",
        issued,
        updated: issued,
        level: "Yellow",
        headline: "Rain warning for Westmeath",
        description: "Heavy showers may cause difficult travelling conditions.",
        onset: issued,
        expiry
      }],
      warningsStatus: "live",
      issTle: null,
      satellite: null,
      earthquakes: [],
      contextStatus: {
        marine: "unavailable", measuredAir: "unavailable", tides: "unavailable", bathing: "unavailable",
        satellite: "unavailable", earthquakes: "unavailable", iss: "unavailable", warnings: "live"
      }
    })
  }));
  await page.route("**/api/transit", (route) => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({
      transit: [{
        id: "provider-shaped-bus",
        label: "100",
        route: "3 73 a",
        latitude: 53.35,
        longitude: -6.26,
        bearing: 90,
        speedKmh: 22,
        speedSource: "reported",
        observedAt
      }],
      transitStatus: "live"
    })
  }));
}

async function notableTargetMetrics(control: Locator) {
  return control.evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    const visibleWidth = Math.max(0, Math.min(bounds.right, innerWidth) - Math.max(bounds.left, 0));
    const visibleHeight = Math.max(0, Math.min(bounds.bottom, innerHeight) - Math.max(bounds.top, 0));
    const centreElement = document.elementFromPoint(
      bounds.left + bounds.width / 2,
      bounds.top + bounds.height / 2
    );
    return {
      fontSize: Number.parseFloat(style.fontSize),
      width: bounds.width,
      height: bounds.height,
      top: bounds.top,
      bottom: bounds.bottom,
      left: bounds.left,
      right: bounds.right,
      viewportWidth: innerWidth,
      viewportHeight: innerHeight,
      visibleWidth,
      visibleHeight,
      centreHit: centreElement === element || (centreElement !== null && element.contains(centreElement)),
      centreOwner: centreElement
        ? `${centreElement.tagName.toLowerCase()}.${String(centreElement.className).replace(/\s+/g, ".")}`
        : "none"
    };
  });
}

async function waitForNotablePositionToSettle(control: Locator) {
  return control.evaluate((element) => new Promise<boolean>((resolve) => {
    let previousScroll = scrollY;
    let previousBounds = element.getBoundingClientRect();
    let stableFrames = 0;
    let frameCount = 0;
    const sample = () => {
      const bounds = element.getBoundingClientRect();
      const stable = Math.abs(scrollY - previousScroll) < 0.25 &&
        Math.abs(bounds.top - previousBounds.top) < 0.25 &&
        Math.abs(bounds.bottom - previousBounds.bottom) < 0.25;
      stableFrames = stable ? stableFrames + 1 : 0;
      previousScroll = scrollY;
      previousBounds = bounds;
      frameCount += 1;
      if (stableFrames >= 6) {
        resolve(true);
      } else if (frameCount >= 240) {
        resolve(false);
      } else {
        requestAnimationFrame(sample);
      }
    };
    requestAnimationFrame(sample);
  }));
}

async function revealNotableTargetWithKeyboard(page: Page, control: Locator) {
  expect(await page.evaluate(() => ({
    computed: getComputedStyle(document.documentElement).scrollBehavior,
    inline: document.documentElement.style.scrollBehavior
  }))).toEqual({ computed: "smooth", inline: "" });

  await page.keyboard.press("Home");
  expect(await waitForNotablePositionToSettle(control)).toBe(true);
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const metrics = await notableTargetMetrics(control);
    const fullyInsideViewport = metrics.top >= 0 &&
      metrics.bottom <= metrics.viewportHeight &&
      metrics.left >= 0 &&
      metrics.right <= metrics.viewportWidth + 1;
    if (fullyInsideViewport && metrics.centreHit) return metrics;

    let key: "PageDown" | "PageUp" | "ArrowDown" | "ArrowUp";
    if (metrics.top >= metrics.viewportHeight * 1.25) {
      key = "PageDown";
    } else if (metrics.bottom > metrics.viewportHeight) {
      key = "ArrowDown";
    } else if (metrics.bottom <= -metrics.viewportHeight * 0.25) {
      key = "PageUp";
    } else if (metrics.top < 0) {
      key = "ArrowUp";
    } else {
      key = (metrics.top + metrics.bottom) / 2 < metrics.viewportHeight / 2 ? "ArrowUp" : "ArrowDown";
    }
    await page.keyboard.press(key);
    expect(await waitForNotablePositionToSettle(control)).toBe(true);
  }
  throw new Error(`Natural keyboard scrolling did not reveal the notable control: ${JSON.stringify(await notableTargetMetrics(control))}`);
}

async function expectNotableMoreTarget(page: Page) {
  const control = page.getByRole("button", { name: "View 2 more", exact: true });
  await expect(control).toBeVisible();
  const metrics = await revealNotableTargetWithKeyboard(page, control);
  expect(metrics.fontSize).toBeGreaterThanOrEqual(12);
  expect(metrics.width).toBeGreaterThanOrEqual(44);
  expect(metrics.height).toBeGreaterThanOrEqual(44);
  expect(metrics.visibleWidth).toBeGreaterThanOrEqual(44);
  expect(metrics.visibleHeight).toBeGreaterThanOrEqual(44);
  expect(metrics.top).toBeGreaterThanOrEqual(0);
  expect(metrics.bottom).toBeLessThanOrEqual(metrics.viewportHeight);
  expect(metrics.left).toBeGreaterThanOrEqual(0);
  expect(metrics.right).toBeLessThanOrEqual(metrics.viewportWidth + 1);
  expect(metrics.centreHit).toBe(true);
  return control;
}

test("boot refresh uses canonical weather stations and one contexts request", async ({ page }) => {
  const stationNames = new Map([
    ["malin-head", "Malin Head"], ["finner", "Finner"], ["belmullet", "Belmullet"],
    ["athenry", "Athenry"], ["dublin", "Dublin Airport"], ["gurteen", "Gurteen"],
    ["valentia", "Valentia"], ["cork", "Cork"], ["johnstown-castle", "Johnstown Castle"]
  ]);
  const requestedStations: string[] = [];
  let contextsRequests = 0;
  const observation = metObservationTime(50);

  await page.route("https://prodapi.metweb.ie/observations/*/today", async (route) => {
    const endpoint = new URL(route.request().url()).pathname.split("/")[2];
    requestedStations.push(endpoint);
    await new Promise((resolve) => setTimeout(resolve, 400));
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify([{
        name: stationNames.get(endpoint) ?? "Wrong station",
        ...observation,
        temperature: "16",
        rainfall: "0.0",
        windSpeed: "8",
        cardinalWindDirection: "E",
        weatherDescription: "Test observation"
      }])
    });
  });
  await page.route("**/api/contexts", async (route) => {
    contextsRequests += 1;
    await new Promise((resolve) => setTimeout(resolve, 400));
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        marine: [], radar: [], grid: null, airQuality: [], aurora: null, tides: [], bathingAlerts: [],
        warnings: [], warningsStatus: "live", issTle: null, satellite: null, earthquakes: [],
        contextStatus: {
          marine: "unavailable", measuredAir: "unavailable", tides: "unavailable", bathing: "unavailable",
          satellite: "unavailable", earthquakes: "unavailable", iss: "unavailable", warnings: "live"
        }
      })
    });
  });
  await page.route("**/api/living", (route) => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({ trains: [], rivers: [], sourceStatus: { trains: "unavailable", rivers: "unavailable" } })
  }));
  await page.route("**/api/transit", (route) => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({ transit: [], transitStatus: "unavailable" })
  }));

  await page.goto("/");
  await expect(page.locator(".live-state")).toHaveAttribute("data-service-state", "connecting");
  await expect(page.locator(".rail-status")).toContainText("Connecting to live services");
  await expect(page.locator(".station-marker")).toHaveCount(9);
  const weatherChip = page.locator(".freshness-chip").filter({ hasText: "Weather provider" });
  await expect(weatherChip).toContainText(/live · observed/);
  await expect(weatherChip).not.toContainText("stale");
  expect(contextsRequests).toBe(1);
  expect(requestedStations).toContain("dublin");
  expect(requestedStations).toContain("cork");
  expect(requestedStations).not.toContain("dublin-airport");
  expect(requestedStations).not.toContain("cork-airport");
});

test("renders the living map and live observations", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  const headingText = await page.getByRole("heading", { level: 1 }).textContent();
  expect(headingText).toMatch(/Ireland/i);
  await expect(page.getByLabel("Live map of Ireland")).toBeVisible();
  await expect(page.getByText("Today so far")).toBeVisible();
  await expect(page.locator(".station-marker").first()).toBeVisible();
  const markerLabel = await page.locator(".station-marker").first().getAttribute("aria-label");
  expect(markerLabel).toMatch(/degrees|unknown/);
  await expect(
    page.getByRole("navigation", { name: "Map view shortcuts" }).getByRole("button", { name: /Movement/ })
  ).toBeVisible();
  await expect(page.locator("body")).not.toHaveCSS("overflow-x", "scroll");
});

test("the live map leads into selected-place and across-Ireland evidence", async ({ page }) => {
  await page.goto("/?place=cork");
  const briefing = page.locator(".place-context");
  await expect(briefing).toHaveAttribute("data-place-id", "cork");
  await expect(briefing.getByText("My Place", { exact: true })).toBeVisible();
  await expect(briefing.getByRole("heading", { name: "Cork", exact: true })).toBeVisible();
  await expect(briefing.locator(".place-observations")).toHaveAttribute("aria-label", "Local observations near Cork");
  await expect(briefing.locator("dl")).toBeVisible();
  await expect(briefing.locator("dl > div")).toHaveCount(4);
  const localLabels = await briefing.locator("dl > div small").allTextContents();
  for (const label of localLabels) {
    expect(label).toMatch(/Connecting to|No nearby .* observation|(?:Met Éireann|OPW|EEA measured|CAMS modelled).*km away|unavailable.*cannot be assessed|cached readings are not used as current/i);
  }
  await expect(page.locator(".freshness-chip").filter({ hasText: "Weather provider" })).toContainText(/(?:live|partial|fallback) · observed/);
  await expect(page.locator(".workspace-facts")).toHaveAttribute("aria-label", "Current national highlights across Ireland");

  const hierarchy = await page.evaluate(() => {
    const place = document.querySelector(".place-context");
    const notices = document.querySelector(".official-notices");
    const matters = document.querySelector(".what-matters-now");
    const map = document.querySelector("#live-map");
    return Boolean(
      place && notices && matters && map &&
      (map.compareDocumentPosition(place) & Node.DOCUMENT_POSITION_FOLLOWING) &&
      (place.compareDocumentPosition(notices) & Node.DOCUMENT_POSITION_FOLLOWING) &&
      (notices.compareDocumentPosition(matters) & Node.DOCUMENT_POSITION_FOLLOWING) &&
      !(matters.compareDocumentPosition(map) & Node.DOCUMENT_POSITION_FOLLOWING)
    );
  });
  expect(hierarchy).toBe(true);
});

test("default island context stays compact until a place is selected", async ({ page }) => {
  await installMapMarkerFixtures(page);
  await page.goto("/");

  const place = page.locator(".place-context");
  await expect(place).toHaveClass(/place-context-compact/);
  await expect(place.getByRole("heading", { name: "Personalise this view" })).toBeVisible();
  await expect(place.locator(".place-observations")).toHaveCount(0);
  await expect(place.locator("#place-message")).toContainText("GPS coordinates are never stored or shared");

  const notices = page.locator(".official-notices");
  await expect(notices).toHaveClass(/compact/);
  await expect(notices).toContainText("No current or upcoming Met Éireann notices");

  await place.locator("#place-select").selectOption("cork");
  await expect(place).not.toHaveClass(/place-context-compact/);
  await expect(place.getByRole("heading", { name: "Cork", exact: true })).toBeVisible();
  await expect(place.locator(".place-observations dl > div")).toHaveCount(4);
});

test("official notices retain scope after the map", async ({ page }) => {
  await page.goto("/?view=weather");
  const notices = page.locator(".official-notices");
  await expect(notices).toHaveAttribute("data-scope", "across-ireland");
  await expect(notices.getByRole("heading", { name: /Official notices/ })).toBeVisible();

  const afterMap = await page.evaluate(() => {
    const notices = document.querySelector(".official-notices");
    const map = document.querySelector("#live-map");
    return Boolean(notices && map && (map.compareDocumentPosition(notices) & Node.DOCUMENT_POSITION_FOLLOWING));
  });
  expect(afterMap).toBe(true);

  const warning = notices.locator(".warning-strip");
  if (await warning.count()) {
    await expect(warning.first()).toHaveAttribute("aria-label", /Official Met Éireann (active|upcoming) notice for/);
    await expect(warning.first().getByText(/Official notice|Upcoming notice/, { exact: true })).toBeVisible();
    await expect(warning.first()).toContainText("Met Éireann");
  } else {
    await expect(notices).toContainText(/No current or upcoming Met Éireann notices|notice feed is unavailable/);
  }
  await expect(page.locator(".what-matters-now .signal-item").filter({ hasText: "Met Éireann" })).toHaveCount(0);
});

test("multiple notices render as active/upcoming facts without turning Blight into a walk notice", async ({ page }) => {
  const stationNames = new Map([
    ["malin-head", "Malin Head"], ["finner", "Finner"], ["belmullet", "Belmullet"],
    ["athenry", "Athenry"], ["dublin", "Dublin Airport"], ["gurteen", "Gurteen"],
    ["valentia", "Valentia"], ["cork", "Cork"], ["johnstown-castle", "Johnstown Castle"]
  ]);
  const observation = metObservationTime(20);
  const issued = new Date(Date.now() - 45 * 60_000).toISOString();
  const activeExpiry = new Date(Date.now() + 2 * 60 * 60_000).toISOString();
  const upcomingOnset = new Date(Date.now() + 60 * 60_000).toISOString();
  const upcomingExpiry = new Date(Date.now() + 4 * 60 * 60_000).toISOString();

  await page.route("https://prodapi.metweb.ie/observations/*/today", (route) => {
    const endpoint = new URL(route.request().url()).pathname.split("/")[2];
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify([{
        name: stationNames.get(endpoint) ?? "Athenry",
        ...observation,
        temperature: "16",
        rainfall: "0.0",
        windSpeed: "8",
        cardinalWindDirection: "E",
        weatherDescription: "Test observation"
      }])
    });
  });
  await page.route("**/api/contexts", (route) => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({
      marine: [], radar: [], grid: null, airQuality: [], aurora: null, tides: [], bathingAlerts: [],
      warnings: [
        {
          id: "blight-1", capId: "cap-blight-1", type: "yellow; Moderate; Blight", severity: "Moderate", certainty: "Likely",
          regions: ["EI27"], status: "Warning", issued, updated: issued, level: "Yellow", headline: "Blight Advisory",
          description: "A potato blight advisory is in effect.", onset: issued, expiry: activeExpiry
        },
        {
          id: "rain-1", capId: "cap-rain-1", type: "yellow; Moderate", severity: "Moderate", certainty: "Likely",
          regions: ["EI27", "EI30", "EI31"], status: "Warning", issued, updated: issued, level: "Yellow",
          headline: "Rain warning for Waterford, Wexford &amp; Wicklow", description: "Spells of heavy thundery rain.",
          onset: upcomingOnset, expiry: upcomingExpiry
        }
      ],
      warningsStatus: "live", issTle: null, satellite: null, earthquakes: [],
      contextStatus: {
        marine: "unavailable", measuredAir: "unavailable", tides: "unavailable", bathing: "unavailable",
        satellite: "unavailable", earthquakes: "unavailable", iss: "unavailable", warnings: "live"
      }
    })
  }));
  await page.route("**/api/living", (route) => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({ trains: [], rivers: [], sourceStatus: { trains: "unavailable", rivers: "unavailable" } })
  }));
  await page.route("**/api/transit", (route) => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({ transit: [], transitStatus: "unavailable" })
  }));

  await page.goto("/?place=waterford");
  const notices = page.locator(".official-notices .warning-strip");
  await expect(notices).toHaveCount(2);
  await expect(notices.nth(0)).toContainText("Official notice");
  await expect(notices.nth(1)).toContainText("Upcoming notice");
  await expect(notices.nth(1)).toContainText("Rain warning for Waterford, Wexford & Wicklow");
  await expect(page.locator('[data-activity-id="outdoor-walk"] .guidance-status')).toHaveText("Live observations");
  await expect(page.locator(".guidance-card")).toHaveCount(4);
  expect((await page.locator(".guidance-card").allTextContents()).join(" ")).not.toMatch(/Favourable|Mixed signals|Caution/);
});

test("explore layers and station details are interactive", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Explore", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Live layers" })).toBeVisible();
  const rain = page.getByRole("button", { name: /Observed rain/ });
  await rain.click();
  await expect(rain).toHaveAttribute("aria-pressed", "false");
  await page.getByRole("button", { name: "Close explore panel" }).click();
  await page.locator(".station-marker").first().click();
  await expect(page.locator(".station-card")).toBeVisible();
  await expect(page.locator(".station-card h2")).not.toHaveText("");
  await expect(page.locator(".station-card .station-temperature")).toContainText(/°/);
  await expect(page.locator(".station-card dl")).toBeVisible();
});

test("map markers use one roving tab stop in default and all-layer views", async ({ page }) => {
  await installMapMarkerFixtures(page);
  await page.goto("/");
  await expect(page.locator(".station-marker")).toHaveCount(9);

  const map = page.locator("svg.ireland-map");
  await expect(map).toHaveAttribute("role", "group");
  await expect(map).toHaveAttribute("aria-describedby", /map-keyboard-instructions/);
  await expect(page.locator("#map-keyboard-instructions")).toContainText(/Home and End/);
  await expect(page.locator(".wind-marker[aria-hidden='true']")).toHaveCount(9);
  await expect(page.locator(".wind-marker[role='button']")).toHaveCount(0);

  const readTabStops = () => page.locator("svg.ireland-map [data-map-marker]").evaluateAll((markers) => ({
    ids: markers.map((marker) => marker.getAttribute("data-marker-id")),
    tabIndexes: markers.map((marker) => (marker as SVGElement).tabIndex)
  }));
  const defaultStops = await readTabStops();
  expect(defaultStops.ids).toHaveLength(9);
  expect(new Set(defaultStops.ids).size).toBe(defaultStops.ids.length);
  expect(defaultStops.tabIndexes.filter((tabIndex) => tabIndex === 0)).toHaveLength(1);
  expect(defaultStops.tabIndexes.filter((tabIndex) => tabIndex === -1)).toHaveLength(8);

  const secondDefaultMarker = page.locator("svg.ireland-map [data-marker-id='station:finner']");
  await secondDefaultMarker.focus();
  await expect(secondDefaultMarker).toHaveAttribute("tabindex", "0");
  await page.getByRole("navigation", { name: "Map view shortcuts" }).getByRole("button", { name: /All layers/ }).click();
  await expect(secondDefaultMarker).toHaveAttribute("tabindex", "0");
  await secondDefaultMarker.focus();
  await page.keyboard.press("Tab");
  expect(await page.locator("svg.ireland-map [data-map-marker]:focus").count()).toBe(0);
  await page.keyboard.press("Shift+Tab");
  await expect(secondDefaultMarker).toBeFocused();

  await page.goto("/?view=all");
  await expect(page.locator(".river-marker")).toHaveCount(1);
  await expect(page.locator(".tide-marker")).toHaveCount(1);
  await expect(page.locator(".air-marker")).toHaveCount(1);
  await expect(page.locator(".train-marker")).toHaveCount(1);
  await expect.poll(() => page.locator("svg.ireland-map [data-map-marker]").count()).toBeGreaterThan(defaultStops.ids.length);
  const allStops = await readTabStops();
  expect(allStops.ids.length).toBeGreaterThan(defaultStops.ids.length);
  expect(new Set(allStops.ids).size).toBe(allStops.ids.length);
  expect(allStops.tabIndexes.filter((tabIndex) => tabIndex === 0)).toHaveLength(1);
  expect(allStops.tabIndexes.filter((tabIndex) => tabIndex === -1)).toHaveLength(allStops.ids.length - 1);
  expect(await page.locator("svg.ireland-map [data-map-marker]").evaluateAll((markers) => markers.some((marker) => marker.getAttribute("tabindex") === "0"))).toBe(true);
});

test("map marker keyboard navigation announces position, prevents scroll, and restores focus", async ({ page }) => {
  await installMapMarkerFixtures(page);
  await page.goto("/");
  await expect(page.locator(".station-marker")).toHaveCount(9);
  await page.evaluate(() => { document.documentElement.style.scrollBehavior = "auto"; });

  const markers = page.locator("svg.ireland-map [data-map-marker]");
  const first = markers.first();
  const second = markers.nth(1);
  const last = markers.last();
  await first.focus();
  await expect(first).toBeFocused();
  await expect(page.locator("#map-marker-announcement")).toHaveText(/item 1 of 9/);

  await page.keyboard.press("ArrowRight");
  await expect(second).toBeFocused();
  await expect(page.locator("#map-marker-announcement")).toHaveText(/item 2 of 9/);
  await page.keyboard.press("ArrowDown");
  await expect(markers.nth(2)).toBeFocused();
  await page.keyboard.press("ArrowUp");
  await expect(second).toBeFocused();
  await page.keyboard.press("ArrowLeft");
  await expect(first).toBeFocused();
  await page.keyboard.press("Home");
  await expect(first).toBeFocused();
  await page.keyboard.press("End");
  await expect(last).toBeFocused();
  await expect(page.locator("#map-marker-announcement")).toHaveText(/item 9 of 9/);

  await first.focus();
  await page.evaluate(() => window.scrollTo({ left: window.scrollX, top: window.scrollY, behavior: "instant" }));
  const beforeScroll = await page.evaluate(() => window.scrollY);
  await page.keyboard.press("Space");
  expect(await page.evaluate(() => window.scrollY)).toBe(beforeScroll);
  await expect(page.locator(".detail-station")).toBeVisible();
  await page.getByRole("button", { name: "Close map details" }).click();
  await expect(first).toBeFocused();

  await page.keyboard.press("Enter");
  await expect(page.locator(".detail-station")).toBeVisible();
  await page.getByRole("button", { name: "Close map details" }).click();
  await expect(first).toBeFocused();
});

test("weather and wind share one accessible station entry while wind-only remains keyboard accessible", async ({ page }) => {
  await installMapMarkerFixtures(page);
  await page.goto("/");
  await expect(page.locator(".station-marker")).toHaveCount(9);
  await expect(page.locator("svg.ireland-map [role='button']")).toHaveCount(9);
  await expect(page.locator(".wind-marker[aria-hidden='true']")).toHaveCount(9);
  expect(await page.locator(".wind-marker[aria-hidden='true']").first().getAttribute("aria-label")).toBeNull();
  await expect(page.locator(".station-marker").first()).toHaveAccessibleName(/Bright intervals.*wind 12 kilometres per hour/);

  const combined = page.locator(".station-marker[data-marker-id='station:johnstown-castle']");
  const glyph = page.locator(".wind-marker[aria-hidden='true'][data-wind-for='johnstown-castle']");
  await expect(combined).toHaveCount(1);
  await expect(glyph).toHaveCount(1);
  await expect(glyph).not.toHaveAttribute("data-map-marker");
  await expect(glyph).not.toHaveAttribute("data-marker-pointer-target");
  await expect(page.getByRole("button", { name: /Wexford.*wind 12 kilometres per hour/ })).toHaveCount(1);
  await expect(combined.locator(":scope > .map-marker-hit-target")).toHaveCount(2);
  const glyphPointerEvents = await glyph.locator(":scope, :scope *").evaluateAll((elements) =>
    elements.map((element) => getComputedStyle(element).pointerEvents)
  );
  expect(new Set(glyphPointerEvents)).toEqual(new Set(["none"]));
  const combinedStops = await page.locator("svg.ireland-map [data-map-marker]").evaluateAll((markers) =>
    markers.map((marker) => (marker as SVGElement).tabIndex)
  );
  expect(combinedStops.filter((tabIndex) => tabIndex === 0)).toHaveLength(1);
  expect(combinedStops.filter((tabIndex) => tabIndex === -1)).toHaveLength(8);

  const combinedHitStyles = () => combined.locator(":scope > .map-marker-hit-target").evaluateAll((targets) =>
    targets.map((target) => {
      const style = getComputedStyle(target);
      return {
        pointerEvents: style.pointerEvents,
        strokeWidth: Number.parseFloat(style.strokeWidth),
        opacity: Number.parseFloat(style.opacity),
        filter: style.filter
      };
    })
  );
  const stableHitStyle = { pointerEvents: "stroke", strokeWidth: 44, opacity: 1, filter: "none" };
  expect(await combinedHitStyles()).toEqual([stableHitStyle, stableHitStyle]);
  await combined.hover({ force: true });
  expect(await combinedHitStyles()).toEqual([stableHitStyle, stableHitStyle]);

  await page.locator("#live-map").scrollIntoViewIfNeeded();
  const hitOffsets = [
    { name: "left", x: -20, y: 0 },
    { name: "right", x: 20, y: 0 },
    { name: "up", x: 0, y: -20 },
    { name: "down", x: 0, y: 20 }
  ];
  for (const offset of hitOffsets) {
    const point = await glyph.evaluate((element, currentOffset) => {
      const matrix = (element as SVGGElement).getScreenCTM();
      if (!matrix) return null;
      const centre = new DOMPoint(0, 0).matrixTransform(matrix);
      return { x: centre.x + currentOffset.x, y: centre.y + currentOffset.y };
    }, offset);
    expect(point, `${offset.name} wind hit point must be projected`).not.toBeNull();
    if (!point) continue;
    await page.mouse.click(point.x, point.y);
    await expect(
      page.locator("[role='dialog'].detail-station").getByRole("heading", { name: "Wexford" }),
      `${offset.name} 20px wind offset must open the combined Wexford station marker`
    ).toBeVisible();
    await page.getByRole("button", { name: "Close map details" }).click();
  }

  await page.emulateMedia({ forcedColors: "active" });
  expect(await combinedHitStyles()).toEqual([stableHitStyle, stableHitStyle]);
  await combined.hover({ force: true });
  expect(await combinedHitStyles()).toEqual([stableHitStyle, stableHitStyle]);
  expect(new Set(await glyph.locator(":scope, :scope *").evaluateAll((elements) =>
    elements.map((element) => getComputedStyle(element).pointerEvents)
  ))).toEqual(new Set(["none"]));
  await page.emulateMedia({ forcedColors: "none" });

  await page.goto("/?view=custom&layers=wind");
  await expect(page.locator(".station-marker")).toHaveCount(0);
  await expect(page.locator(".wind-marker[role='button']")).toHaveCount(9);
  await expect(page.locator("svg.ireland-map [role='button']")).toHaveCount(9);
  const windStops = await page.locator(".wind-marker[role='button']").evaluateAll((markers) => markers.map((marker) => (marker as SVGElement).tabIndex));
  expect(windStops.filter((tabIndex) => tabIndex === 0)).toHaveLength(1);
  expect(windStops.filter((tabIndex) => tabIndex === -1)).toHaveLength(8);
  await page.locator(".wind-marker[role='button']").first().focus();
  await expect(page.locator("#map-marker-announcement")).toHaveText(/wind 12 kilometres per hour.*item 1 of 9/);
  await page.keyboard.press("Enter");
  await expect(page.locator(".detail-station")).toBeVisible();
  await page.getByRole("button", { name: "Close map details" }).click();
  await expect(page.locator(".wind-marker[role='button']").first()).toBeFocused();
});

test("station identity and focus survive weather and wind representation changes", async ({ page }) => {
  await installMapMarkerFixtures(page);
  await page.goto("/");
  await page.getByRole("button", { name: "Explore", exact: true }).click();
  const weatherLayer = page.locator(".explore-panel").getByRole("button", { name: /Weather stations/ });
  const finner = page.locator("[data-marker-id='station:finner']");
  await finner.focus();

  const toggleWithoutMovingFocus = () => weatherLayer.evaluate((button) => {
    button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });

  await toggleWithoutMovingFocus();
  const windFinner = page.locator(".wind-marker[data-marker-id='station:finner']");
  await expect(windFinner).toBeVisible();
  await expect(page.locator(".station-marker")).toHaveCount(0);
  await expect(windFinner).toBeFocused();
  await expect(windFinner).toHaveAttribute("tabindex", "0");

  await toggleWithoutMovingFocus();
  const weatherFinner = page.locator(".station-marker[data-marker-id='station:finner']");
  await expect(weatherFinner).toBeVisible();
  await expect(weatherFinner).toBeFocused();
  await expect(weatherFinner).toHaveAttribute("tabindex", "0");

  await weatherLayer.focus();
  await weatherLayer.click();
  await expect(weatherLayer).toBeFocused();
  await expect(page.locator("[data-map-marker]:focus")).toHaveCount(0);
  await weatherLayer.click();
  await expect(weatherLayer).toBeFocused();
  await expect(page.locator("[data-map-marker]:focus")).toHaveCount(0);

  await weatherFinner.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("button", { name: "Close map details" })).toBeFocused();
  await page.getByRole("button", { name: "Close map details" }).click();
  await expect(weatherFinner).toBeFocused();

  const ids = await page.locator("[data-map-marker]").evaluateAll((markers) =>
    markers.map((marker) => marker.getAttribute("data-marker-id"))
  );
  expect(new Set(ids).size).toBe(ids.length);
});

test("focus rings are hidden until focus-visible without changing marker opacity", async ({ page }) => {
  await installMapMarkerFixtures(page);
  await page.goto("/?view=all");

  const readRingStyle = (selector: string) => page.locator(selector).first().evaluate((marker) => {
    const ring = marker.querySelector<SVGCircleElement>(":scope > .map-marker-focus-ring");
    const ordinaryCircle = marker.querySelector<SVGCircleElement>(
      ":scope > circle:not(.map-marker-focus-ring):not(.map-marker-hit-target)"
    );
    return {
      ringOpacity: ring ? Number(getComputedStyle(ring).opacity) : -1,
      ordinaryOpacity: ordinaryCircle ? Number(getComputedStyle(ordinaryCircle).opacity) : -1,
      focusVisible: marker.matches(":focus-visible")
    };
  });

  const air = page.locator(".air-marker").first();
  const movement = page.locator(".train-marker").first();
  await expect(air).toBeVisible();
  await expect(movement).toBeVisible();
  expect((await readRingStyle(".air-marker")).ringOpacity).toBe(0);
  expect((await readRingStyle(".air-marker")).ordinaryOpacity).toBeCloseTo(.88);
  expect((await readRingStyle(".train-marker")).ringOpacity).toBe(0);

  await air.focus();
  await expect.poll(async () => (await readRingStyle(".air-marker")).focusVisible).toBe(true);
  await expect.poll(async () => (await readRingStyle(".air-marker")).ringOpacity).toBeGreaterThan(0);
  await movement.focus();
  await expect.poll(async () => (await readRingStyle(".train-marker")).focusVisible).toBe(true);
  await expect.poll(async () => (await readRingStyle(".train-marker")).ringOpacity).toBeGreaterThan(0);
});

test("representative map marker pointer activation opens each available detail", async ({ page }) => {
  await installMapMarkerFixtures(page);
  await page.goto("/?view=all");
  await expect(page.locator(".station-marker")).toHaveCount(9);
  await page.getByRole("button", { name: "Explore", exact: true }).click();
  const radar = page.locator(".explore-panel").getByRole("button", { name: /Rainfall radar/ });
  if (await radar.getAttribute("aria-pressed") === "true") await radar.click();
  await page.getByRole("button", { name: "Close explore panel" }).click();
  for (const selector of [
    ".station-marker",
    ".river-marker",
    ".tide-marker",
    ".air-marker",
    ".train-marker"
  ]) {
    const marker = page.locator(selector).first();
    await expect(marker).toBeVisible();
    await marker.click();
    await expect(page.locator(".station-card")).toBeVisible();
    await page.getByRole("button", { name: "Close map details" }).click();
  }
});

test("explore layers stay grouped while preserving all layer IDs", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Explore", exact: true }).click();

  for (const heading of [
    "Weather & official notices",
    "Movement",
    "Water & coast",
    "Air, sky & earth",
    "Across Ireland",
    "Places"
  ]) {
    await expect(page.getByRole("heading", { name: heading, exact: true })).toBeVisible();
  }

  const controls = page.locator(".layer-group-controls > button");
  await expect(controls).toHaveCount(18);
  const ids = await controls.evaluateAll((buttons) => buttons.map((button) => button.getAttribute("data-layer-id")));
  expect(ids.filter((id): id is string => Boolean(id)).sort()).toEqual([
    "air", "aurora", "bathing", "earthquakes", "grid", "iss", "places", "radar", "rain",
    "rivers", "satellite", "sea", "tides", "trains", "transit", "warnings", "weather", "wind"
  ]);

  const rain = page.locator('[data-layer-id="rain"]');
  await expect(rain).toHaveAttribute("aria-pressed", "true");
  await rain.click();
  await expect(rain).toHaveAttribute("aria-pressed", "false");
  await page.getByRole("button", { name: "Close explore panel" }).click();
});

test("explore layer dialog traps and restores focus", async ({ page }) => {
  await page.goto("/");
  const opener = page.getByRole("button", { name: "Explore", exact: true });
  await opener.click();
  const close = page.getByRole("button", { name: "Close explore panel" });
  await expect(close).toBeFocused();

  await page.keyboard.press("Shift+Tab");
  expect(await page.locator(".explore-panel").evaluate((panel) => panel.contains(document.activeElement))).toBe(true);
  await page.keyboard.press("Tab");
  await expect(close).toBeFocused();

  await page.keyboard.press("Escape");
  await expect(page.locator(".explore-panel.is-open")).toHaveCount(0);
  await expect(opener).toBeFocused();
});

test("data details disclosure is keyboard operable and keeps focus", async ({ page }) => {
  await page.goto("/");
  const details = page.locator("details.freshness-details");
  const summary = details.locator("summary");
  await summary.focus();
  await expect(summary).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(details).toHaveAttribute("open", "");
  await expect(summary).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(details).not.toHaveAttribute("open", "");
  await expect(summary).toBeFocused();
});

test("does not expose a decorative sound control", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("button", { name: /Sound (on|off)/ })).toHaveCount(0);
});

test("independent service refreshes merge without erasing one another", async ({ page }) => {
  const observedAt = new Date().toISOString();
  await page.route("**/api/living", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 650));
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        generatedAt: observedAt,
        trains: [],
        rivers: [{ id: "merge-river", name: "Merge gauge", latitude: 53, longitude: -8, level: 1, observedAt, fresh: true }],
        sourceStatus: { trains: "live", rivers: "live" }
      })
    });
  });
  await page.route("**/api/contexts", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 80));
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        marine: [], radar: [], airQuality: [], aurora: null, tides: [], bathingAlerts: [],
        issTle: null, satellite: null, earthquakes: [],
        grid: {
          observedAt, demandMW: 1000, generationMW: 1000, windMW: 770,
          windSharePercent: 77, carbonIntensity: 200, carbonEmissions: 100,
          frequencyHz: 50, interconnectorMW: 0
        },
        contextStatus: {
          measuredAir: "unavailable", tides: "live", bathing: "live",
          satellite: "unavailable", earthquakes: "live", iss: "unavailable"
        }
      })
    });
  });
  await page.route("**/api/transit", (route) => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({ transit: [], transitStatus: "live" })
  }));

  await page.goto("/");
  await expect(page.locator(".pulse-card.grid").getByText("77%", { exact: true })).toBeVisible();
  await page.getByRole("navigation", { name: "Map view shortcuts" }).getByRole("button", { name: /Water/ }).click();
  await expect(page.locator(".river-marker")).toHaveCount(1);
});

test("a slower context refresh cannot erase a newer public transport refresh", async ({ page }) => {
  const observedAt = new Date().toISOString();
  await page.route("**/api/contexts", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 500));
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        marine: [], radar: [], airQuality: [], aurora: null, tides: [], bathingAlerts: [],
        issTle: null, satellite: null, earthquakes: [], grid: null,
        contextStatus: {
          measuredAir: "unavailable", tides: "unavailable", bathing: "unavailable",
          satellite: "unavailable", earthquakes: "unavailable", iss: "unavailable"
        }
      })
    });
  });
  await page.route("**/api/transit", (route) => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({
      transit: [{
        id: "race-bus",
        label: "Race test bus",
        route: "99",
        latitude: 53.3498,
        longitude: -6.2603,
        bearing: 90,
        speedKmh: 20,
        speedSource: "reported",
        observedAt
      }],
      transitStatus: "live"
    })
  }));

  await page.goto("/?view=custom&layers=transit");
  await expect(page.getByRole("button", { name: "Route 99, Heading east, live public transport position" })).toBeVisible();
});

test("page exposes live freshness and source provenance", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#connection-summary")).toContainText(/Connected|Checking for newer data/);
  await expect(page.getByText(/Copyright Met Éireann/)).toBeVisible();
  await expect(page.getByRole("heading", { name: "What matters now." })).toBeVisible();
  await expect(page.getByRole("heading", { name: /Ireland, at a glance|Signals that matter|What the live data shows/ })).toHaveCount(0);
  const dataDetails = page.locator("details.freshness-details");
  await expect(dataDetails).not.toHaveAttribute("open", "");
  await dataDetails.locator("summary").click();
  const freshnessChips = page.locator(".freshness-chip");
  await expect(freshnessChips.first()).toBeVisible();
  const chipCount = await freshnessChips.count();
  expect(chipCount).toBeGreaterThanOrEqual(3);
  for (let i = 0; i < chipCount; i++) {
    const chip = freshnessChips.nth(i);
    await expect(chip.locator("b")).not.toHaveText("");
    await expect(chip.locator("small")).not.toHaveText("");
  }
  const timelinePoints = await page.locator(".timeline-point").count();
  if (timelinePoints === 0) {
    await expect(page.getByText(/Connecting to hourly weather observations|current provider response contains no hourly observations|No saved hourly observations|Hourly weather observations are unavailable/)).toBeVisible();
  } else {
    expect(timelinePoints).toBeGreaterThanOrEqual(1);
    const firstPoint = page.locator(".timeline-point").first();
    await expect(firstPoint).toHaveAttribute("aria-label", /temperature.*degrees.*rainfall.*millimetres/);
    const ariaLabel = await firstPoint.getAttribute("aria-label");
    expect(ariaLabel).toMatch(/\d/);
  }
});

test("rail and water presets expose the live transport and gauge layers", async ({ page }) => {
  await page.goto("/");
  await page
    .getByRole("navigation", { name: "Map view shortcuts" })
    .getByRole("button", { name: /Movement/ })
    .click();
  if (await page.locator(".train-marker").count()) {
    await page.locator(".train-marker").first().focus();
    await page.keyboard.press("Enter");
    await expect(page.locator(".detail-train")).toBeVisible();
  }
  await page
    .getByRole("navigation", { name: "Map view shortcuts" })
    .getByRole("button", { name: /Water/ })
    .click();
  if (await page.locator(".river-marker").count()) {
    await page.locator(".river-marker").first().click();
    await expect(page.locator(".detail-river")).toBeVisible();
  }
});

test("overlapping rail and transport positions stay anchored and can be browsed", async ({ page }) => {
  const observedAt = new Date().toISOString();
  await page.route("**/api/living", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        generatedAt: observedAt,
        trains: [{
          id: "stack-train",
          latitude: 53.3498,
          longitude: -6.2603,
          status: "running",
          direction: "Dublin",
          message: "Test train",
          observedAt,
          speedKmh: 64,
          speedSource: "calculated"
        }],
        rivers: [],
        sourceStatus: { trains: "live", rivers: "live" }
      })
    });
  });
  await page.route("**/api/transit", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        transit: [{
          id: "stack-bus",
          label: "Test bus",
          route: "42",
          latitude: 53.3498,
          longitude: -6.2603,
          bearing: 90,
          speedKmh: 20,
          speedSource: "calculated",
          observedAt
        }],
        transitStatus: "live"
      })
    });
  });

  await page.goto("/");
  await page
    .getByRole("navigation", { name: "Map view shortcuts" })
    .getByRole("button", { name: /Movement/ })
    .click();
  const stack = page.locator(".movement-stack-marker").filter({ hasText: "2" });
  await expect(stack).toBeVisible();
  await stack.click();
  await expect(page.getByText("1 of 2")).toBeVisible();
  await expect(page.locator(".detail-train")).toBeVisible();
  await expect(page.locator(".detail-train")).toContainText("≈ 64 km/h");
  await expect(page.locator(".detail-train")).toContainText("Estimated from the distance");
  await page.getByRole("button", { name: "Next item at this location" }).click();
  await expect(page.locator(".detail-transit")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Route 42" })).toBeVisible();
  await expect(page.locator(".detail-transit")).toContainText("≈ 20 km/h");
});

test("moving transport keeps its marker identity through a boundary crossing and cluster split", async ({ page }) => {
  await page.addInitScript(() => {
    const originalSetInterval = window.setInterval;
    window.setInterval = ((handler: TimerHandler, timeout?: number, ...args: unknown[]) =>
      originalSetInterval(handler, timeout === 65_000 ? 250 : timeout, ...args)
    ) as typeof window.setInterval;
  });
  const observedAt = new Date().toISOString();
  let refreshes = 0;
  const vehicle = (id: string, longitude: number) => ({
    id,
    label: "Boundary bus",
    route: "42",
    latitude: 53.35,
    longitude,
    bearing: 90,
    speedKmh: 20,
    speedSource: "reported",
    observedAt
  });
  await page.route("**/api/transit", async (route) => {
    refreshes += 1;
    const body = refreshes === 1
      ? { transit: [vehicle("boundary-bus", -6.26)], transitStatus: "live" }
      : refreshes === 2
        ? { transit: [vehicle("boundary-bus", -6.02), vehicle("merge-bus", -6.02)], transitStatus: "live" }
        : { transit: [vehicle("boundary-bus", -6.02), vehicle("merge-bus", -9.2)], transitStatus: "live" };
    await route.fulfill({ contentType: "application/json", body: JSON.stringify(body) });
  });

  await page.goto("/?view=custom&layers=transit");
  const marker = page.locator("[data-marker-id='movement:transit:boundary-bus']");
  await expect(marker).toHaveCount(1);
  await marker.focus();
  const firstTransform = await marker.getAttribute("transform");
  await page.evaluate(() => {
    const current = document.querySelector("[data-marker-id='movement:transit:boundary-bus']");
    (window as unknown as { __boundaryMarker?: Element }).__boundaryMarker = current ?? undefined;
  });
  await expect.poll(() => refreshes).toBeGreaterThanOrEqual(2);
  await expect.poll(() => page.locator(".movement-stack-marker").count()).toBe(1);
  await expect.poll(() => marker.getAttribute("transform")).not.toBe(firstTransform);
  await expect(marker).toBeFocused();

  await expect.poll(() => refreshes).toBeGreaterThanOrEqual(3);
  await expect(marker).toBeFocused();
  expect(await page.evaluate(() => {
    const current = document.querySelector("[data-marker-id='movement:transit:boundary-bus']");
    const remembered = (window as unknown as { __boundaryMarker?: Element }).__boundaryMarker;
    return remembered === current;
  })).toBe(true);
  const markers = page.locator("[data-map-marker]");
  const markerState = await markers.evaluateAll((elements) => ({
    ids: elements.map((element) => element.getAttribute("data-marker-id")),
    tabIndexes: elements.map((element) => (element as SVGElement).tabIndex)
  }));
  expect(new Set(markerState.ids).size).toBe(markerState.ids.length);
  expect(markerState.tabIndexes.filter((tabIndex) => tabIndex === 0)).toHaveLength(1);
  expect(markerState.tabIndexes.filter((tabIndex) => tabIndex === -1)).toHaveLength(markerState.ids.length - 1);
});

test("movement clustering is deterministic across provider permutations and preserves focus", async ({ page }) => {
  await page.addInitScript(() => {
    const originalSetInterval = window.setInterval;
    window.setInterval = ((handler: TimerHandler, timeout?: number, ...args: unknown[]) =>
      originalSetInterval(handler, timeout === 65_000 ? 800 : timeout, ...args)
    ) as typeof window.setInterval;
  });
  const observedAt = new Date().toISOString();
  const vehicle = (id: string, longitude: number) => ({
    id,
    label: "Permutation test bus",
    route: "chain",
    latitude: 53.35,
    longitude,
    bearing: 90,
    speedKmh: 20,
    speedSource: "reported" as const,
    observedAt
  });
  const chain = [
    vehicle("chain-a", -8.42),
    vehicle("chain-b", -8.10),
    vehicle("chain-c", -7.78)
  ];
  let refreshes = 0;
  const requestedOrders: string[] = [];
  await page.route("**/api/transit", async (route) => {
    refreshes += 1;
    const orderedVehicles = refreshes === 1 ? chain : [chain[1]!, chain[0]!, chain[2]!];
    requestedOrders.push(orderedVehicles.map((item) => item.id).join(","));
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ transit: orderedVehicles, transitStatus: "live" })
    });
  });

  await page.goto("/?view=custom&layers=transit");
  const movementMarkers = page.locator("svg.ireland-map [data-marker-id^='movement:']");
  const readMovementState = () => movementMarkers.evaluateAll((markers) => markers.map((marker) => ({
    id: marker.getAttribute("data-marker-id"),
    members: (marker.getAttribute("data-movement-members") ?? "").split(",").filter(Boolean).sort(),
    transform: marker.getAttribute("transform"),
    tabIndex: (marker as SVGElement).tabIndex
  })).sort((first, second) => {
    const firstId = first.id ?? "";
    const secondId = second.id ?? "";
    return firstId < secondId ? -1 : firstId > secondId ? 1 : 0;
  }));

  await expect(movementMarkers).toHaveCount(test.info().project.name === "desktop" ? 2 : 1);
  const firstState = await readMovementState();
  expect(requestedOrders[0]).toBe("chain-a,chain-b,chain-c");
  expect(firstState.map(({ id, members }) => ({ id, members }))).toEqual(test.info().project.name === "desktop"
    ? [
        { id: "movement:transit:chain-a", members: ["transit:chain-a", "transit:chain-b"] },
        { id: "movement:transit:chain-c", members: ["transit:chain-c"] }
      ]
    : [
        { id: "movement:transit:chain-a", members: ["transit:chain-a", "transit:chain-b", "transit:chain-c"] }
      ]
  );
  expect(new Set(firstState.map(({ id }) => id)).size).toBe(firstState.length);
  expect(firstState.filter(({ tabIndex }) => tabIndex === 0)).toHaveLength(1);
  expect(firstState.filter(({ tabIndex }) => tabIndex === -1)).toHaveLength(firstState.length - 1);

  const focusedMarker = page.locator("[data-marker-id='movement:transit:chain-a']");
  await focusedMarker.focus();
  await expect(focusedMarker).toBeFocused();
  await page.evaluate(() => {
    const marker = document.querySelector("[data-marker-id='movement:transit:chain-a']");
    (window as unknown as { __focusedMovementMarker?: Element }).__focusedMovementMarker = marker ?? undefined;
  });

  await expect.poll(() => refreshes).toBeGreaterThanOrEqual(2);
  expect(requestedOrders.slice(0, 2)).toEqual(["chain-a,chain-b,chain-c", "chain-b,chain-a,chain-c"]);
  const secondState = await readMovementState();
  expect(secondState).toEqual(firstState);
  expect(new Set(secondState.map(({ id }) => id)).size).toBe(secondState.length);
  expect(secondState.filter(({ tabIndex }) => tabIndex === 0)).toHaveLength(1);
  expect(secondState.filter(({ tabIndex }) => tabIndex === -1)).toHaveLength(secondState.length - 1);
  await expect(focusedMarker).toBeFocused();
  expect(await page.evaluate(() => {
    const current = document.querySelector("[data-marker-id='movement:transit:chain-a']");
    const remembered = (window as unknown as { __focusedMovementMarker?: Element }).__focusedMovementMarker;
    return current === remembered;
  })).toBe(true);

  for (let step = 0; step < 7; step += 1) {
    await page.locator("svg.ireland-map").evaluate((element) => {
      const bounds = element.getBoundingClientRect();
      element.dispatchEvent(new WheelEvent("wheel", {
        bubbles: true,
        cancelable: true,
        clientX: bounds.left + bounds.width / 2,
        clientY: bounds.top + bounds.height / 2,
        deltaY: -300
      }));
    });
  }
  await expect(page.locator(".map-viewport")).toHaveAttribute("data-scale", "4.00");
  await expect(focusedMarker).toBeFocused();
  const splitState = await readMovementState();
  expect(splitState.flatMap(({ members }) => members).sort()).toEqual([
    "transit:chain-a", "transit:chain-b", "transit:chain-c"
  ]);
  expect(splitState.length).toBeGreaterThan(1);
  expect(splitState.filter(({ tabIndex }) => tabIndex === 0)).toHaveLength(1);
  expect(splitState.filter(({ tabIndex }) => tabIndex === -1)).toHaveLength(splitState.length - 1);
});

test("duplicate public transport IDs resolve newest data and stable equal-time payloads", async ({ page }) => {
  await page.addInitScript(() => {
    const originalSetInterval = window.setInterval;
    window.setInterval = ((handler: TimerHandler, timeout?: number, ...args: unknown[]) =>
      originalSetInterval(handler, timeout === 65_000 ? 800 : timeout, ...args)
    ) as typeof window.setInterval;
  });
  const olderAt = new Date(Date.now() - 5 * 60_000).toISOString();
  const newerAt = new Date(Date.now() - 4 * 60_000).toISOString();
  const equalAt = new Date(Date.now() - 3 * 60_000).toISOString();
  const vehicle = (route: string, label: string, latitude: number, longitude: number, observedAt: string) => ({
    id: "duplicate-transit",
    label,
    route,
    latitude,
    longitude,
    bearing: 90,
    speedKmh: 20,
    speedSource: "reported" as const,
    observedAt
  });
  const older = vehicle("3 220 d a", "Older position", 53.35, -9.2, olderAt);
  const newer = vehicle("2 NX c a", "Newest position", 53.35, -6.26, newerAt);
  const equalWest = vehicle("3 S4 a", "Equal west position", 53.35, -9.2, equalAt);
  const equalEast = vehicle("3 L27 a", "Equal east position", 53.35, -7.4, equalAt);
  const responses = [
    [older, newer],
    [newer, older],
    [equalWest, equalEast],
    [equalEast, equalWest]
  ];
  let refreshes = 0;

  await page.route("**/api/living", (route) => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({ trains: [], rivers: [], sourceStatus: { trains: "unavailable", rivers: "unavailable" } })
  }));
  await page.route("**/api/transit", (route) => {
    const ordered = responses[Math.min(refreshes, responses.length - 1)]!;
    refreshes += 1;
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ transit: ordered, transitStatus: "live" })
    });
  });

  await page.goto("/?view=custom&layers=transit");
  const marker = page.locator("[data-marker-id='movement:transit:duplicate-transit']");
  const readState = () => marker.evaluate((element) => ({
    id: element.getAttribute("data-marker-id"),
    transform: element.getAttribute("transform"),
    members: element.getAttribute("data-movement-members"),
    ariaLabel: element.getAttribute("aria-label"),
    tabIndex: (element as SVGElement).tabIndex
  }));
  const assertOneRovingStop = async () => {
    const tabIndexes = await page.locator("svg.ireland-map [data-map-marker]").evaluateAll((elements) =>
      elements.map((element) => (element as SVGElement).tabIndex)
    );
    expect(tabIndexes).toHaveLength(1);
    expect(tabIndexes.filter((tabIndex) => tabIndex === 0)).toHaveLength(1);
  };

  await expect(marker).toHaveCount(1);
  await marker.focus();
  const firstState = await readState();
  expect(firstState.ariaLabel).toContain("Route NX");
  await assertOneRovingStop();
  await page.evaluate(() => {
    (window as unknown as { __duplicateTransitMarker?: Element }).__duplicateTransitMarker =
      document.querySelector("[data-marker-id='movement:transit:duplicate-transit']") ?? undefined;
  });

  await expect.poll(() => refreshes).toBeGreaterThanOrEqual(2);
  const secondState = await readState();
  expect(secondState).toEqual(firstState);
  await expect(marker).toBeFocused();
  await assertOneRovingStop();
  expect(await page.evaluate(() => {
    const markerElement = document.querySelector("[data-marker-id='movement:transit:duplicate-transit']");
    const remembered = (window as unknown as { __duplicateTransitMarker?: Element }).__duplicateTransitMarker;
    return markerElement === remembered;
  })).toBe(true);

  await expect.poll(() => refreshes).toBeGreaterThanOrEqual(3);
  const thirdState = await readState();
  expect(thirdState.id).toBe(firstState.id);
  expect(thirdState.members).toBe(firstState.members);
  expect(thirdState.transform).not.toBe(firstState.transform);
  await assertOneRovingStop();
  await expect(marker).toBeFocused();

  await expect.poll(() => refreshes).toBeGreaterThanOrEqual(4);
  const fourthState = await readState();
  expect(fourthState).toEqual(thirdState);
  await expect(marker).toBeFocused();
  await assertOneRovingStop();
  expect(await page.evaluate(() => {
    const markerElement = document.querySelector("[data-marker-id='movement:transit:duplicate-transit']");
    const remembered = (window as unknown as { __duplicateTransitMarker?: Element }).__duplicateTransitMarker;
    return markerElement === remembered;
  })).toBe(true);
});

test("duplicate public transport IDs resolve U+001F route/label collisions independently of order", async ({ page }) => {
  await page.addInitScript(() => {
    const originalSetInterval = window.setInterval;
    window.setInterval = ((handler: TimerHandler, timeout?: number, ...args: unknown[]) =>
      originalSetInterval(handler, timeout === 65_000 ? 800 : timeout, ...args)
    ) as typeof window.setInterval;
  });
  const observedAt = new Date(Date.now() - 3 * 60_000).toISOString();
  const separator = "\u001f";
  const vehicle = (route: string, label: string, bearing: number) => ({
    id: "separator-transit",
    label,
    route,
    latitude: 53.35,
    longitude: -7.4,
    bearing,
    speedKmh: 20,
    speedSource: "reported" as const,
    observedAt
  });
  const first = vehicle(`x${separator}string:y`, "z", 270);
  const second = vehicle("x", `y${separator}string:z`, 90);
  const responses = [
    [first, second],
    [second, first],
    [first, second],
    [second, first]
  ];
  let refreshes = 0;

  await page.route("**/api/living", (route) => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({ trains: [], rivers: [], sourceStatus: { trains: "unavailable", rivers: "unavailable" } })
  }));
  await page.route("**/api/transit", (route) => {
    const ordered = responses[Math.min(refreshes, responses.length - 1)]!;
    refreshes += 1;
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ transit: ordered, transitStatus: "live" })
    });
  });

  await page.goto("/?view=custom&layers=transit");
  const marker = page.locator("[data-marker-id='movement:transit:separator-transit']");
  const readState = () => marker.evaluate((element) => ({
    id: element.getAttribute("data-marker-id"),
    transform: element.getAttribute("transform"),
    members: element.getAttribute("data-movement-members"),
    ariaLabel: element.getAttribute("aria-label"),
    tabIndex: (element as SVGElement).tabIndex
  }));
  const assertOneRovingStop = async () => {
    const tabIndexes = await page.locator("svg.ireland-map [data-map-marker]").evaluateAll((elements) =>
      elements.map((element) => (element as SVGElement).tabIndex)
    );
    expect(tabIndexes).toHaveLength(1);
    expect(tabIndexes.filter((tabIndex) => tabIndex === 0)).toHaveLength(1);
  };
  const openWithEnter = async () => {
    await marker.focus();
    await page.keyboard.press("Enter");
    await expect(page.locator(".detail-transit")).toBeVisible();
    const detail = await page.locator(".detail-transit").innerText();
    expect(detail).not.toContain(separator);
    expect(detail).not.toContain("string:z");
    expect(detail).toContain("Heading east");
    expect(detail).not.toContain("Heading west");
    await page.getByRole("button", { name: "Close map details" }).click();
    await expect(marker).toBeFocused();
    return detail;
  };

  await expect(marker).toHaveCount(1);
  const firstState = await readState();
  expect(firstState).toEqual({
    id: "movement:transit:separator-transit",
    transform: firstState.transform,
    members: "transit:separator-transit",
    ariaLabel: "Route X, Heading east, live public transport position",
    tabIndex: 0
  });
  const firstDetail = await openWithEnter();
  await marker.click();
  await expect(page.locator(".detail-transit")).toBeVisible();
  await expect(page.locator(".detail-transit")).not.toContainText(separator);
  await expect(page.locator(".detail-transit")).not.toContainText("string:z");
  await expect(page.locator(".detail-transit")).toContainText("Heading east");
  await expect(page.locator(".detail-transit")).not.toContainText("Heading west");
  await page.getByRole("button", { name: "Close map details" }).click();
  await expect(marker).toBeFocused();
  await assertOneRovingStop();
  await page.evaluate(() => {
    (window as unknown as { __separatorTransitMarker?: Element }).__separatorTransitMarker =
      document.querySelector("[data-marker-id='movement:transit:separator-transit']") ?? undefined;
  });

  await expect.poll(() => refreshes).toBeGreaterThanOrEqual(2);
  const secondState = await readState();
  expect(secondState).toEqual(firstState);
  expect(await openWithEnter()).toBe(firstDetail);
  await assertOneRovingStop();
  expect(await page.evaluate(() => {
    const current = document.querySelector("[data-marker-id='movement:transit:separator-transit']");
    const remembered = (window as unknown as { __separatorTransitMarker?: Element }).__separatorTransitMarker;
    return current === remembered;
  })).toBe(true);

  await expect.poll(() => refreshes).toBeGreaterThanOrEqual(3);
  const thirdState = await readState();
  expect(thirdState).toEqual(firstState);
  await expect(marker).toBeFocused();
  await assertOneRovingStop();

  await expect.poll(() => refreshes).toBeGreaterThanOrEqual(4);
  const fourthState = await readState();
  expect(fourthState).toEqual(firstState);
  await expect(marker).toBeFocused();
  await assertOneRovingStop();
});

test("duplicate train IDs resolve equal-time direction/message separator collisions identically", async ({ page }) => {
  await page.addInitScript(() => {
    const originalSetInterval = window.setInterval;
    window.setInterval = ((handler: TimerHandler, timeout?: number, ...args: unknown[]) =>
      originalSetInterval(handler, timeout === 60_000 ? 800 : timeout, ...args)
    ) as typeof window.setInterval;
  });
  const observedAt = new Date(Date.now() - 2 * 60_000).toISOString();
  const separator = "\u001f";
  const train = (direction: string, message: string, latitude: number, longitude: number) => ({
    id: "duplicate-train",
    latitude,
    longitude,
    status: "running" as const,
    direction,
    message,
    observedAt,
    speedKmh: 48,
    speedSource: "calculated" as const
  });
  const west = train(`x${separator}string:y`, "z", 53.35, -7.4);
  const east = train("x", `y${separator}string:z`, 53.35, -7.4);
  const responses = [[west, east], [east, west]];
  let refreshes = 0;

  await page.route("**/api/living", (route) => {
    const ordered = responses[Math.min(refreshes, responses.length - 1)]!;
    refreshes += 1;
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        trains: ordered,
        rivers: [],
        sourceStatus: { trains: "live", rivers: "unavailable" }
      })
    });
  });
  await page.route("**/api/transit", (route) => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({ transit: [], transitStatus: "unavailable" })
  }));

  await page.goto("/?view=custom&layers=trains");
  const marker = page.locator("[data-marker-id='movement:train:duplicate-train']");
  const readState = () => marker.evaluate((element) => ({
    id: element.getAttribute("data-marker-id"),
    transform: element.getAttribute("transform"),
    members: element.getAttribute("data-movement-members"),
    ariaLabel: element.getAttribute("aria-label"),
    className: element.getAttribute("class"),
    tabIndex: (element as SVGElement).tabIndex
  }));
  const readDetail = async () => {
    await marker.focus();
    await page.keyboard.press("Enter");
    await expect(page.locator(".detail-train")).toBeVisible();
    const detail = await page.locator(".detail-train").innerText();
    await page.getByRole("button", { name: "Close map details" }).click();
    await expect(marker).toBeFocused();
    return detail;
  };
  const assertOneRovingStop = async () => {
    const tabIndexes = await page.locator("svg.ireland-map [data-map-marker]").evaluateAll((elements) =>
      elements.map((element) => (element as SVGElement).tabIndex)
    );
    expect(tabIndexes).toHaveLength(1);
    expect(tabIndexes.filter((tabIndex) => tabIndex === 0)).toHaveLength(1);
  };

  await expect(marker).toHaveCount(1);
  const firstState = await readState();
  const firstDetail = await readDetail();
  expect(firstState.ariaLabel).toBe("Train duplicate-train, x, running");
  expect(firstDetail).toContain(`y${separator}string:z`);
  const expectedCheckedTime = new Intl.DateTimeFormat("en-IE", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "Europe/Dublin"
  }).format(new Date(observedAt));
  expect(firstDetail).toContain(expectedCheckedTime);
  await assertOneRovingStop();
  await page.evaluate(() => {
    (window as unknown as { __duplicateTrainMarker?: Element }).__duplicateTrainMarker =
      document.querySelector("[data-marker-id='movement:train:duplicate-train']") ?? undefined;
  });

  await expect.poll(() => refreshes).toBeGreaterThanOrEqual(2);
  const secondState = await readState();
  const secondDetail = await readDetail();
  expect(secondState).toEqual(firstState);
  expect(secondDetail).toBe(firstDetail);
  await expect(marker).toBeFocused();
  await assertOneRovingStop();
  expect(await page.evaluate(() => {
    const markerElement = document.querySelector("[data-marker-id='movement:train:duplicate-train']");
    const remembered = (window as unknown as { __duplicateTrainMarker?: Element }).__duplicateTrainMarker;
    return markerElement === remembered;
  })).toBe(true);
});

test("duplicate trains with invalid timestamps remain deterministic and show unavailable time", async ({ page }) => {
  await page.addInitScript(() => {
    const originalSetInterval = window.setInterval;
    window.setInterval = ((handler: TimerHandler, timeout?: number, ...args: unknown[]) =>
      originalSetInterval(handler, timeout === 60_000 ? 800 : timeout, ...args)
    ) as typeof window.setInterval;
  });
  const train = (direction: string, message: string, observedAt: string) => ({
    id: "invalid-date-train",
    latitude: 53.35,
    longitude: -7.4,
    status: "running" as const,
    direction,
    message,
    observedAt,
    speedKmh: 48,
    speedSource: "calculated" as const
  });
  const first = train("Alpha", "Alpha detail", "invalid-alpha-time");
  const second = train("Beta", "Beta detail", "invalid-beta-time");
  const responses = [
    [first, second],
    [second, first],
    [first, second]
  ];
  let refreshes = 0;
  const pageErrors: Error[] = [];
  page.on("pageerror", (error) => pageErrors.push(error));

  await page.route("**/api/living", (route) => {
    const ordered = responses[Math.min(refreshes, responses.length - 1)]!;
    refreshes += 1;
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        trains: ordered,
        rivers: [],
        sourceStatus: { trains: "live", rivers: "unavailable" }
      })
    });
  });
  await page.route("**/api/transit", (route) => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({ transit: [], transitStatus: "unavailable" })
  }));

  await page.goto("/?view=custom&layers=trains");
  const marker = page.locator("[data-marker-id='movement:train:invalid-date-train']");
  const readState = () => marker.evaluate((element) => ({
    id: element.getAttribute("data-marker-id"),
    transform: element.getAttribute("transform"),
    members: element.getAttribute("data-movement-members"),
    ariaLabel: element.getAttribute("aria-label"),
    className: element.getAttribute("class"),
    tabIndex: (element as SVGElement).tabIndex
  }));
  const assertOneRovingStop = async () => {
    const tabIndexes = await page.locator("svg.ireland-map [data-map-marker]").evaluateAll((elements) =>
      elements.map((element) => (element as SVGElement).tabIndex)
    );
    expect(tabIndexes).toHaveLength(1);
    expect(tabIndexes.filter((tabIndex) => tabIndex === 0)).toHaveLength(1);
  };
  const openWithEnter = async () => {
    await marker.focus();
    await page.keyboard.press("Enter");
    await expect(page.locator(".detail-train")).toBeVisible();
    const detail = await page.locator(".detail-train").innerText();
    expect(detail).toContain("Alpha detail");
    expect(detail).toContain("Unavailable");
    await page.getByRole("button", { name: "Close map details" }).click();
    await expect(marker).toBeFocused();
    return detail;
  };

  await expect(marker).toHaveCount(1);
  const firstState = await readState();
  expect(firstState).toEqual({
    id: "movement:train:invalid-date-train",
    transform: firstState.transform,
    members: "train:invalid-date-train",
    ariaLabel: "Train invalid-date-train, Alpha, running",
    className: "train-marker running",
    tabIndex: 0
  });
  const firstDetail = await openWithEnter();
  await marker.click();
  await expect(page.locator(".detail-train")).toBeVisible();
  await expect(page.locator(".detail-train")).toContainText("Alpha detail");
  await expect(page.locator(".detail-train")).toContainText("Unavailable");
  await page.getByRole("button", { name: "Close map details" }).click();
  await expect(marker).toBeFocused();
  await assertOneRovingStop();
  await page.evaluate(() => {
    (window as unknown as { __invalidTrainMarker?: Element }).__invalidTrainMarker =
      document.querySelector("[data-marker-id='movement:train:invalid-date-train']") ?? undefined;
  });

  await expect.poll(() => refreshes).toBeGreaterThanOrEqual(2);
  const secondState = await readState();
  expect(secondState).toEqual(firstState);
  expect(await openWithEnter()).toBe(firstDetail);
  await assertOneRovingStop();
  expect(await page.evaluate(() => {
    const current = document.querySelector("[data-marker-id='movement:train:invalid-date-train']");
    const remembered = (window as unknown as { __invalidTrainMarker?: Element }).__invalidTrainMarker;
    return current === remembered;
  })).toBe(true);

  await expect.poll(() => refreshes).toBeGreaterThanOrEqual(3);
  const thirdState = await readState();
  expect(thirdState).toEqual(firstState);
  await expect(marker).toBeFocused();
  await assertOneRovingStop();
  expect(pageErrors).toEqual([]);
});

test("Stitch map workspace uses an island-only coastline and visible roads", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".island-shape path")).toHaveCount(1);
  const roadCount = await page.locator(".road-network path").count();
  expect(roadCount).toBeGreaterThan(50);
  await expect(page.locator(".road-network path.motorway").first()).toBeVisible();
  if (test.info().project.name === "desktop") {
    await expect(page.getByText("Provider feeds", { exact: true })).toBeVisible();
    await expect.poll(() => page.locator(".live-signal-dock").textContent())
      .toMatch(/weather stations|observations unavailable/i);
  }

  const heading = await page.getByRole("heading", { level: 1 }).boundingBox();
  const map = await page.getByLabel("Live map of Ireland").boundingBox();
  expect(heading).not.toBeNull();
  expect(map).not.toBeNull();
  expect((heading?.y ?? 0) + (heading?.height ?? 0)).toBeLessThan(map?.y ?? 0);
});

test("map supports accessible zoom, pan and reset controls", async ({ page }) => {
  await page.goto("/");
  const map = page.getByLabel("Live map of Ireland");
  const viewport = page.locator(".map-viewport");
  const navigation = page.getByRole("navigation", { name: "Map navigation" });

  await expect(navigation.getByRole("button", { name: "Zoom out" })).toBeDisabled();
  await expect(navigation.getByLabel("Current map zoom")).toHaveText("100%");
  await navigation.getByRole("button", { name: "Zoom in" }).click();
  await expect(viewport).toHaveAttribute("data-scale", "1.40");
  await expect(navigation.getByLabel("Current map zoom")).toHaveText("140%");

  const beforePan = await viewport.getAttribute("transform");
  await map.scrollIntoViewIfNeeded();
  const box = await map.boundingBox();
  expect(box).not.toBeNull();
  await page.mouse.move((box?.x ?? 0) + (box?.width ?? 0) * .55, (box?.y ?? 0) + (box?.height ?? 0) * .55);
  await page.mouse.down();
  await page.mouse.move((box?.x ?? 0) + (box?.width ?? 0) * .45, (box?.y ?? 0) + (box?.height ?? 0) * .45, { steps: 4 });
  await page.mouse.up();
  await expect(viewport).not.toHaveAttribute("transform", beforePan ?? "");

  await navigation.getByRole("button", { name: "Reset", exact: true }).click();
  await expect(viewport).toHaveAttribute("data-scale", "1.00");
  await expect(viewport).toHaveAttribute("transform", "translate(0 0) scale(1)");
  await expect(navigation.getByLabel("Current map zoom")).toHaveText("100%");

  if (test.info().project.name === "mobile") {
    const centerX = (box?.x ?? 0) + (box?.width ?? 0) / 2;
    const centerY = (box?.y ?? 0) + (box?.height ?? 0) / 2;
    const svg = page.locator("svg.ireland-map");
    await svg.dispatchEvent("pointerdown", { pointerId: 1, pointerType: "touch", clientX: centerX - 30, clientY: centerY, buttons: 1 });
    await svg.dispatchEvent("pointerdown", { pointerId: 2, pointerType: "touch", clientX: centerX + 30, clientY: centerY, buttons: 1 });
    await svg.dispatchEvent("pointermove", { pointerId: 1, pointerType: "touch", clientX: centerX - 65, clientY: centerY, buttons: 1 });
    await svg.dispatchEvent("pointermove", { pointerId: 2, pointerType: "touch", clientX: centerX + 65, clientY: centerY, buttons: 1 });
    await svg.dispatchEvent("pointerup", { pointerId: 1, pointerType: "touch", clientX: centerX - 65, clientY: centerY });
    await svg.dispatchEvent("pointerup", { pointerId: 2, pointerType: "touch", clientX: centerX + 65, clientY: centerY });
  } else {
    await page.evaluate(() => {
      document.querySelector("svg.ireland-map")?.dispatchEvent(
        new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: -300 })
      );
    });
  }
  await expect(viewport).not.toHaveAttribute("data-scale", "1.00");
  await navigation.getByRole("button", { name: "Reset", exact: true }).click();
  await expect(viewport).toHaveAttribute("data-scale", "1.00");
});

test("context cards focus one layer, explain its freshness and return to the map", async ({ page }) => {
  await page.goto("/");
  await page.locator(".pulse-card.grid").click();
  await expect(page.getByText("The all-island grid now", { exact: true })).toBeVisible();
  const gridPanel = page.locator(".grid-panel:visible");
  await expect(gridPanel).toBeVisible();
  await expect(gridPanel).toContainText("Generation");
  await expect(gridPanel.getByText("Demand", { exact: true }).locator("..").locator("dd")).not.toHaveText("0 MW");
  await expect(page.locator(".train-marker")).toHaveCount(0);

  await page.locator(".pulse-card.trains").click();
  const railContextTitle = page.locator(".map-notice > strong");
  await expect(railContextTitle).toHaveText(/Live rail positions|Cached rail positions|Rail positions unavailable/);
  await expect(railContextTitle).toBeVisible();
  if (await page.locator(".train-marker").count()) {
    await expect(page.locator(".train-marker").first()).toBeVisible();
  } else {
    await expect(railContextTitle).toBeVisible();
  }
  await expect(page.getByLabel("All-island electricity grid now")).toHaveCount(0);
});

test("sea context distinguishes weather buoys from coastal observatories", async ({ page }) => {
  const observedAt = new Date().toISOString();
  await page.route("**/api/contexts", (route) => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({
      marine: [
        {
          id: "test-buoy", name: "Test weather buoy", kind: "weather-buoy",
          latitude: 53, longitude: -10, observedAt, windSpeedKnots: 8,
          waveHeight: 1.2, wavePeriod: 7, seaTemperature: 14
        },
        {
          id: "test-observatory", name: "Test coastal observatory", kind: "coastal-observatory",
          latitude: 53.2, longitude: -9.4, observedAt, windSpeedKnots: 6,
          waveHeight: null, wavePeriod: null, seaTemperature: 15
        }
      ],
      radar: [], grid: null, airQuality: [], aurora: null, tides: [], bathingAlerts: [],
      warnings: [], warningsStatus: "live", issTle: null, satellite: null, earthquakes: [],
      contextStatus: {
        marine: "live", measuredAir: "unavailable", tides: "live", bathing: "live",
        satellite: "unavailable", earthquakes: "live", iss: "unavailable", warnings: "live"
      }
    })
  }));
  await page.goto("/");
  if (test.info().project.name === "desktop") {
    const marineSummary = page.getByRole("button", { name: /marine sites reporting/ });
    await expect(marineSummary).toContainText("2");
    await marineSummary.click();
    await expect(page.getByText("Marine conditions", { exact: true })).toBeVisible();
  } else {
    await enableExploreLayer(page, /Sea conditions/);
  }
  await expect(page.locator(".buoy")).toHaveCount(2);
  await expect(page.getByRole("button", { name: /Test weather buoy, weather buoy/ })).toBeVisible();
  await page.getByRole("button", { name: /Test coastal observatory, coastal observatory/ }).click();
  await expect(page.locator(".detail-buoy")).toContainText("coastal marine observatory");
  await expect(page.getByText(/Sea temperature/)).toBeVisible();
});

test("public launch metadata and trust pages are available", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator('link[rel="canonical"]')).toHaveAttribute("href", "https://day.illek.ie");
  await expect(page.locator('meta[property="og:image"]')).toHaveAttribute(
    "content",
    "https://day.illek.ie/social/day-in-ireland.jpg"
  );
  await page.getByRole("link", { name: "Data & methodology" }).last().click();
  await expect(page).toHaveURL(/\/data$/);
  await expect(page.getByRole("heading", { level: 1, name: /What the map knows/ })).toBeVisible();
  await expect(page.getByRole("heading", { level: 2, name: "Sources" })).toBeVisible();
});

test("historical traffic is removed from the live experience", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".traffic-marker")).toHaveCount(0);
  await expect(page.getByText(/historical road|AADT|traffic counter/i)).toHaveCount(0);
});

test("wind context displays measured station speeds and directions", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".wind-marker").first()).toBeVisible();
  await expect(page.locator(".wind-marker text").first()).toContainText("km/h");
  expect(await page.locator(".wind-marker").first().evaluate((element) => getComputedStyle(element).pointerEvents)).toBe("none");
  await page.locator("#live-map").scrollIntoViewIfNeeded();
  const windCentre = await page.locator(".wind-marker[data-wind-for='johnstown-castle']").evaluate((element) => {
    const matrix = (element as SVGGElement).getScreenCTM();
    if (!matrix) return null;
    return new DOMPoint(0, 0).matrixTransform(matrix);
  });
  expect(windCentre).not.toBeNull();
  if (windCentre) await page.mouse.click(windCentre.x, windCentre.y);
  await expect(page.locator(".detail-station")).toBeVisible();
  await expect(page.locator(".detail-station").getByText(/km\/h/)).toBeVisible();
});

test("radar context exposes five-minute imagery and playback controls", async ({ page }) => {
  await page.goto("/");
  if (test.info().project.name === "desktop") {
    await page
      .getByRole("navigation", { name: "Map view shortcuts" })
      .getByRole("button", { name: /Rain radar/ })
      .click();
  } else {
    await enableExploreLayer(page, /Rainfall radar/);
  }
  await expect(page.getByLabel("Rainfall radar timeline")).toBeVisible();
  if (await page.locator(".radar-tiles image").count()) {
    await expect(page.locator(".radar-tiles image")).toHaveCount(4);
    await expect(page.getByLabel("Rainfall radar timeline")).toBeVisible();
    await expect(page.getByLabel("Radar frame")).toBeEnabled();
  } else {
    const unavailable = test.info().project.name === "desktop"
      ? page.locator(".map-notice").getByText(/radar imagery is unavailable/i)
      : page.getByLabel("Rainfall radar timeline").getByText(/Radar tiles unavailable/);
    await expect(unavailable).toBeVisible();
  }
});

test("air and aurora contexts preserve model and forecast caveats", async ({ page }) => {
  await page.goto("/");
  await enableExploreLayer(page, /Air & exposure/);
  if (await page.locator(".air-marker.modelled").count()) {
    await page.locator(".air-marker.modelled").first().click();
    await expect(page.locator(".detail-air")).toContainText(/model output, not a reading from a sensor/i);
    await page.getByRole("button", { name: "Close map details" }).click({ force: true });
  }
  if (await page.locator(".air-marker.measured").count()) {
    await page.locator(".air-marker.measured").first().click();
    await expect(page.locator(".detail-air")).toContainText(/reported monitoring-station reading/i);
  }

  await enableExploreLayer(page, /Aurora probability/);
  await expect(page.locator(".aurora-panel:visible")).toBeVisible();
  await expect(page.locator(".aurora-panel:visible")).toContainText(/not a guarantee/i);
});

test("new public contexts are discoverable and honestly describe unavailable data", async ({ page }) => {
  await page.goto("/");
  await enableExploreLayer(page, /Tides & surge/);
  if (await page.locator(".tide-marker").count()) {
    await expect(page.locator(".tide-marker").first()).toBeVisible();
  } else {
    await page.getByRole("button", { name: "Explore", exact: true }).click();
    await expect(page.getByRole("button", { name: /Tides & surge/ })).toHaveAttribute("aria-pressed", "true");
    await page.getByRole("button", { name: "Close explore panel" }).click();
  }

  await enableExploreLayer(page, /Bathing alerts/);
  if (await page.locator(".bathing-marker").count()) await expect(page.locator(".bathing-marker").first()).toBeVisible();

  await enableExploreLayer(page, /ISS passes/);
  await expect(page.locator(".iss-panel:visible")).toBeVisible();
  await expect(page.locator(".iss-panel:visible")).toContainText(/temporarily unavailable|next pass/i);

  await enableExploreLayer(page, /Satellite image/);
  if (await page.locator(".satellite-tiles").count()) await expect(page.locator(".satellite-tiles")).toBeVisible();

  await enableExploreLayer(page, /Earthquakes/);

  await page.getByRole("button", { name: "Explore", exact: true }).click();
  const movementGroup = page.locator('.explore-panel details[data-layer-group="movement"]');
  if (!(await movementGroup.evaluate((element: HTMLDetailsElement) => element.open))) {
    await movementGroup.locator("summary").click();
  }
  await expect(movementGroup.getByRole("button", { name: /Public transport/ })).toBeVisible();
});

test("what-matters board only presents selected-layer signals when they exist", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "What matters now." })).toBeVisible();
  await expect(page.getByText("Bathing water", { exact: true })).toHaveCount(0);
  await page.getByRole("navigation", { name: "Map view shortcuts" }).getByRole("button", { name: /Water/ }).click();
  const signals = page.locator(".notable-signals .signal-item");
  const visibleSignalCount = await page.locator(".notable-signals .signal-item:visible").count();
  const visiblePulseCount = await page.locator(".what-matters-grid .pulse-card:visible").count();
  await expect(page.locator(".what-matters-grid .pulse-card")).toHaveCount(3);
  expect(visibleSignalCount).toBeLessThanOrEqual(1);
  expect(visibleSignalCount + visiblePulseCount).toBeLessThanOrEqual(4);
  if (!(await signals.count())) await expect(page.locator(".notable-signals")).toHaveCount(0);
});

test("multiple true signals expose one concise exception and a legible disclosure", async ({ page }) => {
  await installMapMarkerFixtures(page, { multipleSignals: true });
  await page.goto("/?view=custom&layers=rain,trains,grid,tides,bathing");

  const signals = page.locator(".notable-signals .signal-item");
  await expect(signals).toHaveCount(3);
  await expect(page.locator(".notable-signals .signal-item:visible")).toHaveCount(1);
  await expect(page.locator(".what-matters-grid .pulse-card:visible")).toHaveCount(3);
  const control = await expectNotableMoreTarget(page);
  await control.click();
  await expect(page.getByRole("button", { name: "Show fewer", exact: true })).toBeVisible();
  await expect(page.locator(".notable-signals .signal-item:visible")).toHaveCount(3);
});

test("multiple-signal disclosure remains visible and usable at 320px and 200 percent text", async ({ page }, testInfo) => {
  if (testInfo.project.name !== "desktop") testInfo.skip();
  await installMapMarkerFixtures(page, { multipleSignals: true });
  await page.setViewportSize({ width: 320, height: 800 });
  await page.goto("/?view=custom&layers=rain,trains,grid,tides,bathing");
  await page.evaluate(() => { document.documentElement.style.fontSize = "200%"; });

  await expect(page.locator(".notable-signals .signal-item")).toHaveCount(3);
  await expect(page.locator(".notable-signals .signal-item:visible")).toHaveCount(1);
  const control = await expectNotableMoreTarget(page);
  await control.click();
  await expect(page.getByRole("button", { name: "Show fewer", exact: true })).toBeVisible();
  await expect(page.locator(".notable-signals .signal-item:visible")).toHaveCount(3);
});

test("my place and shared view state survive a deep link", async ({ page }) => {
  await page.goto("/?place=cork&view=movement");
  await expect(page.locator("#place-select")).toHaveValue("cork");
  await expect(page.getByRole("heading", { name: "Cork", exact: true })).toBeVisible();
  await expect(
    page.getByRole("navigation", { name: "Map view shortcuts" }).getByRole("button", { name: /Movement/ })
  ).toHaveClass(/active/);

  await page.locator("#place-select").selectOption("dublin");
  await expect(page).toHaveURL(/place=dublin/);
  await expect(page.getByRole("heading", { name: "Dublin", exact: true })).toBeVisible();
});

test("all layers includes satellite and public transport", async ({ page }) => {
  await page.goto("/");
  await page
    .getByRole("navigation", { name: "Map view shortcuts" })
    .getByRole("button", { name: /All layers/ })
    .click();
  await page.getByRole("button", { name: "Explore", exact: true }).click();
  await expect(page.getByRole("button", { name: /Satellite image/, includeHidden: true })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("button", { name: /Public transport/, includeHidden: true })).toHaveAttribute("aria-pressed", "true");
});

test("all-layer context panels disclose outside the map canvas without overlap", async ({ page }) => {
  await page.goto("/?view=all");

  const canvas = page.locator(".map-canvas");
  const disclosure = page.locator(".map-context-disclosure");
  await expect(disclosure).not.toHaveAttribute("open", "");
  expect(await canvas.locator(".map-context-disclosure").count()).toBe(0);
  await disclosure.locator("summary").click();
  await expect(disclosure).toHaveAttribute("open", "");
  const panels = disclosure.locator(".map-context-grid .map-data-panel");
  await expect(panels).toHaveCount(3);
  const geometry = await page.evaluate(() => {
    const canvasBounds = document.querySelector(".map-canvas")!.getBoundingClientRect();
    const disclosureBounds = document.querySelector(".map-context-disclosure")!.getBoundingClientRect();
    const panels = [...document.querySelectorAll(".map-context-grid .map-data-panel")].map((element) => {
      const bounds = element.getBoundingClientRect();
      return { top: bounds.top, bottom: bounds.bottom, left: bounds.left, right: bounds.right };
    });
    return { canvasBottom: canvasBounds.bottom, disclosureTop: disclosureBounds.top, panels };
  });
  expect(geometry.disclosureTop).toBeGreaterThanOrEqual(geometry.canvasBottom - 1);
  for (let first = 0; first < geometry.panels.length; first += 1) {
    for (let second = first + 1; second < geometry.panels.length; second += 1) {
      const a = geometry.panels[first]!;
      const b = geometry.panels[second]!;
      const overlapX = Math.min(a.right, b.right) - Math.max(a.left, b.left);
      const overlapY = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
      expect(overlapX > 1 && overlapY > 1).toBe(false);
    }
  }
});

test("deep links still hydrate when local storage is blocked", async ({ page }) => {
  await page.addInitScript(() => {
    Storage.prototype.getItem = () => { throw new DOMException("Blocked", "SecurityError"); };
    Storage.prototype.setItem = () => { throw new DOMException("Blocked", "SecurityError"); };
  });
  await page.goto("/?place=cork&view=movement");
  await expect(page.locator("#place-select")).toHaveValue("cork");
  await expect(page.getByRole("heading", { name: "Cork", exact: true })).toBeVisible();
  await expect(
    page.getByRole("navigation", { name: "Map view shortcuts" }).getByRole("button", { name: /Movement/ })
  ).toHaveClass(/active/);
});

test("map details behave as an accessible dialog", async ({ page }) => {
  await page.goto("/");
  const opener = page.locator(".station-marker").first();
  await opener.click();
  await expect(page.locator('[role="dialog"].detail-station')).toBeVisible();
  await expect(page.getByRole("button", { name: "Close map details" })).toBeFocused();
  await expect(page.locator(".experience")).toHaveAttribute("inert", "");
  await page.locator(".detail-modal-layer").click({ position: { x: 8, y: 8 } });
  await expect(page.locator('.station-card[role="dialog"]')).toHaveCount(0);
  await expect(page.locator(".experience")).not.toHaveAttribute("inert", "");
  await expect(opener).toBeFocused();

  await opener.press("Enter");
  await expect(page.locator('[role="dialog"].detail-station')).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator('.station-card[role="dialog"]')).toHaveCount(0);
  await expect(page.locator(".experience")).not.toHaveAttribute("inert", "");
  await expect(opener).toBeFocused();
});

test("tide details explain negative datum heights and order upcoming events by time", async ({ page }) => {
  await installMapMarkerFixtures(page);
  await page.goto("/?view=all");
  await page.locator(".tide-marker").click();

  const detail = page.locator('[role="dialog"].detail-tide');
  await expect(detail).toBeVisible();
  await expect(detail).toContainText("Ordnance Datum Malin is Ireland's national height reference");
  await expect(detail).toContainText("not that the water has negative depth");
  await expect(detail.locator("dt")).toHaveText(["Observed", "Movement", "Next low", "Next high"]);
});

test("current activity guidance and hourly timeline are actionable", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("details.activity-context")).not.toHaveAttribute("open", "");
  await openActivityContext(page);
  await expect(page.getByRole("heading", { name: "What the live data supports." })).toBeVisible();
  await expect(page.locator(".guidance-card")).toHaveCount(4);
  await expect(page.locator(".guidance-card").first()).not.toContainText(/\/100|No score/);
  await page.locator(".guidance-card").first().click();
  await expect(page.locator(".map-notice")).toBeVisible();

  const timelinePoint = page.locator(".timeline-point").first();
  if (await timelinePoint.count()) {
    await timelinePoint.click();
    await expect(page.locator(".timeline-selection")).toBeVisible();
    await expect(timelinePoint).toHaveAttribute("aria-pressed", "true");
  }
});

test("activity actions preserve My Place in view state, storage, and share payload", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(window.navigator, "share", {
      configurable: true,
      value: async (payload: { text: string; url: string }) => {
        (window as unknown as { __sharePayload?: { text: string; url: string } }).__sharePayload = payload;
      }
    });
  });
  await page.goto("/?place=cork");
  await openActivityContext(page);
  const card = page.locator('[data-activity-id="outdoor-walk"]');
  await expect(card).toBeVisible();
  await card.click();
  await expect(page).toHaveURL(/place=cork/);
  await expect.poll(() => page.evaluate(() => localStorage.getItem("a-day-in-ireland.place"))).toBe("cork");

  const navigation = page.getByRole("navigation", { name: "Map navigation" });
  await navigation.getByRole("button", { name: "Zoom in" }).click();
  const map = page.getByLabel("Live map of Ireland");
  await map.scrollIntoViewIfNeeded();
  const mapBox = await map.boundingBox();
  expect(mapBox).not.toBeNull();
  await page.mouse.move((mapBox?.x ?? 0) + 220, (mapBox?.y ?? 0) + 240);
  await page.mouse.down();
  await page.mouse.move((mapBox?.x ?? 0) + 150, (mapBox?.y ?? 0) + 180, { steps: 4 });
  await page.mouse.up();
  await expect(page.locator(".map-viewport")).not.toHaveAttribute("transform", "translate(0 0) scale(1.4)");

  await page.getByRole("button", { name: "Share this view for Cork" }).click();
  await expect.poll(() => page.evaluate(() => (window as unknown as {
    __sharePayload?: { text: string; url: string }
  }).__sharePayload ?? null)).not.toBeNull();
  const payload = await page.evaluate(() => (window as unknown as {
    __sharePayload: { text: string; url: string }
  }).__sharePayload);
  expect(payload.url).toMatch(/[?&]place=cork(?:&|$)/);
  expect(payload.url).toMatch(/[?&]zoom=1\.40(?:&|$)/);
  expect(payload.url).toMatch(/[?&]x=-/);
  expect(payload.url).toMatch(/[?&]y=-/);
  expect(payload.text).toContain("Cork");

  const search = new URL(payload.url).search;
  await page.goto(`/${search}`);
  await expect(page.locator(".map-viewport")).toHaveAttribute("data-scale", "1.40");
  await expect(page.locator(".map-viewport")).toHaveAttribute("transform", /translate\(-\d/);
});

test("reduced motion disables radar replay but keeps manual frame selection", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");
  await enableExploreLayer(page, /Rainfall radar/);
  const control = page.getByLabel("Rainfall radar timeline");
  await expect(control).toBeVisible();
  const replay = control.getByRole("button");
  await expect(replay).toBeDisabled();
  await expect(replay).toHaveAccessibleName(/reduced motion/i);
  const frame = control.getByLabel("Radar frame");
  if (await frame.isEnabled()) {
    await expect(frame).toHaveAttribute("aria-valuetext", /Radar (imagery|tiles|frame)/);
  }
});

test("unavailable providers and old observations never appear live or as zero activity", async ({ page }) => {
  const unavailableProvenance = (provider: string) => ({
    provider,
    endpoint: "https://example.invalid",
    status: "unavailable",
    fetchedAt: new Date().toISOString(),
    latestObservedAt: null,
    fallback: null
  });
  await page.route("https://prodapi.metweb.ie/**", (route) => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify([{
      date: "01-01-2020", reportTime: "00:00", temperature: "12", rainfall: "0",
      windSpeed: "10", cardinalWindDirection: "W", weatherDescription: "Old"
    }])
  }));
  await page.route("https://www.met.ie/latest-reports/observations/download", (route) => route.fulfill({
    contentType: "text/csv",
    body: "Name,Temperature,Description,Wind,Unused,Direction,Unused,Rain,Unused\nCork Airport,12,Old,10,,W,,0,"
  }));
  await page.route("**/api/living", (route) => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({
      trains: [], rivers: [], sourceStatus: { trains: "unavailable", rivers: "unavailable" },
      sourceProvenance: {
        trains: unavailableProvenance("Irish Rail"),
        rivers: unavailableProvenance("OPW waterlevel.ie")
      }
    })
  }));
  await page.route("**/api/contexts", (route) => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({
      marine: [], radar: [], grid: null, airQuality: [], aurora: null, tides: [], bathingAlerts: [],
      warnings: [], warningsStatus: "unavailable", issTle: null, satellite: null, earthquakes: [],
      contextStatus: {
        marine: "unavailable", measuredAir: "unavailable", tides: "unavailable", bathing: "unavailable",
        satellite: "unavailable", earthquakes: "unavailable", iss: "unavailable", warnings: "unavailable"
      }
    })
  }));
  await page.route("**/api/transit", (route) => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({
      transitStatus: "live",
      transit: [{
        id: "old-bus", label: "Old bus", route: "1", latitude: 53.3, longitude: -7.2,
        bearing: null, speedKmh: null, speedSource: null,
        observedAt: new Date(Date.now() - 31 * 60_000).toISOString()
      }]
    })
  }));

  await page.goto("/");
  await expect(page.locator(".station-marker")).toHaveCount(0);
  await expect(page.locator(".freshness-chip").filter({ hasText: "Rail provider" })).toContainText("unavailable");
  await expect(page.locator(".rail-metrics p").filter({ hasText: "Trains moving" })).toContainText("Provider unavailable");
  await expect(page.locator(".workspace-facts button").filter({ hasText: "marine observations unavailable" })).toContainText("—");
  await expect(page.locator(".pulse-card.grid strong")).toHaveText("—");
  await expect(page.locator(".pulse-card.trains strong")).toHaveText("—");
  await expect(page.locator(".pulse-card.rivers strong")).toHaveText("—");
  await page.getByRole("navigation", { name: "Map view shortcuts" }).getByRole("button", { name: /Movement/ }).click();
  await expect(page.locator(".movement-stack-marker")).toHaveCount(0);
  await expect(page.locator('[data-activity-id="outdoor-walk"] .guidance-status')).toHaveText("Unavailable");
  await expect(page.locator('[data-activity-id="travel"] .guidance-status')).toHaveText("Unavailable");
});

test("connection state settles truthfully, retries, and retains last-good data only as cached", async ({ page }) => {
  const stationNames = new Map([
    ["malin-head", "Malin Head"], ["finner", "Finner"], ["belmullet", "Belmullet"],
    ["athenry", "Athenry"], ["dublin", "Dublin Airport"], ["gurteen", "Gurteen"],
    ["valentia", "Valentia"], ["cork", "Cork"], ["johnstown-castle", "Johnstown Castle"]
  ]);
  let providersAvailable = false;
  const delayed = () => new Promise((resolve) => setTimeout(resolve, 250));
  const observedAt = () => new Date(Date.now() - 60_000).toISOString();

  await page.route("https://prodapi.metweb.ie/observations/*/today", async (route) => {
    await delayed();
    const endpoint = new URL(route.request().url()).pathname.split("/")[2];
    const observation = providersAvailable ? metObservationTime(1) : { date: "01-01-2020", reportTime: "00:00" };
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify([{
        name: stationNames.get(endpoint) ?? "Unknown station",
        ...observation,
        temperature: "14", rainfall: "0", windSpeed: "8", cardinalWindDirection: "W",
        weatherDescription: providersAvailable ? "Current fixture" : "Expired fixture"
      }])
    });
  });
  await page.route("https://www.met.ie/latest-reports/observations/download", async (route) => {
    await delayed();
    await route.fulfill({
      contentType: "text/csv",
      body: "Name,Temperature,Description,Wind,Unused,Direction,Unused,Rain,Unused\n"
    });
  });
  await page.route("**/api/living", async (route) => {
    await delayed();
    const current = observedAt();
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(providersAvailable ? {
        generatedAt: new Date().toISOString(),
        trains: [{
          id: "retry-train", latitude: 53.3, longitude: -7.2, status: "running",
          direction: "South", message: "Retry fixture", observedAt: current,
          speedKmh: null, speedSource: null
        }],
        rivers: [{ id: "retry-river", name: "Retry gauge", latitude: 53.2, longitude: -7.4, level: 1.2, observedAt: current }],
        sourceStatus: { trains: "live", rivers: "live" }
      } : {
        trains: [], rivers: [], sourceStatus: { trains: "unavailable", rivers: "unavailable" }
      })
    });
  });
  await page.route("**/api/contexts", async (route) => {
    await delayed();
    const unavailable = {
      marine: "unavailable", radar: "unavailable", grid: "unavailable", measuredAir: "unavailable",
      modelledAir: "unavailable", aurora: "unavailable", tides: "unavailable", bathing: "unavailable",
      satellite: "unavailable", earthquakes: "unavailable", iss: "unavailable",
      warnings: providersAvailable ? "live" : "unavailable"
    };
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        generatedAt: new Date().toISOString(),
        marine: [], radar: [], grid: null, airQuality: [], aurora: null, tides: [], bathingAlerts: [],
        warnings: [], warningsStatus: providersAvailable ? "live" : "unavailable",
        issTle: null, satellite: null, earthquakes: [], contextStatus: unavailable
      })
    });
  });
  await page.route("**/api/transit", async (route) => {
    await delayed();
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ transit: [], transitStatus: "unavailable" })
    });
  });

  await page.goto("/");
  await expect(page.locator(".live-state")).toHaveAttribute("data-service-state", "connecting");
  await expect(page.locator(".guidance-card .guidance-status")).toHaveText(["Connecting", "Connecting", "Connecting", "Connecting"]);
  await expect(page.locator(".pulse-card.trains strong")).toHaveText("…");
  await expect(page.locator(".official-notices-empty")).toContainText("Connecting");

  await expect(page.locator(".live-state")).toHaveAttribute("data-service-state", "unavailable");
  await expect(page.locator(".pulse-card.trains strong")).toHaveText("—");
  await expect(page.locator(".pulse-card.rivers strong")).toHaveText("—");
  await expect(page.locator(".pulse-card.trains")).toContainText("cannot be assessed");
  await expect(page.locator(".signal-assessment")).toContainText("Unable to assess every selected signal source");
  await expect(page.locator(".official-notices-empty")).toContainText("cannot be confirmed");
  await expect(page.locator(".retry-live-data")).toBeEnabled();

  providersAvailable = true;
  await page.locator(".retry-live-data").click();
  await expect(page.locator(".live-state")).toHaveAttribute("data-service-state", "refreshing");
  await expect(page.locator(".freshness-chip").filter({ hasText: "Weather provider" })).toContainText("Provider: live");
  await expect(page.locator(".pulse-card.trains strong")).toHaveText("1");
  await expect(page.locator(".pulse-card.rivers strong")).toHaveText("1");
  await expect(page.locator(".live-state")).not.toHaveAttribute("data-service-state", "unavailable");
  const successfulRefreshTime = await page.locator(".live-state time").textContent();
  expect(successfulRefreshTime).not.toBe("—");

  await page.context().setOffline(true);
  await expect(page.locator(".live-state")).toHaveAttribute("data-service-state", "offline");
  await expect(page.locator(".guidance-card .guidance-status")).toHaveText(["Offline", "Offline", "Offline", "Offline"]);
  await expect(page.locator(".freshness-chip").filter({ hasText: "Weather provider" })).toContainText("Provider: cached (offline)");
  await expect(page.locator(".official-notices-empty")).toContainText("Offline");
  await expect(page.locator(".signal-assessment")).toContainText("offline connection");
  await expect(page.locator(".station-marker")).toHaveCount(0);
  await page.context().setOffline(false);
  await expect(page.locator(".live-state")).not.toHaveAttribute("data-service-state", "offline");

  providersAvailable = false;
  await page.locator(".retry-live-data").click();
  await expect(page.locator(".live-state")).toHaveAttribute("data-service-state", "cached");
  await expect(page.locator(".freshness-chip").filter({ hasText: "Weather provider" })).toContainText("Provider: cached");
  await expect(page.locator(".freshness-chip").filter({ hasText: "Rail provider" })).toContainText("Provider: cached");
  await expect(page.locator(".pulse-card.trains strong")).toHaveText("1");
  await expect(page.locator(".pulse-card.trains")).toContainText("cached snapshot");
  await expect(page.locator(".pulse-card.rivers")).toContainText("cached snapshot");
  await expect(page.locator(".station-marker")).toHaveCount(0);
  await expect(page.locator(".live-state time")).toHaveText(successfulRefreshTime ?? "");
});

test("all failed radar tiles are unavailable rather than observed precipitation", async ({ page }, testInfo) => {
  await installRadarTileAvailabilityFixture(page, "unavailable");
  await page.goto(testInfo.project.name === "mobile" ? "/?view=custom&layers=radar" : "/");
  if (testInfo.project.name === "desktop") {
    await page.locator(".workspace-facts button").filter({ hasText: "rain observations unavailable" }).click();
  }

  const control = page.getByLabel("Rainfall radar timeline");
  await expect(control).toHaveAttribute("data-radar-availability", "unavailable");
  await expect(control).toHaveAttribute("data-radar-ready-tiles", "0");
  await expect(control).toHaveAttribute("data-radar-unavailable-tiles", "4");
  await expect(page.locator('.radar-tile[data-radar-tile-state="unavailable"]')).toHaveCount(4);
  await expect(control).toContainText("Radar tiles unavailable · current precipitation cannot be assessed");
  await expect(control).not.toContainText("Observed precipitation");
  if (testInfo.project.name === "desktop") {
    await expect(page.locator('.map-notice[data-radar-availability="unavailable"]')).toContainText("none of the 4 Ireland tiles loaded");
    await expect(page.locator(".map-notice")).not.toContainText(/1 Met Éireann frame/);
  }
  await expect(page.locator(".signal-assessment")).toContainText("rain radar");
  await expect(page.locator(".notable-signals")).toHaveCount(0);
});

test("partial radar tiles are labelled incomplete and never aggregate to live", async ({ page }, testInfo) => {
  await installRadarTileAvailabilityFixture(page, "partial");
  await page.goto(testInfo.project.name === "mobile" ? "/?view=custom&layers=radar" : "/");
  if (testInfo.project.name === "desktop") {
    await page.locator(".workspace-facts button").filter({ hasText: "rain observations unavailable" }).click();
  }

  const control = page.getByLabel("Rainfall radar timeline");
  await expect(control).toHaveAttribute("data-radar-availability", "partial");
  await expect(control).toHaveAttribute("data-radar-ready-tiles", "2");
  await expect(control).toHaveAttribute("data-radar-unavailable-tiles", "2");
  await expect(page.locator('.radar-tile[data-radar-tile-state="ready"]')).toHaveCount(2);
  await expect(page.locator('.radar-tile[data-radar-tile-state="unavailable"]')).toHaveCount(2);
  await expect(control).toContainText("Partial radar coverage · 2 of 4 Ireland tiles loaded");
  await expect(control).not.toContainText("Observed precipitation");
  if (testInfo.project.name === "desktop") {
    await expect(page.locator('.map-notice[data-radar-availability="partial"]')).toContainText("Displayed imagery is incomplete");
  }
  await expect(page.locator(".signal-assessment")).toContainText("rain radar");
  await expect(page.locator(".notable-signals")).toHaveCount(0);
});

test("browser radar rendering masks the neutral no-data wedge and preserves precipitation colour", async ({ page }, testInfo) => {
  await installRadarTileAvailabilityFixture(page, "valid");

  await page.goto(testInfo.project.name === "mobile" ? "/?view=custom&layers=radar" : "/");
  if (testInfo.project.name === "desktop") {
    await page.locator(".workspace-facts button").filter({ hasText: "rain observations unavailable" }).click();
  }
  const control = page.getByLabel("Rainfall radar timeline");
  await expect(control).toHaveAttribute("data-radar-availability", "live");
  await expect(control).toHaveAttribute("data-radar-ready-tiles", "4");
  await expect(control).toHaveAttribute("data-radar-unavailable-tiles", "0");
  await expect(control).toContainText("Observed precipitation · all Ireland tiles loaded");
  if (testInfo.project.name === "desktop") {
    await expect(page.locator('.map-notice[data-radar-availability="live"]')).toContainText("all 4 Ireland tiles loaded");
  }
  await expect(page.locator('.radar-tile[data-radar-tile-state="ready"]')).toHaveCount(4);
  await expect(page.locator(".notable-signals")).toHaveCount(0);
  await expect(page.locator(".signal-assessment")).toHaveCount(0);
  const pixels = await page.locator('.radar-tile[data-radar-tile-state="ready"]').first().evaluate(async (tile) => {
    const href = (tile as SVGImageElement).href.baseVal;
    const image = new Image();
    image.src = href;
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    const context = canvas.getContext("2d");
    context?.drawImage(image, 0, 0);
    return [...(context?.getImageData(0, 0, 2, 1).data ?? [])];
  });
  expect(pixels[3]).toBe(0);
  expect(pixels.slice(4)).toEqual([0, 128, 194, 255]);
});

test("mobile view keeps the layer rail clear of the what-matters board", async ({ page }, testInfo) => {
  if (testInfo.project.name !== "mobile") testInfo.skip();
  await page.goto("/?place=cork&view=all");
  const rail = await page.locator(".section-rail").boundingBox();
  const notable = await page.locator(".what-matters-now").boundingBox();
  expect(rail).not.toBeNull();
  expect(notable).not.toBeNull();
  expect((rail?.y ?? 0) + (rail?.height ?? 0)).toBeLessThanOrEqual(notable?.y ?? 0);

  const viewport = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    documentWidth: document.documentElement.scrollWidth,
    bodyWidth: document.body.scrollWidth
  }));
  expect(viewport.documentWidth).toBeLessThanOrEqual(viewport.clientWidth + 1);
  expect(viewport.bodyWidth).toBeLessThanOrEqual(viewport.clientWidth + 1);

  const place = await page.locator(".place-context").boundingBox();
  expect(place).not.toBeNull();
  expect((place?.x ?? 0) + (place?.width ?? 0)).toBeLessThanOrEqual(viewport.clientWidth + 1);

  const dataDetails = await page.locator("details.freshness-details > summary").boundingBox();
  expect(dataDetails).not.toBeNull();
  expect(dataDetails?.x ?? -1).toBeGreaterThanOrEqual(0);
  expect((dataDetails?.x ?? 0) + (dataDetails?.width ?? 0)).toBeLessThanOrEqual(viewport.clientWidth + 1);

  await openActivityContext(page);
  await page.locator(".guidance-card").first().click();
  await page.waitForFunction(() => {
    const rail = document.querySelector(".section-rail")?.getBoundingClientRect();
    const map = document.querySelector("#live-map")?.getBoundingClientRect();
    return Boolean(rail && map && map.top >= rail.bottom - 1);
  });

  await page.getByRole("button", { name: "Explore", exact: true }).click();
  await page.waitForFunction(() => {
    const panel = document.querySelector(".explore-panel.is-open");
    if (!panel) return false;
    return Math.abs(panel.getBoundingClientRect().right - window.innerWidth) <= 1;
  });
  const panel = await page.locator(".explore-panel.is-open").boundingBox();
  expect(panel).not.toBeNull();
  expect((panel?.x ?? 0) + (panel?.width ?? 0)).toBeLessThanOrEqual(viewport.clientWidth + 1);
  await expect(page.locator(".layer-group").first()).toBeVisible();
});

test("visible presets expose pressed state, clean names, and an explicit custom view", async ({ page }) => {
  await installAccessibilityContentFixtures(page);
  await page.goto("/");

  const presets = page.getByRole("navigation", { name: "Map view shortcuts" });
  const weather = presets.getByRole("button", { name: "Weather", exact: true });
  const movement = presets.getByRole("button", { name: "Movement", exact: true });
  const water = presets.getByRole("button", { name: "Water", exact: true });
  const all = presets.getByRole("button", { name: "All layers", exact: true });
  await expect(weather).toHaveAttribute("aria-pressed", "true");
  await expect(movement).toHaveAttribute("aria-pressed", "false");
  await expect(water).toHaveAttribute("aria-pressed", "false");
  await expect(all).toHaveAttribute("aria-pressed", "false");
  expect(await presets.locator("button > span").evaluateAll((glyphs) =>
    glyphs.every((glyph) => glyph.getAttribute("aria-hidden") === "true")
  )).toBe(true);

  await movement.click();
  await expect(movement).toHaveAttribute("aria-pressed", "true");
  await expect(weather).toHaveAttribute("aria-pressed", "false");
  await enableExploreLayer(page, /Air & exposure/);
  await expect(page.locator(".custom-view-state")).toHaveText(/Custom view · \d+ active layers?/);
});

test("mobile warnings prioritise human scope and expiry with an official source", async ({ page }, testInfo) => {
  if (testInfo.project.name !== "mobile") testInfo.skip();
  await installAccessibilityContentFixtures(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");

  const warning = page.locator(".warning-strip.official-notice");
  await expect(warning).toBeVisible();
  await expect(warning).toContainText("Westmeath");
  await expect(warning).not.toContainText("EI29");
  await expect(warning.locator(".warning-key-facts dt")).toHaveText(["Scope", "Expires"]);
  const official = warning.getByRole("link", { name: /Check official Met Éireann notice/ });
  await expect(official).toHaveAttribute("href", "https://www.met.ie/warnings-today.html");
  const sourceDetails = warning.getByText("Source and issue details", { exact: true });
  await expect(sourceDetails).toBeVisible();
  await expect(warning.locator(".warning-actions details > p")).toBeHidden();

  const layout = await warning.evaluate((element) => {
    const badge = element.querySelector(".warning-badge")?.getBoundingClientRect();
    const heading = element.querySelector("h3")?.getBoundingClientRect();
    const link = element.querySelector("a")?.getBoundingClientRect();
    return { badgeBottom: badge?.bottom ?? 0, headingTop: heading?.top ?? 0, linkHeight: link?.height ?? 0 };
  });
  expect(layout.badgeBottom).toBeLessThanOrEqual(layout.headingTop);
  expect(layout.linkHeight).toBeGreaterThanOrEqual(44);
});

test("shape of the day has labelled dual scales, independent rain bars, and a data list", async ({ page }) => {
  await installAccessibilityContentFixtures(page);
  await page.goto("/");
  await expect.poll(() => page.locator(".timeline-point").count()).toBeGreaterThan(0);

  await expect(page.locator(".temperature-axis")).toContainText(/Temperature/);
  await expect(page.locator(".rain-axis")).toContainText(/rain/i);
  await expect(page.locator(".timeline-x-axis")).toContainText(/Hour of day · Irish time/);
  const firstPoint = page.locator(".timeline-point").first();
  await expect(firstPoint).toHaveAccessibleName(/average temperature.*degrees Celsius.*average observed rainfall.*millimetres per reporting station.*average wind.*kilometres per hour/);
  const barHeights = await firstPoint.locator(".bar").evaluateAll((bars) => bars.map((bar) => getComputedStyle(bar).height));
  expect(barHeights).toHaveLength(2);
  expect(new Set(barHeights).size).toBe(2);

  const list = page.locator(".timeline-data-list");
  await list.locator("summary").click();
  await expect(list.getByRole("table", { name: /Hourly averages across reporting Met Éireann stations; rain is the mean/ })).toBeVisible();
  await expect(list.getByRole("columnheader")).toHaveText(["Time", "Average temperature", "Average rain", "Average wind"]);
  await expect(list.locator("tbody tr").first().locator("td").nth(1)).toHaveText("0.4 mm");
});

test("390px primary controls, chart points, and map marker hit regions meet touch floors", async ({ page }, testInfo) => {
  if (testInfo.project.name !== "mobile") testInfo.skip();
  await installAccessibilityContentFixtures(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await expect.poll(() => page.locator(".timeline-point").count()).toBeGreaterThan(0);

  const controls = page.locator([
    ".header-actions button",
    ".section-rail nav button",
    ".place-controls select",
    ".place-controls button",
    ".freshness-strip > button",
    ".map-navigation button",
    ".timeline-point"
  ].join(","));
  const undersized = await controls.evaluateAll((elements) => elements
    .filter((element) => {
      const style = getComputedStyle(element);
      return style.display !== "none" && style.visibility !== "hidden";
    })
    .map((element) => {
      const bounds = element.getBoundingClientRect();
      return { name: element.getAttribute("aria-label") || element.textContent?.trim(), width: bounds.width, height: bounds.height };
    })
    .filter((bounds) => bounds.width < 44 || bounds.height < 44));
  expect(undersized).toEqual([]);

  const hitTarget = await page.locator(".map-marker-hit-target").first().evaluate((element) => ({
    pointerEvents: getComputedStyle(element).pointerEvents,
    strokeWidth: Number.parseFloat(getComputedStyle(element).strokeWidth)
  }));
  expect(hitTarget.pointerEvents).toBe("stroke");
  expect(hitTarget.strokeWidth).toBeGreaterThanOrEqual(44);
  await page.getByLabel("Live map of Ireland").scrollIntoViewIfNeeded();
  const markerCenter = await page.locator(".station-marker .map-marker-hit-target").first().evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    return { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
  });
  await page.mouse.click(markerCenter.x, markerCenter.y);
  await expect(page.locator("[role='dialog'].detail-station")).toBeVisible();
});

test("every interactive marker retains its 44px hit stroke through hover and forced colours", async ({ page }, testInfo) => {
  if (testInfo.project.name !== "desktop") testInfo.skip();
  await installMapMarkerFixtures(page);
  const markerCases = [
    { view: "/?view=custom&layers=weather", selector: ".station-marker", detail: ".detail-station" },
    { view: "/?view=custom&layers=rivers", selector: ".river-marker", detail: ".detail-river" },
    { view: "/?view=custom&layers=sea", selector: ".buoy", detail: ".detail-buoy" },
    { view: "/?view=custom&layers=tides", selector: ".tide-marker", detail: ".detail-tide" },
    { view: "/?view=custom&layers=bathing", selector: ".bathing-marker", detail: ".detail-bathing" },
    { view: "/?view=custom&layers=air", selector: ".air-marker", detail: ".detail-air" },
    { view: "/?view=custom&layers=trains", selector: ".train-marker", detail: ".detail-train" },
    { view: "/?view=custom&layers=transit", selector: ".transit-marker", detail: ".detail-transit" },
    { view: "/?view=custom&layers=trains,transit", selector: ".movement-stack-marker", detail: ".detail-train" },
    { view: "/?view=custom&layers=earthquakes", selector: ".earthquake-marker", detail: ".detail-earthquake" },
    { view: "/?view=custom&layers=wind", selector: ".wind-marker[data-map-marker]", detail: ".detail-station" }
  ];

  const hitStyle = async (selector: string) => page.locator(selector).first().locator(":scope > .map-marker-hit-target").evaluate((target) => {
    const style = getComputedStyle(target);
    return {
      pointerEvents: style.pointerEvents,
      strokeWidth: Number.parseFloat(style.strokeWidth),
      opacity: Number.parseFloat(style.opacity),
      filter: style.filter
    };
  });
  const expectStableStyle = (style: Awaited<ReturnType<typeof hitStyle>>) => {
    expect(style).toEqual({ pointerEvents: "stroke", strokeWidth: 44, opacity: 1, filter: "none" });
  };
  const assertRealHitArea = async (selector: string, expectedDetail: string) => {
    const marker = page.locator(selector).first();
    await expect(marker).toBeVisible();
    expectStableStyle(await hitStyle(selector));
    await marker.hover({ force: true });
    expectStableStyle(await hitStyle(selector));
    const hitTest = await marker.evaluate((group) => {
      const target = group.querySelector(".map-marker-hit-target") as SVGCircleElement | null;
      const matrix = target?.getScreenCTM();
      if (!target || !matrix) return { points: [], click: null };
      const centre = new DOMPoint(0, 0).matrixTransform(matrix);
      const offsets = [[-20, 0], [20, 0], [0, -20], [0, 20]];
      return { points: offsets.map(([x, y]) => ({ x: centre.x + x, y: centre.y + y })) };
    });
    expect(hitTest.points).toHaveLength(4);
    for (const [index, point] of hitTest.points.entries()) {
      await page.mouse.click(point.x, point.y);
      await expect(
        page.locator(`[role='dialog']${expectedDetail}`),
        `${selector} must activate at hit offset ${index} (${point.x}, ${point.y})`
      ).toBeVisible();
      await page.getByRole("button", { name: "Close map details" }).click();
    }
  };

  for (const marker of markerCases) {
    await page.goto(marker.view);
    await page.locator("#live-map").scrollIntoViewIfNeeded();
    await assertRealHitArea(marker.selector, marker.detail);
  }

  await page.emulateMedia({ forcedColors: "active" });
  for (const marker of markerCases) {
    await page.goto(marker.view);
    await page.locator("#live-map").scrollIntoViewIfNeeded();
    expectStableStyle(await hitStyle(marker.selector));
    await page.locator(marker.selector).first().hover({ force: true });
    expectStableStyle(await hitStyle(marker.selector));
  }
});

test("320px at 200 percent text keeps actions, preset overflow, map, and list usable", async ({ page }, testInfo) => {
  if (testInfo.project.name !== "desktop") testInfo.skip();
  await installAccessibilityContentFixtures(page);
  await page.setViewportSize({ width: 320, height: 800 });
  await page.goto("/");
  await page.evaluate(() => { document.documentElement.style.fontSize = "200%"; });

  const actions = page.locator(".header-actions button");
  await expect(actions).toHaveCount(2);
  for (const action of await actions.all()) await expect(action).toBeVisible();
  const actionBounds = await actions.evaluateAll((buttons) => buttons.map((button) => {
    const bounds = button.getBoundingClientRect();
    return { top: bounds.top, width: bounds.width, height: bounds.height };
  }));
  expect(Math.abs(actionBounds[0]!.top - actionBounds[1]!.top)).toBeLessThanOrEqual(1);
  expect(actionBounds.every(({ width, height }) => width >= 44 && height >= 44)).toBe(true);
  await expect(page.locator(".preset-scroll-hint")).toBeVisible();
  const presetStrip = page.getByRole("navigation", { name: "Map view shortcuts" });
  await expect(presetStrip.getByRole("button")).toHaveCount(5);
  const allLayers = presetStrip.getByRole("button", { name: "All layers", exact: true });
  await allLayers.scrollIntoViewIfNeeded();
  await expect(allLayers).toBeVisible();
  const map = page.getByLabel("Live map of Ireland");
  await expect(map).toBeVisible();
  await map.scrollIntoViewIfNeeded();
  const clippedControls = await page.evaluate(() => {
    const stage = document.querySelector("#live-map")?.getBoundingClientRect();
    if (!stage) return [{ name: "map", reason: "missing" }];
    return [...document.querySelectorAll<HTMLElement>(".map-navigation button")].flatMap((control) => {
      const bounds = control.getBoundingClientRect();
      const visibleWidth = Math.max(0, Math.min(bounds.right, stage.right, innerWidth) - Math.max(bounds.left, stage.left, 0));
      const visibleHeight = Math.max(0, Math.min(bounds.bottom, stage.bottom, innerHeight) - Math.max(bounds.top, stage.top, 0));
      return bounds.left < stage.left - 1 || bounds.right > stage.right + 1 || visibleWidth < 44 || visibleHeight < 44
        ? [{
            name: control.getAttribute("aria-label") || control.textContent?.trim(),
            left: bounds.left,
            right: bounds.right,
            stageLeft: stage.left,
            stageRight: stage.right,
            visibleWidth,
            visibleHeight
          }]
        : [];
    });
  });
  expect(clippedControls).toEqual([]);
  await expect(page.locator(".timeline-data-list summary")).toBeVisible();
  await page.locator(".timeline-data-list summary").click();
  await expect(page.getByRole("region", { name: "Hourly weather data table" })).toBeVisible();

  const overflow = await page.evaluate(() => ({
    viewport: document.documentElement.clientWidth,
    document: document.documentElement.scrollWidth,
    body: document.body.scrollWidth,
    headerRight: Math.max(...[...document.querySelectorAll(".header-actions button")].map((element) => element.getBoundingClientRect().right)),
    mapRight: document.querySelector("#live-map")?.getBoundingClientRect().right ?? Infinity
  }));
  expect(overflow.document).toBeLessThanOrEqual(overflow.viewport + 1);
  expect(overflow.body).toBeLessThanOrEqual(overflow.viewport + 1);
  expect(overflow.headerRight).toBeLessThanOrEqual(overflow.viewport + 1);
  expect(overflow.mapRight).toBeLessThanOrEqual(overflow.viewport + 1);
});

test("every visible meaningful term and map label stays above the practical type floor", async ({ page }, testInfo) => {
  if (testInfo.project.name !== "desktop") testInfo.skip();
  await installMapMarkerFixtures(page);
  await page.goto("/?view=all");
  await page.getByRole("button", { name: "Explore", exact: true }).click();

  const result = await page.evaluate(() => {
    const root = document.querySelector(".experience");
    if (!root) return { inspected: 0, undersized: [{ text: "experience missing", size: 0, selector: "body" }] };
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const seen = new Set<Element>();
    const undersized: Array<{ text: string; size: number; selector: string }> = [];
    let inspected = 0;
    while (walker.nextNode()) {
      const text = walker.currentNode.textContent?.replace(/\s+/g, " ").trim() ?? "";
      const element = walker.currentNode.parentElement;
      if (!text || !element || seen.has(element)) continue;
      if (element.closest(".sr-only, [hidden], script, style")) continue;
      const hiddenAncestor = element.closest("[aria-hidden='true']");
      if (hiddenAncestor && element.tagName.toLowerCase() !== "text") continue;
      if (!/[\p{L}\p{N}]/u.test(text)) continue;
      const style = getComputedStyle(element);
      const bounds = element.getBoundingClientRect();
      if (style.display === "none" || style.visibility === "hidden" || Number.parseFloat(style.opacity) === 0 || !bounds.width || !bounds.height) continue;
      seen.add(element);
      inspected += 1;
      const size = Number.parseFloat(style.fontSize);
      if (size < 12) {
        undersized.push({
          text: text.slice(0, 80),
          size,
          selector: `${element.tagName.toLowerCase()}.${String(element.className).replace(/\s+/g, ".")}`
        });
      }
    }
    return { inspected, undersized };
  });
  expect(result.inspected).toBeGreaterThan(100);
  expect(result.undersized).toEqual([]);

  const mapLabelSizes = await page.locator("svg.ireland-map text").evaluateAll((labels) => labels.map((label) => ({
    text: label.textContent?.trim(),
    size: Number.parseFloat(getComputedStyle(label).fontSize)
  })));
  expect(mapLabelSizes.length).toBeGreaterThan(10);
  expect(mapLabelSizes.filter((label) => label.size < 12)).toEqual([]);
});

test("forced colours and reduced motion retain visible focus and non-animated map semantics", async ({ page }, testInfo) => {
  if (testInfo.project.name !== "desktop") testInfo.skip();
  await page.emulateMedia({ forcedColors: "active", reducedMotion: "reduce" });
  await installAccessibilityContentFixtures(page);
  await page.goto("/");

  const weather = page.getByRole("navigation", { name: "Map view shortcuts" }).getByRole("button", { name: "Weather", exact: true });
  await weather.focus();
  expect(await weather.evaluate((element) => Number.parseFloat(getComputedStyle(element).outlineWidth))).toBeGreaterThanOrEqual(3);
  const marker = page.locator(".station-marker").first();
  await marker.focus();
  const ring = marker.locator(".map-marker-focus-ring");
  expect(await ring.evaluate((element) => Number.parseFloat(getComputedStyle(element).opacity))).toBe(1);
  const animationDuration = await page.locator(".live-dot").first().evaluate((element) => getComputedStyle(element).animationDuration);
  expect(animationDuration).toMatch(/^(?:0\.001ms|1e-06s)$/);
});

test("TFI details expose a captured public route and honest live-feed limitations", async ({ page }, testInfo) => {
  if (testInfo.project.name !== "desktop") testInfo.skip();
  await installAccessibilityContentFixtures(page);
  await page.goto("/?view=custom&layers=transit");
  const marker = page.getByRole("button", { name: "Route 73, Heading east, live public transport position" });
  await expect(marker).toBeVisible();
  await marker.click();

  const detail = page.locator(".detail-transit");
  await expect(detail.getByRole("heading", { name: "Route 73" })).toBeVisible();
  await expect(detail).toContainText("Heading east");
  await expect(detail).toContainText("Destination unavailable from this TFI live vehicle feed");
  await expect(detail).not.toContainText("3 73 a");
  await expect(detail).not.toContainText(/\b100\b/);
});

test("success then 503 then offline never claims erased data was retained", async ({ page, context }, testInfo) => {
  if (testInfo.project.name !== "desktop") testInfo.skip();
  await installMapMarkerFixtures(page);
  await page.goto("/");
  const connection = page.locator("#connection-summary");
  const retry = page.locator(".refresh-data-button");
  await expect(connection).toContainText(/Connected|Checking for newer data/);
  await expect(page.locator(".station-marker")).toHaveCount(9);
  await expect(retry).toBeEnabled();
  await expect(page.locator(".live-state[role='status'][aria-live='polite']")).toHaveCount(1);
  await expect(connection).not.toHaveAttribute("role", "status");
  await expect(connection).not.toHaveAttribute("aria-live", "polite");

  await page.unroute("https://prodapi.metweb.ie/observations/*/today");
  await page.unroute("https://www.met.ie/latest-reports/observations/download");
  await page.route("https://prodapi.metweb.ie/observations/*/today", (route) => route.fulfill({ status: 503 }));
  await page.route("https://www.met.ie/latest-reports/observations/download", (route) => route.fulfill({ status: 503 }));
  await retry.click();
  await expect(page.locator(".station-marker")).toHaveCount(0);

  await context.setOffline(true);
  await expect(connection).toContainText("Offline · live refresh unavailable");
  await expect(connection).not.toContainText(/showing|last received|retained/i);
  await expect(retry).toBeDisabled();
  await context.setOffline(false);
  await expect(connection).toContainText(/Connected|Checking for newer data/);
  await expect(retry).toBeEnabled();
});
