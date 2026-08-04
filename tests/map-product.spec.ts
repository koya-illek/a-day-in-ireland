import { expect, test, type Page } from "@playwright/test";

const emptyContextStatus = {
  marine: "unavailable",
  measuredAir: "unavailable",
  tides: "unavailable",
  bathing: "unavailable",
  satellite: "unavailable",
  earthquakes: "unavailable",
  iss: "unavailable",
  warnings: "live"
} as const;

async function installMovementCluster(page: Page, count = 48) {
  const observedAt = new Date().toISOString();
  const trainCount = 3;
  await page.route("**/api/living", (route) => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({
      trains: Array.from({ length: trainCount }, (_, index) => ({
        id: `cluster-train-${index}`,
        latitude: 53.35,
        longitude: -8.05,
        status: "running",
        direction: `Rail destination ${index}`,
        message: `Rail service ${index}`,
        observedAt,
        speedKmh: null,
        speedSource: null
      })),
      rivers: [],
      sourceStatus: { trains: "live", rivers: "unavailable" }
    })
  }));
  await page.route("**/api/transit", (route) => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({
      transitStatus: "live",
      transit: Array.from({ length: count - trainCount }, (_, index) => ({
        id: `cluster-bus-${index}`,
        label: `Northbound to Test Destination ${index}`,
        route: `R${index}`,
        latitude: 53.35,
        longitude: -8.05,
        bearing: 45,
        speedKmh: 24,
        speedSource: "reported",
        observedAt
      }))
    })
  }));
}

async function installDenseAirFixture(page: Page) {
  const observedAt = new Date().toISOString();
  const airQuality = Array.from({ length: 120 }, (_, index) => {
    const row = Math.floor(index / 12);
    const column = index % 12;
    return {
      id: `dense-air-${index}`,
      name: `Model cell ${index}`,
      latitude: 52.7 + row * 0.14,
      longitude: -9.15 + column * 0.21,
      observedAt,
      europeanAqi: 15 + index % 45,
      pm25: 5,
      pm10: 9,
      nitrogenDioxide: 8,
      ozone: 60,
      uvIndex: 2,
      grassPollen: 1,
      source: "modelled",
      stationClassification: null
    };
  });
  await page.route("**/api/contexts", (route) => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({
      marine: [], radar: [], grid: null, airQuality, aurora: null, tides: [], bathingAlerts: [],
      warnings: [], warningsStatus: "live", issTle: null, satellite: null, earthquakes: [],
      contextStatus: { ...emptyContextStatus, measuredAir: "live" }
    })
  }));
}

test("map hierarchy and persistent view controls survive every target width and 200% text", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "One deterministic viewport matrix is sufficient.");
  const sizes = [
    { width: 1440, height: 900 },
    { width: 768, height: 1024 },
    { width: 390, height: 844 },
    { width: 320, height: 800 }
  ];

  for (const size of sizes) {
    await page.setViewportSize(size);
    await page.goto("/");
    const map = page.locator("#live-map");
    await expect(map.getByRole("heading", { name: "Ireland on the map" })).toBeVisible();
    const mapTop = await map.evaluate((element) => element.getBoundingClientRect().top);
    expect(mapTop, `${size.width}px map fold`).toBeLessThanOrEqual(size.height * .55);
    await expect(map.locator(".map-presets button")).toHaveCount(5);
    for (const control of await map.locator(".map-presets button").all()) await expect(control).toBeVisible();
    await expect(page.getByRole("link", { name: /View live map/ }).first()).toBeVisible();
    expect(await page.evaluate(() => {
      const map = document.querySelector("#live-map");
      const place = document.querySelector(".place-context");
      return Boolean(map && place && (map.compareDocumentPosition(place) & Node.DOCUMENT_POSITION_FOLLOWING));
    })).toBe(true);
    const widths = await page.evaluate(() => ({
      client: document.documentElement.clientWidth,
      document: document.documentElement.scrollWidth,
      body: document.body.scrollWidth
    }));
    expect(widths.document).toBeLessThanOrEqual(widths.client + 1);
    expect(widths.body).toBeLessThanOrEqual(widths.client + 1);
  }

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await page.evaluate(() => { document.documentElement.style.fontSize = "200%"; });
  const largeText = await page.evaluate(() => ({
    mapTop: document.querySelector("#live-map")!.getBoundingClientRect().top,
    client: document.documentElement.clientWidth,
    document: document.documentElement.scrollWidth,
    body: document.body.scrollWidth
  }));
  expect(largeText.mapTop).toBeLessThanOrEqual(900);
  expect(largeText.document).toBeLessThanOrEqual(largeText.client + 1);
  expect(largeText.body).toBeLessThanOrEqual(largeText.client + 1);
  await expect(page.locator("#live-map .map-presets")).toBeVisible();
});

