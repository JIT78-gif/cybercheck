import type { Metadata } from "next";
import { Suspense } from "react";
import { TestingRunView } from "@/components/testing/testing-run-view";
import { Spinner } from "@/components/ui/form";

export const metadata: Metadata = { title: "Testing run" };

async function View({ params }: { params: Promise<{ id: string; runId: string }> }) {
  const { id, runId } = await params;
  return <TestingRunView projectId={id} runId={runId} />;
}

export default function TestingRunPage(props: { params: Promise<{ id: string; runId: string }> }) {
  return (
    <Suspense
      fallback={
        <div className="flex items-center gap-2 py-10 text-fg-muted">
          <Spinner /> Loading run
        </div>
      }
    >
      <View params={props.params} />
    </Suspense>
  );
}
