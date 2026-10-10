import type { Metadata } from "next";
import { Suspense } from "react";
import { notFound } from "next/navigation";
import { CheckId, CHECKS } from "@cybercheck/contracts";
import { CheckWorkspace, CheckWorkspaceFallback } from "@/components/app/check-workspace";
import { CHECK_INFO } from "@/lib/checks";

export function generateStaticParams() {
  return CHECKS.map((check) => ({ check }));
}

export async function generateMetadata(props: PageProps<"/app/checks/[check]">): Promise<Metadata> {
  const { check } = await props.params;
  const parsed = CheckId.safeParse(check);
  return { title: parsed.success ? CHECK_INFO[parsed.data].name : "Check" };
}

// URL data is read inside <Suspense> so navigation between tabs stays instant.
async function CheckContent({ params }: { params: Promise<{ check: string }> }) {
  const { check } = await params;
  const parsed = CheckId.safeParse(check);
  if (!parsed.success) notFound();
  return <CheckWorkspace check={parsed.data} />;
}

export default function CheckPage(props: PageProps<"/app/checks/[check]">) {
  return (
    <Suspense fallback={<CheckWorkspaceFallback />}>
      <CheckContent params={props.params} />
    </Suspense>
  );
}