test("mobile preset changes preserve the visible map anchor", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "mobile", "Mobile-only scroll anchoring behavior.");
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 800 });
    await page.goto("/");
    await page.evaluate(() => {
      document.documentElement.style.scrollBehavior = "auto";
      const map = document.querySelector("#live-map")!;
      window.scrollTo(0, map.getBoundingClientRect().top + window.scrollY + 80);
    });
    const map = page.locator("#live-map");
    await expect.poll(() => map.evaluate((element) => element.getBoundingClientRect().top)).toBeCloseTo(-80, 0);
    for (const preset of ["Movement", "Water", "All layers", "Weather"]) {
      const before = await map.evaluate((element) => element.getBoundingClientRect().top);
      await map.getByRole("navigation", { name: "Map views" }).getByRole("button", { name: preset, exact: true }).click();
      await expect.poll(() => map.evaluate((element) => element.getBoundingClientRect().top)).toBeCloseTo(before, 0);
      const bounds = await map.boundingBox();
      expect(bounds).not.toBeNull();
      expect((bounds?.y ?? 1000)).toBeLessThan(844);
      expect((bounds?.y ?? 0) + (bounds?.height ?? 0)).toBeGreaterThan(0);
    }
  }
});

test("large movement clusters zoom before exposing searchable paginated results", async ({ page }) => {
  await installMovementCluster(page);
  await page.goto("/?view=movement");
  const cluster = page.locator(".movement-stack-marker");
  await expect(cluster).toHaveCount(1);
  await expect(cluster).toHaveAttribute("data-cluster-size", "48");

  await cluster.focus();
  await page.keyboard.press("Enter");
  await expect(page.locator(".map-viewport")).toHaveAttribute("data-scale", "2.00");
  await expect(page.locator(".movement-browser")).toHaveCount(0);
  await expect(cluster).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.locator(".map-viewport")).toHaveAttribute("data-scale", "4.00");
  await expect(page.locator(".movement-browser")).toHaveCount(0);
  await expect(cluster).toBeFocused();
  await page.keyboard.press("Enter");

  const browser = page.locator(".movement-browser");
  await expect(browser).toBeVisible();
  await expect(page.getByRole("button", { name: "Close map details" })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(browser.getByRole("searchbox", { name: "Search route, direction or vehicle" })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(browser.getByRole("combobox", { name: "Transport type" })).toBeFocused();
  await expect(browser).toContainText("48 of 48");
  await expect(browser.locator(".movement-results li")).toHaveCount(12);
  await expect(browser.getByRole("navigation", { name: "Transport result pages" })).toContainText("Page 1 of 4");
  await expect(page.getByRole("button", { name: "Next item at this location" })).toHaveCount(0);
  await browser.getByRole("button", { name: "Next", exact: true }).click();
  await expect(browser.getByRole("navigation", { name: "Transport result pages" })).toContainText("Page 2 of 4");

  await browser.getByRole("combobox", { name: "Transport type" }).selectOption("train");
  await expect(browser).toContainText("3 of 48");
  await expect(browser.locator(".movement-results li")).toHaveCount(3);
  await browser.getByRole("combobox", { name: "Transport type" }).selectOption("all");
  await browser.getByRole("searchbox", { name: "Search route, direction or vehicle" }).fill("R17");
  await expect(browser).toContainText("1 of 48");
  await expect(browser.locator(".movement-results li")).toHaveCount(1);
  await browser.locator(".movement-results button").click();
  await expect(page.locator(".detail-transit").getByRole("heading", { name: "Route R17" })).toBeVisible();
});

test("dense point layers declutter by viewport and keep the focused marker while zoom reveals more", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "Deterministic density assertion runs once.");
  await installDenseAirFixture(page);
  await page.goto("/?view=all");
  const map = page.locator("svg.ireland-map");
  await expect(page.locator(".air-marker").first()).toBeVisible();
  await expect(map).toHaveClass(/is-dense-map/);
  const initial = await map.evaluate((element) => ({
    visible: Number(element.getAttribute("data-visible-markers")),
    raw: Number(element.getAttribute("data-point-observations"))
  }));
  expect(initial.raw).toBeGreaterThanOrEqual(120);
  expect(initial.visible).toBeLessThan(initial.raw);
  await expect(page.locator(".air-marker text").first()).toHaveCSS("display", "none");

  const focused = page.locator(".air-marker").first();
  const focusedId = await focused.getAttribute("data-marker-id");
  expect(focusedId).not.toBeNull();
  await focused.focus();
  for (let step = 0; step < 4; step += 1) {
    await map.evaluate((element) => {
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
  await expect.poll(() => map.evaluate((element) => Number(element.getAttribute("data-visible-markers")))).toBeGreaterThan(initial.visible);
  await expect(page.locator(`[data-marker-id="${focusedId}"]`)).toBeFocused();
  const rovingStops = await page.locator("[data-map-marker]").evaluateAll((markers) =>
    markers.filter((marker) => (marker as SVGElement).tabIndex === 0).length
  );
  expect(rovingStops).toBe(1);
});

test("radar and whole-island context controls stay outside the map canvas at constrained widths", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "One deterministic responsive geometry matrix is sufficient.");
  for (const size of [{ width: 768, height: 1024 }, { width: 390, height: 844 }, { width: 320, height: 800 }]) {
    await page.setViewportSize(size);
    await page.goto("/?view=all");
    const canvas = page.locator(".map-canvas");
    const radar = page.locator(".radar-control");
    const context = page.locator(".map-context-disclosure");
    await expect(radar).toBeVisible();
    await expect(context).toBeVisible();
    expect(await canvas.locator(".radar-control, .map-context-disclosure").count()).toBe(0);
    const geometry = await page.evaluate(() => {
      const box = (selector: string) => {
        const bounds = document.querySelector(selector)!.getBoundingClientRect();
        return { top: bounds.top, bottom: bounds.bottom, left: bounds.left, right: bounds.right };
      };
      return { canvas: box(".map-canvas"), radar: box(".radar-control"), context: box(".map-context-disclosure") };
    });
    expect(geometry.radar.top).toBeGreaterThanOrEqual(geometry.canvas.bottom - 1);
    expect(geometry.context.top).toBeGreaterThanOrEqual(geometry.radar.bottom - 1);
    expect(geometry.radar.left).toBeGreaterThanOrEqual(0);
    expect(geometry.radar.right).toBeLessThanOrEqual(size.width + 1);
  }
});

