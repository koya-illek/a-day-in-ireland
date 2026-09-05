import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.argv[2] ?? join(process.cwd(), "dist", "client");
const canonicalOrigin = "https://day.illek.ie";
const documents = [
  { file: "v2.html", path: "/v2", indexable: false },
  { file: "index.html", path: "", indexable: true },
  { file: "about.html", path: "/about", indexable: true },
  { file: "data.html", path: "/data", indexable: true },
  { file: "developers.html", path: "/developers", indexable: true },
  { file: "privacy.html", path: "/privacy", indexable: true },
  { file: "contact.html", path: "/contact", indexable: true },
  { file: "404.html", path: null, indexable: false }
];

const matches = (html, pattern) => [...html.matchAll(pattern)];
const failures = [];
const fail = (file, message) => failures.push(`${file}: ${message}`);

for (const document of documents) {
  const filePath = join(root, document.file);
  if (!existsSync(filePath)) {
    fail(document.file, "document is missing; run npm run build first");
    continue;
  }
  const html = readFileSync(filePath, "utf8");
  if (!/<html\b[^>]*\blang="en-IE"/i.test(html)) fail(document.file, "html lang must be en-IE");
  if (!/<main\b/i.test(html)) fail(document.file, "main landmark is missing");

  const titles = matches(html, /<title>([^<]+)<\/title>/gi);
  if (titles.length !== 1 || !titles[0][1].trim()) fail(document.file, "must have one non-empty title");
  const descriptions = matches(html, /<meta\b[^>]*\bname="description"[^>]*\bcontent="([^"]+)"[^>]*>/gi);
  if (descriptions.length !== 1 || descriptions[0][1].trim().length < 40) {
    fail(document.file, "must have one useful meta description");
  }

  const headings = matches(html, /<h([1-6])\b[^>]*>/gi).map((match) => Number(match[1]));
  if (headings.filter((level) => level === 1).length !== 1) fail(document.file, "must have exactly one h1");
  for (let index = 1; index < headings.length; index += 1) {
    if (headings[index] > headings[index - 1] + 1) {
      fail(document.file, `heading order skips from h${headings[index - 1]} to h${headings[index]}`);
    }
  }

  const skipLink = /<a\b[^>]*\bclass="[^"]*\bskip-link\b[^"]*"[^>]*\bhref="#([^"]+)"[^>]*>/i.exec(html);
  if (!skipLink || !new RegExp(`\\bid="${skipLink?.[1] ?? "missing"}"`).test(html)) {
    fail(document.file, "skip link must target an element in the document");
  }

  for (const anchor of matches(html, /<a\b[^>]*\btarget="_blank"[^>]*>/gi)) {
    const rel = /\brel="([^"]*)"/i.exec(anchor[0])?.[1].split(/\s+/) ?? [];
    if (!rel.includes("noreferrer") && !rel.includes("noopener")) {
      fail(document.file, "target=_blank link is missing noreferrer or noopener");
    }
  }

  const canonicals = matches(html, /<link\b[^>]*\brel="canonical"[^>]*\bhref="([^"]+)"[^>]*>/gi);
  if (document.indexable) {
    const expected = `${canonicalOrigin}${document.path}`;
    if (canonicals.length !== 1 || canonicals[0][1] !== expected) {
      fail(document.file, `canonical must be ${expected}`);
    }
    for (const property of ["og:title", "og:description", "og:url", "og:image"]) {
      if (!new RegExp(`<meta\\b[^>]*\\bproperty="${property}"[^>]*\\bcontent="[^"]+"`, "i").test(html)) {
        fail(document.file, `${property} metadata is missing`);
      }
    }
    if (!/<meta\b[^>]*\bname="twitter:card"[^>]*\bcontent="[^"]+"/i.test(html)) {
      fail(document.file, "Twitter card metadata is missing");
    }
  } else {
    if (canonicals.length) fail(document.file, "non-indexable document must not declare a canonical URL");
    if (!/<meta\b[^>]*\bname="robots"[^>]*\bcontent="[^"]*noindex/i.test(html)) {
      fail(document.file, "non-indexable document must declare noindex");
    }
    if (/<meta\b[^>]*\bproperty="og:url"[^>]*\bcontent="https:\/\/day\.illek\.ie\/?"/i.test(html)) {
      fail(document.file, "non-indexable document must not inherit the homepage Open Graph URL");
    }
  }

  const jsonLd = matches(html, /<script\b[^>]*\btype="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi);
  // WebSite/Dataset claims describe this product, so they belong only on the
  // homepage document; other pages must not inherit them.
  const expectedJsonLd = document.file.startsWith("index") ? 1 : 0;
  if (jsonLd.length !== expectedJsonLd) {
    fail(document.file, `must contain exactly ${expectedJsonLd} JSON-LD block(s)`);
  } else if (jsonLd.length) {
    try {
      JSON.parse(jsonLd[0][1]);
    } catch {
      fail(document.file, "JSON-LD is not valid JSON");
    }
  }
}

if (failures.length) {
  throw new Error(`HTML audit failed:\n${failures.map((failure) => `- ${failure}`).join("\n")}`);
}

console.log(`HTML audit passed for ${documents.length} documents in ${root}.`);
