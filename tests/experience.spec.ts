import { expect, test, type Page } from "@playwright/test";

async function enableExploreLayer(page: Page, name: RegExp) {
  await page.getByRole("button", { name: "Explore", exact: true }).click();
  const layer = page.locator(".explore-panel").getByRole("button", { name });
  if (await layer.getAttribute("aria-pressed") !== "true") await layer.click();
  await page.getByRole("button", { name: "Close explore panel" }).click();
}

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

test("selected place briefing leads into the across-Ireland evidence surface", async ({ page }) => {
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
    expect(label).toMatch(/No nearby .* observation|(?:Met Éireann|OPW|EEA measured|CAMS modelled).*km away/);
  }
  await expect(page.locator(".freshness-chip").filter({ hasText: "Weather provider" })).toContainText(/Provider: .*Observation:/);
  await expect(page.locator(".workspace-facts")).toHaveAttribute("aria-label", "Current national highlights across Ireland");

  const hierarchy = await page.evaluate(() => {
    const place = document.querySelector(".place-context");
    const notices = document.querySelector(".official-notices");
    const guidance = document.querySelector(".now-guidance");
    const map = document.querySelector("#live-map");
    return Boolean(
      place && notices && guidance && map &&
      (place.compareDocumentPosition(notices) & Node.DOCUMENT_POSITION_FOLLOWING) &&
      (notices.compareDocumentPosition(guidance) & Node.DOCUMENT_POSITION_FOLLOWING) &&
      (guidance.compareDocumentPosition(map) & Node.DOCUMENT_POSITION_FOLLOWING)
    );
  });
  expect(hierarchy).toBe(true);
});

test("official notices are labelled across Ireland and precede the map", async ({ page }) => {
  await page.goto("/?view=weather");
  const notices = page.locator(".official-notices");
  await expect(notices).toHaveAttribute("data-scope", "across-ireland");
  await expect(notices.getByRole("heading", { name: "Official notices across Ireland", exact: true })).toBeVisible();

  const beforeMap = await page.evaluate(() => {
    const notices = document.querySelector(".official-notices");
    const map = document.querySelector("#live-map");
    return Boolean(notices && map && (notices.compareDocumentPosition(map) & Node.DOCUMENT_POSITION_FOLLOWING));
  });
  expect(beforeMap).toBe(true);

  const warning = notices.locator(".warning-strip");
  if (await warning.count()) {
    await expect(warning).toHaveAttribute("aria-label", "Official Met Éireann notice across Ireland");
    await expect(warning.getByText("Official notice", { exact: true })).toBeVisible();
    await expect(warning).toContainText("across Ireland");
  } else {
    await expect(notices).toContainText(/No current Met Éireann notices across Ireland|notice feed is unavailable/);
  }
  await expect(page.locator(".notable-now .signal-item").filter({ hasText: "Met Éireann" })).toHaveCount(0);
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

  const dataDetails = page.getByRole("button", { name: "Data details" });
  await dataDetails.click();
  await expect(close).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(dataDetails).toBeFocused();
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
  await expect(page.getByRole("button", { name: "Route 99, live public transport position" })).toBeVisible();
});

test("page exposes live freshness and source provenance", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByText(/Live observations|Partial observations/)).toHaveCount(1);
  await expect(page.getByText(/Copyright Met Éireann/)).toBeVisible();
  await expect(page.getByText("Ireland, at a glance.")).toBeVisible();
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
    await expect(page.getByText(/The day is just beginning/)).toBeVisible();
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

