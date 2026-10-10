import type { Metadata } from "next";
import { Suspense } from "react";
import { ArchitectureView } from "@/components/architecture/architecture-view";
import { Spinner } from "@/components/ui/form";

export const metadata: Metadata = { title: "Architecture" };

async function View({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <ArchitectureView id={id} />;
}

export default function ArchitecturePage(props: PageProps<"/app/projects/[id]/architecture">) {
  return (
    <Suspense
      fallback={
        <div className="flex items-center gap-2 py-10 text-fg-muted">
          <Spinner /> Loading architecture
        </div>
      }
    >
      <View params={props.params} />
    </Suspense>
  );
}
