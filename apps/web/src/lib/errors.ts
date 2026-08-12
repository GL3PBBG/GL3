import { ApiError } from "../api/client.js";

/**
 * Player-facing copy for the server's snake_case error codes.
 *
 * The server answers every failure with `{ error: "<code>" }` and the client
 * surfaces it via ApiError. Rendering `error.message` directly (as Login did)
 * shows the player the literal string "401 invalid_credentials", so every code
 * the API can emit gets a sentence here. The list is the full set found in
 * apps/server/src (grep for `error: "`), not just the ones the core loop hits,
 * so a Pass 2 page inherits the copy instead of regressing to raw codes.
 */
const MESSAGES: Record<string, string> = {
  already_in_a_gang: "You're already in a gang.",
  already_there: "You're already in that city.",
  amount_must_be_positive: "Enter an amount greater than zero.",
  boss_must_transfer_first: "A boss must hand the gang over before leaving.",
  cannot_kick_boss: "You can't kick the boss.",
  crime_not_found: "That crime no longer exists.",
  email_taken: "That email is already registered.",
  forbidden: "You don't have permission to do that.",
  gang_name_taken: "That gang name is taken.",
  gang_not_found: "That gang no longer exists.",
  insufficient_cash: "You don't have enough cash on hand.",
  insufficient_funds: "You don't have enough money.",
  insufficient_gang_funds: "The gang doesn't have enough money.",
  insufficient_stock: "Not enough in stock.",
  invalid_credentials: "Wrong username or password.",
  invalid_kind: "Unknown leaderboard.",
  invalid_request: "That request wasn't valid.",
  invite_not_found: "That invite is gone.",
  jailed: "You're in jail.",
  location_not_found: "No such city.",
  mail_not_found: "That message is gone.",
  no_location: "Travel to a city first.",
  not_a_member: "You're not a member of that gang.",
  not_sold_here: "This location doesn't stock that.",
  notification_not_found: "That notification is gone.",
  on_cooldown: "Not ready yet.",
  player_not_found: "No such player.",
  rate_limited: "Too many attempts — wait a moment.",
  recipient_not_found: "No such player.",
  unauthorized: "Your session expired — log in again.",
  unknown_error: "Something went wrong.",
  username_taken: "That username is taken.",
};

/** "45s", "2m 05s" — used to make the timed errors say how long. */
export function formatDuration(totalSeconds: number): string {
  const seconds = Math.max(0, Math.trunc(totalSeconds));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
}

/**
 * One sentence for any thrown value. Unknown codes fall back to the raw code
 * rather than a generic message, so a code added server-side without copy here
 * is still diagnosable from the screen.
 */
export function describeError(error: unknown): string {
  if (!(error instanceof ApiError)) {
    return error instanceof Error ? error.message : "Something went wrong.";
  }

  const base = MESSAGES[error.code] ?? error.code;

  // The timed/quantified codes carry a number the base sentence should use.
  if (error.code === "jailed" && error.remainingSeconds !== undefined) {
    return `You're in jail for another ${formatDuration(error.remainingSeconds)}.`;
  }
  if (error.code === "on_cooldown" && error.retryAfter !== undefined) {
    return `Not ready yet — ${formatDuration(error.retryAfter)} to go.`;
  }
  if (error.code === "insufficient_stock" && error.available !== undefined) {
    return `Only ${error.available} left in stock here.`;
  }
  return base;
}
