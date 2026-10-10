import {
  Ban,
  Eye,
  FileCheck2,
  ListChecks,
  Lock,
  RotateCcw,
} from "lucide-react";
import { reveal } from "@/components/motion/reveal";
import { Container, SectionHeading } from "./section";

const promises = [
  {
    icon: Eye,
    title: "Read-only by default",
    body: "Analysis never modifies your project. We work from a frozen snapshot.",
  },
  {
    icon: Lock,
    title: "Fixes happen in a sandbox",
    body: "Repairs are made on an isolated copy, never on your original code or live systems.",
  },
  {
    icon: FileCheck2,
    title: "Every claim has evidence",
    body: "Findings link to logs, test results, and file locations you can check yourself.",
  },
  {
    icon: ListChecks,
    title: "Nothing is hidden",
    body: "Failed, blocked, and untested areas are always shown. We never say “everything passed” unless it did.",
  },
  {
    icon: RotateCcw,
    title: "Bounded repair attempts",
    body: "At most three attempts per fix. If it can't be fixed safely, we tell you why.",
  },
  {
    icon: Ban,
    title: "No attacks on live systems",
    body: "Adversarial testing only targets an isolated copy we deploy, inside rules you approve.",
  },
];

export function Trust() {
  return (
    <section
      id="safety"
      aria-labelledby="safety-title"
      className="scroll-mt-20 border-t border-border bg-surface/40 py-16 sm:py-24"
    >
      <Container>
        <SectionHeading
          id="safety-title"
          eyebrow="Safety"
          title="Built so you never have to trust us blindly"
          description="A tool that checks your code has to be careful with it. These rules are part of how cybercheck works, not optional settings."
        />
        <ul className="mt-12 grid gap-x-10 gap-y-8 sm:grid-cols-2 lg:grid-cols-3">
          {promises.map((p, i) => (
            <li key={p.title} {...reveal(i * 70)} className="group flex gap-4">
              <span className="inline-flex size-10 shrink-0 items-center justify-center rounded-lg border border-border bg-surface text-accent transition-colors duration-300 group-hover:border-accent/50 group-hover:bg-accent group-hover:text-primary-fg">
                <p.icon className="size-5" aria-hidden="true" />
              </span>
              <div>
                <h3 className="font-medium text-fg">{p.title}</h3>
                <p className="mt-1 text-fg-muted">{p.body}</p>
              </div>
            </li>
          ))}
        </ul>
      </Container>
    </section>
  );
}
