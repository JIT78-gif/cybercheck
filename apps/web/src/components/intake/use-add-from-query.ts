"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";

/**
 * `?add=github` means "reopen the add-project flow on the GitHub step" (used when
 * returning from connecting or installing GitHub). Must render inside <Suspense>.
 */
export function useAddFromQuery() {
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const fromGithub = params.get("add") === "github";

  function clear() {
    if (!fromGithub) return;
    const q = new URLSearchParams(params.toString());
    q.delete("add");
    const rest = q.toString();
    router.replace(rest ? `${pathname}?${rest}` : pathname, { scroll: false });
  }

  return { fromGithub, clear };
}
