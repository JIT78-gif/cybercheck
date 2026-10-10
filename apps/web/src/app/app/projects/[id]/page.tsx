import type { Metadata } from "next";
import { Suspense } from "react";
import { ProjectDetailView } from "@/components/app/project-detail";
import { Spinner } from "@/components/ui/form";

export const metadata: Metadata = { title: "Project" };

async function Detail({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <ProjectDetailView id={id} />;
}

export default function ProjectPage(props: PageProps<"/app/projects/[id]">) {
  return (
    <Suspense
      fallback={
        <div className="flex items-center gap-2 py-10 text-fg-muted">
          <Spinner /> Loading project
        </div>
      }
    >
      <Detail params={props.params} />
    </Suspense>
  );
}
