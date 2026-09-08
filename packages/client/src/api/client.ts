import { ApiError, type ApiErrorDetail, type FieldIssue } from "./apiError.js";
import { clientConfig } from "../config.js";

export { ApiError, type ApiErrorDetail, type FieldIssue };

function asCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/**
 * The zod issue list a 400 `invalid_request` may carry. Each entry is kept
 * only if it has a string message and an array path; anything else is
 * dropped rather than failing the whole error, since the code alone is still
 * a usable ApiError. An empty or absent list is `undefined`.
 */
function asIssues(value: unknown): FieldIssue[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const issues: FieldIssue[] = [];
  for (const raw of value) {
    if (typeof raw !== "object" || raw === null) continue;
    const entry = raw as Record<string, unknown>;
    if (typeof entry["message"] !== "string" || !Array.isArray(entry["path"])) continue;
    const path = entry["path"].map((segment) => String(segment)).join(".");
    const code = typeof entry["code"] === "string" ? entry["code"] : undefined;
    const minimum = asCount(entry["minimum"]);
    const maximum = asCount(entry["maximum"]);
    issues.push({
      path,
      message: entry["message"],
      ...(code === undefined ? {} : { code }),
      ...(minimum === undefined ? {} : { minimum }),
      ...(maximum === undefined ? {} : { maximum }),
    });
  }
  return issues.length > 0 ? issues : undefined;
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const config = clientConfig();
  const token = config.tokenStore.get();
  const response = await fetch(`${config.baseUrl}${path}`, {
    ...init,
    headers: {
      // Only declare a JSON body when we're actually sending one — the
      // server's JSON parser rejects `content-type: application/json` on a
      // bodyless request (e.g. POST /commit, POST /ws/ticket) with 400
      // FST_ERR_CTP_EMPTY_JSON_BODY.
      ...(init.body !== undefined ? { "content-type": "application/json" } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...init.headers,
    },
  });

  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    // 423 and both 429 variants also carry the wait as a `retry-after` header;
    // fall back to it so a proxy that strips the body still leaves us a number
    // to lock the button with.
    const header = Number.parseInt(response.headers.get("retry-after") ?? "", 10);
    const fromHeader = Number.isFinite(header) && header >= 0 ? header : undefined;
    const code = typeof body["error"] === "string" ? body["error"] : "unknown_error";
    // The gate: any authed non-exempt route 403s an unverified player. There is
    // no client-side state that tracks verification (MeResponseSchema carries
    // no such field — see docs), so the redirect lives here, at the one place
    // every request already passes through, rather than duplicated per query.
    // The host decides what "gated" means (which URL, whether to guard against
    // a self-redirect loop) via onGate — see apps/web/src/lib/clientBoot.ts.
    if (response.status === 403 && code === "email_unverified") clientConfig().onGate("email_unverified");
    // Same shape as the verify gate: a moderator-flagged account 409s every
    // mutating request until the /challenge check is answered.
    if (response.status === 409 && code === "challenge_required") clientConfig().onGate("challenge_required");
    throw new ApiError(response.status, code, {
      retryAfter: asCount(body["retryAfter"]) ?? fromHeader,
      remainingSeconds: asCount(body["remainingSeconds"]) ?? fromHeader,
      available: asCount(body["available"]),
      maxBuy: asCount(body["maxBuy"]),
      issues: asIssues(body["issues"]),
    });
  }
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}
