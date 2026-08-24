import { gzipSync } from "node:zlib";
import { existsSync, readdirSync, statSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = "dist/client";
if (!existsSync(root)) throw new Error("dist/client is missing; run npm run build first");

const files = [];
const visit = (directory) => {
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) visit(path);
    else files.push(path);
  }
};
visit(root);

const bytes = (path) => statSync(path).size;
const javascript = files.filter((path) => path.endsWith(".js"));
const largestJavascript = Math.max(0, ...javascript.map(bytes));
const largestJavascriptPath = javascript.find((path) => bytes(path) === largestJavascript);
const largestJavascriptGzipBytes = largestJavascriptPath
  ? gzipSync(readFileSync(largestJavascriptPath), { level: 9 }).length
  : 0;
const html = files.filter((path) => path.endsWith(".html"));
const largestHtml = Math.max(0, ...html.map(bytes));
// Every shipped copy of the transit dictionary counts, not just the
// canonical name: the content-hashed asset used to escape this check. The
// hash segment keeps the small manifest from being counted as data.
const transitAssets = files.filter((path) => /\/data\/transit-destinations\.[0-9a-f]{8,}\.json$/.test(path));
const transitBytes = Math.max(0, ...transitAssets.map(bytes), 0);
const transitGzipBytes = Math.max(0, ...transitAssets.map((path) => gzipSync(readFileSync(path), { level: 9 }).length));
// Decorative road geometry loads as a static asset; keep it from regrowing
// into the bundle-sized liability it was before iteration 6.
const roads = files.find((path) => path.endsWith("/map/major-roads.json"));
const roadsGzipBytes = roads ? gzipSync(readFileSync(roads), { level: 9 }).length : 0;
// Catch-all for future data assets: any non-code, non-media file over the
// cap must be given an explicit budget instead of silently shipping.
const budgetExempt = (path) =>
  /\.(js|html|css|jpe?g|png|webp|avif|ico|svg|woff2?|txt|xml|webmanifest)$/i.test(path) ||
  /\/data\/transit-destinations\./.test(path) ||
  path.endsWith("major-roads.json");
const strayAssetCap = 512_000;
const strayAssets = files.filter((path) => !budgetExempt(path) && bytes(path) > strayAssetCap);

// Requests the landing document fires before interactivity: scripts,
// stylesheets and preloaded assets declared in the built index.html.
const indexHtmlPath = join(root, "index.html");
if (!existsSync(indexHtmlPath)) throw new Error("dist/client/index.html is missing; run npm run build first");
const indexHtml = readFileSync(indexHtmlPath, "utf8");
const assetPath = (url) => join(root, decodeURIComponent(new URL(url, "https://day.illek.ie").pathname.slice(1)));
const initialScriptTags = [...indexHtml.matchAll(/<script\b[^>]*\bsrc="([^"]+)"[^>]*>/gi)];
const initialJavascript = initialScriptTags
  .filter(([tag]) => !/\bnomodule\b/i.test(tag))
  .map(([, url]) => assetPath(url));
const initialStylesheets = [...indexHtml.matchAll(/<link\b[^>]*\brel="stylesheet"[^>]*\bhref="([^"]+)"[^>]*>/gi)]
  .map(([, url]) => assetPath(url));
for (const path of [...initialJavascript, ...initialStylesheets]) {
  if (!existsSync(path)) throw new Error(`Initial asset is missing: ${path}`);
}
const totalBytes = (paths) => paths.reduce((total, path) => total + bytes(path), 0);
const totalGzipBytes = (paths) => paths.reduce(
  (total, path) => total + gzipSync(readFileSync(path), { level: 9 }).length,
  0
);
const initialJavascriptBytes = totalBytes(initialJavascript);
const initialJavascriptGzipBytes = totalGzipBytes(initialJavascript);
const initialStylesheetBytes = totalBytes(initialStylesheets);
const initialStylesheetGzipBytes = totalGzipBytes(initialStylesheets);
const initialPageJavascript = initialJavascript.find((path) => /\/chunks\/app\/page-[^/]+\.js$/.test(path));
if (!initialPageJavascript) throw new Error("The landing page JavaScript chunk is missing");
const initialPageJavascriptBytes = bytes(initialPageJavascript);
const initialRequests =
  initialJavascript.length +
  (indexHtml.match(/<link\b[^>]*\brel="stylesheet"/g)?.length ?? 0) +
  (indexHtml.match(/<link\b[^>]*\brel="preload"/g)?.length ?? 0);

