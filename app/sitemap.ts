import type { MetadataRoute } from "next";

export const dynamic = "force-static";

export default function sitemap(): MetadataRoute.Sitemap {
  const routes = ["", "/about", "/data", "/privacy", "/contact"];
  return routes.map((route) => ({
    url: `https://day.illek.ie${route}`,
    lastModified: new Date(),
    changeFrequency: route === "" ? "daily" : "monthly",
    priority: route === "" ? 1 : .6
  }));
}
