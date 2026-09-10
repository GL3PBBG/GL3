import { eq } from "drizzle-orm";
import type { StorageDriver } from "../assets/driver.js";
import { resolveSingletonAsset } from "../assets/service.js";
import type { Db } from "../db/client.js";
import { settings } from "../db/schema/index.js";
import { CORE_SCOPE } from "../plugins/asset-slots.js";
import { GAME_NAME_KEY, resolveGameName } from "../theme/presets.js";
import type { MailMessage } from "./driver.js";

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/** Read the same live branding as the login page for every outgoing email. */
export async function authEmail(
  db: Db, driver: StorageDriver, appBaseUrl: string,
  to: string, kind: "verify" | "reset", token: string,
): Promise<MailMessage> {
  const [rows, logoLogin] = await Promise.all([
    db.select({ key: settings.key, value: settings.value }).from(settings).where(eq(settings.key, GAME_NAME_KEY)),
    resolveSingletonAsset(db, driver, CORE_SCOPE, "logo-login"),
  ]);
  const gameName = resolveGameName(rows);
  const subject = kind === "verify" ? `Verify your ${gameName} account` : `Reset your ${gameName} password`;
  const baseUrl = appBaseUrl.replace(/\/+$/, "");
  const link = kind === "verify"
    ? `${baseUrl}/verify?code=${encodeURIComponent(token)}`
    : `${baseUrl}/reset?token=${encodeURIComponent(token)}`;
  const introduction = kind === "verify" ? `Your verification code is ${token}` : "Reset your password using the link below.";
  const expiry = kind === "verify" ? "The code expires in 24 hours."
    : "The link expires in 1 hour. If you didn't ask for this, ignore it.";
  // Filesystem assets have root-relative URLs; email clients need absolute URLs.
  const logo = logoLogin === null ? "" : `<img src="${escapeHtml(new URL(logoLogin, `${baseUrl}/`).href)}" alt="${escapeHtml(gameName)}" width="320" style="display:block;max-width:100%;height:auto;margin:0 auto 24px;">`;
  return {
    to, subject,
    text: `${subject}\n\n${introduction}\n\n${kind === "verify" ? "Or click" : "Reset link"}: ${link}\n\n${expiry}`,
    html: `<!doctype html>
<html lang="en"><body style="margin:0;padding:32px 16px;background:#f4f4f5;color:#18181b;font-family:Arial,sans-serif;">
<div style="max-width:560px;margin:0 auto;padding:32px;background:#ffffff;border-radius:8px;">
${logo}<h1 style="font-size:24px;">${escapeHtml(gameName)}</h1>
<h2 style="font-size:20px;">${escapeHtml(subject)}</h2>
<p>${escapeHtml(introduction)}</p>
<p><a href="${escapeHtml(link)}">${kind === "verify" ? "Verify your account" : "Reset your password"}</a></p>
<p>${escapeHtml(expiry)}</p>
</div></body></html>`,
  };
}
