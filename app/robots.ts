import type { MetadataRoute } from "next";

export const dynamic = "force-static";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: "*",
      allow: "/",
      // The MCP transport is a POST-only protocol endpoint; keep crawlers from
      // probing it alongside the JSON API.
      disallow: ["/api/", "/mcp"] as string[],
    },
    sitemap: "https://day.illek.ie/sitemap.xml",
    host: "https://day.illek.ie"
  };
}
