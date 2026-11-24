import { expect, test } from '@playwright/test';

// The location controls sit above the map. They must be in the document before
// split JavaScript arrives, rather than moving the map down during hydration.
for (const width of [320, 390, 1440]) {
  test(`location controls reserve their real layout before hydration at ${width}px`, async ({ browser, baseURL }, info) => {
    test.skip(info.project.name !== 'desktop');
    const context = await browser.newContext({ javaScriptEnabled: false, viewport: { width, height: 1000 } });
    try {
      const page = await context.newPage();
      const response = await page.goto(baseURL!);
      expect(response?.status()).toBe(200);
      await expect(page.locator('.place-context')).toBeVisible();
      await expect(page.getByRole('combobox', { name: 'Town or city' })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Use my location' })).toBeVisible();
      const controls = await page.locator('.place-context').boundingBox();
      const map = await page.locator('#live-map').boundingBox();
      expect(controls!.height).toBeGreaterThan(44);
      expect(map!.y).toBeGreaterThanOrEqual(controls!.y + controls!.height);
      expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
    } finally { await context.close(); }
  });
}
