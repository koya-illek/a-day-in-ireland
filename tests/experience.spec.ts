import { expect, test, type Page } from "@playwright/test";

async function enableExploreLayer(page: Page, name: RegExp) {
  await page.getByRole("button", { name: "Explore", exact: true }).click();
  const layer = page.getByRole("button", { name });
  if (await layer.getAttribute("aria-pressed") !== "true") await layer.click();
  await page.getByRole("button", { name: "Close explore panel" }).click();
}

test("renders the living map and live observations", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await expect(page.getByLabel("Live map of Ireland")).toBeVisible();
  await expect(page.getByText("Today so far")).toBeVisible();
  await expect(page.locator(".station-marker").first()).toBeVisible();
  await expect(
    page.getByRole("navigation", { name: "Map view shortcuts" }).getByRole("button", { name: /Transport/ })
  ).toBeVisible();
  await expect(page.locator("body")).not.toHaveCSS("overflow-x", "scroll");
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

test("page exposes live freshness and source provenance", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByText(/Live observations|Partial observations/)).toHaveCount(1);
  await expect(page.getByText(/Copyright Met Éireann/)).toBeVisible();
  await expect(page.getByText("Ireland, at a glance.")).toBeVisible();
  const timelinePoints = await page.locator(".timeline-point").count();
  if (timelinePoints === 0) {
    await expect(page.getByText(/The day is just beginning/)).toBeVisible();
  } else {
    expect(timelinePoints).toBeGreaterThanOrEqual(1);
  }
});

test("rail and water presets expose the live transport and gauge layers", async ({ page }) => {
  await page.goto("/");
  await page
    .getByRole("navigation", { name: "Map view shortcuts" })
    .getByRole("button", { name: /Transport/ })
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
    .getByRole("button", { name: /Transport/ })
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
  expect(await page.locator(".road-network path").count()).toBeGreaterThan(50);
  await expect(page.locator(".road-network path.motorway").first()).toBeVisible();
  if (test.info().project.name === "desktop") {
    await expect(page.getByText("Live now", { exact: true })).toBeVisible();
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
    await map.hover();
    await page.mouse.wheel(0, -300);
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
    await expect(page.getByText(/not reporting any train positions/i)).toBeVisible();
  }
  await expect(page.getByLabel("All-island electricity grid now")).toHaveCount(0);
});

test("sea context exposes clickable buoy details", async ({ page }) => {
  await page.goto("/");
  if (test.info().project.name === "desktop") {
    await page.getByRole("button", { name: /buoys reporting at sea/ }).click();
    await expect(page.getByText("Offshore conditions", { exact: true })).toBeVisible();
  } else {
    await page
      .getByRole("navigation", { name: "Map view shortcuts" })
      .getByRole("button", { name: /Water/ })
      .click();
  }
  if (await page.locator(".buoy").count()) {
    await page.locator(".buoy").first().click();
    await expect(page.locator(".detail-buoy")).toBeVisible();
    await expect(page.getByText(/Sea temperature/)).toBeVisible();
  } else {
    await expect(page.getByText(/No Marine Institute buoy observations/)).toBeVisible();
  }
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
    await page.getByRole("button", { name: "Explore", exact: true }).click();
    await page.getByRole("button", { name: /Rainfall radar/ }).click();
    await page.getByRole("button", { name: "Close explore panel" }).click();
  }
  await expect(page.getByText("Rainfall radar", { exact: true }).first()).toBeVisible();
  if (await page.locator(".radar-tiles image").count()) {
    await expect(page.locator(".radar-tiles image").first()).toBeVisible();
    await expect(page.getByLabel("Rainfall radar timeline")).toBeVisible();
    await expect(page.getByLabel("Radar frame")).toBeEnabled();
  } else {
    await expect(page.getByText(/radar imagery is temporarily unavailable/i)).toBeVisible();
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
  if (await signals.count()) {
    await expect(signals.first()).toBeVisible();
    expect(await page.locator(".notable-signals .signal-item:visible").count()).toBeLessThanOrEqual(3);
  } else {
    await expect(quiet).toBeVisible();
  }
});
