import type { Metadata } from "next";
import InfoPage from "../../components/InfoPage";

export const metadata: Metadata = {
  title: "Contact",
  description: "Contact A Day in Ireland about feedback, data or collaboration.",
  alternates: { canonical: "/contact" },
  openGraph: { url: "/contact", title: "Contact · A Day in Ireland", description: "Contact A Day in Ireland about feedback, data or collaboration." }
};

export default function ContactPage() {
  return (
    <InfoPage
      current="contact"
      sectionLabel="Contact"
      title="Feedback makes the map better."
      introduction="Report a misleading signal, inaccessible interaction, broken source or an idea that would make the island more understandable."
    >
      <section>
        <h2>Email</h2>
        <p><a className="info-email" href="mailto:hello@illek.ie">hello@illek.ie</a></p>
        <p>Please include the layer, approximate time and device or browser when reporting a problem.</p>
      </section>
      <section>
        <h2>Data corrections</h2>
        <p>A Day in Ireland republishes and interprets third-party public observations. Errors in the presentation can be corrected here; errors in an underlying measurement may also need to be raised with the named data provider.</p>
      </section>
      <section>
        <h2>Collaboration</h2>
        <p>Thoughtful collaborations around public data, environmental awareness and useful civic technology are welcome. Sponsorship would always be identified and kept separate from editorial and data decisions.</p>
      </section>
    </InfoPage>
  );
}
