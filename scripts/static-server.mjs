import { createReadStream, existsSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize } from "node:path";

const root = join(process.cwd(), "dist", "client");
const staticHeaders = (() => {
  const path = join(root, "_headers");
  if (!existsSync(path)) return [];
  const headers = [];
  let inGlobalBlock = false;
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    if (line.trim() === "/*") {
      inGlobalBlock = true;
      continue;
    }
    if (inGlobalBlock && line && !/^\s/.test(line)) break;
    if (!inGlobalBlock) continue;
    const match = line.match(/^\s+([^:]+):\s*(.+)$/);
    if (match) headers.push([match[1], match[2]]);
  }
  return headers;
})();
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
  if (pathname.startsWith("/api/")) {
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
  for (const [name, value] of staticHeaders) response.setHeader(name, value);
  const requested = normalize(pathname).replace(/^(\.\.(\/|\\|$))+/, "");
  let file = join(root, requested === "/" ? "index.html" : requested);
  if (!existsSync(file) && !extname(file) && existsSync(`${file}.html`)) file = `${file}.html`;
  if (!existsSync(file) && !extname(file)) file = join(root, "index.html");
  if (!existsSync(file)) {
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
