import { createReadStream, existsSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize } from "node:path";

const root = join(process.cwd(), "dist", "client");
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
      const env = process.env.NTA_API_KEY ? { NTA_API_KEY: process.env.NTA_API_KEY } : {};
      const upstream = await worker.fetch(new Request(`http://127.0.0.1:${port}${request.url}`), env);
      response.writeHead(upstream.status, Object.fromEntries(upstream.headers));
      response.end(Buffer.from(await upstream.arrayBuffer()));
      return;
    }
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ unavailable: true }));
    return;
  }
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
