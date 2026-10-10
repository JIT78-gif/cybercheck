"use client";

import { Suspense, useEffect, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  BookOpen,
  Check,
  ChevronDown,
  FolderKanban,
  House,
  LogOut,
  Menu,
  Settings,
  SquareArrowOutUpRight,
  X,
  type LucideIcon,
} from "lucide-react";
import { Logo } from "@/components/brand/logo";
import { Alert, Spinner } from "@/components/ui/form";
import { authClient } from "@/lib/auth-client";
import { CHECK_INFO, CHECK_ORDER } from "@/lib/checks";
import { cn } from "@/lib/cn";
import { initials } from "@/lib/format";
import { useAppData } from "./app-data";

type NavItem = { href: string; label: string; icon: LucideIcon; external?: boolean };

const mainNav: NavItem[] = [
  { href: "/app", label: "Overview", icon: House },
  { href: "/app/projects", label: "Projects", icon: FolderKanban },
];
const checkNav: NavItem[] = CHECK_ORDER.map((id) => ({
  href: `/app/checks/${id}`,
  label: CHECK_INFO[id].name,
  icon: CHECK_INFO[id].icon,
}));
const footerNav: NavItem[] = [
  { href: "/app/settings", label: "Settings", icon: Settings },
  { href: "/#how-it-works", label: "Documentation", icon: BookOpen, external: true },
];

function isActive(pathname: string, href: string) {
  return href === "/app" ? pathname === "/app" : pathname === href || pathname.startsWith(href + "/");
}

function NavLink({ item, active, onNavigate }: { item: NavItem; active: boolean; onNavigate?: () => void }) {
  return (
    <Link
      href={item.href}
      onClick={onNavigate}
      target={item.external ? "_blank" : undefined}
      aria-current={active ? "page" : undefined}
      className={cn(
        "group flex min-h-11 items-center gap-3 rounded-xl px-3 text-[15px] transition-colors duration-200",
        active ? "bg-surface-2 font-semibold text-fg" : "text-fg-muted hover:bg-surface-2/60 hover:text-fg",
      )}
    >
      <item.icon
        className={cn("size-[18px] shrink-0 transition-colors", active ? "text-accent" : "text-fg-muted group-hover:text-fg")}
        aria-hidden="true"
      />
      <span className="flex-1">{item.label}</span>
      {item.external && <SquareArrowOutUpRight className="size-3.5 text-fg-muted" aria-label="(opens in a new tab)" />}
    </Link>
  );
}

function WorkspaceSwitcher() {
  const { me, workspace } = useAppData();
  const [open, setOpen] = useState(false);
  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="true"
        className="flex h-12 w-full cursor-pointer items-center gap-3 rounded-full border border-accent/20 bg-accent/5 px-2 pr-4 text-left transition-colors hover:bg-accent/10"
      >
        <span className="inline-flex size-8 shrink-0 items-center justify-center rounded-full bg-accent text-sm font-semibold text-white">
          {me ? initials(me.user.name) : ""}
        </span>
        <span className="flex-1 truncate font-medium text-accent">{workspace?.name ?? "Loading"}</span>
        <ChevronDown className={cn("size-4 text-accent transition-transform", open && "rotate-180")} aria-hidden="true" />
      </button>
      {open && (
        <div className="animate-fade-up absolute inset-x-0 top-14 z-20 rounded-xl border border-border bg-surface p-1.5 shadow-lg">
          <p className="px-3 py-1.5 text-xs text-fg-muted">Workspaces</p>
          {me?.workspaces.map((w) => (
            <div key={w.id} className="flex min-h-10 items-center justify-between rounded-lg bg-surface-2 px-3 text-sm text-fg">
              {w.name}
              <Check className="size-4 text-accent" aria-label="current" />
            </div>
          ))}
          <p className="px-3 py-2 text-xs text-fg-muted">Team workspaces arrive with role-based approvals.</p>
        </div>
      )}
    </div>
  );
}

function NavLists({ pathname, onNavigate }: { pathname: string; onNavigate?: () => void }) {
  return (
    <nav aria-label="App" className="flex-1 overflow-y-auto px-4 py-4 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
      <ul className="space-y-1">
        {mainNav.map((i) => (
          <li key={i.href}>
            <NavLink item={i} active={isActive(pathname, i.href)} onNavigate={onNavigate} />
          </li>
        ))}
      </ul>
      <p className="mt-6 mb-2 px-3 font-mono text-[11px] uppercase tracking-[0.08em] text-fg-muted">Checks</p>
      <ul className="space-y-1">
        {checkNav.map((i) => (
          <li key={i.href}>
            <NavLink item={i} active={isActive(pathname, i.href)} onNavigate={onNavigate} />
          </li>
        ))}
      </ul>
      <div className="my-4 h-px bg-border" />
      <ul className="space-y-1">
        {footerNav.map((i) => (
          <li key={i.href}>
            <NavLink item={i} active={isActive(pathname, i.href)} onNavigate={onNavigate} />
          </li>
        ))}
      </ul>
    </nav>
  );
}

