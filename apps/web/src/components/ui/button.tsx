import Link from "next/link";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/cn";

export const buttonVariants = cva(
  "group inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md font-medium transition duration-200 ease-out cursor-pointer active:scale-[0.98] disabled:pointer-events-none disabled:opacity-50 [&_svg]:size-4 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        primary: "bg-primary text-primary-fg hover:opacity-90",
        outline:
          "border border-border bg-transparent text-fg hover:bg-surface-2",
        ghost: "bg-transparent text-fg-muted hover:text-fg hover:bg-surface-2",
      },
      size: {
        sm: "h-9 px-3 text-sm",
        md: "h-11 px-4 text-sm",
        lg: "h-12 px-6 text-base",
        icon: "size-10 p-0",
      },
      shape: {
        default: "",
        pill: "rounded-full",
      },
    },
    compoundVariants: [
      { shape: "pill", size: "sm", className: "px-4" },
      { shape: "pill", size: "md", className: "px-5" },
    ],
    defaultVariants: { variant: "primary", size: "md", shape: "default" },
  },
);

type ButtonVariantProps = VariantProps<typeof buttonVariants>;

export function Button({
  className,
  variant,
  size,
  shape,
  ...props
}: React.ComponentProps<"button"> & ButtonVariantProps) {
  return (
    <button
      className={cn(buttonVariants({ variant, size, shape }), className)}
      {...props}
    />
  );
}

export function ButtonLink({
  className,
  variant,
  size,
  shape,
  ...props
}: React.ComponentProps<typeof Link> & ButtonVariantProps) {
  return (
    <Link
      className={cn(buttonVariants({ variant, size, shape }), className)}
      {...props}
    />
  );
}