const budgets = {
  largestJavascriptBytes: 320_000,
  largestJavascriptGzipBytes: 110_000,
  largestHtmlBytes: 120_000,
  transitMetadataBytes: 4_000_000,
  transitMetadataGzipBytes: 500_000,
  roadGeometryGzipBytes: 150_000,
  strayDataAssetBytes: strayAssetCap,
  initialJavascriptBytes: 650_000,
  initialJavascriptGzipBytes: 197_000,
  initialPageJavascriptBytes: 235_000,
  initialStylesheetBytes: 125_000,
  initialStylesheetGzipBytes: 25_000,
  initialRequestBudget: 24
};
const failures = [];
if (largestJavascript > budgets.largestJavascriptBytes) failures.push(`largest JavaScript asset is ${largestJavascript} bytes`);
if (largestJavascriptGzipBytes > budgets.largestJavascriptGzipBytes) failures.push(`gzip largest JavaScript asset is ${largestJavascriptGzipBytes} bytes`);
if (largestHtml > budgets.largestHtmlBytes) failures.push(`largest HTML document is ${largestHtml} bytes`);
if (transitBytes > budgets.transitMetadataBytes) failures.push(`transit metadata is ${transitBytes} bytes`);
if (transitGzipBytes > budgets.transitMetadataGzipBytes) failures.push(`gzip transit metadata is ${transitGzipBytes} bytes`);
if (roadsGzipBytes > budgets.roadGeometryGzipBytes) failures.push(`gzip road geometry is ${roadsGzipBytes} bytes`);
for (const path of strayAssets) failures.push(`${path.replace(`${root}/`, "")} is ${bytes(path)} bytes with no explicit budget`);
if (initialJavascriptBytes > budgets.initialJavascriptBytes) failures.push(`initial JavaScript is ${initialJavascriptBytes} bytes`);
if (initialJavascriptGzipBytes > budgets.initialJavascriptGzipBytes) failures.push(`gzip initial JavaScript is ${initialJavascriptGzipBytes} bytes`);
if (initialPageJavascriptBytes > budgets.initialPageJavascriptBytes) failures.push(`landing page JavaScript is ${initialPageJavascriptBytes} bytes`);
if (initialStylesheetBytes > budgets.initialStylesheetBytes) failures.push(`initial stylesheets are ${initialStylesheetBytes} bytes`);
if (initialStylesheetGzipBytes > budgets.initialStylesheetGzipBytes) failures.push(`gzip initial stylesheets are ${initialStylesheetGzipBytes} bytes`);
if (initialRequests > budgets.initialRequestBudget) failures.push(`landing document declares ${initialRequests} initial requests, over the budget of ${budgets.initialRequestBudget}`);
if (failures.length) throw new Error(`Performance budget exceeded: ${failures.join("; ")}`);

console.log(JSON.stringify({
  budgets,
  observed: {
    javascriptFiles: javascript.length,
    largestJavascript,
    largestJavascriptGzipBytes,
    largestHtml,
    transitAssets: transitAssets.length,
    transitBytes,
    transitGzipBytes,
    roadGeometryGzipBytes: roadsGzipBytes,
    initialJavascriptBytes,
    initialJavascriptGzipBytes,
    initialPageJavascriptBytes,
    initialStylesheetBytes,
    initialStylesheetGzipBytes,
    initialRequests
  }
}, null, 2));
