import { ChevronDown } from "lucide-react";
import { reveal } from "@/components/motion/reveal";
import { Container, SectionHeading } from "./section";

const faqs = [
  {
    q: "Will cybercheck change my code?",
    a: "Not unless you ask it to. Analysis is read-only. When you approve a fix, it is made on a sandbox copy and re-tested. You then get a patch, and applying it to your real project is a separate step you control.",
  },
  {
    q: "Is my code safe with you?",
    a: "Your project runs only inside isolated sandboxes, separate from other customers. Secrets and personal data are redacted before anything is shown in a report or sent to an AI model.",
  },
  {
    q: "Which languages and frameworks are supported?",
    a: "The first release focuses on Node.js and TypeScript web apps and APIs. You can still upload other projects, and we'll tell you clearly which checks can and can't run.",
  },
  {
    q: "Do I need to have tests already?",
    a: "No. We discover what exists, run it, and show which parts of your app are untested. We can also propose new tests as part of a fix.",
  },
  {
    q: "What is a sandbox?",
    a: "A sealed, temporary computer environment created just for your check. It has no access to your live systems or real credentials, and it is destroyed afterwards.",
  },
  {
    q: "Will you attack my live website?",
    a: "No. Adversarial testing only targets an isolated copy of your app that we deploy ourselves, using test data and rules you approve.",
  },
  {
    q: "How do I add my project?",
    a: "Sign in, then upload a .zip or .tar.gz of your code, or connect your GitHub account and pick a repository and branch.",
  },
];

export function Faq() {
  return (
    <section
      id="faq"
      aria-labelledby="faq-title"
      className="scroll-mt-20 border-t border-border bg-surface/40 py-16 sm:py-24"
    >
      <Container className="grid gap-12 lg:grid-cols-[1fr_1.6fr]">
        <SectionHeading
          id="faq-title"
          eyebrow="FAQ"
          title="Questions people ask before they upload"
        />
        <div
          {...reveal(120)}
          className="divide-y divide-border rounded-xl border border-border bg-surface"
        >
          {faqs.map((f) => (
            <details key={f.q} className="group px-5 [&_summary::-webkit-details-marker]:hidden">
              <summary className="flex min-h-14 cursor-pointer list-none items-center justify-between gap-4 py-4 font-medium text-fg transition-colors duration-200 hover:text-accent">
                {f.q}
                <ChevronDown
                  className="size-4 shrink-0 text-fg-muted transition-transform duration-200 group-open:rotate-180"
                  aria-hidden="true"
                />
              </summary>
              <p className="faq-answer pb-5 text-fg-muted">{f.a}</p>
            </details>
          ))}
        </div>
      </Container>
    </section>
  );
}
