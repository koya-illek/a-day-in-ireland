"use client";

import Link from "next/link";

// A render error anywhere in the experience must not blank the whole page.
// This boundary keeps the failure scoped, honest about what happened, and
// recoverable without a full reload.
export default function ExperienceError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <main className="info-page">
      <article>
        <p className="utility-label">Something went wrong</p>
        <h1>The map could not finish rendering.</h1>
        <p className="info-introduction">
          An unexpected client error interrupted the page. No data was lost upstream; live sources and stored history
          are unaffected.
        </p>
        <div className="info-content">
          <section>
            <h2>Try again</h2>
            <p>
              <button type="button" onClick={reset}>Reload the map</button>{" "}
              or return to the <Link href="/">live map</Link> from a fresh load.
            </p>
            {error.digest ? (
              <p>
                Error reference: <code>{error.digest}</code>. Sharing this reference makes the cause easier to trace.
              </p>
            ) : null}
          </section>
          <section>
            <h2>If it keeps failing</h2>
            <p>
              The project pages stay available: <Link href="/about">about</Link>,{" "}
              <Link href="/data">data sources</Link> and <Link href="/privacy">privacy</Link>. Official providers remain
              authoritative for safety and travel decisions.
            </p>
          </section>
        </div>
      </article>
    </main>
  );
}
