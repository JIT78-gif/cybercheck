import { createAuthClient } from "better-auth/react";
import { emailOTPClient } from "better-auth/client/plugins";

// Same-origin: /api/auth/* is proxied to the API by next.config.ts.
export const authClient = createAuthClient({
  plugins: [emailOTPClient()],
});

export type AuthProviders = {
  google: boolean;
  github: boolean;
  emailDelivery: "smtp" | "console";
};

/** Email waiting for verification. Kept in sessionStorage, never in the URL. */
const PENDING_EMAIL_KEY = "cc_pending_email";

export function setPendingEmail(email: string) {
  try {
    sessionStorage.setItem(PENDING_EMAIL_KEY, email);
  } catch {
    // storage blocked: the verify page falls back to asking for the email
  }
}

export function getPendingEmail(): string {
  try {
    return sessionStorage.getItem(PENDING_EMAIL_KEY) ?? "";
  } catch {
    return "";
  }
}

export function clearPendingEmail() {
  try {
    sessionStorage.removeItem(PENDING_EMAIL_KEY);
  } catch {
    // ignore
  }
}

/** Only allow same-site relative redirects after login. */
export function safeNextPath(next: string | null | undefined, fallback = "/app") {
  if (!next || !next.startsWith("/") || next.startsWith("//") || next.startsWith("/\\")) {
    return fallback;
  }
  return next;
}
