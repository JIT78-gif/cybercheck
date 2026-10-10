"use client";

import { useEffect, useState } from "react";
import { authClient, safeNextPath, type AuthProviders } from "@/lib/auth-client";
import { authErrorMessage } from "@/lib/auth-errors";
import { Alert, Spinner } from "@/components/ui/form";
import { GitHubIcon, GoogleIcon } from "./provider-icons";

type Provider = "google" | "github";

const labels: Record<Provider, string> = { google: "Google", github: "GitHub" };

export function SocialButtons({ next }: { next?: string | null }) {
  const [providers, setProviders] = useState<AuthProviders | null>(null);
  const [pending, setPending] = useState<Provider | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/v1/auth/providers")
      .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
      .then((p: AuthProviders) => !cancelled && setProviders(p))
      .catch(() => !cancelled && setProviders({ google: false, github: false, emailDelivery: "console" }));
    return () => {
      cancelled = true;
    };
  }, []);

  async function signIn(provider: Provider) {
    setError(null);
    setPending(provider);
    const origin = window.location.origin;
    const { error } = await authClient.signIn.social({
      provider,
      callbackURL: origin + safeNextPath(next),
      errorCallbackURL: `${origin}/login?error=oauth`,
    });
    // On success the browser is redirected to the provider; we only get here on error.
    if (error) {
      setError(authErrorMessage(error));
      setPending(null);
    }
  }

  return (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-2">
        {(Object.keys(labels) as Provider[]).map((p) => {
          const loading = providers === null;
          const enabled = providers?.[p] ?? false;
          const Icon = p === "google" ? GoogleIcon : GitHubIcon;
          return (
            <button
              key={p}
              type="button"
              onClick={() => signIn(p)}
              disabled={!enabled || pending !== null}
              aria-describedby={!loading && !enabled ? `${p}-unavailable` : undefined}
              className="inline-flex h-11 cursor-pointer items-center justify-center gap-2.5 rounded-md border border-border bg-surface px-4 text-sm font-medium text-fg transition duration-200 hover:border-fg/20 hover:bg-surface-2 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50"
            >
              {pending === p ? <Spinner /> : <Icon className="size-4.5" />}
              {labels[p]}
            </button>
          );
        })}
      </div>
      {providers && (!providers.google || !providers.github) && (
        <p className="text-xs text-fg-muted">
          {!providers.google && (
            <span id="google-unavailable">Google sign-in isn&apos;t set up yet. </span>
          )}
          {!providers.github && (
            <span id="github-unavailable">GitHub sign-in isn&apos;t set up yet. </span>
          )}
          Use your email for now.
        </p>
      )}
      {error && <Alert>{error}</Alert>}
    </div>
  );
}

export function Divider({ label = "or continue with email" }: { label?: string }) {
  return (
    <div className="flex items-center gap-3" role="separator" aria-label={label}>
      <span className="h-px flex-1 bg-border" />
      <span className="text-xs text-fg-muted">{label}</span>
      <span className="h-px flex-1 bg-border" />
    </div>
  );
}
