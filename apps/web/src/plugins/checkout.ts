/** Checkout responses may leave the game only for Stripe's hosted checkout.
 * Called exclusively after a player submits an action, never from GET data. */
export function checkoutDestination(result: unknown): string | null {
  if (typeof result !== "object" || result === null || !("checkoutUrl" in result)) return null;
  if (typeof result.checkoutUrl !== "string") throw new Error("Invalid checkout destination");
  const url = new URL(result.checkoutUrl);
  if (url.protocol !== "https:" || url.hostname !== "checkout.stripe.com" || url.port || url.username || url.password) {
    throw new Error("Invalid checkout destination");
  }
  return url.href;
}
