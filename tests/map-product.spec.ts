import { expect, test, type Page } from "@playwright/test";

const emptyContextStatus = {
  marine: "unavailable",
  radar: "unavailable",
  grid: "unavailable",
  measuredAir: "unavailable",
  modelledAir: "unavailable",
  aurora: "unavailable",
  tides: "unavailable",
  bathing: "unavailable",
  satellite: "unavailable",
  earthquakes: "unavailable",
  iss: "unavailable",
  warnings: "live",
  solar: "unavailable",
  forecast: "unavailable"
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
      contextStatus: { ...emptyContextStatus, modelledAir: "live" }
    })
  }));
}

test("map hierarchy and persistent view controls survive every target width and 200% text", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "One deterministic viewport matrix is sufficient.");
  const sizes = [
    { width: 1440, height: 900, maximumMapTop: 495 },
    { width: 768, height: 1024, maximumMapTop: 564 },
    { width: 390, height: 844, maximumMapTop: 576 },
    { width: 320, height: 800, maximumMapTop: 576 }
  ];

  for (const size of sizes) {
    await page.setViewportSize(size);
    await page.goto("/");
    const map = page.locator("#live-map");
    await expect(map.getByRole("heading", { name: "Ireland on the map" })).toBeVisible();
    const mapTop = await map.evaluate((element) => element.getBoundingClientRect().top);
    expect(mapTop, `${size.width}px map fold`).toBeLessThanOrEqual(size.maximumMapTop);
    await expect(map.locator(".map-presets button")).toHaveCount(5);
    for (const control of await map.locator(".map-presets button").all()) await expect(control).toBeVisible();
    if (size.width <= 600) {
      await expect(page.locator(".preset-scroll-hint")).toBeVisible();
    }
    const sectionShortcuts = page.getByRole("navigation", { name: "Section shortcuts" });
    await expect(sectionShortcuts).toBeVisible();
    if (size.width <= 600) {
      const sectionShortcutGeometry = await sectionShortcuts.locator("a").evaluateAll((links) => links.map((link) => {
        const bounds = link.getBoundingClientRect();
        return {
          name: link.textContent?.trim() ?? "section shortcut",
          left: bounds.left,
          right: bounds.right,
          top: bounds.top,
          bottom: bounds.bottom,
          clientWidth: link.clientWidth,
          scrollWidth: link.scrollWidth
        };
      }));
      for (const shortcut of sectionShortcutGeometry) {
        expect(shortcut.scrollWidth, `${shortcut.name} internal overflow`).toBeLessThanOrEqual(shortcut.clientWidth);
      }
      for (let first = 0; first < sectionShortcutGeometry.length; first += 1) {
        for (let second = first + 1; second < sectionShortcutGeometry.length; second += 1) {
          const a = sectionShortcutGeometry[first]!;
          const b = sectionShortcutGeometry[second]!;
          const overlapWidth = Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left));
          const overlapHeight = Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
          expect(overlapWidth * overlapHeight, `${a.name} overlaps ${b.name}`).toBe(0);
        }
      }
    }
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

  await page.setViewportSize({ width: 320, height: 800 });
  await page.goto("/");
  await page.evaluate(() => { document.documentElement.style.fontSize = "200%"; });
  await page.waitForTimeout(700);
  const narrowLargeText = await page.evaluate(() => ({
    client: document.documentElement.clientWidth,
    document: document.documentElement.scrollWidth,
    body: document.body.scrollWidth
  }));
  expect(narrowLargeText.document).toBeLessThanOrEqual(narrowLargeText.client + 1);
  expect(narrowLargeText.body).toBeLessThanOrEqual(narrowLargeText.client + 1);
  await expect(page.locator("#live-map .map-presets")).toBeVisible();
  await expect(page.locator(".preset-scroll-hint")).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Section shortcuts" })).toBeVisible();

  const narrowMap = page.locator("#live-map");
  await narrowMap.scrollIntoViewIfNeeded();
  const narrowControlGeometry = await page.evaluate(() => {
    const canvas = document.querySelector(".map-canvas")!.getBoundingClientRect();
    return [...document.querySelectorAll<HTMLElement>(".map-navigation button")].map((control) => {
      const bounds = control.getBoundingClientRect();
      return {
        name: control.getAttribute("aria-label") ?? control.textContent?.trim() ?? "map control",
        insideCanvas: bounds.left >= canvas.left - 1 && bounds.right <= canvas.right + 1 &&
          bounds.top >= canvas.top - 1 && bounds.bottom <= canvas.bottom + 1,
        visibleWidth: Math.max(0, Math.min(bounds.right, canvas.right, innerWidth) - Math.max(bounds.left, canvas.left, 0)),
        visibleHeight: Math.max(0, Math.min(bounds.bottom, canvas.bottom, innerHeight) - Math.max(bounds.top, canvas.top, 0))
      };
    });
  });
  expect(narrowControlGeometry).toHaveLength(3);
  for (const control of narrowControlGeometry) {
    expect(control.insideCanvas, `${control.name} remains inside the map canvas`).toBe(true);
    expect(control.visibleWidth, `${control.name} visible width after map navigation`).toBeGreaterThanOrEqual(44);
    expect(control.visibleHeight, `${control.name} visible height after map navigation`).toBeGreaterThanOrEqual(44);
  }
});

