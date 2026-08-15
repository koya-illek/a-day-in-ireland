import type { Metadata } from "next";
import InfoPage from "../../components/InfoPage";

export const metadata: Metadata = {
  title: "About",
  description: "Why A Day in Ireland exists and what it is designed to show.",
  alternates: { canonical: "/about" },
  openGraph: { url: "/about", title: "About · A Day in Ireland", description: "Why A Day in Ireland exists and what it is designed to show." }
};

export default function AboutPage() {
  return (
    <InfoPage
      current="about"
      sectionLabel="About the project"
      title="A living portrait of the island."
      introduction="A Day in Ireland brings public observations together so the island can be understood as one changing place, rather than a collection of disconnected dashboards."
    >
      <section>
        <h2>What it is</h2>
        <p>The map combines weather, authoritative daylight and lunar events, the official Met Éireann national text forecast, rain radar, public transport, rail, rivers, sea conditions, air quality, tides, electricity and occasional events such as aurora or seismic activity.</p>
        <p>It is an independent experimental project from <a href="https://illek.ie">Illek</a>. It is not operated by, endorsed by or affiliated with any of the public data providers shown.</p>
      </section>
      <section>
        <h2>What it is not</h2>
        <p>This is a national overview, not a navigation, flood, weather-warning or emergency-response service. Always use the relevant official provider for decisions involving safety or travel.</p>
      </section>
      <section>
        <h2>Design principle</h2>
        <p>Every signal should say what it measures, when it was observed and whether it is measured, modelled, predicted or calculated. Missing information should remain missing rather than quietly becoming zero.</p>
      </section>
    </InfoPage>
  );
}
