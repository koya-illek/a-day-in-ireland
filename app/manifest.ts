import type { MetadataRoute } from "next";

export const dynamic = "force-static";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "A Day in Ireland",
    short_name: "Ireland Now",
    description: "A living portrait of Ireland through public observations.",
    start_url: "/",
    display: "standalone",
    background_color: "#050d1b",
    theme_color: "#071426",
    icons: [{
      src: "/icon.svg",
      sizes: "any",
      type: "image/svg+xml"
    }]
  };
}
