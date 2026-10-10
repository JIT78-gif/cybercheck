"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { KeyRound } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Alert, Field, PasswordField, Spinner } from "@/components/ui/form";
import { authClient } from "@/lib/auth-client";
import { authErrorMessage } from "@/lib/auth-errors";
import { OtpInput } from "./otp-input";
import { useEmailDelivery, useResendCooldown } from "./use-resend-cooldown";

const MIN_PASSWORD = 10;

export function ForgotPasswordForm() {
  const router = useRouter();
  const [step, setStep] = useState<"email" | "reset">("email");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { remaining, restart } = useResendCooldown(0);
  const delivery = useEmailDelivery();

  async function sendCode(e?: React.FormEvent) {
    e?.preventDefault();
    if (!email.trim()) return;
    setError(null);
    setSubmitting(true);
    const { error } = await authClient.emailOtp.requestPasswordReset({ email: email.trim() });
    setSubmitting(false);
    if (error) {
      setError(authErrorMessage(error));
      return;
    }
    setStep("reset");
    setCode("");
    restart(60);
  }

  async function resetPassword(e: React.FormEvent) {
    e.preventDefault();
    if (code.length !== 6 || password.length < MIN_PASSWORD) return;
    setError(null);
    setSubmitting(true);
    const { error } = await authClient.emailOtp.resetPassword({
      email: email.trim(),
      otp: code,
      password,
    });
    if (error) {
      setError(authErrorMessage(error));
      setSubmitting(false);
      return;
    }
    // Next keeps visited pages mounted (hidden); reset the form so no password or code lingers.
    setPassword("");
    setCode("");
    setStep("email");
    setSubmitting(false);
    router.replace("/login?reset=1");
  }

  return (
    <div>
      <span className="inline-flex size-12 items-center justify-center rounded-xl bg-accent/10 text-accent">
        <KeyRound className="size-6" aria-hidden="true" />
      </span>
      <h1 className="mt-5 text-2xl font-semibold tracking-tight text-fg">Reset your password</h1>

      {step === "email" ? (
        <form onSubmit={sendCode} noValidate className="mt-8 space-y-5">
          <p className="text-sm text-fg-muted">
            Enter your account email. If it exists, we&apos;ll send a 6-digit code to reset your
            password.
          </p>
          <Field
            label="Email"
            type="email"
            autoComplete="email"
            inputMode="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            disabled={submitting}
          />
          {error && <Alert>{error}</Alert>}
          <Button type="submit" className="w-full" disabled={submitting || !email.trim()}>
            {submitting && <Spinner />}
            {submitting ? "Sending code" : "Send reset code"}
          </Button>
        </form>
      ) : (
        <form onSubmit={resetPassword} noValidate className="mt-8 space-y-5">
          <p className="text-sm text-fg-muted">
            If an account exists for <span className="font-medium text-fg">{email}</span>, a code is
            on its way. It expires in 10 minutes.
          </p>
          <div>
            <p id="reset-otp-help" className="mb-2 text-sm font-medium text-fg">
              Reset code
            </p>
            <OtpInput
              value={code}
              onChange={setCode}
              disabled={submitting}
              invalid={Boolean(error)}
              describedBy="reset-otp-help"
            />
          </div>
          <PasswordField
            label="New password"
            autoComplete="new-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            hint={`At least ${MIN_PASSWORD} characters. You'll be signed out on other devices.`}
            disabled={submitting}
          />
          {delivery === "console" && (
            <Alert tone="info">
              Development mode: the code is printed in the API terminal (
              <span className="font-mono">[dev-mail]</span>).
            </Alert>
          )}
          {error && <Alert>{error}</Alert>}
          <Button
            type="submit"
            className="w-full"
            disabled={submitting || code.length !== 6 || password.length < MIN_PASSWORD}
          >
            {submitting && <Spinner />}
            {submitting ? "Saving" : "Set new password"}
          </Button>
          <button
            type="button"
            onClick={() => sendCode()}
            disabled={remaining > 0 || submitting}
            className="inline-flex min-h-11 cursor-pointer items-center text-sm font-medium text-accent underline-offset-4 hover:underline disabled:cursor-not-allowed disabled:text-fg-muted disabled:no-underline"
          >
            {remaining > 0 ? `Resend code in ${remaining}s` : "Resend code"}
          </button>
        </form>
      )}

      <p className="mt-6 text-sm text-fg-muted">
        Remembered it?{" "}
        <Link href="/login" className="font-medium text-accent underline-offset-4 hover:underline">
          Back to sign in
        </Link>
      </p>
    </div>
  );
}
