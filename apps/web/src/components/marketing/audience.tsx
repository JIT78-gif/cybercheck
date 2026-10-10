import { Building2, Code, Rocket, Sparkles } from "lucide-react";
import { reveal } from "@/components/motion/reveal";
import { Container, SectionHeading } from "./section";

const audiences = [
  {
    icon: Code,
    title: "Solo developers and founders",
    body: "Get the checks a full QA and security team would run, before you launch.",
  },
  {
    icon: Rocket,
    title: "Startups shipping fast",
    body: "Keep moving quickly without guessing whether the last change opened a hole.",
  },
  {
    icon: Sparkles,
    title: "Teams adding AI features",
    body: "Prove your chatbot or agent can't be tricked into leaking data or misusing tools.",
  },
  {
    icon: Building2,
    title: "Agencies and freelancers",
    body: "Hand clients a clear, evidence-backed report along with the code you deliver.",
  },
];

export function Audience() {
  return (
    <section aria-labelledby="audience-title" className="border-t border-border py-16 sm:py-24">
      <Container>
        <SectionHeading
          id="audience-title"
          eyebrow="Who it's for"
          title="For anyone who ships code people rely on"
        />
        <ul className="mt-12 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {audiences.map((a, i) => (
            <li key={a.title} {...reveal(i * 90)}>
              <div className="group h-full rounded-xl border border-border bg-surface p-6 transition duration-300 ease-out hover:-translate-y-1 hover:border-accent/40 hover:shadow-lg hover:shadow-black/30">
                <a.icon
                  className="size-5 text-accent transition-transform duration-300 group-hover:scale-110"
                  aria-hidden="true"
                />
                <h3 className="mt-4 font-medium text-fg">{a.title}</h3>
                <p className="mt-2 text-sm text-fg-muted">{a.body}</p>
              </div>
            </li>
          ))}
        </ul>
      </Container>
    </section>
  );
}
