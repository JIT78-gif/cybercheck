/** Turns Better Auth error codes into a cause plus a fix the user can act on. */
const messages: Record<string, string> = {
  INVALID_EMAIL_OR_PASSWORD: "That email and password don't match. Check for typos, or reset your password.",
  EMAIL_NOT_VERIFIED: "Please confirm your email first. We've sent you a new code.",
  USER_ALREADY_EXISTS: "An account with this email already exists. Sign in instead, or reset your password.",
  USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL: "An account with this email already exists. Sign in instead, or use another email.",
  PASSWORD_TOO_SHORT: "Your password needs at least 10 characters.",
  PASSWORD_TOO_LONG: "Your password can be at most 128 characters.",
  INVALID_EMAIL: "That doesn't look like a valid email address.",
  INVALID_OTP: "That code isn't right. Check the latest email and try again.",
  OTP_EXPIRED: "That code has expired. Send a new one and use it within 10 minutes.",
  TOO_MANY_ATTEMPTS: "Too many wrong attempts for this code. Send a new code to try again.",
  USER_NOT_FOUND: "We couldn't find an account with that email.",
};

export function authErrorMessage(
  error: { code?: string; message?: string; status?: number } | null | undefined,
): string {
  if (!error) return "Something went wrong. Please try again.";
  if (error.status === 429) return "Too many attempts. Wait a minute, then try again.";
  if (error.code && messages[error.code]) return messages[error.code]!;
  return error.message || "Something went wrong. Please try again.";
}