test("320px at 200% text keeps map, shortcut, and Custom controls fully operable", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "One deterministic combined reflow profile is sufficient.");
  await page.setViewportSize({ width: 320, height: 800 });
  await page.goto("/");
  await page.evaluate(() => { document.documentElement.style.fontSize = "200%"; });
  await page.waitForTimeout(700);

  const canvas = page.locator(".map-canvas");
  const mapNavigation = page.getByRole("navigation", { name: "Map navigation" });
  const mapGeometry = await page.evaluate(() => {
    const canvasBounds = document.querySelector(".map-canvas")!.getBoundingClientRect();
    return {
      canvas: {
        left: canvasBounds.left,
        right: canvasBounds.right,
        top: canvasBounds.top,
        bottom: canvasBounds.bottom
      },
      controls: [...document.querySelector(".map-navigation")!.children].map((element) => {
        const control = element as HTMLElement;
        const bounds = control.getBoundingClientRect();
        const visibleWidth = Math.max(0, Math.min(bounds.right, canvasBounds.right) - Math.max(bounds.left, canvasBounds.left));
        const visibleHeight = Math.max(0, Math.min(bounds.bottom, canvasBounds.bottom) - Math.max(bounds.top, canvasBounds.top));
        return {
          name: control.getAttribute("aria-label") ?? control.textContent?.trim() ?? "map control",
          left: bounds.left,
          right: bounds.right,
          top: bounds.top,
          bottom: bounds.bottom,
          width: bounds.width,
          height: bounds.height,
          visibleWidth,
          visibleHeight,
          visibleArea: visibleWidth * visibleHeight,
          clientWidth: control.clientWidth,
          scrollWidth: control.scrollWidth
        };
      })
    };
  });
  for (const control of mapGeometry.controls) {
    expect(control.left, `${control.name} left edge`).toBeGreaterThanOrEqual(mapGeometry.canvas.left);
    expect(control.right, `${control.name} right edge`).toBeLessThanOrEqual(mapGeometry.canvas.right);
    expect(control.top, `${control.name} top edge`).toBeGreaterThanOrEqual(mapGeometry.canvas.top);
    expect(control.bottom, `${control.name} bottom edge`).toBeLessThanOrEqual(mapGeometry.canvas.bottom);
    expect(control.width, `${control.name} target width`).toBeGreaterThanOrEqual(44);
    expect(control.height, `${control.name} target height`).toBeGreaterThanOrEqual(44);
    expect(control.visibleWidth, `${control.name} visible width`).toBeGreaterThanOrEqual(44);
    expect(control.visibleHeight, `${control.name} visible height`).toBeGreaterThanOrEqual(44);
    expect(control.visibleArea, `${control.name} visible target area`).toBeGreaterThanOrEqual(44 * 44);
    expect(control.scrollWidth, `${control.name} internal overflow`).toBeLessThanOrEqual(control.clientWidth);
  }

  const zoomIn = mapNavigation.getByRole("button", { name: "Zoom in" });
  const zoomOut = mapNavigation.getByRole("button", { name: "Zoom out" });
  const reset = mapNavigation.getByRole("button", { name: "Reset" });
  const zoom = mapNavigation.getByLabel("Current map zoom");
  await zoomIn.click();
  await expect(zoom).toHaveText("140%");
  await zoomOut.click();
  await expect(zoom).toHaveText("100%");
  await zoomIn.click();
  await reset.click();
  await expect(zoom).toHaveText("100%");

  const shortcuts = page.getByRole("navigation", { name: "Map view shortcuts" });
  const shortcutButtons = shortcuts.locator("button:visible");
  const shortcutGeometry = await shortcutButtons.evaluateAll((buttons) => buttons.map((button) => {
    const target = button as HTMLButtonElement;
    const label = target.querySelector<HTMLElement>(".preset-label")!;
    const bounds = target.getBoundingClientRect();
    return {
      name: target.textContent?.trim() ?? "shortcut",
      left: bounds.left,
      right: bounds.right,
      top: bounds.top,
      bottom: bounds.bottom,
      width: bounds.width,
      height: bounds.height,
      clientWidth: target.clientWidth,
      scrollWidth: target.scrollWidth,
      labelClientWidth: label.clientWidth,
      labelScrollWidth: label.scrollWidth
    };
  }));
  expect(shortcutGeometry).toHaveLength(5);
  for (const shortcut of shortcutGeometry) {
    expect(shortcut.width, `${shortcut.name} target width`).toBeGreaterThanOrEqual(44);
    expect(shortcut.height, `${shortcut.name} target height`).toBeGreaterThanOrEqual(44);
    expect(shortcut.scrollWidth, `${shortcut.name} button overflow`).toBeLessThanOrEqual(shortcut.clientWidth);
    expect(shortcut.labelScrollWidth, `${shortcut.name} label overflow`).toBeLessThanOrEqual(shortcut.labelClientWidth);
  }
  for (let first = 0; first < shortcutGeometry.length; first += 1) {
    for (let second = first + 1; second < shortcutGeometry.length; second += 1) {
      const a = shortcutGeometry[first]!;
      const b = shortcutGeometry[second]!;
      const overlapWidth = Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left));
      const overlapHeight = Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
      expect(overlapWidth * overlapHeight, `${a.name} overlaps ${b.name}`).toBe(0);
    }
  }
  for (let index = 0; index < await shortcutButtons.count(); index += 1) {
    const shortcut = shortcutButtons.nth(index);
    await shortcut.scrollIntoViewIfNeeded();
    const bounds = await shortcut.boundingBox();
    expect(bounds).not.toBeNull();
    expect(bounds?.x ?? -1, `${await shortcut.textContent()} visible left edge`).toBeGreaterThanOrEqual(0);
    expect((bounds?.x ?? 0) + (bounds?.width ?? 0), `${await shortcut.textContent()} visible right edge`).toBeLessThanOrEqual(320);
  }

  const movement = shortcuts.getByRole("button", { name: "Movement", exact: true });
  await movement.scrollIntoViewIfNeeded();
  await movement.focus();
  await page.keyboard.press("Enter");
  await expect(movement).toHaveAttribute("aria-pressed", "true");
  const custom = shortcuts.getByRole("button", { name: /Custom/ });
  await custom.scrollIntoViewIfNeeded();
  await custom.click();
  const panel = page.getByRole("dialog", { name: "Explore live map layers" });
  await expect(panel).toBeVisible();
  const panelOverflow = await panel.evaluate((element) => {
    const targets = [
      element,
      ...element.querySelectorAll<HTMLElement>(
        ".panel-heading, .panel-layer-state, .panel-presets, .panel-presets button, .layer-group, .layer-group-heading, .layer-group-controls, .layer-group-controls > button, .source-note"
      )
    ];
    return targets.map((target) => ({
      name: target.getAttribute("aria-label") ?? target.className ?? target.tagName,
      clientWidth: target.clientWidth,
      scrollWidth: target.scrollWidth
    }));
  });
  for (const target of panelOverflow) {
    expect(target.scrollWidth, `${target.name} internal overflow`).toBeLessThanOrEqual(target.clientWidth);
  }

  const movementPreset = panel.getByRole("button", { name: "Movement", exact: true });
  await movementPreset.click();
  await expect(movementPreset).toHaveAttribute("aria-pressed", "true");
  const movementGroup = panel.locator('details[data-layer-group="movement"]');
  await movementGroup.locator("summary").click();
  const publicTransport = movementGroup.getByRole("button", { name: /Public transport/ });
  await publicTransport.focus();
  await page.keyboard.press("Space");
  await expect(publicTransport).toHaveAttribute("aria-pressed", "false");
  await expect(panel.locator(".panel-layer-state")).toContainText("Custom");
  await page.keyboard.press("Escape");
  await expect(panel).toBeHidden();
  await expect(custom).toBeFocused();
  await expect(canvas).toBeVisible();
});

