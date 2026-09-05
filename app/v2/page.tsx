import type { Metadata } from "next";
import IrelandExperience from "../../components/IrelandExperience";
import { createInitialSnapshot } from "../../lib/initial-snapshot";

export const metadata: Metadata = {
  title: { absolute: "Living atlas preview | A Day in Ireland" },
  openGraph: { title: "Living atlas preview", description: "Explore Ireland through weather, water and movement in the alternate living atlas.", url: "/v2", type: "website" },
  description: "Explore an alternate map-led view of Ireland's weather, water and movement. Compare the living atlas with the original experience.",
  robots: { index: false, follow: true },
  alternates: { canonical: null }
};

export default function AtlasPreview() {
  return <IrelandExperience atlas initialSnapshot={createInitialSnapshot()} />;
}
