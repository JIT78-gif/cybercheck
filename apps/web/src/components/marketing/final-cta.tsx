import { reveal } from "@/components/motion/reveal";
import { ArrowIcon } from "@/components/ui/arrow-icon";
import { ButtonLink } from "@/components/ui/button";
import { Container } from "./section";

export function FinalCta() {
  return (
    <section
      aria-labelledby="cta-title"
      className="relative overflow-hidden border-t border-border py-20 sm:py-28"
    >
      <div
        aria-hidden="true"
        className="animate-breathe pointer-events-none absolute inset-0 bg-[radial-gradient(45%_60%_at_50%_100%,color-mix(in_srgb,var(--accent)_14%,transparent),transparent)]"
      />
      <Container className="relative text-center">
        <h2
          id="cta-title"
          {...reveal()}
          className="mx-auto max-w-3xl text-3xl font-medium leading-tight tracking-tight text-fg sm:text-5xl"
        >
          See what&apos;s hiding in your code,{" "}
          <span className="text-accent">with proof.</span>
        </h2>
        <p {...reveal(100)} className="mx-auto mt-5 max-w-xl text-lg text-fg-muted">
          Add your project in a couple of minutes. You decide what gets checked
          and what gets fixed.
        </p>
        <div
          {...reveal(200)}
          className="mt-8 flex flex-col justify-center gap-3 sm:flex-row"
        >
          <ButtonLink href="/signup" size="lg">
            Get started
            <ArrowIcon />
          </ButtonLink>
          <ButtonLink href="/login" variant="outline" size="lg">
            I already have an account
          </ButtonLink>
        </div>
      </Container>
    </section>
  );
}
