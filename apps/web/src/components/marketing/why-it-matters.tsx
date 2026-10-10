import { Bug, KeyRound, Route, BotMessageSquare } from "lucide-react";
import { reveal } from "@/components/motion/reveal";
import { Container, SectionHeading } from "./section";

const risks = [
  {
    icon: Bug,
    title: "Releases that break for real users",
    body: "Code that works on your laptop can fail at checkout, on mobile, or under load. Paths nobody tested are the ones customers find first.",
  },
  {
    icon: KeyRound,
    title: "Leaked keys and private data",
    body: "One committed API key or one endpoint that forgets to check who is asking can expose customer data and run up your bill.",
  },
  {
    icon: Route,
    title: "Small mistakes chained into a breach",
    body: "Attackers rarely need one huge bug. A guessable ID plus a missing permission check is often enough to take over accounts.",
  },
  {
    icon: BotMessageSquare,
    title: "AI features that can be talked into anything",
    body: "Chatbots and agents can be tricked by hidden instructions into revealing data or using tools they should never touch.",
  },
];

export function WhyItMatters() {
  return (
    <section aria-labelledby="why-title" className="border-t border-border py-16 sm:py-24">
      <Container>
        <SectionHeading
          id="why-title"
          eyebrow="Why it matters"
          title="What goes wrong when nobody checks"
          description="Most teams don't have a QA team, a security team, and an AI red team. These are the problems that slip through, and they are usually found by customers or attackers, not by you."
        />

        <ul className="mt-12 grid gap-4 sm:grid-cols-2">
          {risks.map((r, i) => (
            <li key={r.title} {...reveal(i * 90)}>
              <div className="group h-full rounded-xl border border-border bg-surface p-6 transition duration-300 ease-out hover:-translate-y-1 hover:border-warning/40 hover:shadow-lg hover:shadow-black/30">
                <span className="inline-flex size-10 items-center justify-center rounded-lg border border-border bg-surface-2 transition-transform duration-300 group-hover:scale-110">
                  <r.icon className="size-5 text-warning" aria-hidden="true" />
                </span>
                <h3 className="mt-4 text-lg font-medium text-fg">{r.title}</h3>
                <p className="mt-2 text-fg-muted">{r.body}</p>
              </div>
            </li>
          ))}
        </ul>

        <p {...reveal(100)} className="mt-10 max-w-3xl text-lg text-fg">
          cybercheck brings all four perspectives together in one place, and it
          backs every finding with evidence you can check yourself.
        </p>
      </Container>
    </section>
  );
}
