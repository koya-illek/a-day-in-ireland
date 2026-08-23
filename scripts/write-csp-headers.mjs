// Rewrites the built _headers file so each HTML document gets its own
// Content-Security-Policy containing only the inline-script hashes that page
// needs. Cloudflare's _headers format has a 2,000-character line limit, so one
// global policy containing every hash in the site is not deployable. The source
// public/_headers keeps a normal 'unsafe-inline' CSP as a readable template and
// fallback; this generator removes that global CSP from the built file and
// appends bounded per-page policies instead.
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { pathToFileURL } from "node:url";

const GENERATED_BEGIN = "# BEGIN GENERATED PER-PAGE CSP";
const GENERATED_END = "# END GENERATED PER-PAGE CSP";
const HEADER_LINE_LIMIT = 2000;

export const inlineScriptHashes = (html) => {
  const hashes = new Set();
  // Mirrors HTML raw-text parsing: the body runs to the first matching close
  // tag, case-insensitively, tolerating whitespace before the bracket. Even
  // empty bodies execute as script elements and need their own allowance.
  for (const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)) {
    if (/\bsrc\s*=/i.test(match[1])) continue;
    // CSP hashes the exact raw bytes between the tags, which is also what
    // the browser executes; no entity decoding or whitespace trimming.
    hashes.add(`'sha256-${createHash("sha256").update(match[2]).digest("base64")}'`);
  }
  return [...hashes];
};

const generatedPattern = () => new RegExp(`\\n?${GENERATED_BEGIN}[\\s\\S]*?${GENERATED_END}\\n?`, "m");

export const stripGeneratedCsp = (headersText) => headersText
  .replace(generatedPattern(), "\n")
  .replace(/\n{3,}/g, "\n\n")
  .trimEnd();

const globalCspLine = (headersText) => {
  const match = headersText.match(/^([ \t]*Content-Security-Policy:[^\n]*)$/m);
  if (!match) throw new Error("The base _headers file is missing its global Content-Security-Policy template.");
  if (!match[1].includes("'unsafe-inline'")) {
    throw new Error("The base Content-Security-Policy must keep 'unsafe-inline' as the pre-generation fallback.");
  }
  return match[1];
};

const withoutGlobalCsp = (headersText) => headersText
  .replace(/^([ \t]*Content-Security-Policy:[^\n]*)\n?/m, "")
  .replace(/\n{3,}/g, "\n\n")
  .trimEnd();

export const collectDocumentHashes = (root) => {
  const documents = [];
  const visit = (directory) => {
    for (const entry of readdirSync(directory)) {
      const path = join(directory, entry);
      if (statSync(path).isDirectory()) visit(path);
      else if (path.endsWith(".html")) {
        documents.push({
          file: relative(root, path).replaceAll("\\", "/"),
          hashes: inlineScriptHashes(readFileSync(path, "utf8"))
        });
      }
    }
  };
  visit(root);
  return documents.sort((left, right) => left.file.localeCompare(right.file));
};

const pathsForDocument = (file) => {
  if (file === "index.html") return ["/", "/index.html"];
  // The branded 404 document is served from asset misses at the bare "/404"
  // path by every adapter, and directly at "/404.html"; both need the policy.
  if (file === "404.html") return ["/404", "/404.html"];
  if (file.endsWith("/index.html")) {
    const directory = file.slice(0, -"/index.html".length);
    return [`/${directory}/`, `/${directory}/index.html`];
  }
  const cleanPath = file.slice(0, -".html".length);
  return [`/${cleanPath}`, `/${cleanPath}/`, `/${file}`];
};

const assertLineLength = (line, file) => {
  if (line.length > HEADER_LINE_LIMIT) {
    throw new Error(`Generated CSP for ${file} is ${line.length} characters; Cloudflare's _headers line limit is ${HEADER_LINE_LIMIT}.`);
  }
};

export const renderHeadersWithPerPageCsp = (headersText, documents) => {
  const template = globalCspLine(headersText);
  const base = withoutGlobalCsp(stripGeneratedCsp(headersText));
  const uniqueHashes = new Set();
  const blocks = [];

  for (const document of documents) {
    if (!document.hashes.length) {
      throw new Error(`${document.file} has no inline scripts; refusing to guess the CSP.`);
    }
    for (const hash of document.hashes) uniqueHashes.add(hash);
    const cspLine = template.replace("'unsafe-inline'", document.hashes.join(" "));
    assertLineLength(cspLine, document.file);
    for (const path of pathsForDocument(document.file)) {
      blocks.push(`${path}\n${cspLine}`);
    }
  }

  return `${base}\n\n${GENERATED_BEGIN}\n${blocks.join("\n\n")}\n${GENERATED_END}\n`;
};

const main = () => {
  const root = process.argv[2] ?? join(process.cwd(), "dist", "client");
  const headersPath = join(root, "_headers");
  if (!existsSync(headersPath)) throw new Error(`${headersPath} is missing; run npm run build first`);
  const original = readFileSync(headersPath, "utf8");
  if (!original.includes("'unsafe-inline'") && original.includes(GENERATED_BEGIN)) {
    console.log("Per-page Content-Security-Policy rules were already generated; nothing to do.");
    return;
  }
  const documents = collectDocumentHashes(root);
  const updated = renderHeadersWithPerPageCsp(original, documents);
  writeFileSync(headersPath, updated);
  const uniqueHashCount = new Set(documents.flatMap((document) => document.hashes)).size;
  console.log(`CSP script-src now allows ${uniqueHashCount} unique inline script hashes across ${documents.length} documents instead of one global 'unsafe-inline' policy.`);
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
