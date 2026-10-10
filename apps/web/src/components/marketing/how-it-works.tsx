import {
  Camera,
  FileSearch,
  GitPullRequest,
  Hand,
  Boxes,
  Upload,
} from "lucide-react";
import { reveal } from "@/components/motion/reveal";
import { Container, SectionHeading } from "./section";

const steps = [
  {
    icon: Upload,
    title: "Add your project",
    body: "Upload a .zip or connect a GitHub repository. Confirm that you own the code or are allowed to assess it.",
  },
  {
    icon: Camera,
    title: "We freeze a snapshot",
    body: "We record the exact version we're checking, so every result points to the same code and nothing gets mixed up.",
  },
  {
    icon: Boxes,
    title: "Checks run in isolation",
    body: "Tests, security scans, AI evaluations, and attack simulations run in sealed sandboxes, never on your live systems.",
  },
  {
    icon: FileSearch,
    title: "You get a report with proof",
    body: "Each finding comes with evidence: logs, the failing step, the exact file, and how sure we are. Untested areas are listed too.",
  },
  {
    icon: Hand,
    title: "You choose what to fix",
    body: "Pick the findings you care about. Fixes are applied to a sandbox copy and re-tested, with up to three attempts, all visible.",
  },
  {
    icon: GitPullRequest,
    title: "Apply only when you're ready",
    body: "You get a verified patch and its test results. Applying it to your real project is a separate decision that stays yours.",
  },
];

export function HowItWorks() {
  return (
    <section
      id="how-it-works"
      aria-labelledby="how-title"
      className="scroll-mt-20 border-t border-border bg-surface/40 py-16 sm:py-24"
    >
      <Container>
        <SectionHeading
          id="how-title"
          eyebrow="How it works"
          title="Six steps from upload to a verified fix"
          description="You stay in control the whole way. Nothing touches your real code until you say so."
        />

        <ol className="mt-12 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {steps.map((s, i) => (
            <li key={s.title} {...reveal(i * 80)}>
              <div className="group relative h-full rounded-xl border border-border bg-surface p-6 transition duration-300 ease-out hover:-translate-y-1 hover:border-accent/40 hover:shadow-lg hover:shadow-black/30">
                <div className="flex items-center justify-between">
                  <span className="inline-flex size-10 items-center justify-center rounded-lg bg-surface-2 text-accent transition-colors duration-300 group-hover:bg-accent group-hover:text-primary-fg">
                    <s.icon className="size-5" aria-hidden="true" />
                  </span>
                  <span className="font-mono text-xs text-fg-muted transition-colors duration-300 group-hover:text-accent">
                    Step {String(i + 1).padStart(2, "0")}
                  </span>
                </div>
                <h3 className="mt-4 text-lg font-medium text-fg">{s.title}</h3>
                <p className="mt-2 text-fg-muted">{s.body}</p>
              </div>
            </li>
          ))}
        </ol>
      </Container>
    </section>
  );
}
