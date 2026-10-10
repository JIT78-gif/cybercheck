import Link from "next/link";
import { brand } from "@/config/brand";
import { cn } from "@/lib/cn";

export function LogoMark({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 32 32"
      aria-hidden="true"
      className={cn("size-8", className)}
    >
      <rect width="32" height="32" rx="8" className="fill-primary" />
      <path
        d="M16 6.5 9 9.3v6.1c0 4.6 3 8.3 7 9.6 4-1.3 7-5 7-9.6V9.3l-7-2.8Z"
        fill="none"
        className="stroke-primary-fg"
        strokeWidth="1.9"
        strokeLinejoin="round"
      />
      <path
        d="m12.7 15.8 2.4 2.4 4.3-4.6"
        fill="none"
        className="stroke-primary-fg"
        strokeWidth="1.9"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function Logo({
  href = "/",
  className,
}: {
  href?: string;
  className?: string;
}) {
  return (
    <Link
      href={href}
      className={cn("inline-flex items-center gap-2.5 rounded-md", className)}
      aria-label={`${brand.name} home`}
    >
      <LogoMark />
      <span className="text-lg font-semibold tracking-tight text-fg">
        {brand.name}
      </span>
    </Link>
  );
}
