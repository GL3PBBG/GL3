import { z } from "zod";

export const EXPO_SEND_URL = "https://exp.host/--/api/v2/push/send";
/** Expo's documented per-request cap. */
export const EXPO_BATCH_SIZE = 100;
/** A hung provider must not hang the subscriber's serialised dispatch chain. */
const REQUEST_TIMEOUT_MS = 10_000;

export interface ExpoPushMessage {
  to: string;
  title: string;
  body: string;
  /** `eventId` lets the client correlate a tap with an event it may already hold. */
  data: { path: string; eventId: string; type: string };
  channelId: "default";
  priority: "high";
}

export interface ExpoSendDeps {
  /**
   * Injected rather than imported so the unit test can supply a capture. The
   * repo's no-mocks rule covers the database, queue and bus paths; this is an
   * outbound third-party call with no local service to run against.
   */
  fetch: typeof fetch;
  /** Omit the Authorization header entirely when null — Expo accepts unauthenticated sends. */
  accessToken: string | null;
  onDeadToken: (token: string) => Promise<void>;
}

const TicketSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("ok"), id: z.string().optional() }),
  z.object({
    status: z.literal("error"),
    message: z.string().optional(),
    details: z.object({ error: z.string().optional() }).passthrough().optional(),
  }),
]);
const TicketResponseSchema = z.object({ data: z.array(TicketSchema) });

/**
 * Nothing here is retried. Push has no durability requirement — the fact
 * itself lives in `notifications`, `mail_messages` or `p_combat_log` either
 * way, and the WebSocket has already delivered it to anyone connected — so a
 * retry loop here would be a second, worse outbox.
 */
export async function sendExpoPush(
  messages: readonly ExpoPushMessage[],
  deps: ExpoSendDeps,
): Promise<{ sent: number; failed: number }> {
  let sent = 0;
  let failed = 0;

  for (let offset = 0; offset < messages.length; offset += EXPO_BATCH_SIZE) {
    const batch = messages.slice(offset, offset + EXPO_BATCH_SIZE);
    try {
      const response = await deps.fetch(EXPO_SEND_URL, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "accept-encoding": "gzip",
          ...(deps.accessToken !== null ? { authorization: `Bearer ${deps.accessToken}` } : {}),
        },
        body: JSON.stringify(batch),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });

      if (!response.ok) {
        console.error(`[push] expo ${response.status} ${await response.text().catch(() => "")}`);
        failed += batch.length;
        continue;
      }

      const body: unknown = await response.json();
      const parsed = TicketResponseSchema.safeParse(body);
      if (!parsed.success) {
        console.error("[push] expo returned an unrecognised body", parsed.error.issues);
        failed += batch.length;
        continue;
      }

      // Tickets are positionally aligned with the request array.
      for (const [index, ticket] of parsed.data.data.entries()) {
        if (ticket.status === "ok") { sent += 1; continue; }
        failed += 1;
        const token = batch[index]?.to;
        if (token !== undefined && ticket.details?.error === "DeviceNotRegistered") {
          // A reinstall, almost always. Soft-disable so the device query stops
          // selecting it; a re-registration upsert clears it again.
          await deps.onDeadToken(token);
        } else {
          console.error(`[push] ticket error: ${ticket.details?.error ?? ticket.message ?? "unknown"}`);
        }
      }
    } catch (error) {
      console.error("[push] send failed", error);
      failed += batch.length;
    }
  }

  return { sent, failed };
}
