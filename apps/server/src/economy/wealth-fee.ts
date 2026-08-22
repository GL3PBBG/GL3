/**
 * The wealth-scaled fee: the feedback-loop sink. Flat fees are trivial for an
 * established player — bail at $1,000/sec is noise to anyone past mid-game —
 * so the three facility fees (jail bail, hospital discharge, detectives) are
 * raised toward a percent of the PAYER's cash + bank, floored at the flat fee
 * and capped at a multiple of it.
 *
 * Three deliberate properties:
 *   - The floor is the flat fee, so a poor player pays exactly what they pay
 *     today and nothing about the early game changes.
 *   - Wealth includes the bank. Cash-only scaling would make depositing a fee
 *     shelter; the bank keeps its real job (surviving a kill's cash looting)
 *     without gaming bail.
 *   - `percent = 0` collapses to the flat fee — the operator's rollback knob,
 *     which is why it is clamped-to-valid rather than rejected.
 *
 * Pure bigint math, no I/O: the CALLER'S row is already locked in every debit
 * path that uses this (jail/hospital lock the payer before reading; the
 * detectives hire reads in-transaction). `packages/plugins/detectives` carries
 * a copy — plugins import from @gl3/plugin-sdk, not core, and one function is
 * below the threshold the "plugins copy small parsers" convention sets.
 */
export function wealthScaledFee(
  flat: bigint, wealth: bigint, percent: number, capMultiplier: number,
): bigint {
  if (percent <= 0) return flat;
  if (flat <= 0n) return flat; // a free facility stays free; 0 × anything is 0
  // Ceiling division — the fee rounds up against the payer, same direction as
  // travel's membership fare (`(cost + 3n) / 4n`).
  const target = (wealth * BigInt(percent) + 99n) / 100n;
  const capped = flat * BigInt(capMultiplier);
  const raised = target > flat ? target : flat;
  return raised > capped ? capped : raised;
}
