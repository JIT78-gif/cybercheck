import type { Metadata } from "next";
import { GithubInstalled } from "@/components/intake/github-installed";

export const metadata: Metadata = { title: "GitHub" };

export default function Page() {
  return <GithubInstalled />;
}
