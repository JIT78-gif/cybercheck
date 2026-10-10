"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Check, Circle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Alert, Field, PasswordField, Spinner } from "@/components/ui/form";
import { authClient, setPendingEmail } from "@/lib/auth-client";
import { authErrorMessage } from "@/lib/auth-errors";
import { cn } from "@/lib/cn";
import { Divider, SocialButtons } from "./social-buttons";

const MIN_PASSWORD = 10;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function SignupForm() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [touched, setTouched] = useState({ name: false, email: false, password: false });
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const errors = {
    name: name.trim() ? undefined : "Enter your name.",
    email: EMAIL_RE.test(email.trim()) ? undefined : "Enter a valid email, like you@company.com.",
    password:
      password.length >= MIN_PASSWORD ? undefined : `Use at least ${MIN_PASSWORD} characters.`,
  };
  const valid = !errors.name && !errors.email && !errors.password;

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setTouched({ name: true, email: true, password: true });
    if (!valid) return;
    setError(null);
    setSubmitting(true);
    const cleanEmail = email.trim();
    const { error } = await authClient.signUp.email({
      name: name.trim(),
      email: cleanEmail,
      password,
    });
    if (error) {
      setError(authErrorMessage(error));
      setSubmitting(false);
      return;
    }
    // Next keeps visited pages mounted (hidden) for back navigation; don't leave the password in it.
    setPassword("");
    setSubmitting(false);
    setPendingEmail(cleanEmail);
    router.push("/verify-email");
  }

  const rules = [
    { ok: password.length >= MIN_PASSWORD, text: `At least ${MIN_PASSWORD} characters` },
    { ok: password.length >= 14, text: "14+ characters is even stronger (optional)" },
  ];

  return (
    <div>
      <h1 className="text-2xl font-semibold tracking-tight text-fg">Create your account</h1>
      <p className="mt-2 text-sm text-fg-muted">
        Already have one?{" "}
        <Link href="/login" className="font-medium text-accent underline-offset-4 hover:underline">
          Sign in
        </Link>
      </p>

      <div className="mt-8 space-y-6">
        <SocialButtons />
        <Divider />

        <form onSubmit={onSubmit} noValidate className="space-y-4">
          <Field
            label="Full name"
            name="name"
            autoComplete="name"
            required
            value={name}
            onChange={(e) => setName(e.target.value)}
            onBlur={() => setTouched((t) => ({ ...t, name: true }))}
            error={touched.name ? errors.name : undefined}
            disabled={submitting}
          />
          <Field
            label="Work email"
            type="email"
            name="email"
            autoComplete="email"
            inputMode="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            onBlur={() => setTouched((t) => ({ ...t, email: true }))}
            error={touched.email ? errors.email : undefined}
            hint="We'll send a 6-digit code to confirm it's you."
            disabled={submitting}
          />
          <div>
            <PasswordField
              name="password"
              autoComplete="new-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              onBlur={() => setTouched((t) => ({ ...t, password: true }))}
              error={touched.password ? errors.password : undefined}
              disabled={submitting}
            />
            <ul className="mt-2 space-y-1" aria-label="Password requirements">
              {rules.map((r) => (
                <li
                  key={r.text}
                  className={cn(
                    "flex items-center gap-1.5 text-xs transition-colors duration-200",
                    r.ok ? "text-success" : "text-fg-muted",
                  )}
                >
                  {r.ok ? (
                    <Check className="size-3.5" aria-hidden="true" />
                  ) : (
                    <Circle className="size-3" aria-hidden="true" />
                  )}
                  <span>
                    {r.text}
                    <span className="sr-only">{r.ok ? " (met)" : " (not met)"}</span>
                  </span>
                </li>
              ))}
            </ul>
          </div>

          {error && <Alert>{error}</Alert>}
          <Button type="submit" className="w-full" disabled={submitting}>
            {submitting && <Spinner />}
            {submitting ? "Creating account" : "Create account"}
          </Button>
          <p className="text-center text-xs text-fg-muted">
            Your code is only analysed after you add a project and confirm you&apos;re
            allowed to assess it.
          </p>
        </form>
      </div>
    </div>
  );
}
