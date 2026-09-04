import { z } from "zod";

/**
 * An Expo push token, e.g. `ExponentPushToken[xxxxxxxxxxxxxxxxxxxxxx]`
 * (`ExpoPushToken[…]` is the newer spelling; both are accepted).
 *
 * The shape is validated because the sender POSTs whatever is stored straight
 * to Expo on every pushed event — an unvalidated string here lets any
 * signed-in client fill the table with junk the server then transmits
 * forever. The length cap bounds both the row and the URL the delete route
 * carries the token back in.
 */
export const ExpoPushTokenSchema = z.string().max(200).regex(/^Expo(nent)?PushToken\[[^\]]+\]$/);

export const PushDeviceRegisterRequestSchema = z.object({
  expoToken: ExpoPushTokenSchema,
  /** Stored, unused by the sender in v1 — Expo's message shape is platform-neutral. */
  platform: z.enum(["android", "ios"]),
}).strict();
export type PushDeviceRegisterRequest = z.infer<typeof PushDeviceRegisterRequestSchema>;

export const PushDeviceRegisterResponseSchema = z.object({ registered: z.literal(true) }).strict();
export type PushDeviceRegisterResponse = z.infer<typeof PushDeviceRegisterResponseSchema>;
