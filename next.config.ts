import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { NextConfig } from "next";

// Content-hashes the road geometry so its asset URL changes whenever the file
// is regenerated; the immutable cache rule in public/_headers stays correct.
const roadsAssetVersion = (() => {
  try {
    return createHash("sha256")
      .update(readFileSync("public/map/major-roads.json"))
      .digest("hex")
      .slice(0, 16);
  } catch {
    return "";
  }
})();

const nextConfig: NextConfig = {
  output: "export",
  poweredByHeader: false,
  reactStrictMode: true,
  env: {
    NEXT_PUBLIC_ROADS_ASSET_VERSION: roadsAssetVersion
  },
  experimental: {
    optimizePackageImports: ["d3-geo"]
  }
};

export default nextConfig;
