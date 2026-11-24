/* eslint-disable @next/next/no-html-link-for-pages -- Static export uses native document navigation; no router or prefetch is needed for these links. */
import type { ReactNode } from "react";

const INFO_LINKS = [
  { href: "/", label: "Live map" },
  { href: "/about", label: "About" },
  { href: "/data", label: "Data" },
  { href: "/developers", label: "Developers" },
  { href: "/privacy", label: "Privacy" },
  { href: "/contact", label: "Contact" }
] as const;

export default function InfoPage({
  current,
  sectionLabel,
  title,
  introduction,
  children
}: {
  current: "about" | "data" | "developers" | "privacy" | "contact" | "not-found";
  sectionLabel: string;
  title: string;
  introduction: string;
  children: ReactNode;
}) {
  return (
    <main className="info-page">
      <a className="skip-link" href="#info-content">Skip to page content</a>
      <header className="info-header">
        <a className="info-brand" href="/">
          <span aria-hidden="true">←</span>
          <span><b>A Day in Ireland</b><small>Live island view</small></span>
        </a>
        <nav className="info-nav" aria-label="Project information">
          {INFO_LINKS.map((item) => (
            <a
              key={item.href}
              href={item.href}
              aria-current={item.href === `/${current}` ? "page" : undefined}
            >
              {item.label}
            </a>
          ))}
        </nav>
      </header>
      <article id="info-content" tabIndex={-1}>
        <p className="utility-label">{sectionLabel}</p>
        <h1>{title}</h1>
        <p className="info-introduction">{introduction}</p>
        <div className="info-content">{children}</div>
      </article>
      <footer className="info-footer">
        <nav aria-label="Project information, footer">
          {INFO_LINKS.filter((item) => item.href !== "/").map((item) => (
            <a
              key={item.href}
              href={item.href}
              aria-current={item.href === `/${current}` ? "page" : undefined}
            >
              {item.label}
            </a>
          ))}
        </nav>
      </footer>
    </main>
  );
}
