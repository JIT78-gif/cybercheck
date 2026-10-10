"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import { useRouter } from "next/navigation";
import { CircleCheck } from "lucide-react";
import type { GithubStatus } from "@cybercheck/contracts";
import { Card, PageHeader } from "@/components/app/ui";
import { GitHubIcon } from "@/components/auth/provider-icons";
import { ButtonLink } from "@/components/ui/button";
import { Alert, Spinner } from "@/components/ui/form";
import { ApiError, api } from "@/lib/api";
import { safeNextPath } from "@/lib/auth-client";
import { clearGithubReturn, readGithubReturn } from "./github-import";

const noopSubscribe = () => () => {};
const DEFAULT_BACK = "/app/projects?add=github";

/**
 * GitHub sends people here after installing the app. The installation_id in the URL
 * is ignored: we ask our API, which asks GitHub what this signed-in user can access.
 */
export function GithubInstalled() {
  const router = useRouter();
  const [status, setStatus] = useState<GithubStatus | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const stored = useSyncExternalStore(noopSubscribe, readGithubReturn, () => null);
  const back = safeNextPath(stored, DEFAULT_BACK);

  useEffect(() => {
    api<GithubStatus>("/v1/github/status")
      .then((s) => {
        setStatus(s);
        if (s.authorized && s.installations.length > 0) {
          setTimeout(() => {
            const target = safeNextPath(readGithubReturn(), DEFAULT_BACK);
            clearGithubReturn();
            router.replace(target);
          }, 1500);
        }
      })
      .catch((e) => setError(e instanceof ApiError ? e : null));
  }, [router]);

  const ok = status?.authorized && status.installations.length > 0;
  return (
    <div className="space-y-6">
      <PageHeader section="GitHub" title="GitHub" />
      <Card className="max-w-xl">
        {error ? (
          <Alert>
            {error.message} {error.fix}
          </Alert>
        ) : !status ? (
          <p className="flex items-center gap-2 text-fg-muted">
            <Spinner /> Checking your GitHub installation
          </p>
        ) : ok ? (
          <div className="animate-fade-up">
            <p className="flex items-center gap-2 font-semibold text-success">
              <CircleCheck className="size-5" aria-hidden="true" /> cybercheck can now read the repositories you chose
            </p>
            <p className="mt-2 text-sm text-fg-muted">
              Installed on {status.installations.map((i) => i.account.login).join(", ")}. Taking you back to pick a repository.
            </p>
          </div>
        ) : (
          <div>
            <p className="flex items-center gap-2 font-semibold text-fg">
              <GitHubIcon className="size-5" /> We couldn&apos;t confirm the installation yet
            </p>
            <p className="mt-2 text-sm text-fg-muted">
              {status.authorized
                ? "GitHub hasn't reported an installation for your account. If you cancelled, you can try again any time."
                : "Your GitHub connection needs to be renewed first. Open the import screen and choose Reconnect GitHub."}
            </p>
          </div>
        )}
        <div className="mt-6">
          <ButtonLink href={back} shape="pill" variant={ok ? "outline" : "primary"}>
            Back to import
          </ButtonLink>
        </div>
      </Card>
    </div>
  );
}
