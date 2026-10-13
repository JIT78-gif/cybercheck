import { ProviderError, safeFetch, type FetchLike } from "./errors.js";

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
}

export interface Mailer {
  send(message: EmailMessage): Promise<void>;
}

export interface SendgridOptions {
  apiKey: string;
  from: string;
  baseUrl?: string;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
}

export function createSendgridMailer(options: SendgridOptions): Mailer {
  const baseUrl = options.baseUrl ?? "https://api.sendgrid.com";
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 10_000;

  return {
    async send(message) {
      const response = await safeFetch(
        "sendgrid",
        fetchImpl,
        `${baseUrl}/v3/mail/send`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${options.apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            personalizations: [{ to: [{ email: message.to }] }],
            from: { email: options.from },
            subject: message.subject,
            content: [{ type: "text/plain", value: message.text }],
          }),
        },
        timeoutMs,
      );

      if (response.status !== 202 && response.status !== 200) {
        const detail = await response.text().catch(() => "");
        throw new ProviderError("sendgrid", response.status, `SendGrid returned ${response.status} ${detail}`.trim());
      }
    },
  };
}
