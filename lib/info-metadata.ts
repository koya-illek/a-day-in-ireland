import type { Metadata } from "next";

// Info pages define their own openGraph objects, which replace the root one
// wholesale: without this helper they shipped no og:image and their Twitter
// tags fell back to homepage copy.
const SOCIAL_IMAGE = {
  url: "/social/day-in-ireland.jpg",
  width: 1200,
  height: 630,
  alt: "A luminous living map of Ireland at night"
};

export const infoPageMetadata = ({
  title,
  description,
  path
}: {
  title: string;
  description: string;
  path: string;
}): Metadata => ({
  title,
  description,
  alternates: { canonical: path },
  openGraph: {
    title: `${title} · A Day in Ireland`,
    description,
    type: "website",
    locale: "en_IE",
    siteName: "A Day in Ireland",
    url: path,
    images: [SOCIAL_IMAGE]
  },
  twitter: {
    card: "summary_large_image",
    title: `${title} · A Day in Ireland`,
    description,
    images: [SOCIAL_IMAGE.url]
  }
});