/** Reads the URL (runtime data), so it renders inside <Suspense>; the fallback shows no active item. */
function ActiveNavLists({ onNavigate }: { onNavigate?: () => void }) {
  return <NavLists pathname={usePathname()} onNavigate={onNavigate} />;
}

function SidebarContent({ onNavigate }: { onNavigate?: () => void }) {
  const router = useRouter();
  const { me } = useAppData();
  const [signingOut, setSigningOut] = useState(false);

  async function signOut() {
    setSigningOut(true);
    await authClient.signOut();
    router.replace("/login");
    router.refresh();
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-20 items-center justify-center border-b border-border px-6">
        <Logo href="/app" />
      </div>
      <div className="border-b border-border p-4">
        <WorkspaceSwitcher />
      </div>
      <Suspense fallback={<NavLists pathname="" onNavigate={onNavigate} />}>
        <ActiveNavLists onNavigate={onNavigate} />
      </Suspense>
      <div className="flex items-center gap-3 border-t border-border px-5 py-4">
        <span className="inline-flex size-10 shrink-0 items-center justify-center rounded-full bg-primary text-sm font-semibold text-primary-fg">
          {me ? initials(me.user.name) : ""}
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold text-fg">{me?.user.name ?? " "}</p>
          <p className="truncate text-xs text-fg-muted">{me?.user.email ?? " "}</p>
        </div>
        <button
          type="button"
          onClick={signOut}
          disabled={signingOut}
          aria-label="Sign out"
          title="Sign out"
          className="inline-flex size-10 shrink-0 cursor-pointer items-center justify-center rounded-full border border-border text-fg-muted transition-colors hover:bg-surface-2 hover:text-fg"
        >
          {signingOut ? <Spinner /> : <LogOut className="size-4" />}
        </button>
      </div>
    </div>
  );
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const { error } = useAppData();
  const [drawer, setDrawer] = useState(false);

  useEffect(() => {
    if (!drawer) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setDrawer(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [drawer]);

  return (
    <div className="min-h-dvh flex-1 bg-bg">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50 focus:rounded-md focus:bg-primary focus:px-4 focus:py-2 focus:text-primary-fg"
      >
        Skip to main content
      </a>

      {/* Desktop: floating sidebar card */}
      <aside className="fixed inset-y-4 left-4 z-30 hidden w-72 overflow-hidden rounded-3xl border border-border bg-surface shadow-[0_8px_30px_rgb(0_0_0/0.05)] lg:block">
        <SidebarContent />
      </aside>

      {/* Mobile / tablet: top bar + drawer */}
      <header className="sticky top-0 z-30 flex h-16 items-center justify-between border-b border-border bg-surface/90 px-4 backdrop-blur lg:hidden">
        <Logo href="/app" />
        <button
          type="button"
          onClick={() => setDrawer(true)}
          aria-label="Open navigation"
          aria-expanded={drawer}
          className="inline-flex size-11 items-center justify-center rounded-md text-fg"
        >
          <Menu className="size-5" />
        </button>
      </header>
      {drawer && (
        <div className="fixed inset-0 z-40 lg:hidden" role="dialog" aria-modal="true" aria-label="Navigation">
          <button
            type="button"
            className="absolute inset-0 bg-black/40"
            aria-label="Close navigation"
            onClick={() => setDrawer(false)}
          />
          <div className="animate-fade-up absolute inset-y-0 left-0 w-[85%] max-w-80 bg-surface shadow-2xl">
            <button
              type="button"
              onClick={() => setDrawer(false)}
              aria-label="Close navigation"
              className="absolute right-3 top-4 z-10 inline-flex size-11 items-center justify-center rounded-md text-fg-muted"
            >
              <X className="size-5" />
            </button>
            <SidebarContent onNavigate={() => setDrawer(false)} />
          </div>
        </div>
      )}

      <main id="main" className="px-4 py-8 sm:px-8 lg:ml-80 lg:py-10 lg:pr-10 lg:pl-6">
        <div className="mx-auto max-w-300">
          {error && <Alert className="mb-6">{error}</Alert>}
          <div className="animate-fade-up">{children}</div>
        </div>
      </main>
    </div>
  );
}
