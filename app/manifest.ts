import type { MetadataRoute } from "next";

export const dynamic = "force-static";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "A Day in Ireland",
    short_name: "Day in Ireland",
    description: "A living portrait of Ireland through public observations.",
    start_url: "/",
    display: "standalone",
    // Both colours match the dark chrome the installed app actually renders;
    // a pale launch background flashed before the dark interface loaded.
    background_color: "#071815",
    theme_color: "#071815",
    icons: [{
      src: "/icon.svg",
      sizes: "any",
      type: "image/svg+xml"
    }]
  };
}
