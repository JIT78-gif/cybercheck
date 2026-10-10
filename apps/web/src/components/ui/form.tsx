"use client";

import { useId, useState } from "react";
import { CircleAlert, CircleCheck, Eye, EyeOff, Info, LoaderCircle } from "lucide-react";
import { cn } from "@/lib/cn";

const inputBase =
  "block h-11 w-full rounded-md border bg-surface px-3 text-base text-fg placeholder:text-fg-muted/70 transition-colors duration-200 focus:outline-none focus-visible:outline-2 focus-visible:outline-offset-0 focus-visible:outline-ring disabled:cursor-not-allowed disabled:opacity-60 sm:text-sm";

type FieldProps = Omit<React.ComponentProps<"input">, "id"> & {
  label: string;
  hint?: string;
  error?: string;
  labelAction?: React.ReactNode;
};

export function Field({ label, hint, error, labelAction, className, ...props }: FieldProps) {
  const id = useId();
  const describedBy = [hint && `${id}-hint`, error && `${id}-error`].filter(Boolean).join(" ") || undefined;
  return (
    <div className={className}>
      <div className="mb-1.5 flex items-center justify-between gap-2">
        <label htmlFor={id} className="text-sm font-medium text-fg">
          {label}
        </label>
        {labelAction}
      </div>
      <input
        id={id}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy}
        className={cn(inputBase, error ? "border-danger" : "border-border")}
        {...props}
      />
      {hint && !error && (
        <p id={`${id}-hint`} className="mt-1.5 text-xs text-fg-muted">
          {hint}
        </p>
      )}
      {error && (
        <p id={`${id}-error`} className="mt-1.5 flex items-start gap-1.5 text-xs text-danger" role="alert">
          <CircleAlert className="mt-px size-3.5 shrink-0" aria-hidden="true" />
          {error}
        </p>
      )}
    </div>
  );
}

export function PasswordField({
  label = "Password",
  ...props
}: Omit<FieldProps, "type" | "label"> & { label?: string }) {
  const id = useId();
  const [visible, setVisible] = useState(false);
  const { hint, error, labelAction, className, ...inputProps } = props;
  const describedBy = [hint && `${id}-hint`, error && `${id}-error`].filter(Boolean).join(" ") || undefined;
  return (
    <div className={className}>
      <div className="mb-1.5 flex items-center justify-between gap-2">
        <label htmlFor={id} className="text-sm font-medium text-fg">
          {label}
        </label>
        {labelAction}
      </div>
      <div className="relative">
        <input
          id={id}
          type={visible ? "text" : "password"}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy}
          className={cn(inputBase, "pr-11", error ? "border-danger" : "border-border")}
          {...inputProps}
        />
        <button
          type="button"
          onClick={() => setVisible((v) => !v)}
          className="absolute inset-y-0 right-0 inline-flex w-11 cursor-pointer items-center justify-center rounded-r-md text-fg-muted transition-colors hover:text-fg"
          aria-label={visible ? "Hide password" : "Show password"}
          aria-pressed={visible}
        >
          {visible ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
        </button>
      </div>
      {hint && !error && (
        <p id={`${id}-hint`} className="mt-1.5 text-xs text-fg-muted">
          {hint}
        </p>
      )}
      {error && (
        <p id={`${id}-error`} className="mt-1.5 flex items-start gap-1.5 text-xs text-danger" role="alert">
          <CircleAlert className="mt-px size-3.5 shrink-0" aria-hidden="true" />
          {error}
        </p>
      )}
    </div>
  );
}

export function Alert({
  tone = "error",
  children,
  className,
}: {
  tone?: "error" | "success" | "info";
  children: React.ReactNode;
  className?: string;
}) {
  const Icon = tone === "error" ? CircleAlert : tone === "success" ? CircleCheck : Info;
  return (
    <div
      role={tone === "error" ? "alert" : "status"}
      aria-live={tone === "error" ? "assertive" : "polite"}
      className={cn(
        "animate-fade-up flex items-start gap-2.5 rounded-lg border px-3.5 py-3 text-sm",
        tone === "error" && "border-danger/30 bg-danger/5 text-danger",
        tone === "success" && "border-success/30 bg-success/5 text-success",
        tone === "info" && "border-accent/30 bg-accent/5 text-fg",
        className,
      )}
    >
      <Icon className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
      <div className="min-w-0">{children}</div>
    </div>
  );
}

export function Spinner({ className }: { className?: string }) {
  return <LoaderCircle className={cn("size-4 animate-spin", className)} aria-hidden="true" />;
}
