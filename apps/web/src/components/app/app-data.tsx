"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import type { Me, ProjectSummary, Workspace } from "@cybercheck/contracts";
import { ApiError, api } from "@/lib/api";
import { RUNNING_STAGES } from "./ui";

type AppData = {
  me: Me | null;
  workspace: Workspace | null;
  projects: ProjectSummary[] | null;
  error: string | null;
  refreshProjects: () => Promise<ProjectSummary[] | null>;
  /** Insert or replace one project without refetching the list. */
  upsertProject: (p: ProjectSummary) => void;
};

const Ctx = createContext<AppData | null>(null);

export function useAppData() {
  const v = useContext(Ctx);
  if (!v) throw new Error("useAppData must be used inside <AppDataProvider>");
  return v;
}

/** Loads the signed-in user, their workspace and its projects once for the whole app shell. */
export function AppDataProvider({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const [me, setMe] = useState<Me | null>(null);
  const [projects, setProjects] = useState<ProjectSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const workspace = me?.workspaces.find((w) => w.personal) ?? me?.workspaces[0] ?? null;

  const handle = useCallback(
    (err: unknown) => {
      if (err instanceof ApiError && err.status === 401) {
        router.replace(`/login?next=${encodeURIComponent(window.location.pathname)}`);
        return;
      }
      setError(err instanceof ApiError ? `${err.message} ${err.fix ?? ""}` : "Something went wrong.");
    },
    [router],
  );

  useEffect(() => {
    api<Me>("/v1/me").then(setMe).catch(handle);
  }, [handle]);

  const workspaceId = workspace?.id;
  const refreshProjects = useCallback(async () => {
    if (!workspaceId) return null;
    try {
      const { projects } = await api<{ projects: ProjectSummary[] }>(`/v1/workspaces/${workspaceId}/projects`);
      setProjects(projects);
      return projects;
    } catch (err) {
      handle(err);
      return null;
    }
  }, [workspaceId, handle]);

  useEffect(() => {
    if (!workspaceId) return;
    let cancelled = false;
    api<{ projects: ProjectSummary[] }>(`/v1/workspaces/${workspaceId}/projects`)
      .then((r) => !cancelled && setProjects(r.projects))
      .catch(handle);
    return () => {
      cancelled = true;
    };
  }, [workspaceId, handle]);

  // Analysis may be started from another page (or another browser tab).
  // Revalidate when the user comes back instead of trusting a stale failed
  // status forever. The running-state poll below then takes over if needed.
  useEffect(() => {
    if (!workspaceId) return;
    const refresh = () => {
      void refreshProjects();
    };
    const refreshWhenVisible = () => {
      if (document.visibilityState === "visible") refresh();
    };
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refreshWhenVisible);
    return () => {
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refreshWhenVisible);
    };
  }, [workspaceId, refreshProjects]);

  // Live status: while any project is still being analysed, refresh the list every few seconds.
  const running = projects?.some((p) => RUNNING_STAGES.has(p.analysis.stage)) ?? false;
  useEffect(() => {
    if (!running || !workspaceId) return;
    const timer = setTimeout(() => {
      api<{ projects: ProjectSummary[] }>(`/v1/workspaces/${workspaceId}/projects`)
        .then((r) => setProjects(r.projects))
        .catch(() => {
          // try again on the next tick
        });
    }, 3000);
    return () => clearTimeout(timer);
  }, [running, projects, workspaceId]);

  const upsertProject = useCallback((p: ProjectSummary) => {
    setProjects((list) => {
      if (!list) return [p];
      const i = list.findIndex((x) => x.id === p.id);
      if (i === -1) return [p, ...list];
      const next = list.slice();
      next[i] = p;
      return next;
    });
  }, []);

  const value = useMemo(
    () => ({ me, workspace, projects, error, refreshProjects, upsertProject }),
    [me, workspace, projects, error, refreshProjects, upsertProject],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
