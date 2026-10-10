"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Alert, Field, PasswordField, Spinner } from "@/components/ui/form";
import { authClient, safeNextPath, setPendingEmail } from "@/lib/auth-client";
import { authErrorMessage } from "@/lib/auth-errors";
import { Divider, SocialButtons } from "./social-buttons";

export function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const next = params.get("next");
  const notice =
    params.get("reset") === "1"
      ? "Your password was changed. Sign in with your new password."
      : null;
  const oauthError =
    params.get("error") === "oauth"
      ? "Sign-in with that provider didn't complete. Please try again, or use your email."
      : null;

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(oauthError);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    const { error } = await authClient.signIn.email({ email: email.trim(), password });
    if (!error || error.code === "EMAIL_NOT_VERIFIED") {
      // Next keeps visited pages mounted (hidden); don't leave the password in it.
      setPassword("");
      setSubmitting(false);
    }
    if (!error) {
      router.replace(safeNextPath(next));
      router.refresh();
      return;
    }
    if (error.code === "EMAIL_NOT_VERIFIED") {
      // A fresh code was sent on this sign-in attempt; finish verification.
      setPendingEmail(email.trim());
      router.push("/verify-email");
      return;
    }
    setError(authErrorMessage(error));
    setSubmitting(false);
  }

  return (
    <div>
      <h1 className="text-2xl font-semibold tracking-tight text-fg">Sign in to cybercheck</h1>
      <p className="mt-2 text-sm text-fg-muted">
        New here?{" "}
        <Link href="/signup" className="font-medium text-accent underline-offset-4 hover:underline">
          Create an account
        </Link>
      </p>

      <div className="mt-8 space-y-6">
        {notice && <Alert tone="success">{notice}</Alert>}
        <SocialButtons next={next} />
        <Divider />

        <form onSubmit={onSubmit} noValidate className="space-y-4">
          <Field
            label="Email"
            type="email"
            name="email"
            autoComplete="email"
            inputMode="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            disabled={submitting}
          />
          <PasswordField
            name="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            disabled={submitting}
            labelAction={
              <Link
                href="/forgot-password"
                className="text-xs font-medium text-accent underline-offset-4 hover:underline"
              >
                Forgot password?
              </Link>
            }
          />
          {error && <Alert>{error}</Alert>}
          <Button type="submit" className="w-full" disabled={submitting || !email || !password}>
            {submitting && <Spinner />}
            {submitting ? "Signing in" : "Sign in"}
          </Button>
        </form>
      </div>
    </div>
  );
}
