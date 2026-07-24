import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "A Day in Ireland — See Ireland happening",
  description:
    "A living, near-real-time portrait of weather, daylight and the sea across Ireland.",
  metadataBase: new URL("https://a-day-in-ireland.chatgpt.team"),
  openGraph: {
    title: "A Day in Ireland",
    description: "See Ireland happening, right now.",
    type: "website"
  }
};

export const viewport: Viewport = {
  colorScheme: "dark",
  themeColor: "#071815",
  width: "device-width",
  initialScale: 1
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
