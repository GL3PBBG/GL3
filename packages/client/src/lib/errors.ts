import { ApiError } from "../api/apiError.js";

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
  already_bet: "Your stake for this hand is already in.",
  already_full: "You're at full health.",
  already_hospitalised: "You're already in hospital.",
  already_in_a_gang: "You're already in a gang.",
  already_jailed: "You're in jail yourself.",
  already_owned: "That's already owned.",
  already_seated: "You're already sitting at a table.",
  already_there: "You're already in that city.",
  already_verified: "Your email is already verified.",
  amount_must_be_positive: "Enter an amount greater than zero.",
  banned: "This account is banned.",
  boss_must_transfer_first: "A boss must hand the gang over before leaving.",
  cannot_ban_self: "You can't ban yourself.",
  cannot_kick_boss: "You can't kick the boss.",
  cooldown: "You just fired — wait a moment.",
  cost_above_max: "That price is above the maximum bullet cost.",
  crime_not_found: "That crime no longer exists.",
  downgrade_refused: "You can't move to a smaller house.",
  email_taken: "That email is already registered.",
  email_unverified: "Verify your email to continue.",
  forbidden: "You don't have permission to do that.",
  forum_not_found: "That forum no longer exists.",
  gang_name_taken: "That gang name is taken.",
  game_error: "The table wouldn't take that move.",
  gang_not_found: "That gang no longer exists.",
  hospitalised: "You're in hospital.",
  house_cannot_cover: "The house can't cover a win that big — bet less.",
  in_super_max: "Super max. Nobody attempts anything from super max.",
  insufficient_brave: "You're not feeling brave enough — it comes back over time.",
  insufficient_bullets: "You don't have enough bullets.",
  insufficient_cash: "You don't have enough cash on hand.",
  insufficient_energy: "You're out of energy — it comes back over time.",
  insufficient_funds: "You don't have enough money.",
  insufficient_gang_funds: "The gang doesn't have enough money.",
  insufficient_level: "Your level is too low for that.",
  insufficient_stock: "Not enough in stock.",
  insufficient_will: "You don't have the will for that right now — it comes back over time.",
  lever_above_cap: "That price is above the limit the admin set.",
  min_above_max: "The hourly minimum can't be above the maximum.",
  quantity_above_max: "That's more than you can buy at once.",
  stock_above_max: "That stock is above the maximum.",
  invalid_action: "That isn't a move in this game.",
  invalid_body: "That request didn't make sense.",
  invalid_code: "That verification code is invalid or expired.",
  invalid_credentials: "Wrong username or password.",
  invalid_game_multiplier: "That game is misconfigured — the table is closed.",
  invalid_kind: "Unknown leaderboard.",
  invalid_payout: "That game is misconfigured — the table is closed.",
  invalid_request: "That request wasn't valid.",
  invalid_scope: "Unknown leaderboard scope.",
  invalid_token: "That link is invalid or expired.",
  invalid_wager_delta: "That game is misconfigured — the table is closed.",
  invalid_window: "A round must end after it starts.",
  invite_not_found: "That invite is gone.",
  jailed: "You're in jail.",
  location_not_found: "No such city.",
  mail_not_found: "That message is gone.",
  no_email: "You don't have an email on file.",
  no_location: "Travel to a city first.",
  no_session: "You don't have a hand in play.",
  no_such_game: "That game isn't dealt here.",
  no_such_table: "That table is gone.",
  not_hospitalised: "You're not in hospital.",
  not_injured: "You're already at full health.",
  no_such_target: "No such player.",
  not_a_member: "You're not a member of that gang.",
  not_jailed: "They're not in jail.",
  not_owned: "You don't own that item.",
  not_seated: "You're not sitting at a table.",
  not_sold_here: "This location doesn't stock that.",
  not_your_turn: "It's not your turn yet.",
  notification_not_found: "That notification is gone.",
  on_cooldown: "Not ready yet.",
  player_not_found: "No such player.",
  post_not_found: "That post is gone.",
  protected: "That player is under protection.",
  rank_too_low: "You're not experienced enough to use that.",
  rate_limited: "Too many attempts — wait a moment.",
  recipient_not_found: "No such player.",
  round_finalized: "That round has already been settled.",
  round_not_found: "That round no longer exists.",
  round_overlap: "Another round already covers that period.",
  same_gang: "You can't shoot your own gang.",
  session_closed: "That hand is already over.",
  session_expired: "That hand timed out — deal a new one.",
  session_open: "Finish the hand you're playing first.",
  table_full: "Every seat at that table is taken.",
  target_elsewhere: "That player is elsewhere.",
  target_hospitalised: "That player is in hospital.",
  target_in_super_max: "They're in super max — no bail, no bust, only time.",
  target_jailed: "That player is in jail.",
  self_attack: "You can't shoot yourself.",
  self_target: "That's you.",
  topic_locked: "This topic is locked.",
  topic_not_found: "That topic no longer exists.",
  unauthorized: "Your session expired — log in again.",
  unknown_error: "Something went wrong.",
  username_taken: "That username is taken.",
  wager_above_max: "That's over the table limit.",
  wager_below_min: "That's under the minimum bet.",
  wrong_location: "They're not in this town.",
  wrong_phase: "The hand has moved on — that isn't the move now.",
  wrong_slot: "You can't equip that in that slot.",
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
  if (error.code === "cooldown" && error.retryAfter !== undefined) {
    return `You just fired — ${formatDuration(error.retryAfter)} to go.`;
  }
  if (error.code === "on_cooldown" && error.retryAfter !== undefined) {
    return `Not ready yet — ${formatDuration(error.retryAfter)} to go.`;
  }
  if (error.code === "insufficient_stock" && error.available !== undefined) {
    return `Only ${error.available} left in stock here.`;
  }
  if (error.code === "quantity_above_max" && error.maxBuy !== undefined) {
    return `You can buy at most ${error.maxBuy} bullets at a time.`;
  }
  return base;
}

/**
 * What an optimistically-started action cooldown should become after the
 * server refused the action. A 429 carries the server's own remaining time; a
 * refusal without one (insufficient_brave, jailed, a 404) happened BEFORE the
 * cooldown burned, so the optimistic lock must release — a dead button next to
 * no message was exactly how a brave shortfall looked like nothing at all.
 * A transport error returns null: the request may have landed, keep the lock.
 */
export function refusalCooldownSeconds(error: unknown): number | null {
  if (!(error instanceof ApiError)) return null;
  return error.retryAfter ?? 0;
}
