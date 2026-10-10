import { Lock } from "lucide-react";
import { ArrowIcon } from "@/components/ui/arrow-icon";
import { ButtonLink } from "@/components/ui/button";
import { ReportPreview } from "./report-preview";
import { Container, Eyebrow } from "./section";

export function Hero() {
  return (
    <section aria-labelledby="hero-title" className="relative overflow-hidden">
      {/* Faint dot grid, faded out towards the edges. */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 bg-[radial-gradient(var(--border)_1px,transparent_1px)] [background-size:28px_28px] [mask-image:radial-gradient(70%_60%_at_60%_30%,black,transparent)]"
      />
      <div
        aria-hidden="true"
        className="animate-breathe pointer-events-none absolute inset-x-0 top-0 h-140 bg-[radial-gradient(50%_60%_at_70%_0%,color-mix(in_srgb,var(--accent)_14%,transparent),transparent)]"
      />
      <Container className="relative grid items-center gap-14 py-16 sm:py-20 lg:grid-cols-[1.05fr_1fr] lg:gap-16 lg:py-28">
        <div>
          <Eyebrow className="animate-fade-up">
            Testing · Security · AI evaluation · Red team
          </Eyebrow>
          <h1
            id="hero-title"
            className="animate-fade-up mt-5 text-4xl font-medium leading-[1.1] tracking-tight text-fg [animation-delay:80ms] sm:text-5xl lg:text-[3.4rem]"
          >
            Find what&apos;s broken and what&apos;s exploitable{" "}
            <span className="text-accent">before your users or attackers do.</span>
          </h1>
          <p className="animate-fade-up mt-6 max-w-xl text-lg text-fg-muted [animation-delay:160ms]">
            Upload your project once. cybercheck tests it, checks its security,
            evaluates its AI, and safely attacks an isolated copy. Then it shows
            you the proof and a fix that has already been re-tested.
          </p>

          <div className="animate-fade-up mt-8 flex flex-col gap-3 [animation-delay:240ms] sm:flex-row">
            <ButtonLink href="/signup" size="lg">
              Get started
              <ArrowIcon />
            </ButtonLink>
            <ButtonLink href="#how-it-works" variant="outline" size="lg">
              See how it works
            </ButtonLink>
          </div>

          <p className="animate-fade-up mt-6 flex items-start gap-2 text-sm text-fg-muted [animation-delay:320ms]">
            <Lock className="mt-0.5 size-4 shrink-0 text-accent" aria-hidden="true" />
            Your real code is never changed without your approval. Every fix is
            tested in a sandbox first.
          </p>
        </div>

        <div className="animate-fade-up [animation-delay:200ms]">
          <ReportPreview />
        </div>
      </Container>
    </section>
  );
}
