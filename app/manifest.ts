import type { MetadataRoute } from "next";

export const dynamic = "force-static";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "A Day in Ireland",
    short_name: "Ireland Now",
    description: "A living portrait of Ireland through public observations.",
    start_url: "/",
    display: "standalone",
    background_color: "#edf2ea",
    // Matches the dark viewport theme color and the installed app chrome the
    // site actually renders, not a separate brand green.
    theme_color: "#071815",
    icons: [{
      src: "/icon.svg",
      sizes: "any",
      type: "image/svg+xml"
    }]
  };
}
