import type { Metadata, Viewport } from "next";
import { DM_Sans, Newsreader } from "next/font/google";
import { createRequire } from "node:module";
import postcss from "postcss";
import { readFileSync } from "node:fs";
import { applyInterfaceTheme } from "../lib/interface-theme";
import "./globals.css";
import "./experience.css";

const require = createRequire(import.meta.url);
const cssnano = require("next/dist/compiled/cssnano-simple");
// Critical palette is inline: activating an initially nonmatching external
// stylesheet can paint the wrong theme before its request completes.
const lightThemeCss = postcss([cssnano({ colormin: false })])
  .process(readFileSync("styles/theme-light.css", "utf8"), { from: undefined, map: false }).css;

const dmSans = DM_Sans({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-sans"
});

const newsreader = Newsreader({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-serif"
});

export const metadata: Metadata = {
  title: {
    default: "A Day in Ireland: See Ireland happening",
    template: "%s · A Day in Ireland"
  },
  description:
    "A living, near-real-time portrait of weather, transport, rivers, daylight, energy and the sea across Ireland.",
  metadataBase: new URL("https://day.illek.ie"),
  alternates: {
    canonical: "/"
  },
  applicationName: "A Day in Ireland",
  category: "weather and public data",
  authors: [{ name: "Illek", url: "https://illek.ie" }],
  creator: "Illek",
  publisher: "Illek",
  robots: {
    index: true,
    follow: true
  },
  openGraph: {
    title: "A Day in Ireland",
    description: "Weather, movement, water and energy across Ireland, happening now.",
    type: "website",
    locale: "en_IE",
    siteName: "A Day in Ireland",
    url: "/",
    images: [{
      url: "/social/day-in-ireland.jpg",
      width: 1200,
      height: 630,
      alt: "A luminous living map of Ireland at night"
    }]
  },
  twitter: {
    card: "summary_large_image",
    title: "A Day in Ireland",
    description: "Weather, movement, water and energy across Ireland, happening now.",
    images: ["/social/day-in-ireland.jpg"]
  },
  manifest: "/manifest.webmanifest"
};

export const viewport: Viewport = {
  colorScheme: "light dark",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#edf2ea" },
    { media: "(prefers-color-scheme: dark)", color: "#071815" }
  ],
  width: "device-width",
  initialScale: 1
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en-IE" data-scroll-behavior="smooth" suppressHydrationWarning>
      <head>
        <style id="ireland-light-theme" suppressHydrationWarning media="(prefers-color-scheme: light)" dangerouslySetInnerHTML={{ __html: lightThemeCss }} />
        <script dangerouslySetInnerHTML={{ __html: `(function(){var t=null;try{t=localStorage.getItem('ireland-interface-theme')}catch(e){}(${applyInterfaceTheme.toString()})(t==='light'||t==='dark'?t:null,(location.pathname==='/v2'||location.pathname.startsWith('/v2/')))})()` }} />
      </head>
      <body className={`${dmSans.variable} ${newsreader.variable}`}>{children}</body>
    </html>
  );
}
