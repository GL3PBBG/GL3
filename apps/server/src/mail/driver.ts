import type { MailConfig } from "../config.js";

export interface MailMessage { to: string; subject: string; text: string }

/**
 * `send` resolves `false` on failure rather than throwing: registration and
 * forgot-password must succeed even when the mail provider is down — the
 * player lands on the verify screen with a resend button either way.
 */
export interface MailDriver { send(msg: MailMessage): Promise<boolean> }

export function createMailDriver(mail: MailConfig): MailDriver {
  if (mail.driver === "log") {
    return {
      async send(msg) {
        console.log(`[mail:log] to=${msg.to} subject=${JSON.stringify(msg.subject)}\n${msg.text}`);
        return true;
      },
    };
  }
  return {
    async send(msg) {
      try {
        const response = await fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: { Authorization: `Bearer ${mail.apiKey}`, "content-type": "application/json" },
          body: JSON.stringify({ from: mail.from, to: [msg.to], subject: msg.subject, text: msg.text }),
        });
        if (!response.ok) {
          console.error(`[mail:resend] ${response.status} ${await response.text().catch(() => "")}`);
          return false;
        }
        return true;
      } catch (err) {
        console.error("[mail:resend] request failed", err);
        return false;
      }
    },
  };
}
