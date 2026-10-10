import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import nodemailer, { type Transporter } from "nodemailer";
import { env, providers } from "../env.ts";

/** Repo-root .data/dev-outbox.jsonl (development only). */
export const DEV_OUTBOX = fileURLToPath(new URL("../../../../.data/dev-outbox.jsonl", import.meta.url));

export type OtpPurpose = "sign-in" | "email-verification" | "forget-password" | "change-email";

const copy: Record<OtpPurpose, { subject: string; heading: string; intro: string }> = {
  "email-verification": {
    subject: "Your cybercheck verification code",
    heading: "Confirm your email",
    intro: "Use this code to finish creating your cybercheck account.",
  },
  "sign-in": {
    subject: "Your cybercheck sign-in code",
    heading: "Sign in to cybercheck",
    intro: "Use this code to sign in.",
  },
  "forget-password": {
    subject: "Reset your cybercheck password",
    heading: "Reset your password",
    intro: "Use this code to choose a new password.",
  },
  "change-email": {
    subject: "Confirm your new email for cybercheck",
    heading: "Confirm your new email",
    intro: "Use this code to confirm your new email address.",
  },
};

let transporter: Transporter | undefined;
function getTransporter() {
  transporter ??= nodemailer.createTransport({
    host: env.SMTP_HOST,
    port: env.SMTP_PORT,
    secure: env.SMTP_PORT === 465,
    auth: { user: env.SMTP_USER, pass: env.SMTP_PASS },
  });
  return transporter;
}

function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

export function renderOtpEmail(purpose: OtpPurpose, otp: string, minutes: number) {
  const c = copy[purpose];
  const text = `${c.heading}\n\n${c.intro}\n\nYour code: ${otp}\n\nIt expires in ${minutes} minutes. If you didn't request this, you can ignore this email.`;
  const html = `<!doctype html><html><body style="margin:0;background:#fafaf7;font-family:Arial,Helvetica,sans-serif;color:#0f172a">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:32px 16px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;background:#ffffff;border:1px solid #e6e4de;border-radius:12px">
<tr><td style="padding:28px 28px 8px"><p style="margin:0;font-size:18px;font-weight:700">cybercheck</p></td></tr>
<tr><td style="padding:8px 28px"><h1 style="margin:0 0 8px;font-size:20px">${escapeHtml(c.heading)}</h1><p style="margin:0;color:#4b5563;font-size:15px;line-height:1.5">${escapeHtml(c.intro)}</p></td></tr>
<tr><td style="padding:20px 28px"><p style="margin:0;padding:16px;text-align:center;background:#f3f2ee;border-radius:8px;font-family:'Courier New',monospace;font-size:32px;letter-spacing:8px;font-weight:700">${escapeHtml(otp)}</p></td></tr>
<tr><td style="padding:0 28px 28px"><p style="margin:0;color:#4b5563;font-size:13px;line-height:1.5">This code expires in ${minutes} minutes. If you didn't request it, you can safely ignore this email.</p></td></tr>
</table></td></tr></table></body></html>`;
  return { subject: c.subject, text, html };
}

export async function sendOtpEmail(to: string, otp: string, purpose: OtpPurpose, minutes: number) {
  const message = renderOtpEmail(purpose, otp, minutes);

  // Reserved test domains (RFC 2606) can never receive mail; in development they go to
  // the outbox so automated tests work even when real SMTP is configured.
  const reserved = /\.(test|example|invalid|localhost)$/i.test(to.split("@").pop() ?? "");
  if (!providers.smtp || (reserved && env.NODE_ENV !== "production")) {
    if (env.NODE_ENV === "production") {
      throw new Error("SMTP is not configured; refusing to log one-time codes in production.");
    }
    // Development fallback: print the code, and append it to a local outbox file
    // that end-to-end tests read (.data/ is gitignored).
    const why = providers.smtp ? "test address, not sent" : "set SMTP_USER and SMTP_PASS in .env to send real email";
    console.log(`\n[dev-mail] ${purpose} code for ${to}: ${otp}  (${why})\n`);
    await mkdir(dirname(DEV_OUTBOX), { recursive: true });
    await appendFile(DEV_OUTBOX, JSON.stringify({ at: new Date().toISOString(), to, purpose, otp }) + "\n");
    return;
  }

  await getTransporter().sendMail({
    from: env.EMAIL_FROM ?? `cybercheck <${env.SMTP_USER}>`,
    to,
    subject: message.subject,
    text: message.text,
    html: message.html,
  });
}
