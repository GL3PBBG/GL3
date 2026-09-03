/**
 * Toggles one instruction index in an in-flight set, returning a new set
 * rather than mutating. Kept pure and separate from `PageRenderer` so the
 * double-submit guard (item 3: a button/form with no pending state lets a
 * double-click double-POST a plugin action that carries no idempotency key)
 * is testable without a DOM — `apps/web`'s vitest project runs in `node`,
 * not `jsdom`, by design (`vitest.workspace.ts`).
 *
 * Scoped per instruction index, not page-wide: one button in flight does not
 * disable the others. A page can carry several independent actions (a panel
 * of unrelated buttons, or a button beside an unrelated form), and disabling
 * all of them for the duration of one unrelated request would be a worse
 * default than the bug this exists to fix.
 */
export function togglePending(
  pending: ReadonlySet<number>,
  index: number,
  active: boolean,
): ReadonlySet<number> {
  const next = new Set(pending);
  if (active) next.add(index);
  else next.delete(index);
  return next;
}
