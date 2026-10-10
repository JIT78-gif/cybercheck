import Link from "next/link";
import { ArrowLeft, CircleCheck, Eye, Hand, Lock } from "lucide-react";
import { Logo } from "@/components/brand/logo";

const promises = [
  { icon: Eye, text: "Analysis is read-only. Your project is never modified." },
  { icon: Lock, text: "Every fix is tested in an isolated sandbox first." },
  { icon: Hand, text: "Nothing is applied to your code without your approval." },
];

const checks = [
  "Snapshot frozen at a81f2c7",
  "41 tests discovered and run",
  "Authorization checked on 18 routes",
  "Report ready with evidence",
];

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="grid min-h-dvh flex-1 bg-bg lg:grid-cols-[1fr_1.05fr]">
      <div className="flex flex-col px-4 py-6 sm:px-10 lg:px-16">
        <div className="flex items-center justify-between">
          <Logo />
          <Link
            href="/"
            className="inline-flex min-h-11 items-center gap-1.5 rounded-md px-2 text-sm text-fg-muted transition-colors hover:text-fg"
          >
            <ArrowLeft className="size-4" aria-hidden="true" />
            Back to site
          </Link>
        </div>
        <main id="main" className="flex flex-1 items-center justify-center py-10">
          <div className="animate-fade-up w-full max-w-100">{children}</div>
        </main>
      </div>

      <aside
        aria-hidden="true"
        className="theme-dark relative hidden overflow-hidden bg-bg lg:flex lg:flex-col lg:justify-center lg:px-16"
      >
        <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(var(--border)_1px,transparent_1px)] [background-size:28px_28px] [mask-image:radial-gradient(70%_60%_at_50%_40%,black,transparent)]" />
        <div className="animate-breathe pointer-events-none absolute inset-0 bg-[radial-gradient(55%_50%_at_60%_30%,color-mix(in_srgb,var(--accent)_16%,transparent),transparent)]" />

        <div className="relative max-w-md">
          <p className="font-mono text-xs uppercase tracking-[0.08em] text-accent">
            Testing · Security · AI evaluation · Red team
          </p>
          <h2 className="mt-4 text-4xl font-medium leading-tight tracking-tight text-fg">
            Your code, checked <span className="text-accent">with proof.</span>
          </h2>

          <div className="animate-float mt-10 overflow-hidden rounded-xl border border-border bg-surface shadow-2xl shadow-black/40">
            <div className="relative">
              <div className="animate-scan pointer-events-none absolute inset-x-0 top-0 h-1/3 bg-[linear-gradient(to_bottom,transparent,color-mix(in_srgb,var(--accent)_10%,transparent),transparent)]" />
              <div className="border-b border-border px-5 py-3 font-mono text-xs text-fg-muted">
                acme-storefront · checking
              </div>
              <ul className="space-y-3 p-5">
                {checks.map((c, i) => (
                  <li
                    key={c}
                    className="animate-fade-up flex items-center gap-3 text-sm text-fg"
                    style={{ animationDelay: `${500 + i * 350}ms` }}
                  >
                    <CircleCheck className="size-4 text-success" />
                    {c}
                  </li>
                ))}
              </ul>
            </div>
          </div>

          <ul className="mt-10 space-y-4">
            {promises.map((p) => (
              <li key={p.text} className="flex items-start gap-3 text-fg-muted">
                <p.icon className="mt-0.5 size-4 shrink-0 text-accent" />
                {p.text}
              </li>
            ))}
          </ul>
        </div>
      </aside>
    </div>
  );
}
