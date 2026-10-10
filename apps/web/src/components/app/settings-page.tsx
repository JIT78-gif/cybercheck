"use client";

import { useCallback, useEffect, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { CircleCheck, Info, KeyRound, Link2, Mail, Unlink } from "lucide-react";
import { GitHubIcon, GoogleIcon } from "@/components/auth/provider-icons";
import { Button } from "@/components/ui/button";
import { Alert, Spinner } from "@/components/ui/form";
import { authClient, type AuthProviders } from "@/lib/auth-client";
import { authErrorMessage } from "@/lib/auth-errors";
import { api } from "@/lib/api";
import type { GithubStatus } from "@cybercheck/contracts";
import { rememberGithubReturn } from "@/components/intake/github-import";
import { useAppData } from "./app-data";
import { Card, CardTitle, PageHeader } from "./ui";

type LinkedAccount = { id: string; providerId: string; accountId: string; scopes?: string[] };
type Social = "google" | "github";

const SOCIAL: Array<{ id: Social; label: string; icon: typeof GoogleIcon; why: string }> = [
  {
    id: "google",
    label: "Google",
    icon: GoogleIcon,
    why: "Sign in with your Google account.",
  },
  {
    id: "github",
    label: "GitHub",
    icon: GitHubIcon,
    why: "Sign in with GitHub and import repositories as projects. You choose which repositories cybercheck can read, and access is read-only.",
  },
];

/** Better Auth reports linking failures as ?error=<code> on the return URL. */
function linkErrorMessage(code: string) {
  const c = code.toLowerCase();
  if (c.includes("already_linked") || c.includes("linked_to_a_different_user") || c.includes("different_user")) {
    return "That account is already connected to a different cybercheck user. Sign in to that user and disconnect it there first.";
  }
  if (c.includes("access_denied")) return "Connection cancelled. Nothing was changed.";
  if (c.includes("unable_to_link")) return "We couldn't connect that account. Please try again.";
  return "The connection didn't complete. Please try again.";
}

/** Repository access through the GitHub App: where it's installed and how to change it. */
function GithubAccess({ status, onReconnect }: { status: GithubStatus; onReconnect: () => void }) {
  if (!status.configured) return null;
  if (!status.authorized) {
    return (
      <p className="mt-2 text-sm text-warning">
        This connection needs renewing before repositories can be listed.{" "}
        <button type="button" onClick={onReconnect} className="cursor-pointer font-medium underline underline-offset-4">
          Reconnect GitHub
        </button>
      </p>
    );
  }
  return (
    <div className="mt-2 space-y-1 text-sm">
      {status.login && <p className="text-fg">Signed in to GitHub as <span className="font-medium">@{status.login}</span></p>}
      {status.installations.length > 0 ? (
        <ul className="space-y-1">
          {status.installations.map((i) => (
            <li key={i.id} className="text-fg-muted">
              Can read {i.selection === "all" ? "all repositories" : "selected repositories"} of <span className="text-fg">{i.account.login}</span>
              {" · "}
              <a href={i.settingsUrl} target="_blank" rel="noreferrer" className="font-medium text-accent hover:underline">
                Manage repository access
              </a>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-fg-muted">
          No repositories shared yet.{" "}
          {status.installUrl && (
            <a
              href={status.installUrl}
              onClick={() => rememberGithubReturn("/app/projects")}
              className="font-medium text-accent hover:underline"
            >
              Install on GitHub
            </a>
          )}
        </p>
      )}
    </div>
  );
}

export function SettingsPage() {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const { me, workspace } = useAppData();
  const [accounts, setAccounts] = useState<LinkedAccount[] | null>(null);
  const [providers, setProviders] = useState<AuthProviders | null>(null);
  const [githubStatus, setGithubStatus] = useState<GithubStatus | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const linked = params.get("linked");
  const linkError = params.get("error");
  const notice = linked === "github" || linked === "google" ? `${linked === "github" ? "GitHub" : "Google"} is now connected.` : null;

  const load = useCallback(async () => {
    const { data, error } = await authClient.listAccounts();
    if (error) setError(authErrorMessage(error));
    setAccounts(((data as LinkedAccount[] | null) ?? []).filter(Boolean));
  }, []);

  useEffect(() => {
    let cancelled = false;
    authClient
      .listAccounts()
      .then(({ data, error }) => {
        if (cancelled) return;
        if (error) setError(authErrorMessage(error));
        setAccounts(((data as LinkedAccount[] | null) ?? []).filter(Boolean));
      })
      .catch(() => !cancelled && setAccounts([]));
    api<GithubStatus>("/v1/github/status")
      .then((g) => !cancelled && setGithubStatus(g))
      .catch(() => undefined);
    fetch("/v1/auth/providers")
      .then((r) => r.json())
      .then((p: AuthProviders) => !cancelled && setProviders(p))
      .catch(() => !cancelled && setProviders({ google: false, github: false, emailDelivery: "console" }));
    return () => {
      cancelled = true;
    };
  }, []);

  function clearQuery() {
    router.replace(pathname, { scroll: false });
  }

  async function connect(provider: Social) {
    setError(null);
    setBusy(provider);
    const origin = window.location.origin;
    const { error } = await authClient.linkSocial({
      provider,
      callbackURL: `${origin}/app/settings?linked=${provider}`,
      errorCallbackURL: `${origin}/app/settings`,
    });
    // On success the browser leaves for the provider; we only get here on failure.
    if (error) {
      setError(authErrorMessage(error));
      setBusy(null);
    }
  }

  async function disconnect(account: LinkedAccount) {
    setError(null);
    setBusy(account.providerId);
    const { error } = await authClient.unlinkAccount({ accountId: account.accountId });
    setBusy(null);
    if (error) {
      setError(authErrorMessage(error));
      return;
    }
    clearQuery();
    await load();
  }

  const byProvider = new Map(accounts?.map((a) => [a.providerId, a]));
  const hasPassword = byProvider.has("credential");
  const methodCount = accounts?.length ?? 0;

  return (
    <div className="space-y-6">
      <PageHeader section="Settings" title="Settings" />

      <Card>
        <CardTitle>Profile</CardTitle>
        <dl className="mt-5 grid gap-5 sm:grid-cols-3">
          <div>
            <dt className="text-xs text-fg-muted">Name</dt>
            <dd className="mt-1 text-fg">{me?.user.name ?? "..."}</dd>
          </div>
          <div>
            <dt className="text-xs text-fg-muted">Email</dt>
            <dd className="mt-1 flex items-center gap-2 break-all text-fg">
              <Mail className="size-4 shrink-0 text-fg-muted" aria-hidden="true" />
              {me?.user.email ?? "..."}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-fg-muted">Workspace</dt>
            <dd className="mt-1 text-fg">{workspace?.name ?? "..."}</dd>
          </div>
        </dl>
      </Card>

      <Card>
        <CardTitle>Sign-in methods and connected accounts</CardTitle>
        <p className="mt-1 text-sm text-fg-muted">
          Connect GitHub or Google to the account you already have, even if it uses a different email. You can then sign
          in with any connected method.
        </p>

        <div className="mt-5 space-y-3">
          {notice && (
            <Alert tone="success">
              {notice}{" "}
              <button type="button" onClick={clearQuery} className="cursor-pointer underline underline-offset-4">
                Dismiss
              </button>
            </Alert>
          )}
          {linkError && <Alert>{linkErrorMessage(linkError)}</Alert>}
          {error && <Alert>{error}</Alert>}
        </div>

        {accounts === null || providers === null ? (
          <div className="mt-5 flex items-center gap-2 text-sm text-fg-muted">
            <Spinner /> Loading
          </div>
        ) : (
          <ul className="mt-5 divide-y divide-border">
            <li className="flex flex-wrap items-center gap-4 py-4">
              <KeyRound className="size-5 shrink-0 text-fg-muted" aria-hidden="true" />
              <div className="min-w-0 flex-1">
                <p className="font-medium text-fg">Email and password</p>
                <p className="text-sm text-fg-muted">
                  {hasPassword ? "Sign in with your email and a password." : "Not set up. You signed up with another method."}
                </p>
              </div>
              <span className={hasPassword ? "text-sm font-medium text-success" : "text-sm text-fg-muted"}>
                {hasPassword ? "Set up" : "Not set up"}
              </span>
            </li>

            {SOCIAL.map((s) => {
              const account = byProvider.get(s.id);
              const configured = providers[s.id];
              const onlyMethod = Boolean(account) && methodCount <= 1;
              return (
                <li key={s.id} className="flex flex-wrap items-center gap-4 py-4">
                  <s.icon className="size-5 shrink-0" />
                  <div className="min-w-0 flex-1 basis-[calc(100%-3rem)] sm:basis-auto">
                    <p className="flex items-center gap-2 font-medium text-fg">
                      {s.label}
                      {account && (
                        <span className="inline-flex items-center gap-1 rounded-full bg-success/10 px-2 py-0.5 text-xs font-medium text-success">
                          <CircleCheck className="size-3.5" aria-hidden="true" /> Connected
                        </span>
                      )}
                    </p>
                    <p className="text-sm text-fg-muted">{s.why}</p>
                    {s.id === "github" && account && githubStatus && <GithubAccess status={githubStatus} onReconnect={() => connect("github")} />}
                  </div>
                  <div className="pl-9 sm:pl-0">
                    {!configured ? (
                      <span className="text-sm text-fg-muted">Not available yet</span>
                    ) : account ? (
                      <Button
                        variant="outline"
                        size="sm"
                        shape="pill"
                        onClick={() => disconnect(account)}
                        disabled={busy !== null || onlyMethod}
                        title={onlyMethod ? "This is your only way to sign in, so it can't be disconnected." : undefined}
                      >
                        {busy === s.id ? <Spinner /> : <Unlink aria-hidden="true" />}
                        Disconnect
                      </Button>
                    ) : (
                      <Button size="sm" shape="pill" onClick={() => connect(s.id)} disabled={busy !== null}>
                        {busy === s.id ? <Spinner /> : <Link2 aria-hidden="true" />}
                        Connect {s.label}
                      </Button>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}

        <p className="mt-4 flex items-start gap-2 text-xs text-fg-muted">
          <Info className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
          You always keep at least one way to sign in. Connecting an account never changes your cybercheck email.
        </p>
      </Card>
    </div>
  );
}
