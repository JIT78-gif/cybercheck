import type { Metadata } from "next";
import { VerifyEmailForm } from "@/components/auth/verify-email-form";

export const metadata: Metadata = { title: "Verify your email" };

export default function VerifyEmailPage() {
  return <VerifyEmailForm />;
}
