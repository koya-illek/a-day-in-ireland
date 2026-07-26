import Link from "next/link";
import type { ReactNode } from "react";

export default function InfoPage({
  eyebrow,
  title,
  introduction,
  children
}: {
  eyebrow: string;
  title: string;
  introduction: string;
  children: ReactNode;
}) {
  return (
    <main className="info-page">
      <header className="info-header">
        <Link className="info-brand" href="/">
          <span aria-hidden="true">←</span>
          <span><b>A Day in Ireland</b><small>Return to the live island</small></span>
        </Link>
      </header>
      <article>
        <p className="eyebrow">{eyebrow}</p>
        <h1>{title}</h1>
        <p className="info-introduction">{introduction}</p>
        <div className="info-content">{children}</div>
      </article>
      <footer className="info-footer">
        <nav aria-label="Project information">
          <Link href="/about">About</Link>
          <Link href="/data">Data &amp; methodology</Link>
          <Link href="/privacy">Privacy</Link>
          <Link href="/contact">Contact</Link>
        </nav>
      </footer>
    </main>
  );
}
