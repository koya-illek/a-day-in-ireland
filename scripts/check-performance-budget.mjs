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
const html = files.filter((path) => path.endsWith(".html"));
const largestHtml = Math.max(0, ...html.map(bytes));
const transit = files.find((path) => path.endsWith("/transit-destinations.json"));
const transitBytes = transit ? bytes(transit) : 0;
const transitGzipBytes = transit ? gzipSync(readFileSync(transit), { level: 9 }).length : 0;
// Decorative road geometry loads as a static asset; keep it from regrowing
// into the bundle-sized liability it was before iteration 6.
const roads = files.find((path) => path.endsWith("/map/major-roads.json"));
const roadsGzipBytes = roads ? gzipSync(readFileSync(roads), { level: 9 }).length : 0;

// Requests the landing document fires before interactivity: scripts,
// stylesheets and preloaded assets declared in the built index.html.
const indexHtmlPath = join(root, "index.html");
if (!existsSync(indexHtmlPath)) throw new Error("dist/client/index.html is missing; run npm run build first");
const indexHtml = readFileSync(indexHtmlPath, "utf8");
const initialRequests =
  (indexHtml.match(/<script\b[^>]*\bsrc=/g)?.length ?? 0) +
  (indexHtml.match(/<link\b[^>]*\brel="stylesheet"/g)?.length ?? 0) +
  (indexHtml.match(/<link\b[^>]*\brel="preload"/g)?.length ?? 0);

const budgets = {
  largestJavascriptBytes: 320_000,
  largestHtmlBytes: 120_000,
  transitMetadataBytes: 4_000_000,
  transitMetadataGzipBytes: 500_000,
  roadGeometryGzipBytes: 150_000,
  initialRequestBudget: 24
};
const failures = [];
if (largestJavascript > budgets.largestJavascriptBytes) failures.push(`largest JavaScript asset is ${largestJavascript} bytes`);
if (largestHtml > budgets.largestHtmlBytes) failures.push(`largest HTML document is ${largestHtml} bytes`);
if (transitBytes > budgets.transitMetadataBytes) failures.push(`transit metadata is ${transitBytes} bytes`);
if (transitGzipBytes > budgets.transitMetadataGzipBytes) failures.push(`gzip transit metadata is ${transitGzipBytes} bytes`);
if (roadsGzipBytes > budgets.roadGeometryGzipBytes) failures.push(`gzip road geometry is ${roadsGzipBytes} bytes`);
if (initialRequests > budgets.initialRequestBudget) failures.push(`landing document declares ${initialRequests} initial requests, over the budget of ${budgets.initialRequestBudget}`);
if (failures.length) throw new Error(`Performance budget exceeded: ${failures.join("; ")}`);

console.log(JSON.stringify({
  budgets,
  observed: {
    javascriptFiles: javascript.length,
    largestJavascript,
    largestHtml,
    transitBytes,
    transitGzipBytes,
    roadGeometryGzipBytes: roadsGzipBytes,
    initialRequests
  }
}, null, 2));
