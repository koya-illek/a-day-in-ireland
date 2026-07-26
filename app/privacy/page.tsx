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
      introduction="The public map does not ask you to sign in, provide a location or submit personal information."
    >
      <section>
        <h2>What the site stores</h2>
        <p>The experience does not set advertising cookies or create an account for you. Map preferences currently last only for the open page and are not retained as a personal profile.</p>
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
        <h2>Future analytics</h2>
        <p>If privacy-preserving audience measurement is introduced, this page will be updated before it is enabled. Advertising trackers are not currently part of the experience.</p>
      </section>
    </InfoPage>
  );
}
