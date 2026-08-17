/**
 * `GameStep.state` is opaque, game-owned JSON persisted into the `state`
 * jsonb column (spec §4.1) — but a game's state commonly carries money as
 * `bigint` (blackjack's `BlackjackState.wager`), and neither native
 * `JSON.stringify` nor postgres.js's own jsonb encoder can serialize one:
 * both throw "Do not know how to serialize a BigInt". These two functions
 * round-trip a bigint through a tagged object so `state` survives storage
 * and comes back exactly as the game wrote it — `toStorableState` is used
 * wherever a session row is inserted or updated; `fromStorableState` is the
 * read-side counterpart a later task (`act`, the lazy forfeit) needs when it
 * loads `state` back out to hand to `game.act`/`game.settle`.
 */
const BIGINT_TAG = "__casino_bigint__";

export function toStorableState(value: unknown): unknown {
  return JSON.parse(
    JSON.stringify(value, (_key, v: unknown) =>
      (typeof v === "bigint" ? { [BIGINT_TAG]: v.toString() } : v)),
  );
}

export function fromStorableState(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(fromStorableState);
  if (value === null || typeof value !== "object") return value;
  const obj = value as Record<string, unknown>;
  const tagged = obj[BIGINT_TAG];
  if (typeof tagged === "string") return BigInt(tagged);
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(obj)) out[key] = fromStorableState(v);
  return out;
}
