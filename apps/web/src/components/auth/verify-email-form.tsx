"use client";

import { useState, useSyncExternalStore } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { MailCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Alert, Field, Spinner } from "@/components/ui/form";
import { authClient, clearPendingEmail, getPendingEmail, setPendingEmail } from "@/lib/auth-client";
import { authErrorMessage } from "@/lib/auth-errors";
import { OtpInput } from "./otp-input";
import { useEmailDelivery, useResendCooldown } from "./use-resend-cooldown";

const noopSubscribe = () => () => {};

export function VerifyEmailForm() {
  const router = useRouter();
  // Email saved by the sign-up/sign-in step (read from sessionStorage; empty on the server).
  const pending = useSyncExternalStore(noopSubscribe, getPendingEmail, () => "");
  const [typedEmail, setTypedEmail] = useState("");
  const [sentTo, setSentTo] = useState<string | null>(null);
  const email = sentTo ?? (pending || typedEmail);
  const knownEmail = Boolean(sentTo || pending);

  const [code, setCode] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [resending, setResending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const cooldown = useResendCooldown(60);
  // A code was just sent only if we know the email; otherwise allow sending right away.
  const remaining = knownEmail ? cooldown.remaining : 0;
  const restart = cooldown.restart;
  const delivery = useEmailDelivery();

  async function verify(otp: string) {
    if (otp.length !== 6 || !email) return;
    setError(null);
    setInfo(null);
    setSubmitting(true);
    const { error } = await authClient.emailOtp.verifyEmail({ email: email.trim(), otp });
    if (error) {
      setError(authErrorMessage(error));
      setCode("");
      setSubmitting(false);
      return;
    }
    clearPendingEmail();
    router.replace("/app");
    router.refresh();
  }

  async function resend() {
    if (!email) return;
    setError(null);
    setInfo(null);
    setResending(true);
    const { error } = await authClient.emailOtp.sendVerificationOtp({
      email: email.trim(),
      type: "email-verification",
    });
    setResending(false);
    if (error) {
      setError(authErrorMessage(error));
      return;
    }
    setPendingEmail(email.trim());
    setSentTo(email.trim());
    setCode("");
    setInfo("A new code is on its way. Earlier codes no longer work.");
    restart(60);
  }

  return (
    <div>
      <span className="inline-flex size-12 items-center justify-center rounded-xl bg-accent/10 text-accent">
        <MailCheck className="size-6" aria-hidden="true" />
      </span>
      <h1 className="mt-5 text-2xl font-semibold tracking-tight text-fg">Check your email</h1>
      <p className="mt-2 text-sm text-fg-muted">
        {knownEmail ? (
          <>
            We sent a 6-digit code to <span className="font-medium text-fg">{email}</span>. It
            expires in 10 minutes.
          </>
        ) : (
          "Enter the email you signed up with, then send yourself a code."
        )}
      </p>

      <div className="mt-8 space-y-5">
        {!knownEmail && (
          <Field
            label="Email"
            type="email"
            autoComplete="email"
            inputMode="email"
            value={typedEmail}
            onChange={(e) => setTypedEmail(e.target.value)}
          />
        )}

        <div>
          <p id="otp-help" className="mb-2 text-sm font-medium text-fg">
            Verification code
          </p>
          <OtpInput
            value={code}
            onChange={setCode}
            onComplete={verify}
            disabled={submitting || !email}
            invalid={Boolean(error)}
            describedBy="otp-help"
          />
        </div>

        {delivery === "console" && (
          <Alert tone="info">
            Development mode: email sending isn&apos;t set up, so the code is printed in the API
            terminal (look for <span className="font-mono">[dev-mail]</span>).
          </Alert>
        )}
        {info && <Alert tone="success">{info}</Alert>}
        {error && <Alert>{error}</Alert>}

        <Button
          type="button"
          className="w-full"
          onClick={() => verify(code)}
          disabled={submitting || code.length !== 6 || !email}
        >
          {submitting && <Spinner />}
          {submitting ? "Verifying" : "Verify email"}
        </Button>

        <div className="flex items-center justify-between text-sm">
          <button
            type="button"
            onClick={resend}
            disabled={remaining > 0 || resending || !email}
            className="inline-flex min-h-11 cursor-pointer items-center gap-2 font-medium text-accent underline-offset-4 hover:underline disabled:cursor-not-allowed disabled:text-fg-muted disabled:no-underline"
          >
            {resending && <Spinner />}
            {remaining > 0 ? `Resend code in ${remaining}s` : "Resend code"}
          </button>
          <Link href="/signup" className="text-fg-muted underline-offset-4 hover:text-fg hover:underline">
            Use a different email
          </Link>
        </div>
      </div>
    </div>
  );
}
