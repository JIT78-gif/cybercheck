import {
  BotMessageSquare,
  Check,
  CircleAlert,
  CircleCheck,
  CircleX,
  FlaskConical,
  ShieldCheck,
  Swords,
  type LucideIcon,
} from "lucide-react";
import { reveal, seq } from "@/components/motion/reveal";
import { cn } from "@/lib/cn";
import { Container, Eyebrow, SectionHeading } from "./section";

type CheckItem = {
  id: string;
  icon: LucideIcon;
  label: string;
  title: string;
  body: string;
  bullets: string[];
  panel: React.ReactNode;
};

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <figure className="overflow-hidden rounded-2xl border border-border bg-surface shadow-xl shadow-black/30 transition-colors duration-300 hover:border-accent/40">
      <div className="flex items-center justify-between border-b border-border px-5 py-3">
        <p className="text-sm font-medium text-fg">{title}</p>
        <span className="font-mono text-[11px] text-fg-muted">example</span>
      </div>
      <div className="p-5">{children}</div>
    </figure>
  );
}

function Row({
  status,
  text,
  meta,
  index,
}: {
  status: "pass" | "fail" | "warn";
  text: string;
  meta: string;
  index: number;
}) {
  const Icon = status === "pass" ? CircleCheck : status === "fail" ? CircleX : CircleAlert;
  const label = status === "pass" ? "Passed" : status === "fail" ? "Failed" : "Warning";
  return (
    <li {...seq(index)} className="flex items-start gap-3 py-2.5">
      <Icon
        className={cn(
          "mt-0.5 size-4 shrink-0",
          status === "pass" && "text-success",
          status === "fail" && "text-danger",
          status === "warn" && "text-warning",
        )}
        aria-label={label}
      />
      <div className="min-w-0">
        <p className="text-sm text-fg">{text}</p>
        <p className="font-mono text-xs text-fg-muted">{meta}</p>
      </div>
    </li>
  );
}

const attackSteps = [
  "Invite links use a guessable pattern",
  "Joining a team skips the owner's approval",
  "Team members can download every shared file",
];

const checks: CheckItem[] = [
  {
    id: "testing",
    icon: FlaskConical,
    label: "Testing",
    title: "Know exactly what works, and what was never tested",
    body: "We find the tests you already have, run them in a clean environment, and show which parts of your app are covered and which are not. When something fails, you see the exact step, input, and output.",
    bullets: [
      "Unit, integration, API, and end-to-end tests",
      "Coverage of features and risks, not just lines of code",
      "Flaky tests flagged instead of silently counted as passes",
    ],
    panel: (
      <Panel title="Testing · checkout flow">
        <ul data-sequence className="divide-y divide-border">
          <Row index={0} status="pass" text="Cart adds and removes items" meta="tests/cart.test.ts · 0.4s" />
          <Row index={1} status="fail" text="Total is wrong when a coupon and tax both apply" meta="expected 107.00 · got 110.00 · reproduced 3 of 3" />
          <Row index={2} status="warn" text="Refund flow has no tests" meta="untested area · listed in report" />
        </ul>
      </Panel>
    ),
  },
  {
    id: "security",
    icon: ShieldCheck,
    label: "Security",
    title: "Find the doors attackers would try first",
    body: "We review how your app handles logins, permissions, secrets, dependencies, and configuration. Every finding is confirmed with a safe reproduction and explained in plain language. You get the root cause, not just a scanner alert.",
    bullets: [
      "Permission and account checks on every sensitive route",
      "Leaked secrets and vulnerable dependencies",
      "Risky configuration and missing security controls",
    ],
    panel: (
      <Panel title="Security · finding">
        <div data-sequence>
          <div {...seq(0)} className="flex items-center gap-2">
            <span className="rounded-md bg-danger/15 px-2 py-0.5 font-mono text-xs text-danger">High</span>
            <span className="font-mono text-xs text-fg-muted">src/routes/orders.ts:42</span>
          </div>
          <div {...seq(1)}>
            <p className="mt-3 text-sm font-medium text-fg">
              Signed-in users can read other customers&apos; orders
            </p>
            <p className="mt-2 text-sm text-fg-muted">
              The order endpoint loads an order by ID but never checks that it belongs to the person asking.
            </p>
          </div>
          <div {...seq(2)} className="mt-4 rounded-lg border border-border bg-surface-2 p-3 font-mono text-xs text-fg-muted">
            GET /api/orders/1043 as user B → 200 OK (order of user A)
          </div>
        </div>
      </Panel>
    ),
  },
  {
    id: "ai",
    icon: BotMessageSquare,
    label: "AI Evaluator",
    title: "Make sure your AI does its job and nothing else",
    body: "If your app uses a chatbot, an AI agent, or document search, we test it with realistic and hostile inputs: hidden instructions, attempts to leak data, requests to misuse tools, and questions it should answer correctly.",
    bullets: [
      "Prompt-injection and data-leak resistance",
      "Tool permissions and approval safety",
      "Answer quality, grounding, speed, and cost",
    ],
    panel: (
      <Panel title="AI Evaluator · support bot">
        <div className="flex items-end justify-between">
          <div>
            <p className="font-mono text-xs text-fg-muted">injection test set</p>
            <p className="mt-1 text-2xl font-medium text-fg">33 of 40 blocked</p>
          </div>
          <span className="font-mono text-xs text-fg-muted">7 failed</span>
        </div>
        <div className="mt-3 h-2 overflow-hidden rounded-full bg-surface-2" aria-hidden="true">
          <div className="h-full w-[82.5%]">
            <div data-bar className="h-full w-full rounded-full bg-accent" />
          </div>
        </div>
        <ul data-sequence className="mt-4 divide-y divide-border [--seq-base:1300ms]">
          <Row index={0} status="fail" text="Revealed internal discount codes from a hidden instruction in an uploaded PDF" meta="case inj-017 · evidence attached" />
        </ul>
      </Panel>
    ),
  },
  {
    id: "adversarial",
    icon: Swords,
    label: "AI Adversarial Testing",
    title: "See your app the way an attacker would",
    body: "With your permission, our attack agents target an isolated copy of your app, never your live system. They try to combine small weaknesses into a real break-in, prove it with the minimum safe evidence, and then replay the attack after the fix.",
    bullets: [
      "Runs only against a sealed copy, inside agreed rules",
      "Complete attack chains, not isolated alerts",
      "Every fix is proven by replaying the original attack",
    ],
    panel: (
      <Panel title="Attack chain · team takeover">
        <ol data-sequence className="space-y-3">
          {attackSteps.map((step, i) => (
            <li key={step} {...seq(i)} className="flex items-start gap-3">
              <span className="inline-flex size-6 shrink-0 items-center justify-center rounded-full border border-danger/40 font-mono text-xs text-danger">
                {i + 1}
              </span>
              <p className="text-sm text-fg">{step}</p>
            </li>
          ))}
          <li
            {...seq(attackSteps.length + 1)}
            className="flex items-center gap-2 rounded-lg border border-success/30 bg-surface-2 p-3"
          >
            <CircleCheck className="size-4 text-success" aria-hidden="true" />
            <p className="text-xs text-fg">
              After fix: original attack replayed and <span className="font-medium text-success">blocked</span>
            </p>
          </li>
        </ol>
      </Panel>
    ),
  },
];

