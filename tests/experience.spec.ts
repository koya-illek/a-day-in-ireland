import { expect, test } from "@playwright/test";

test("renders the living map and live observations", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await expect(page.getByLabel("Live map of Ireland")).toBeVisible();
  await expect(page.getByText("Today so far")).toBeVisible();
  await expect(page.locator(".station-marker").first()).toBeVisible();
  await expect(
    page.getByRole("navigation", { name: "Map view shortcuts" }).getByRole("button", { name: /Rail/ })
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
    .getByRole("button", { name: /Rail/ })
    .click();
  if (await page.locator(".train-marker").count()) {
    await page.locator(".train-marker").first().click();
    await expect(page.locator(".detail-train")).toBeVisible();
  }
  await page
    .getByRole("navigation", { name: "Map view shortcuts" })
    .getByRole("button", { name: /Water/ })
    .click();
  await expect(page.locator(".river-marker").first()).toBeVisible();
  await page.locator(".river-marker").first().click();
  await expect(page.locator(".detail-river")).toBeVisible();
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
  await page
    .getByRole("navigation", { name: "More live contexts" })
    .getByRole("button", { name: /Sea conditions/ })
    .click();
  await expect(page.getByText("Offshore conditions", { exact: true })).toBeVisible();
  if (await page.locator(".buoy").count()) {
    expect(await page.locator(".buoy").count()).toBeGreaterThanOrEqual(6);
    await page.locator(".buoy").first().click();
    await expect(page.locator(".detail-buoy")).toBeVisible();
    await expect(page.getByText(/Sea temperature/)).toBeVisible();
  } else {
    await expect(page.getByText(/No Marine Institute buoy observations/)).toBeVisible();
  }
});

test("historical traffic is removed from the live experience", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".traffic-marker")).toHaveCount(0);
  await expect(page.getByText(/historical road|AADT|traffic counter/i)).toHaveCount(0);
});

test("wind context displays measured station speeds and directions", async ({ page }) => {
  await page.goto("/");
  await page
    .getByRole("navigation", { name: "More live contexts" })
    .getByRole("button", { name: /Observed wind/ })
    .click();
  await expect(page.getByText("Observed wind", { exact: true }).first()).toBeVisible();
  await expect(page.locator(".wind-marker").first()).toBeVisible();
  await expect(page.locator(".wind-marker text").first()).toContainText("km/h");
  await page.locator(".wind-marker").first().click();
  await expect(page.locator(".detail-station")).toBeVisible();
  await expect(page.locator(".detail-station").getByText(/km\/h/)).toBeVisible();
});

test("radar context exposes five-minute imagery and playback controls", async ({ page }) => {
  await page.goto("/");
  await page
    .getByRole("navigation", { name: "More live contexts" })
    .getByRole("button", { name: /Rainfall radar/ })
    .click();
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
  const contexts = page.getByRole("navigation", { name: "More live contexts" });
  await contexts.getByRole("button", { name: /Air & exposure/ }).click();
  await expect(page.getByText("Measured and modelled air", { exact: true })).toBeVisible();
  if (await page.locator(".air-marker.modelled").count()) {
    await page.locator(".air-marker.modelled").first().click();
    await expect(page.locator(".detail-air")).toContainText(/model output, not a reading from a sensor/i);
    await page.getByRole("button", { name: "Close map details" }).click({ force: true });
  }
  if (await page.locator(".air-marker.measured").count()) {
    await page.locator(".air-marker.measured").first().click();
    await expect(page.locator(".detail-air")).toContainText(/reported monitoring-station reading/i);
  }

  await contexts.getByRole("button", { name: /Aurora chance/ }).click();
  await expect(page.locator(".aurora-panel:visible")).toBeVisible();
  await expect(page.locator(".aurora-panel:visible")).toContainText(/not a guarantee/i);
});

test("new public contexts are discoverable and honestly describe unavailable data", async ({ page }) => {
  await page.goto("/");
  const contexts = page.getByRole("navigation", { name: "More live contexts" });

  await contexts.getByRole("button", { name: /Tides & surge/ }).click();
  await expect(page.getByText("Tides and coastal anomaly", { exact: true })).toBeVisible();

  await contexts.getByRole("button", { name: /Bathing alerts/ }).click();
  await expect(page.getByText(/bathing-water (alerts|feed)/i).first()).toBeVisible();

  await contexts.getByRole("button", { name: /ISS passes/ }).click();
  await expect(page.locator(".iss-panel:visible")).toBeVisible();
  await expect(page.locator(".iss-panel:visible")).toContainText(/temporarily unavailable|next pass/i);

  await contexts.getByRole("button", { name: /Ireland from space/ }).click();
  await expect(page.getByText("Ireland from space", { exact: true }).first()).toBeVisible();
  await expect(page.locator(".map-notice")).toContainText(/near-real-time daylight imagery|temporarily unavailable/i);

  await contexts.getByRole("button", { name: /Recent earthquakes/ }).click();
  await expect(page.getByText(/earthquakes detected|seismic detections|earthquake feed unavailable/i).first()).toBeVisible();

  await contexts.getByRole("button", { name: /Live public transport/ }).click();
  await expect(page.getByText("Public transport feed awaiting access", { exact: true })).toBeVisible();
  await expect(page.locator(".map-notice")).toContainText(/free developer API key/i);
});

test("notable-now board is present without fabricating an event", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Only the signals worth interrupting the map for." })).toBeVisible();
  const signals = page.locator(".notable-signals button");
  if (await signals.count()) {
    await expect(signals.first()).toBeVisible();
  } else {
    await expect(page.getByText(/No unusual public signals are active right now|Some notable-signal sources are temporarily unavailable/)).toBeVisible();
  }
});
