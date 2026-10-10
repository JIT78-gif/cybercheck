import { Audience } from "@/components/marketing/audience";
import { Checks } from "@/components/marketing/checks";
import { Faq } from "@/components/marketing/faq";
import { FinalCta } from "@/components/marketing/final-cta";
import { Hero } from "@/components/marketing/hero";
import { HowItWorks } from "@/components/marketing/how-it-works";
import { Trust } from "@/components/marketing/trust";
import { WhyItMatters } from "@/components/marketing/why-it-matters";

export default function HomePage() {
  return (
    <>
      <Hero />
      <WhyItMatters />
      <HowItWorks />
      <Checks />
      <Trust />
      <Audience />
      <Faq />
      <FinalCta />
    </>
  );
}
