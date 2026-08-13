import type { Metadata } from "next";
import InfoPage from "../../components/InfoPage";

export const metadata: Metadata = {
  title: "Privacy",
  description: "The privacy approach used by A Day in Ireland.",
  alternates: { canonical: "/privacy" }
};

export default function PrivacyPage() {
  return (
    <InfoPage
      current="privacy"
      eyebrow="Privacy"
      title="No account. No personal profile."
      introduction="The public map does not ask you to sign in, create an account or submit personal information. If you choose to use your browser location, the app uses it to select the nearest mapped place."
    >
      <section>
        <h2>What your browser stores</h2>
        <p>The experience does not set advertising cookies or create an account for you. The selected place is saved as an identifier in your browser&apos;s local storage so it can be restored on a later visit. The app does not save your GPS coordinates or create a personal profile. Other map-view choices are reflected in the page URL.</p>
      </section>
      <section>
        <h2>Historical public data</h2>
        <p>The service stores public, non-personal snapshots of conditions every 15 minutes once collection begins. The 15-minute history tier is kept for 30 days, hourly rollups are kept for 12 months, and daily summaries are retained thereafter. Provider outages and collection gaps remain recorded as gaps rather than zero values.</p>
        <p>These records do not include visitor identifiers or visitor GPS coordinates. Transport history contains aggregate national or route-level NTA summaries only—not raw train or public-transport vehicle positions, vehicle identifiers or public messages. Historical Irish Rail data is not retained pending permission. Radar and satellite image bytes are not stored.</p>
      </section>
      <section>
        <h2>Infrastructure logs</h2>
        <p>Cloudflare may process standard request information such as IP address, browser details and requested URLs to deliver and protect the site. Those infrastructure logs are governed by Cloudflare’s services and retention controls.</p>
      </section>
      <section>
        <h2>External sources</h2>
        <p>The map requests some public imagery and data from external providers. Opening an official-source link takes you to that provider’s website and privacy practices.</p>
      </section>
      <section>
        <h2>Aggregate analytics</h2>
        <p>Cloudflare Web Analytics measures aggregate page usage and performance. It does not use advertising cookies or create cross-site advertising profiles. Advertising trackers are not part of the experience.</p>
      </section>
    </InfoPage>
  );
}
