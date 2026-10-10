import { reveal } from "@/components/motion/reveal";
import { cn } from "@/lib/cn";

export function Container({
  className,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div
      className={cn("mx-auto w-full max-w-300 px-4 sm:px-6 lg:px-8", className)}
      {...props}
    />
  );
}

export function Eyebrow({
  className,
  ...props
}: React.ComponentProps<"p">) {
  return (
    <p
      className={cn(
        "font-mono text-xs font-medium uppercase tracking-[0.08em] text-accent",
        className,
      )}
      {...props}
    />
  );
}

export function SectionHeading({
  eyebrow,
  title,
  description,
  id,
  align = "left",
}: {
  eyebrow: string;
  title: string;
  description?: string;
  id?: string;
  align?: "left" | "center";
}) {
  return (
    <div
      {...reveal()}
      className={cn(
        "max-w-2xl",
        align === "center" && "mx-auto text-center",
      )}
    >
      <Eyebrow>{eyebrow}</Eyebrow>
      <h2
        id={id}
        className="mt-3 text-3xl font-medium leading-tight tracking-tight text-fg sm:text-4xl"
      >
        {title}
      </h2>
      {description && (
        <p className="mt-4 text-base text-fg-muted sm:text-lg">{description}</p>
      )}
    </div>
  );
}
