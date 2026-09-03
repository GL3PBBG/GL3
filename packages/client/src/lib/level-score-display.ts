import { decodeLevelScore, DEFAULT_MONEY_FORMAT, type LeaderboardKind, type MoneyFormat } from "@gl3/shared";
import { formatAmount } from "./money.js";

/**
 * A board's exp column shows a plain integer, except when the server flags
 * `mode: "level"` (a routed boot's composite `level × 1e12 + exp` score) —
 * then it decodes to "Lv {level} · {exp} exp". Every other case (`mode`
 * absent, `mode: "exp"`, or a non-exp `kind`) passes `score` through
 * unchanged: the caller still renders it through `<Amount>`/`<Money>` as
 * before, so this helper only decides WHETHER to decode, not how to format
 * money. `format` defaults to `DEFAULT_MONEY_FORMAT` so every call site —
 * and every existing test — stays unaffected; pass the page's own
 * `useMoneyFormat()` result to respect a plugin-driven thousands separator.
 */
export function formatBoardScore(
  kind: LeaderboardKind,
  mode: "exp" | "level" | undefined,
  score: string,
  format: MoneyFormat = DEFAULT_MONEY_FORMAT,
): string {
  if (kind !== "exp" || mode !== "level") return score;
  const { level, exp } = decodeLevelScore(score);
  return `Lv ${level} · ${formatAmount(exp.toString(), format)} exp`;
}
