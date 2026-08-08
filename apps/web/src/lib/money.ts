/**
 * Money formatting for values that cross the wire as decimal strings.
 *
 * Every monetary field in @gl3/shared is a `MoneySchema` string (`/^-?\d+$/`)
 * because the server stores it as a Postgres `bigint` and JSON has no bigint.
 * Converting to `Number` here would silently lose precision above 2^53 — the
 * exact failure the string encoding exists to prevent — so all of this is
 * string/BigInt work and never touches a float.
 */

/** Insert thousands separators into a run of digits. */
function group(digits: string): string {
  let out = "";
  for (let i = 0; i < digits.length; i += 1) {
    // Separator before every digit whose distance from the end is a multiple
    // of 3, except at the very start ("1,234", not ",1,234").
    if (i > 0 && (digits.length - i) % 3 === 0) out += ",";
    out += digits[i];
  }
  return out;
}

/**
 * `"1234"` → `"1,234"`, `"-50"` → `"-50"`. Throws on anything that isn't an
 * integer string, since that means a DTO changed shape and silently rendering
 * `NaN` would hide it.
 */
export function formatAmount(value: string): string {
  const negative = value.startsWith("-");
  const digits = negative ? value.slice(1) : value;
  if (digits.length === 0 || !/^\d+$/.test(digits)) {
    throw new Error(`not an integer string: ${value}`);
  }
  // Strip leading zeros but keep a single "0".
  const trimmed = digits.replace(/^0+(?=\d)/, "");
  return `${negative ? "-" : ""}${group(trimmed)}`;
}

/** `"1234"` → `"$1,234"`. Negative reads `-$50`, not `$-50`. */
export function formatMoney(value: string): string {
  const formatted = formatAmount(value);
  return formatted.startsWith("-") ? `-$${formatted.slice(1)}` : `$${formatted}`;
}

/**
 * Multiply a money string by a small integer count, staying in BigInt.
 * Used for "quantity × unit price" totals (the bullet shop).
 */
export function multiplyMoney(value: string, count: number): string {
  if (!Number.isSafeInteger(count)) throw new Error(`not an integer count: ${count}`);
  return (BigInt(value) * BigInt(count)).toString();
}

/** True when `have` covers `need`. Both are money strings. */
export function canAfford(have: string, need: string): boolean {
  return BigInt(have) >= BigInt(need);
}
