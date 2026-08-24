import IrelandExperience from "../components/IrelandExperience";
import { createInitialSnapshot } from "../lib/initial-snapshot";

// Structured data lives on the homepage only: the WebSite and Dataset claims
// describe this product, not the privacy or contact documents, which
// previously inherited them from the root layout.
const structuredData = {
  "@context": "https://schema.org",
  "@type": ["WebSite", "Dataset"],
  name: "A Day in Ireland",
  url: "https://day.illek.ie/",
  description: "A living, near-real-time portrait of weather, transport, rivers, daylight, energy and the sea across Ireland.",
  inLanguage: "en-IE",
  spatialCoverage: {
    "@type": "Place",
    name: "Ireland"
  },
  creator: {
    "@type": "Organization",
    name: "Illek",
    url: "https://illek.ie"
  },
  isAccessibleForFree: true,
  // The composite dataset draws on providers with their own licence terms;
  // /data is the canonical statement of those attribution obligations.
  license: "https://day.illek.ie/data"
};

export default function Home() {
  return (
    <>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(structuredData) }} />
      <IrelandExperience initialSnapshot={createInitialSnapshot()} />
    </>
  );
}
