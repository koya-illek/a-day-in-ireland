import { expect, test, type Browser, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { mkdir, writeFile } from 'node:fs/promises';

async function fresh(browser: Browser, baseURL: string | undefined, width: number, theme: string) {
  const context = await browser.newContext({ baseURL, viewport: { width, height: 1000 }, hasTouch: true });
  await context.addInitScript(value => localStorage.setItem('ireland-interface-theme', value), theme);
  let calls = 0;
  await context.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.pathname.startsWith('/api/') || !['127.0.0.1', 'localhost'].includes(url.hostname)) {
      calls++;
      return route.fulfill({ status: 503, contentType: 'application/json', body: '{}' });
    }
    return route.continue();
  });
  return { context, page: await context.newPage(), calls: () => calls };
}
async function audit(page: Page, includes: string[]) {
  let builder = new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa']);
  for (const selector of includes) builder = builder.include(selector);
  const result = await builder.analyze();
  expect(result.violations).toEqual([]);
}

for (const width of [320, 390, 768, 1440]) {
  test(`review fixes preserve controls, contrast and sheet flow at ${width}px`, async ({ browser, baseURL }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop', 'This test explicitly creates the complete viewport/theme matrix.');
    test.setTimeout(120_000);
    const evidence = process.env.IMPECCABLE_EVIDENCE_DIR ?? testInfo.outputPath('evidence');
    await mkdir(evidence, { recursive: true });
    const records = [];
    for (const theme of ['light', 'dark']) {
      const { context, page, calls } = await fresh(browser, baseURL, width, theme);
      try {
        await page.goto('/?place=cork');
        await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
        for (const link of await page.locator('.section-nav a').all()) {
          const colors = await link.evaluate(element => ({ own: getComputedStyle(element).color, ink: getComputedStyle(element).getPropertyValue('--ink').trim() }));
          expect(colors.own).not.toBe('rgb(0, 0, 238)');
        }
        const noticeLink = page.locator('.place-context-summary a[href="#official-notices"]');
        await expect(noticeLink).toBeVisible();
        expect(await noticeLink.evaluate(element => getComputedStyle(element).color)).not.toBe('rgb(0, 0, 238)');
        expect(await page.locator('.freshness-strip').evaluate(element => {
          const map = document.querySelector('#live-map')!;
          const national = document.querySelector('#what-matters-now')!;
          return Boolean(map.compareDocumentPosition(element) & Node.DOCUMENT_POSITION_FOLLOWING) && Boolean(element.compareDocumentPosition(national) & Node.DOCUMENT_POSITION_FOLLOWING);
        })).toBe(true);
        const sourceBounds = await page.locator('.freshness-strip').boundingBox();
        const mapBounds = await page.locator('#live-map').boundingBox();
        const nationalBounds = await page.locator('#what-matters-now').boundingBox();
        expect(sourceBounds!.y).toBeGreaterThanOrEqual(mapBounds!.y + mapBounds!.height - 1);
        expect(nationalBounds!.y).toBeGreaterThanOrEqual(sourceBounds!.y + sourceBounds!.height - 1);
        await expect(page.locator('.refresh-data-button')).toBeEnabled({ timeout: 25_000 });
        const beforeRetry = calls();
        await page.locator('.refresh-data-button').click();
        await expect.poll(calls).toBeGreaterThan(beforeRetry);
        await page.locator('.freshness-details > summary').click();
        await audit(page, ['.section-nav', '.place-context-summary', '.freshness-strip']);
        const colors = await page.locator('.section-nav a').evaluateAll(elements => elements.map(element => ({ text: element.textContent, foreground: getComputedStyle(element).color, body: getComputedStyle(document.body).backgroundColor })));
        records.push({ route: '/', theme, width, colors });
        await page.screenshot({ path: `${evidence}/original-${theme}-${width}.png`, fullPage: true });
      } finally { await context.close(); }
      const atlas = await fresh(browser, baseURL, width, theme);
      try {
        const page = atlas.page;
        await page.goto('/v2');
        const picker = page.getByRole('combobox', { name: 'Town or city' });
        await picker.fill('Cork');
        const selected = page.getByRole('option', { name: 'Cork', exact: true });
        await expect(selected).toHaveAttribute('aria-selected', 'true');
        const pair = await selected.evaluate(element => ({ foreground: getComputedStyle(element).color, background: getComputedStyle(element).backgroundColor }));
        expect(pair).toEqual({ foreground: 'rgb(35, 59, 56)', background: 'rgb(223, 230, 215)' });
        await audit(page, ['.place-search']);
        await page.screenshot({ path: `${evidence}/atlas-search-${theme}-${width}.png`, fullPage: true });
        await picker.press('ArrowDown');
        await picker.press('ArrowUp');
        await picker.press('Enter');
        await expect(picker).toHaveValue('Cork');
        if (width < 761) await expect(page.locator('main[data-expanded]')).toHaveAttribute('data-expanded', 'false');
        await picker.fill('Ireland');
        await picker.press('Enter');
        await expect(picker).toHaveValue('Ireland');
        if (width < 761) await page.getByRole('button', { name: /Across Ireland today.*Read more/ }).click();
        const moreLayers = page.getByRole('button', { name: 'More layers', exact: true });
        if (width < 761) {
          await expect(page.getByRole('button', { name: 'Retry live data', exact: true })).toBeVisible({ timeout: 25_000 });
          const bounds = await moreLayers.evaluate(element => ({
            layer: element.getBoundingClientRect().toJSON(),
            sheet: document.getElementById('atlas-reading')!.getBoundingClientRect().toJSON()
          }));
          expect(bounds.sheet.y).toBeGreaterThanOrEqual(bounds.layer.bottom - 1);
          await page.evaluate(() => { document.documentElement.style.fontSize = '200%'; });
          const scaled = await moreLayers.evaluate(element => ({
            layer: element.getBoundingClientRect().toJSON(),
            sheet: document.getElementById('atlas-reading')!.getBoundingClientRect().toJSON()
          }));
          expect(scaled.sheet.y).toBeGreaterThanOrEqual(scaled.layer.bottom - 1);
          await page.evaluate(() => { document.documentElement.style.fontSize = ''; });
        }
        await moreLayers.click();
        await expect(page.getByRole('dialog', { name: 'Explore live map layers' })).toBeVisible();
        await page.keyboard.press('Escape');
        await expect(moreLayers).toBeFocused();
        await page.getByRole('button', { name: 'Sources', exact: true }).click();
        await page.getByText('Data details', { exact: true }).click();
        const details = page.locator('.freshness-details');
        const bounds = await details.boundingBox();
        expect(bounds!.x).toBeGreaterThanOrEqual(0);
        expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width);
        await audit(page, ['#atlas-reading']);
        const captions = await page.locator('[class*="timebar"] small, [class*="mapFoot"], [class*="footer"] nav a').evaluateAll(elements => elements.map(element => ({ text: element.textContent, size: parseFloat(getComputedStyle(element).fontSize) })));
        for (const caption of captions) expect(caption.size).toBeGreaterThanOrEqual(12);
        expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
        records.push({ route: '/v2', inheritedTheme: theme, width, selectedOption: pair, captions });
        await page.screenshot({ path: `${evidence}/atlas-sources-${theme}-${width}.png`, fullPage: true });
      } finally { await atlas.context.close(); }
    }
    await writeFile(`${evidence}/matrix-${width}.json`, JSON.stringify(records, null, 2));
  });
}
