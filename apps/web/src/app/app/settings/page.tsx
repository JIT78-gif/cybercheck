import type { Metadata } from "next";
import { Suspense } from "react";
import { SettingsPage } from "@/components/app/settings-page";
import { Spinner } from "@/components/ui/form";

export const metadata: Metadata = { title: "Settings" };

export default function Page() {
  return (
    <Suspense
      fallback={
        <div className="flex items-center gap-2 py-10 text-fg-muted">
          <Spinner /> Loading settings
        </div>
      }
    >
      <SettingsPage />
    </Suspense>
  );
}
