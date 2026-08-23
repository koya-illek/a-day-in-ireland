import Link from "next/link";
import type { ReactNode } from "react";

const INFO_LINKS = [
  { href: "/", label: "Live map" },
  { href: "/about", label: "About" },
  { href: "/data", label: "Data" },
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
  current: "about" | "data" | "privacy" | "contact" | "not-found";
  sectionLabel: string;
  title: string;
  introduction: string;
  children: ReactNode;
}) {
  return (
    <main className="info-page">
      <a className="skip-link" href="#info-content">Skip to page content</a>
      <header className="info-header">
        <Link className="info-brand" href="/">
          <span aria-hidden="true">←</span>
          <span><b>A Day in Ireland</b><small>Live island view</small></span>
        </Link>
        <nav className="info-nav" aria-label="Project information">
          {INFO_LINKS.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              aria-current={item.href === `/${current}` ? "page" : undefined}
            >
              {item.label}
            </Link>
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
        <nav aria-label="Project information">
          {INFO_LINKS.filter((item) => item.href !== "/").map((item) => (
            <Link
              key={item.href}
              href={item.href}
              aria-current={item.href === `/${current}` ? "page" : undefined}
            >
              {item.label}
            </Link>
          ))}
        </nav>
      </footer>
    </main>
  );
}