test("mobile preset changes preserve the visible map anchor", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "mobile", "Mobile-only scroll anchoring behavior.");
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 800 });
    await page.goto("/");
    await expect(page.locator(".retry-live-data")).toBeEnabled();
    await page.evaluate(async () => {
      await document.fonts.ready;
      await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      document.documentElement.style.scrollBehavior = "auto";
      const map = document.querySelector("#live-map")!;
      const requested = map.getBoundingClientRect().top + window.scrollY + 80;
      const lower = Math.floor(requested);
      const upper = Math.ceil(requested);
      const target = Math.abs(requested - lower) <= Math.abs(upper - requested) ? lower : upper;
      window.scrollTo(0, target);
    });
    const map = page.locator("#live-map");
    const shortcuts = page.getByRole("navigation", { name: "Map view shortcuts" });
    await expect.poll(() => map.evaluate((element) => element.getBoundingClientRect().top)).toBeCloseTo(-80, 0);
    for (const preset of ["Movement", "Water", "All layers", "Weather"]) {
      const before = await map.evaluate((element) => element.getBoundingClientRect().top);
      const control = await shortcuts.getByRole("button", { name: preset, exact: true }).boundingBox();
      expect(control).not.toBeNull();
      await page.touchscreen.tap(
        (control?.x ?? 0) + (control?.width ?? 0) / 2,
        (control?.y ?? 0) + (control?.height ?? 0) / 2
      );
      await expect.poll(() => map.evaluate((element) => element.getBoundingClientRect().top)).toBeCloseTo(before, 0);
      const bounds = await map.boundingBox();
      expect(bounds).not.toBeNull();
      expect((bounds?.y ?? 1000)).toBeLessThan(844);
      expect((bounds?.y ?? 0) + (bounds?.height ?? 0)).toBeGreaterThan(0);
    }
  }
});

