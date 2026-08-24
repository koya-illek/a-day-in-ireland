import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize } from "node:path";

const root = join(process.cwd(), "dist", "client");

// Parse every _headers block (the global "/*" plus path-specific rules) so
// local checks exercise the same caching and security posture as production.
// Matching follows Cloudflare semantics: all matching rules apply, later
// values override earlier ones for the same header name.
const headerRules = (() => {
  const path = join(root, "_headers");
  if (!existsSync(path)) return [];
  const rules = [];
  let current = null;
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith("#")) continue;
    if (!/^\s/.test(line)) {
      current = { pattern: line.trim(), headers: [] };
      rules.push(current);
      continue;
    }
    const match = line.match(/^\s+([^:]+):\s*(.+)$/);
    if (match && current) current.headers.push([match[1], match[2]]);
  }
  return rules;
})();

const ruleMatches = (pattern, pathname) => {
  if (pattern.endsWith("*")) return pathname.startsWith(pattern.slice(0, -1));
  return pattern === pathname;
};

const headersForPath = (pathname) => {
  const merged = [];
  for (const rule of headerRules) {
    if (!ruleMatches(rule.pattern, pathname)) continue;
    for (const [name, value] of rule.headers) {
      const existing = merged.findIndex(([mergedName]) => mergedName.toLowerCase() === name.toLowerCase());
      if (existing >= 0) merged[existing] = [name, value];
      else merged.push([name, value]);
    }
  }
  return merged;
};

const port = Number.parseInt(process.env.PORT ?? process.env.PLAYWRIGHT_PORT ?? "3000", 10);
if (!Number.isInteger(port) || port < 1 || port > 65_535) {
  throw new Error(`Invalid static server port: ${process.env.PORT ?? process.env.PLAYWRIGHT_PORT}`);
}
const types = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml"
};

createServer(async (request, response) => {
  const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
  // /mcp (and /api/mcp via the prefix below) belongs to the worker surface in
  // live mode, matching the production dispatcher's route set.
  if (pathname.startsWith("/api/") || pathname === "/mcp") {
    if (process.env.LIVE_CONTEXTS === "1") {
      const { default: worker } = await import("../platform/server-entry.js");
      const env = {};
      for (const name of ["NTA_API_KEY"]) {
        if (process.env[name]) env[name] = process.env[name];
      }
      const upstream = await worker.fetch(new Request(`http://127.0.0.1:${port}${request.url}`), env);
      response.writeHead(upstream.status, Object.fromEntries(upstream.headers));
      response.end(Buffer.from(await upstream.arrayBuffer()));
      return;
    }
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ unavailable: true }));
    return;
  }
  for (const [name, value] of headersForPath(pathname)) response.setHeader(name, value);
  const requested = normalize(pathname).replace(/^(\.\.(\/|\\|$))+/, "");
  let file = join(root, requested === "/" ? "index.html" : requested);
  if (!extname(file) && existsSync(`${file}.html`) && statSync(`${file}.html`).isFile()) file = `${file}.html`;
  if (existsSync(file) && statSync(file).isDirectory() && existsSync(join(file, "index.html"))) file = join(file, "index.html");
  if (!existsSync(file)) {
    // Mirror wrangler's not_found_handling = "404-page": unknown document
    // paths get the branded page with a true 404 status, never a soft 200.
    const notFoundFile = join(root, "404.html");
    if (existsSync(notFoundFile)) {
      // The miss path may have matched long-cache rules above (a stale
      // content-hashed asset, say); a branded 404 must never inherit them,
      // or browsers would cache the error page under an immutable-year
      // policy. Reset caching, then layer the /404 document rules on top.
      response.removeHeader("Cache-Control");
      for (const [name, value] of headersForPath("/404")) response.setHeader(name, value);
      if (!response.getHeader("Cache-Control")) response.setHeader("Cache-Control", "no-store");
      response.setHeader("Content-Type", types[".html"]);
      response.writeHead(404);
      const stream = createReadStream(notFoundFile);
      stream.on("error", () => {
        if (!response.headersSent) response.writeHead(500);
        response.end();
      });
      response.on("error", () => stream.destroy());
      stream.pipe(response);
      return;
    }
    response.writeHead(404);
    response.end("Not found");
    return;
  }
  response.setHeader("Content-Type", types[extname(file)] ?? "application/octet-stream");
  const stream = createReadStream(file);
  stream.on("error", () => {
    if (!response.headersSent) response.writeHead(500);
    response.end();
  });
  response.on("error", () => stream.destroy());
  stream.pipe(response);
}).listen(port, "127.0.0.1");
