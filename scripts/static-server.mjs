import { createReadStream, existsSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize } from "node:path";

const root = join(process.cwd(), "dist", "client");
const types = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml"
};

createServer((request, response) => {
  const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
  const requested = normalize(pathname).replace(/^(\.\.(\/|\\|$))+/, "");
  let file = join(root, requested === "/" ? "index.html" : requested);
  if (!existsSync(file) && !extname(file)) file = join(root, "index.html");
  if (!existsSync(file)) {
    response.writeHead(404);
    response.end("Not found");
    return;
  }
  response.setHeader("Content-Type", types[extname(file)] ?? "application/octet-stream");
  createReadStream(file).pipe(response);
}).listen(3000, "127.0.0.1");