test("custom layer state, legend, grouped disclosure, and URL restoration stay explicit", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "State restoration is viewport-independent.");
  await page.goto("/");
  await page.getByRole("button", { name: "Explore", exact: true }).click();
  const panel = page.locator(".explore-panel");
  await expect(panel.locator(".panel-layer-state")).toContainText("Weather preset · 5 layers");
  const weather = panel.locator('details[data-layer-group="weather"]');
  const movement = panel.locator('details[data-layer-group="movement"]');
  await expect(weather).toHaveAttribute("open", "");
  await expect(movement).not.toHaveAttribute("open", "");
  await movement.locator("summary").click();
  await expect(movement).toHaveAttribute("open", "");
  const transit = movement.getByRole("button", { name: /Public transport/ });
  await transit.click();
  await expect(panel.locator(".panel-layer-state")).toContainText("Custom · 6 layers");
  await expect(page.locator("#live-map .map-presets .custom")).toContainText("Custom · 6 layers");
  await expect(page).toHaveURL(/(?:\?|&)view=custom(?:&|$)/);
  const restoredUrl = page.url();
  expect(new URL(restoredUrl).searchParams.get("layers")?.split(",")).toContain("transit");
  await page.getByRole("button", { name: "Close explore panel" }).click();

  const legend = page.locator(".map-legend");
  await expect(legend.locator("summary")).toContainText("6 layers shown");
  await legend.locator("summary").click();
  expect(await legend.locator(".map-legend-content li").count()).toBeGreaterThanOrEqual(2);
  await expect(legend).toContainText("Movement");

  await page.goto(restoredUrl);
  await expect(page.locator("#live-map .map-presets .custom")).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "Explore", exact: true }).click();
  const restoredMovement = page.locator('.explore-panel details[data-layer-group="movement"]');
  await restoredMovement.locator("summary").click();
  await expect(restoredMovement.getByRole("button", { name: /Public transport/ })).toHaveAttribute("aria-pressed", "true");
});

