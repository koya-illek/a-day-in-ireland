import { expect, test, type Browser, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { mkdir, writeFile } from 'node:fs/promises';
const key = 'ireland-interface-theme';
async function fresh(browser: Browser, baseURL: string | undefined, width: number, os: 'light' | 'dark', pin: string | null = null, javaScriptEnabled = true) {
  const context = await browser.newContext({ baseURL, viewport: { width, height: 1000 }, colorScheme: os, javaScriptEnabled,
    storageState: { cookies: [], origins: pin ? [{ origin: new URL(baseURL!).origin, localStorage: [{ name: key, value: pin }] }] : [] } });
  await context.route('**/*', route => {
    const url = new URL(route.request().url());
    if (!['GET', 'HEAD', 'OPTIONS'].includes(route.request().method())) return route.abort();
    if (url.pathname.startsWith('/api/') || !['127.0.0.1', 'localhost'].includes(url.hostname)) return route.fulfill({ status: 503, contentType: 'application/json', body: '{}' });
    return route.continue();
  });
  return { context, page: await context.newPage() };
}
async function read(page: Page) {
  return page.evaluate(() => {
    const root = document.documentElement, input = document.querySelector<HTMLInputElement>('input[type="search"]');
    return { theme: root.dataset.theme, scheme: getComputedStyle(root).colorScheme, meta: document.querySelector<HTMLMetaElement>('meta[name="color-scheme"]')?.content,
      body: getComputedStyle(document.body).backgroundColor, inputScheme: input ? getComputedStyle(input).colorScheme : null,
      inputColor: input ? getComputedStyle(input).color : null, inputBackground: input ? getComputedStyle(input).backgroundColor : null,
      overflow: root.scrollWidth > innerWidth, media: (document.getElementById('ireland-light-theme') as HTMLStyleElement)?.media,
      themeColors: Array.from(document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')).map(meta => meta.content) };
  });
}
async function state(page: Page, theme: 'light' | 'dark', scheme: string) {
  await page.getByRole('combobox', { name: 'Town or city' }).waitFor();
  let value: Awaited<ReturnType<typeof read>> | undefined;
  await expect(async () => {
    value = await read(page);
    expect(value.theme).toBe(theme);
    expect(value.meta).toBe(scheme); expect(value.scheme).toBe(scheme); expect(value.inputScheme).toBe(scheme);
    expect(value.overflow).toBe(false);
    expect(value.body).toBe(theme === 'light' ? 'rgb(237, 242, 234)' : 'rgb(17, 25, 23)');
  }).toPass({ timeout: 10000 });
  return value;
}
async function audit(page: Page) {
  const result = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa']).include('.topbar').include('.place-context').analyze();
  expect(result.violations).toEqual([]);
}
for (const width of [320, 390, 1440]) for (const os of ['light', 'dark'] as const) {
  test(`theme override/native/System/Atlas ${width}px OS ${os}`, async ({ browser, baseURL }, info) => {
    test.skip(info.project.name !== 'desktop', 'Explicit viewport/OS matrix creates its own contexts.');
    test.setTimeout(90_000);
    const evidence = process.env.MWG_EVIDENCE_DIR ?? info.outputPath('evidence'); await mkdir(evidence, { recursive: true });
    const pin = os === 'light' ? 'dark' : 'light';
    const { context, page } = await fresh(browser, baseURL, width, os, pin);
    const records = [], errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
    await context.addInitScript(() => {
      new PerformanceObserver(list => {
        if (list.getEntries().some(entry => entry.name === 'first-contentful-paint'))
          document.documentElement.dataset.firstPaintPalette = getComputedStyle(document.body).backgroundColor;
      }).observe({ type: 'paint', buffered: true });
    });
    try {
      await page.goto('/?place=cork'); await page.getByRole('combobox', { name: 'Town or city' }).waitFor();
      records.push({ state: 'opposite-pin', ...(await state(page, pin, pin)) });
      await expect(page.locator('html')).toHaveAttribute('data-first-paint-palette', pin === 'light' ? 'rgb(237, 242, 234)' : 'rgb(17, 25, 23)');
      await audit(page); await page.screenshot({ path: `${evidence}/original-${pin}-${width}.png`, fullPage: true });
      await page.emulateMedia({ colorScheme: pin }); await state(page, pin, pin);
      expect(await page.evaluate(key => localStorage.getItem(key), key)).toBe(pin);
      await page.emulateMedia({ colorScheme: os }); await state(page, pin, pin);
      expect(await page.evaluate(key => localStorage.getItem(key), key)).toBe(pin);
      await page.getByRole('button', { name: 'Dark mode', exact: true }).click();
      records.push({ state: 'system-reset', ...(await state(page, os, 'light dark')) });
      expect(await page.evaluate(key => localStorage.getItem(key), key)).toBeNull();
      await page.emulateMedia({ colorScheme: pin }); records.push({ state: 'system-change', ...(await state(page, pin, 'light dark')) });
      await page.getByRole('button', { name: 'Dark mode', exact: true }).click();
      await state(page, os, os); expect(await page.evaluate(key => localStorage.getItem(key), key)).toBe(os);
      await page.reload(); await state(page, os, os);
      // A route's head reconciliation must not reset an explicit preference.
      await page.locator('meta[name="color-scheme"]').first().evaluate(meta => meta.setAttribute('content', 'light dark'));
      await state(page, os, os);
      await page.goto('/v2'); await page.getByRole('combobox', { name: 'Town or city' }).waitFor();
      records.push({ state: 'fixed-atlas', ...(await read(page)) });
      await expect.poll(async () => (await read(page)).meta).toBe('light');
      expect((await read(page)).inputScheme).toBe('light');
      expect(await page.locator('[class*="mapArea"]').evaluate(element => getComputedStyle(element).colorScheme)).toBe('dark');
      expect(await page.evaluate(key => localStorage.getItem(key), key)).toBe(os);
      const picker = page.getByRole('combobox', { name: 'Town or city' }); await picker.fill('Cork');
      const option = page.getByRole('option', { name: 'Cork', exact: true });
      expect(await option.evaluate(element => ({ fg: getComputedStyle(element).color, bg: getComputedStyle(element).backgroundColor }))).toEqual({ fg: 'rgb(35, 59, 56)', bg: 'rgb(223, 230, 215)' });
      const axe = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa']).include('.place-search').analyze(); expect(axe.violations).toEqual([]);
      await page.screenshot({ path: `${evidence}/atlas-${os}-${width}.png`, fullPage: true });
      await page.getByRole('link', { name: 'Full view ↗', exact: true }).click();
      await page.getByRole('button', { name: 'Dark mode', exact: true }).waitFor(); await state(page, os, os);
      expect(errors).toEqual([]);
      await writeFile(`${evidence}/theme-${os}-${width}.json`, JSON.stringify({ records, errors }, null, 2));
    } finally { await context.close(); }
  });
}
for (const os of ['light', 'dark'] as const) {
  test(`cross-tab and blocked-storage theme ${os}`, async ({ browser, baseURL }, info) => {
    test.skip(info.project.name !== 'desktop');
    const opposite = os === 'light' ? 'dark' : 'light';
    const { context, page } = await fresh(browser, baseURL, 390, os);
    try {
      const other = await context.newPage(); await page.goto('/'); await other.goto('/');
      await page.getByRole('button', { name: 'Dark mode', exact: true }).waitFor(); await other.getByRole('button', { name: 'Dark mode', exact: true }).waitFor();
      await page.getByRole('combobox', { name: 'Town or city' }).waitFor(); await other.getByRole('combobox', { name: 'Town or city' }).waitFor();
      await page.getByRole('button', { name: 'Dark mode', exact: true }).click(); await state(other, opposite, opposite);
      await page.getByRole('button', { name: 'Dark mode', exact: true }).click(); await state(other, os, 'light dark');
    } finally { await context.close(); }
    const blocked = await fresh(browser, baseURL, 390, os);
    try {
      await blocked.context.addInitScript(() => { for (const method of ['getItem', 'setItem', 'removeItem']) Object.defineProperty(Storage.prototype, method, { configurable: true, value() { throw new DOMException('blocked fixture', 'SecurityError'); } }); });
      await blocked.page.goto('/'); await blocked.page.getByRole('combobox', { name: 'Town or city' }).waitFor();
      await state(blocked.page, os, 'light dark');
      await blocked.page.getByRole('button', { name: 'Dark mode', exact: true }).click(); await state(blocked.page, opposite, opposite);
      await blocked.page.emulateMedia({ colorScheme: opposite }); await state(blocked.page, opposite, opposite);
      await blocked.page.emulateMedia({ colorScheme: os }); await state(blocked.page, opposite, opposite);
    } finally { await blocked.context.close(); }
  });
  test(`no-JS system fallback and pre-hydration pin ${os}`, async ({ browser, baseURL }, info) => {
    test.skip(info.project.name !== 'desktop');
    const opposite = os === 'light' ? 'dark' : 'light';
    const evidence = process.env.MWG_EVIDENCE_DIR ?? info.outputPath('evidence'); await mkdir(evidence, { recursive: true });
    const noJS = await fresh(browser, baseURL, 320, os, opposite, false);
    try {
      await noJS.page.goto('/');
      const original = await read(noJS.page);
      expect(original.body).toBe(os === 'light' ? 'rgb(237, 242, 234)' : 'rgb(17, 25, 23)'); expect(original.scheme).toBe('light dark');
      await noJS.page.screenshot({ path: `${evidence}/no-js-${os}-original.png`, fullPage: true });
      await noJS.page.goto('/v2'); expect(await noJS.page.locator('#atlas-reading button').first().evaluate(element => getComputedStyle(element).colorScheme)).toBe('light');
      expect(await noJS.page.locator('main').evaluate(element => getComputedStyle(element).backgroundColor)).toBe('rgb(18, 59, 64)');
      await noJS.page.screenshot({ path: `${evidence}/no-js-${os}-atlas.png`, fullPage: true });
    } finally { await noJS.context.close(); }
    const prepaint = await fresh(browser, baseURL, 320, os, opposite);
    try {
      await prepaint.context.route('**/_next/**/*.js', route => route.abort());
      const response = await prepaint.page.goto('/');
      const html = await response!.text();
      expect(html.indexOf('id="ireland-light-theme"')).toBeLessThan(html.indexOf('<body'));
      expect(html.indexOf('ireland-interface-theme')).toBeLessThan(html.indexOf('<body'));
      expect((await read(prepaint.page)).theme).toBe(opposite); expect((await read(prepaint.page)).meta).toBe(opposite);
      expect((await read(prepaint.page)).body).toBe(opposite === 'light' ? 'rgb(237, 242, 234)' : 'rgb(17, 25, 23)');
      await prepaint.page.screenshot({ path: `${evidence}/pre-hydration-${opposite}.png`, fullPage: true });
    } finally { await prepaint.context.close(); }
  });
}
