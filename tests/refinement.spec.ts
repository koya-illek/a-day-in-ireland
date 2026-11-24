import { expect, test } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

for (const path of ['/', '/v2']) {
  test(`${path} layers remain named, keyboard-contained and valid`, async ({ page }) => {
    await page.goto(path);
    const opener = page.getByRole('button', { name: path === '/v2' ? 'More layers' : 'Layers', exact: true });
    await opener.click();
    const dialog = page.getByRole('dialog', { name: 'Explore live map layers' });
    await expect(dialog).toBeVisible();
    const audit = await new AxeBuilder({ page }).include('.explore-panel').analyze();
    expect(audit.violations).toEqual([]);
    await page.keyboard.press('Escape');
    await expect(opener).toBeFocused();
  });
}

test('phone atlas retains geography after choosing Cork and exposes outage recovery', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.pathname.startsWith('/api/') || !['127.0.0.1', 'localhost'].includes(url.hostname)) return route.fulfill({ status: 503, body: '{}' });
    return route.continue();
  });
  await page.goto('/v2?place=cork');
  await expect(page.locator('main[data-expanded]')).toHaveAttribute('data-expanded', 'false');
  await expect(page.getByRole('button', { name: /Cork.*Read more/ })).toBeVisible();
  const retry = page.getByRole('button', { name: 'Retry live data' });
  await expect(retry).toBeVisible({ timeout: 20000 });
  await expect(page.getByRole('button', { name: 'Source status', exact: true })).toBeVisible();
  await retry.click();
  await page.getByRole('button', { name: 'Source status', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Behind the observations' })).toBeVisible();
});

test('original recovery and nearby readings keep matched surfaces in both themes', async ({ page }) => {
  await page.goto('/?place=cork');
  await expect(page.locator('.place-observations')).toBeVisible();
  await expect(page.locator('.refresh-data-button')).toBeVisible();
  for (const theme of ['light', 'dark']) {
    const toggle = page.getByRole('button', { name: 'Dark mode', exact: true });
    if (await page.locator('html').getAttribute('data-theme') !== theme) await toggle.click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    const audit = await new AxeBuilder({ page }).include('.place-observations').include('.refresh-data-button').analyze();
    expect(audit.violations).toEqual([]);
  }
});
