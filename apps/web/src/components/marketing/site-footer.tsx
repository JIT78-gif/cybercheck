import { Logo } from "@/components/brand/logo";
import { brand } from "@/config/brand";
import { Container } from "./section";

const groups = [
  {
    title: "Product",
    links: [
      { href: "#checks", label: "What we check" },
      { href: "#how-it-works", label: "How it works" },
      { href: "#safety", label: "Safety" },
    ],
  },
  {
    title: "Get started",
    links: [
      { href: "/signup", label: "Create account" },
      { href: "/login", label: "Sign in" },
      { href: "#faq", label: "FAQ" },
    ],
  },
];

export function SiteFooter() {
  return (
    <footer className="border-t border-border py-12">
      <Container className="grid gap-10 sm:grid-cols-[1.5fr_1fr_1fr]">
        <div>
          <Logo />
          <p className="mt-4 max-w-sm text-sm text-fg-muted">{brand.tagline}.</p>
        </div>
        {groups.map((g) => (
          <nav key={g.title} aria-label={g.title}>
            <p className="font-mono text-xs uppercase tracking-[0.08em] text-fg-muted">
              {g.title}
            </p>
            <ul className="mt-4 space-y-2">
              {g.links.map((l) => (
                <li key={l.href}>
                  <a href={l.href} className="text-sm text-fg-muted hover:text-fg">
                    {l.label}
                  </a>
                </li>
              ))}
            </ul>
          </nav>
        ))}
      </Container>
      <Container className="mt-10 border-t border-border pt-6">
        <p className="font-mono text-xs text-fg-muted">
          © 2026 {brand.name}
        </p>
      </Container>
    </footer>
  );
}
