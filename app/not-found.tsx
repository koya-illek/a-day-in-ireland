import Link from "next/link";
import type { Metadata } from "next";
import InfoPage from "../components/InfoPage";

// Without this the error page inherits the homepage canonical/description and
// claims to be indexable; unknown URLs must not pose as duplicates of "/".
export const metadata: Metadata = {
  title: "Page not found",
  robots: { index: false, follow: true }
};

export default function NotFound() {
  return (
    <InfoPage
      current="not-found"
      sectionLabel="Page not found"
      title="That address is off the map."
      introduction="The page you asked for does not exist at this address. Nothing is missing from the atlas itself: the live map and every project page are one step away."
    >
      <section>
        <h2>Where to go next</h2>
        <p>
          Open the <Link href="/">live map</Link> for current weather, transport, rivers, sea and energy
          conditions across Ireland, or read <Link href="/about">about the project</Link> and{" "}
          <Link href="/data">where the data comes from</Link>.
        </p>
      </section>
      <section>
        <h2>If a link brought you here</h2>
        <p>Pages occasionally move as the project evolves. Every public page stays reachable from the navigation above, so no broken link should leave you stranded.</p>
      </section>
    </InfoPage>
  );
}
