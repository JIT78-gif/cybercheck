import { ArrowRight } from "lucide-react";

/** Arrow for CTA buttons; nudges right when the parent button (`group`) is hovered. */
export function ArrowIcon() {
  return (
    <ArrowRight
      aria-hidden="true"
      className="transition-transform duration-200 ease-out group-hover:translate-x-1"
    />
  );
}