test("session-only coordinates use exact rural context without entering storage or share state", async ({ page, context }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "Privacy state is viewport-independent.");
  const observedAt = new Date().toISOString();
  await page.route("**/api/living", (route) => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({
      trains: [],
      rivers: [{ id: "far-river", name: "Far River", latitude: 54.7, longitude: -6.1, level: 1.2, observedAt }],
      sourceStatus: { trains: "unavailable", rivers: "live" }
    })
  }));
  await page.route("**/api/contexts", (route) => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({
      marine: [], radar: [], grid: null,
      airQuality: [{
        id: "far-air", name: "Far Air", latitude: 54.8, longitude: -6.0, observedAt,
        europeanAqi: 28, pm25: 6, pm10: 10, nitrogenDioxide: 8, ozone: 62,
        uvIndex: 1, grassPollen: 0, source: "modelled", stationClassification: null
      }],
      aurora: null, tides: [], bathingAlerts: [], warnings: [], warningsStatus: "live",
      issTle: null, satellite: null, earthquakes: [],
      contextStatus: { ...emptyContextStatus, measuredAir: "live" }
    })
  }));
  await context.grantPermissions(["geolocation"]);
  await context.setGeolocation({ latitude: 52.1, longitude: -8.0 });
  await page.addInitScript(() => {
    try {
      if (!localStorage.getItem("a-day-in-ireland.place")) localStorage.setItem("a-day-in-ireland.place", "cork");
    } catch { /* URL state remains usable. */ }
    Object.defineProperty(window.navigator, "share", {
      configurable: true,
      value: async (payload: { text: string; url: string }) => {
        (window as unknown as { __mapShare?: { text: string; url: string } }).__mapShare = payload;
      }
    });
  });

  const contexts = page.waitForResponse((response) => response.url().includes("/api/contexts"));
  await page.goto("/");
  await contexts;
  await expect(page.getByRole("heading", { name: "Cork", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Use my location" }).click();
  await expect(page.getByRole("heading", { name: "Your area", exact: true })).toBeVisible();
  await expect(page.locator("#place-select")).toHaveValue("nearby");
  await expect(page.locator("#place-message")).toContainText("session only");
  await expect(page.locator(".place-limits")).toContainText("share link remains an Ireland view");
  const nearestLabels = await page.locator(".place-observations small").allTextContents();
  expect(nearestLabels.filter((label) => /km away/.test(label)).length).toBeGreaterThanOrEqual(2);
  expect(Math.max(...nearestLabels.flatMap((label) => [...label.matchAll(/([\d.]+) km away/g)].map((match) => Number(match[1]))))).toBeGreaterThan(100);
  await expect(page).toHaveURL(/(?:\?|&)place=island(?:&|$)/);
  await expect.poll(() => page.evaluate(() => localStorage.getItem("a-day-in-ireland.place"))).toBe("cork");

  await page.getByRole("button", { name: "Share this view for Your area" }).click();
  const payload = await page.evaluate(() => (window as unknown as {
    __mapShare: { text: string; url: string }
  }).__mapShare);
  const shared = new URL(payload.url);
  expect(shared.searchParams.get("place")).toBe("island");
  expect(payload.url).not.toMatch(/52\.1|-8(?:\.0)?|lat=|lng=/);

  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Cork", exact: true })).toBeVisible();
});
