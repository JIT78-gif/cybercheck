import type { Metadata } from "next";
import { Suspense } from "react";
import { ProjectsPage } from "@/components/app/projects-page";
import { Spinner } from "@/components/ui/form";

export const metadata: Metadata = { title: "Projects" };

export default function Page() {
  return (
    <Suspense
      fallback={
        <div className="flex items-center gap-2 py-10 text-fg-muted">
          <Spinner /> Loading
        </div>
      }
    >
      <ProjectsPage />
    </Suspense>
  );
}