test("initial live hydration keeps visitors at the top of the page", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "mobile", "One mobile hydration profile is sufficient.");
  const observedAt = new Date().toISOString();
  const delayed = () => new Promise((resolve) => setTimeout(resolve, 250));
  await page.route("**/api/living", async (route) => {
    await delayed();
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        trains: Array.from({ length: 12 }, (_, index) => ({
          id: `hydration-train-${index}`,
          latitude: 53.35,
          longitude: -8.05,
          status: "running",
          direction: `Rail destination ${index}`,
          message: `Rail service ${index}`,
          observedAt,
          speedKmh: null,
          speedSource: null
        })),
        rivers: Array.from({ length: 24 }, (_, index) => ({
          id: `hydration-river-${index}`,
          name: `River gauge ${index}`,
          latitude: 53.1,
          longitude: -8.2,
          observedAt,
          level: 1.2,
          trend: "steady"
        })),
        sourceStatus: { trains: "live", rivers: "live" }
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
  await page.route("**/api/contexts", async (route) => {
    await delayed();
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        marine: [], radar: [], grid: null, airQuality: [], aurora: null, tides: [], bathingAlerts: [],
        warnings: [], warningsStatus: "live", issTle: null, satellite: null, earthquakes: [],
        contextStatus: { ...emptyContextStatus, warnings: "live" }
      })
    });
  });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await expect(page.locator(".workspace-facts")).toContainText("12");
  await expect(page.locator(".hero-sentence")).toContainText("12 trains");
  await expect(page.locator(".workspace-facts")).toBeHidden();
  await expect.poll(() => page.locator("#live-map").evaluate((element) => element.getBoundingClientRect().top)).toBeLessThanOrEqual(460);
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);
  await expect(page.getByRole("heading", { name: "Ireland now." })).toBeVisible();
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

