import { randomUUID } from "node:crypto";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { emailOTP } from "better-auth/plugins/email-otp";
import { db } from "../db/client.ts";
import * as schema from "../db/schema.ts";
import { sendOtpEmail } from "../email/mailer.ts";
import { env, providers } from "../env.ts";

const OTP_TTL_SECONDS = 10 * 60;

const socialProviders = {
  ...(providers.google && {
    google: {
      clientId: env.GOOGLE_CLIENT_ID!,
      clientSecret: env.GOOGLE_CLIENT_SECRET!,
      prompt: "select_account" as const,
    },
  }),
  ...(providers.github && {
    github: {
      clientId: env.GITHUB_CLIENT_ID!,
      clientSecret: env.GITHUB_CLIENT_SECRET!,
      // Login only needs identity. Repository access is requested later, when the
      // user chooses "Import from GitHub" (incremental scope via linkSocial).
      scope: ["read:user", "user:email"],
    },
  }),
};

export const auth = betterAuth({
  appName: "cybercheck",
  baseURL: env.BETTER_AUTH_URL,
  secret: env.BETTER_AUTH_SECRET,
  trustedOrigins: [env.WEB_ORIGIN],
  database: drizzleAdapter(db, {
    provider: "pg",
    schema: {
      user: schema.user,
      session: schema.session,
      account: schema.account,
      verification: schema.verification,
    },
  }),

  emailAndPassword: {
    enabled: true,
    requireEmailVerification: true,
    minPasswordLength: 10,
    maxPasswordLength: 128,
    revokeSessionsOnPasswordReset: true,
  },
  emailVerification: {
    sendOnSignIn: true,
    autoSignInAfterVerification: true,
  },
  socialProviders,
  account: {
    encryptOAuthTokens: true,
    accountLinking: {
      enabled: true,
      // Google and GitHub verify email ownership, so linking by email is safe.
      trustedProviders: ["google", "github"],
      // A signed-in user may connect a GitHub/Google account whose email differs from
      // theirs (common: Gmail login + work GitHub). Safe here because linking only
      // starts from Settings inside an authenticated session, the OAuth state is bound
      // to that session, and an account already linked to another user is refused.
      allowDifferentEmails: true,
    },
  },
  rateLimit: {
    enabled: true,
    window: 60,
    max: 100,
    customRules: {
      // Sending email is the abuse vector (inbox flooding): keep it tight.
      "/email-otp/send-verification-otp": { window: 60, max: 3 },
      "/email-otp/request-password-reset": { window: 60, max: 3 },
      // Checking a code: each code already locks after 5 wrong tries (allowedAttempts),
      // so allow a typo or two without making people wait a minute.
      "/email-otp/verify-email": { window: 60, max: 10 },
      "/email-otp/reset-password": { window: 60, max: 10 },
    },
  },
  advanced: {
    // The API only listens on 127.0.0.1 behind the Next.js proxy, which appends the
    // address it saw to x-forwarded-for. Better Auth walks that list from the right,
    // skipping only proxies we operate (TRUSTED_PROXIES), so clients can't spoof
    // their IP and each client gets its own rate-limit bucket.
    ipAddress: { ipAddressHeaders: ["x-forwarded-for"], trustedProxies: env.TRUSTED_PROXIES },
  },

  plugins: [
    emailOTP({
      otpLength: 6,
      expiresIn: OTP_TTL_SECONDS,
      allowedAttempts: 5,
      storeOTP: "hashed",
      sendVerificationOnSignUp: true,
      overrideDefaultEmailVerification: true,
      async sendVerificationOTP({ email, otp, type }) {
        // Not awaited, so response time doesn't reveal whether an account exists.
        void sendOtpEmail(email, otp, type, OTP_TTL_SECONDS / 60).catch((err) =>
          console.error(`[mail] failed to send ${type} code to ${email}:`, err),
        );
      },
    }),
  ],

  databaseHooks: {
    user: {
      create: {
        after: async (createdUser) => {
          const workspaceId = randomUUID();
          await db.transaction(async (tx) => {
            const inserted = await tx
              .insert(schema.workspace)
              .values({ id: workspaceId, name: "Personal", personal: true, createdBy: createdUser.id })
              .onConflictDoNothing()
              .returning({ id: schema.workspace.id });
            if (inserted.length > 0) {
              await tx
                .insert(schema.workspaceMember)
                .values({ workspaceId, userId: createdUser.id, role: "owner" });
            }
          });
        },
      },
    },
  },
});

export type Session = typeof auth.$Infer.Session;
