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
      eyebrow="Privacy"
      title="No account. No personal profile."
      introduction="The public map does not ask you to sign in, create an account or submit personal information. If you choose to use your browser location, the app uses it to select the nearest mapped place."
    >
      <section>
        <h2>What the site stores</h2>
        <p>The experience does not set advertising cookies or create an account for you. The selected place is saved as an identifier in your browser&apos;s local storage so it can be restored on a later visit. The app does not save your GPS coordinates or create a personal profile. Other map-view choices are reflected in the page URL.</p>
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