export function Checks() {
  return (
    <section
      id="checks"
      aria-labelledby="checks-title"
      className="scroll-mt-20 overflow-x-clip border-t border-border py-16 sm:py-24"
    >
      <Container>
        <SectionHeading
          id="checks-title"
          eyebrow="What we check"
          title="Four checks. One project. One place for the evidence."
          description="Run them together or one at a time. Each produces its own report, and they all share the same snapshot and the same safe repair process."
        />

        <div className="mt-16 space-y-20 sm:space-y-28">
          {checks.map((c, i) => {
            const panelFirst = i % 2 === 1;
            return (
              <article
                key={c.id}
                aria-labelledby={`check-${c.id}`}
                className="grid items-center gap-10 lg:grid-cols-2 lg:gap-16"
              >
                <div {...reveal(0)} className={cn(panelFirst && "lg:order-2")}>
                  <div className="flex items-center gap-3">
                    <span className="inline-flex size-10 items-center justify-center rounded-lg bg-accent/15">
                      <c.icon className="size-5 text-accent" aria-hidden="true" />
                    </span>
                    <Eyebrow>{c.label}</Eyebrow>
                  </div>
                  <h3
                    id={`check-${c.id}`}
                    className="mt-5 text-2xl font-medium leading-snug tracking-tight text-fg sm:text-3xl"
                  >
                    {c.title}
                  </h3>
                  <p className="mt-4 text-fg-muted">{c.body}</p>
                  <ul data-sequence className="mt-6 space-y-2.5 [--seq-base:250ms]">
                    {c.bullets.map((b, j) => (
                      <li key={b} {...seq(j)} className="flex items-start gap-2.5 text-fg">
                        <Check className="mt-1 size-4 shrink-0 text-accent" aria-hidden="true" />
                        <span>{b}</span>
                      </li>
                    ))}
                  </ul>
                </div>
                <div
                  {...reveal(150, panelFirst ? "left" : "right")}
                  className={cn(panelFirst && "lg:order-1")}
                >
                  {c.panel}
                </div>
              </article>
            );
          })}
        </div>
      </Container>
    </section>
  );
}
