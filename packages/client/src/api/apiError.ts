/**
 * The extra fields the server attaches to specific failures.
 *
 * Written `?: number | undefined` rather than `?: number` because
 * `exactOptionalPropertyTypes` is on: the construction site below always
 * supplies all three keys, so they must be allowed to hold `undefined`.
 */
export interface ApiErrorDetail {
  /** 429 on_cooldown — seconds until the action is available again. */
  retryAfter?: number | undefined;
  /** 423 jailed — seconds left on the sentence. */
  remainingSeconds?: number | undefined;
  /** 409 insufficient_stock — how many bullets the location actually has. */
  available?: number | undefined;
  /** 400 quantity_above_max — the admin's per-purchase bullet cap. */
  maxBuy?: number | undefined;
}

export class ApiError extends Error {
  readonly retryAfter: number | undefined;
  readonly remainingSeconds: number | undefined;
  readonly available: number | undefined;
  readonly maxBuy: number | undefined;

  constructor(readonly status: number, readonly code: string, detail: ApiErrorDetail = {}) {
    super(`${status} ${code}`);
    this.name = "ApiError";
    this.retryAfter = detail.retryAfter;
    this.remainingSeconds = detail.remainingSeconds;
    this.available = detail.available;
    this.maxBuy = detail.maxBuy;
  }
}
