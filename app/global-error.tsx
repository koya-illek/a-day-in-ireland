"use client";

import Link from "next/link";

// Last-resort boundary for failures thrown by the root layout itself, where
// app/error.tsx is not mounted. It must render its own html/body shell.
export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <html lang="en-IE">
      <body style={{ background: "#edf2ea", color: "#12251f", fontFamily: "system-ui, sans-serif", margin: 0 }}>
        <main style={{ boxSizing: "border-box", maxWidth: "42rem", margin: "0 auto", padding: "3rem 1.25rem" }}>
          <h1 style={{ fontSize: "1.6rem", margin: "0 0 .8rem" }}>A Day in Ireland could not load.</h1>
          <p style={{ lineHeight: 1.6 }}>
            An unexpected client error interrupted the page before it could render. The live data feeds and stored
            history live outside this page, so a rendering fault here does not change what providers have recorded.
          </p>
          <p>
            <button
              type="button"
              onClick={reset}
              style={{ cursor: "pointer", font: "600 1rem system-ui, sans-serif", minHeight: "2.75rem", padding: ".6rem 1rem" }}
            >
              Try rendering again
            </button>
          </p>
          <p style={{ lineHeight: 1.6 }}>
            If that does not help, these pages are served separately:{" "}
            <Link href="/" style={{ color: "#1d4d3b" }}>the live map</Link>,{" "}
            <Link href="/data" style={{ color: "#1d4d3b" }}>data &amp; methodology</Link> or{" "}
            <Link href="/about" style={{ color: "#1d4d3b" }}>about this project</Link>.
          </p>
          {error.digest ? (
            <p style={{ color: "#52665e" }}>
              Error reference: <code>{error.digest}</code>.
            </p>
          ) : null}
        </main>
      </body>
    </html>
  );
}
