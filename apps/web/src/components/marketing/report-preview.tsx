import {
  BotMessageSquare,
  CircleAlert,
  FlaskConical,
  ShieldCheck,
  Swords,
} from "lucide-react";

const tabs = [
  {
    icon: FlaskConical,
    name: "Testing",
    value: "12 findings",
    meta: "30 of 41 planned checks run",
  },
  {
    icon: ShieldCheck,
    name: "Security",
    value: "5 findings",
    meta: "2 high, 3 medium",
  },
  {
    icon: BotMessageSquare,
    name: "AI Evaluator",
    value: "33 of 40 passed",
    meta: "prompt-injection set",
  },
  {
    icon: Swords,
    name: "Adversarial",
    value: "3 attack chains",
    meta: "18 of 24 attempts blocked",
  },
];

// Cells appear one after another once the card has faded in.
const cellDelays = ["[animation-delay:450ms]", "[animation-delay:570ms]", "[animation-delay:690ms]", "[animation-delay:810ms]"];

/** Illustrative mock of a finished report, not live data. */
export function ReportPreview() {
  return (
    <figure className="relative">
      <div
        aria-hidden="true"
        className="animate-breathe absolute -inset-6 rounded-[28px] bg-[radial-gradient(60%_60%_at_50%_40%,color-mix(in_srgb,var(--accent)_18%,transparent),transparent)]"
      />
      <div className="animate-float relative">
        <div className="relative overflow-hidden rounded-2xl border border-border bg-surface shadow-2xl shadow-black/40">
          {/* Scanning light: signals the project is being checked. */}
          <div
            aria-hidden="true"
            className="animate-scan pointer-events-none absolute inset-x-0 top-0 z-10 h-1/4 bg-[linear-gradient(to_bottom,transparent,color-mix(in_srgb,var(--accent)_9%,transparent),transparent)]"
          />

          <div className="flex items-center justify-between gap-4 border-b border-border px-4 py-3 sm:px-5">
            <div className="min-w-0">
              <p className="truncate text-sm font-medium text-fg">acme-storefront</p>
              <p className="font-mono text-xs text-fg-muted">
                baseline a81f2c7 · read-only
              </p>
            </div>
            <span className="inline-flex shrink-0 items-center gap-2 rounded-full border border-border px-2.5 py-1 font-mono text-[11px] text-fg-muted">
              <span className="relative flex size-2" aria-hidden="true">
                <span className="absolute inline-flex size-full animate-ping rounded-full bg-success opacity-60" />
                <span className="relative inline-flex size-2 rounded-full bg-success" />
              </span>
              Report ready
            </span>
          </div>

          <ul className="grid grid-cols-2 gap-px bg-border">
            {tabs.map((t, i) => (
              <li
                key={t.name}
                className={`animate-fade-up bg-surface p-4 sm:p-5 ${cellDelays[i]}`}
              >
                <div className="flex items-center gap-2 text-fg-muted">
                  <t.icon className="size-4 text-accent" aria-hidden="true" />
                  <span className="text-xs font-medium sm:text-sm">{t.name}</span>
                </div>
                <p className="mt-2 text-base font-medium text-fg sm:text-lg">{t.value}</p>
                <p className="mt-0.5 font-mono text-[11px] text-fg-muted sm:text-xs">
                  {t.meta}
                </p>
              </li>
            ))}
          </ul>

          <div className="animate-fade-up border-t border-border bg-surface-2 p-4 [animation-delay:1000ms] sm:p-5">
            <div className="flex items-start gap-3">
              <CircleAlert className="mt-0.5 size-4 shrink-0 text-danger" aria-hidden="true" />
              <div className="min-w-0">
                <p className="text-sm font-medium text-fg">
                  Any signed-in user can read other customers&apos; orders
                </p>
                <p className="mt-1 font-mono text-xs text-fg-muted">
                  High · src/routes/orders.ts:42 · reproduced 3 of 3
                </p>
              </div>
            </div>
            <div className="mt-4 flex flex-wrap items-center gap-2">
              <span className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-fg">
                Fix in sandbox
              </span>
              <span className="rounded-md border border-border px-3 py-1.5 text-xs text-fg-muted">
                View evidence
              </span>
            </div>
          </div>
        </div>
      </div>
      <figcaption className="mt-3 text-center font-mono text-[11px] text-fg-muted">
        Illustrative example report
      </figcaption>
    </figure>
  );
}
