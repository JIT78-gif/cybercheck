"use client";

import { useRef } from "react";
import { cn } from "@/lib/cn";

const LENGTH = 6;

/** Six single-digit boxes that behave like one field: typing advances, paste fills all. */
export function OtpInput({
  value,
  onChange,
  onComplete,
  disabled,
  invalid,
  describedBy,
}: {
  value: string;
  onChange: (value: string) => void;
  onComplete?: (value: string) => void;
  disabled?: boolean;
  invalid?: boolean;
  describedBy?: string;
}) {
  const refs = useRef<Array<HTMLInputElement | null>>([]);
  const digits = Array.from({ length: LENGTH }, (_, i) => value[i] ?? "");

  function update(next: string) {
    const clean = next.replace(/\D/g, "").slice(0, LENGTH);
    onChange(clean);
    if (clean.length === LENGTH) onComplete?.(clean);
    return clean;
  }

  function focus(i: number) {
    refs.current[Math.max(0, Math.min(LENGTH - 1, i))]?.focus();
  }

  return (
    <div
      role="group"
      aria-label="6-digit verification code"
      aria-describedby={describedBy}
      className="flex justify-between gap-2"
    >
      {digits.map((d, i) => (
        <input
          key={i}
          ref={(el) => {
            refs.current[i] = el;
          }}
          inputMode="numeric"
          autoComplete={i === 0 ? "one-time-code" : "off"}
          pattern="[0-9]*"
          maxLength={LENGTH}
          aria-label={`Digit ${i + 1}`}
          aria-invalid={invalid ? true : undefined}
          disabled={disabled}
          value={d}
          onFocus={(e) => e.currentTarget.select()}
          onChange={(e) => {
            const typed = e.target.value.replace(/\D/g, "");
            if (!typed) return;
            // Typing (or autofill) at box i replaces from i onwards.
            const next = update(value.slice(0, i) + typed);
            focus(Math.min(next.length, LENGTH - 1));
          }}
          onKeyDown={(e) => {
            if (e.key === "Backspace") {
              e.preventDefault();
              if (d) update(value.slice(0, i) + value.slice(i + 1));
              else if (i > 0) {
                update(value.slice(0, i - 1) + value.slice(i));
                focus(i - 1);
              }
            } else if (e.key === "ArrowLeft") {
              e.preventDefault();
              focus(i - 1);
            } else if (e.key === "ArrowRight") {
              e.preventDefault();
              focus(i + 1);
            }
          }}
          onPaste={(e) => {
            e.preventDefault();
            const next = update(e.clipboardData.getData("text"));
            focus(Math.min(next.length, LENGTH - 1));
          }}
          className={cn(
            "h-14 w-full min-w-0 rounded-lg border bg-surface text-center font-mono text-2xl text-fg transition duration-200 focus:outline-none focus-visible:outline-2 focus-visible:outline-offset-0 focus-visible:outline-ring disabled:opacity-60",
            invalid ? "border-danger" : d ? "border-accent/60" : "border-border",
          )}
        />
      ))}
    </div>
  );
}
