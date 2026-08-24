import { geoMercator } from "d3-geo";
import { expect, test } from "@playwright/test";

test("skip link moves focus to the map section", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("link", { name: /Skip to .* map/ }).focus();
  await page.keyboard.press("Enter");
  const focusedId = await page.evaluate(() => document.activeElement?.id ?? "");
  expect(focusedId).toBe("live-map");
});

test("section shortcuts land their target below the sticky topbar", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/");
  await page.locator(".section-rail nav a", { hasText: "Notices" }).click();
  await page.waitForTimeout(700);
  const [barBottom, targetTop] = await page.evaluate(() => {
    const bar = document.querySelector(".topbar")?.getBoundingClientRect();
    const target = document.getElementById("official-notices")?.getBoundingClientRect();
    return [bar?.bottom ?? 0, target?.top ?? Number.NaN];
  });
  expect(targetTop).toBeGreaterThanOrEqual(barBottom - 1);
});

const expectedCentre = (viewportWidth: number, latitude: number, longitude: number, zoom: number) => {
  // The map renders translate(x y) scale(s), so a projected point p appears
  // at screen position s·p + offset. Centring the linked place therefore
  // requires offset = centre − s·p, clamped to the pan bounds. This encodes
  // the geometric contract directly so it cannot silently mirror a component
  // regression.
  const scale = viewportWidth <= 430 ? 5750 : viewportWidth <= 600 ? 5550 : 5350;
  const projection = geoMercator().center([-8.05, 53.45]).scale(scale).translate([500, 462]);
  const [pointX, pointY] = projection([longitude, latitude])!;
  return {
    point: [pointX, pointY] as const,
    x: Math.min(0, Math.max(1000 * (1 - zoom), 500 - pointX * zoom)),
    y: Math.min(0, Math.max(900 * (1 - zoom), 450 - pointY * zoom))
  };
};

const readMapView = async (page: import("@playwright/test").Page) => {
  const transform = await page.getAttribute("[data-scale]", "transform");
  const match = transform?.match(/translate\((-?[\d.]+) (-?[\d.]+)\) scale\(([\d.]+)\)/);
  return {
    x: Number(match?.[1]),
    y: Number(match?.[2]),
    scale: Number(match?.[3])
  };
};

test("a hash deep link centres against the settled viewport projection", async ({ page }) => {
  const cases = [
    // Far enough from every pan bound that true centring is reachable.
    { latitude: 53.35, longitude: -6.26, expectCentred: true },
    // Near-vertical-centre impossible at zoom 2: the north coast cannot sit
    // mid-screen without pushing the ocean below into frame, so the link
    // must land on the clamped optimum instead.
    { latitude: 55.3809, longitude: -7.3734, expectCentred: false }
  ];
  for (const width of [1280, 390]) {
    const height = width === 1280 ? 900 : 844;
    for (const { latitude, longitude, expectCentred } of cases) {
      const zoom = 2;
      await page.setViewportSize({ width, height });
      await page.goto(`/#lat=${latitude}&lng=${longitude}&zoom=${zoom}`);
      await page.waitForTimeout(600);
      const view = await readMapView(page);
      const expected = expectedCentre(width, latitude, longitude, zoom);
      expect(view.scale).toBeCloseTo(zoom, 0);
      expect(view.x).toBeCloseTo(expected.x, 0);
      expect(view.y).toBeCloseTo(expected.y, 0);
      if (expectCentred) {
        expect(view.x + view.scale * expected.point[0]).toBeCloseTo(500, 0);
        expect(view.y + view.scale * expected.point[1]).toBeCloseTo(450, 0);
      }
    }
  }
});
