import type { Metadata, Viewport } from "next";
import { DM_Sans, Newsreader } from "next/font/google";
import "./globals.css";

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
  colorScheme: "dark light",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#edf2ea" },
    { media: "(prefers-color-scheme: dark)", color: "#071815" }
  ],
  width: "device-width",
  initialScale: 1
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en-IE" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: `(function(){try{var t=localStorage.getItem('ireland-interface-theme');if(t!=='light'&&t!=='dark')t=matchMedia('(prefers-color-scheme: light)').matches?'light':'dark';document.documentElement.dataset.theme=t}catch(e){document.documentElement.dataset.theme='dark'}})()` }} />
      </head>
      <body className={`${dmSans.variable} ${newsreader.variable}`}>{children}</body>
    </html>
  );
}