test("Stitch map workspace uses an island-only coastline and visible roads", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".island-shape path")).toHaveCount(1);
  const roadCount = await page.locator(".road-network path").count();
  expect(roadCount).toBeGreaterThan(50);
  await expect(page.locator(".road-network path.motorway").first()).toBeVisible();
  if (test.info().project.name === "desktop") {
    await expect(page.getByText("Current feeds", { exact: true })).toBeVisible();
    const feedsText = await page.locator(".live-signal-dock").textContent();
    expect(feedsText).toMatch(/weather stations|observations unavailable/i);
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
  await expect(page.getByText("Live rail positions", { exact: true })).toBeVisible();
  if (await page.locator(".train-marker").count()) {
    await expect(page.locator(".train-marker").first()).toBeVisible();
  } else {
    await expect(page.getByText("Live rail positions", { exact: true })).toBeVisible();
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
  await page.locator(".wind-marker").first().click();
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
  await expect(page.getByText("Rainfall radar", { exact: true }).first()).toBeVisible();
  if (await page.locator(".radar-tiles image").count()) {
    await expect(page.locator(".radar-tiles image")).toHaveCount(4);
    await expect(page.getByLabel("Rainfall radar timeline")).toBeVisible();
    await expect(page.getByLabel("Radar frame")).toBeEnabled();
  } else {
    const unavailable = test.info().project.name === "desktop"
      ? page.locator(".map-notice").getByText(/radar imagery is temporarily unavailable/i)
      : page.getByLabel("Rainfall radar timeline").getByText("Radar temporarily unavailable");
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
  await expect(page.getByRole("button", { name: /Public transport/ })).toBeVisible();
});

test("notable-now board is present without fabricating an event", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Signals that matter to this view." })).toBeVisible();
  await expect(page.getByText("Bathing water", { exact: true })).toHaveCount(0);
  await page.getByRole("navigation", { name: "Map view shortcuts" }).getByRole("button", { name: /Water/ }).click();
  const signals = page.locator(".notable-signals .signal-item");
  const quiet = page.getByText(/No unusual signals match the selected layers|Some selected signal sources are temporarily unavailable/);
  await expect(signals.first().or(quiet)).toBeVisible();
  expect(await page.locator(".notable-signals .signal-item:visible").count()).toBeLessThanOrEqual(3);
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
  await expect(page.getByRole("button", { name: /Satellite image/ })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("button", { name: /Public transport/ })).toHaveAttribute("aria-pressed", "true");
});

test("all-layer context panels do not overlap each other or map navigation", async ({ page }, testInfo) => {
  if (testInfo.project.name !== "desktop") testInfo.skip();
  await page.goto("/?view=all");

  const panels = page.locator(".desktop-context-stack .map-data-panel");
  await expect(panels).toHaveCount(3);
  const panelBoxes = await panels.evaluateAll((elements) => elements.map((element) => {
    const bounds = element.getBoundingClientRect();
    return { top: bounds.top, bottom: bounds.bottom, left: bounds.left, right: bounds.right };
  }));
  const navigationBox = await page.locator(".map-navigation").evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    return { top: bounds.top, bottom: bounds.bottom, left: bounds.left, right: bounds.right };
  });

  expect(navigationBox.bottom).toBeLessThanOrEqual(panelBoxes[0].top);
  for (let index = 1; index < panelBoxes.length; index += 1) {
    expect(panelBoxes[index - 1].bottom).toBeLessThanOrEqual(panelBoxes[index].top);
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
  const secondMarker = await page.locator(".station-marker").nth(1).boundingBox();
  await page.locator(".station-marker").first().click();
  await expect(page.locator('[role="dialog"].detail-station')).toBeVisible();
  await expect(page.getByRole("button", { name: "Close map details" })).toBeFocused();
  await expect(page.locator(".experience")).toHaveAttribute("inert", "");
  const detailTitle = page.locator('.station-card[role="dialog"] h2');
  const title = await detailTitle.textContent();
  if (secondMarker) {
    await page.mouse.click(secondMarker.x + secondMarker.width / 2, secondMarker.y + secondMarker.height / 2);
    await expect(detailTitle).toHaveText(title ?? "");
  }
  await page.keyboard.press("Escape");
  await expect(page.locator('.station-card[role="dialog"]')).toHaveCount(0);
  await expect(page.locator(".experience")).not.toHaveAttribute("inert", "");
});

test("current activity guidance and hourly timeline are actionable", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "What the island supports today." })).toBeVisible();
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
    await expect(frame).toHaveAttribute("aria-valuetext", /Radar frame observed|Radar frame unavailable/);
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
  await expect(page.locator(".workspace-facts button").filter({ hasText: "marine sites reporting" })).toContainText("—");
  await page.getByRole("navigation", { name: "Map view shortcuts" }).getByRole("button", { name: /Movement/ }).click();
  await expect(page.locator(".movement-stack-marker")).toHaveCount(0);
  await expect(page.locator('[data-activity-id="outdoor-walk"] .guidance-status')).toHaveText("Unavailable");
  await expect(page.locator('[data-activity-id="travel"] .guidance-status')).toHaveText("Unavailable");
});

test("mobile view keeps the layer rail clear of the signals board", async ({ page }, testInfo) => {
  if (testInfo.project.name !== "mobile") testInfo.skip();
  await page.goto("/?place=cork&view=all");
  const rail = await page.locator(".section-rail").boundingBox();
  const notable = await page.locator(".notable-now").boundingBox();
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

  const dataDetails = await page.getByRole("button", { name: "Data details" }).boundingBox();
  expect(dataDetails).not.toBeNull();
  expect(dataDetails?.x ?? -1).toBeGreaterThanOrEqual(0);
  expect((dataDetails?.x ?? 0) + (dataDetails?.width ?? 0)).toBeLessThanOrEqual(viewport.clientWidth + 1);

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
