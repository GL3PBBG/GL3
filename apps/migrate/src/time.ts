/** V2 stores every timestamp as a unix-epoch `int(11)` (SPEC §1.1). */
export function unixToDate(seconds: number | null | undefined): Date | null {
  if (seconds === null || seconds === undefined) return null;
  return new Date(seconds * 1000);
}