test("1,200 movement positions stay responsive through repeated wheel interactions", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "Performance budget runs once in the desktop rendering profile.");
  test.skip(process.env.PLAYWRIGHT_PERFORMANCE !== "1", "Run the wall-clock budget in isolated PLAYWRIGHT_PERFORMANCE=1 mode.");
  const observedAt = new Date().toISOString();
  await page.route("https://prodapi.metweb.ie/**", (route) => route.fulfill({
    contentType: "application/json",
    body: "[]"
  }));
  await page.route("https://www.met.ie/latest-reports/observations/download", (route) => route.fulfill({
    contentType: "text/csv",
    body: "Name,Temperature,Description,Wind,Unused,Direction,Unused,Rain,Unused\n"
  }));
  await page.route("**/api/transit", (route) => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({
      transitStatus: "live",
      transit: Array.from({ length: 1_200 }, (_, index) => ({
        id: `field-${String(index).padStart(4, "0")}`,
        label: `Performance vehicle ${index}`,
        route: `P${index % 80}`,
        latitude: 51.55 + Math.floor(index / 40) * .125,
        longitude: -10.45 + (index % 40) * .128,
        bearing: index % 360,
        speedKmh: 20,
        speedSource: "reported",
        observedAt
      }))
    })
  }));

  await page.goto("/?view=custom&layers=transit");
  const map = page.locator("svg.ireland-map");
  await expect.poll(() => map.evaluate((element) => Number(element.getAttribute("data-point-observations")))).toBe(1_200);
  await expect(page.locator(".freshness-chip").filter({ hasText: "Weather provider" })).not.toContainText("Connecting");
  const durations = await map.evaluate(async (element) => {
    const viewport = document.querySelector(".map-viewport")!;
    const samples: number[] = [];
    for (let index = 0; index < 10; index += 1) {
      const previousScale = viewport.getAttribute("data-scale");
      const changed = new Promise<void>((resolve, reject) => {
        const timeout = window.setTimeout(() => {
          observer.disconnect();
          reject(new Error("Map scale did not update inside the interaction budget"));
        }, 2_000);
        const observer = new MutationObserver(() => {
          if (viewport.getAttribute("data-scale") === previousScale) return;
          window.clearTimeout(timeout);
          observer.disconnect();
          resolve();
        });
        observer.observe(viewport, { attributes: true, attributeFilter: ["data-scale"] });
      });
      const bounds = element.getBoundingClientRect();
      const started = performance.now();
      element.dispatchEvent(new WheelEvent("wheel", {
        bubbles: true,
        cancelable: true,
        clientX: bounds.left + bounds.width / 2,
        clientY: bounds.top + bounds.height / 2,
        deltaY: index % 2 === 0 ? -300 : 300
      }));
      await changed;
      samples.push(performance.now() - started);
    }
    return samples;
  });
  const ordered = [...durations].sort((first, second) => first - second);
  const median = ordered[Math.floor(ordered.length / 2)]!;
  const p95 = ordered[Math.floor(ordered.length * .95)]!;
  await testInfo.attach("movement-interaction-budget.json", {
    body: JSON.stringify({ durations, median, p95 }, null, 2),
    contentType: "application/json"
  });
  expect(median, `median wheel-to-render time ${median.toFixed(2)} ms`).toBeLessThan(16);
  expect(p95, `p95 wheel-to-render time ${p95.toFixed(2)} ms`).toBeLessThan(32);
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

test("co-located active bathing alerts all remain reachable", async ({ page }) => {
  const now = Date.now();
  const startedAt = new Date(now - 60 * 60_000).toISOString();
  const updatedAt = new Date(now - 10 * 60_000).toISOString();
  const endsAt = new Date(now + 24 * 60 * 60_000).toISOString();
  await page.route("**/api/contexts", (route) => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({
      marine: [], radar: [], grid: null, airQuality: [], aurora: null, tides: [],
      bathingAlerts: [
        { id: "alert-a", name: "First Beach", county: "Galway", latitude: 53.3, longitude: -8,
          restriction: "Do not swim", description: "First active notice", startedAt, updatedAt, endsAt, noticeUrl: null },
        { id: "alert-b", name: "Second Beach", county: "Galway", latitude: 53.3, longitude: -8,
          restriction: "Avoid bathing", description: "Second active notice", startedAt, updatedAt, endsAt, noticeUrl: null }
      ],
      warnings: [], warningsStatus: "live", issTle: null, satellite: null, earthquakes: [],
      contextStatus: { ...emptyContextStatus, bathing: "live" }
    })
  }));

  await page.goto("/?view=custom&layers=bathing");
  const alerts = page.locator(".bathing-marker");
  await expect(alerts).toHaveCount(2);
  const markerState = await alerts.evaluateAll((markers) => markers.map((marker) => ({
    id: marker.getAttribute("data-marker-id"),
    transform: marker.getAttribute("transform"),
    tabIndex: (marker as SVGElement).tabIndex
  })));
  expect(markerState.map(({ id }) => id)).toEqual(["bathing:alert-a", "bathing:alert-b"]);
  expect(new Set(markerState.map(({ transform }) => transform)).size).toBe(2);
  expect(markerState.filter(({ tabIndex }) => tabIndex === 0)).toHaveLength(1);

  await alerts.first().focus();
  await page.keyboard.press("ArrowRight");
  await expect(alerts.nth(1)).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.locator(".detail-bathing").getByRole("heading", { name: "Second Beach" })).toBeVisible();
  await page.keyboard.press("Escape");
  await alerts.first().click();
  await expect(page.locator(".detail-bathing").getByRole("heading", { name: "First Beach" })).toBeVisible();
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
