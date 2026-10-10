import type { Metadata } from "next";
import { Suspense } from "react";
import { Overview } from "@/components/app/overview";
import { Spinner } from "@/components/ui/form";

export const metadata: Metadata = { title: "Overview" };

export default function OverviewPage() {
  return (
    <Suspense
      fallback={
        <div className="flex items-center gap-2 py-10 text-fg-muted">
          <Spinner /> Loading
        </div>
      }
    >
      <Overview />
    </Suspense>
  );
}
