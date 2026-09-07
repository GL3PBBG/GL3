/** Settings keys behind the four operator-supplied placeholders. `gameName` comes from branding (`game.name`). */
export const LEGAL_KEYS = {
  operatorName: "legal.operator_name",
  contactEmail: "legal.contact_email",
  jurisdiction: "legal.jurisdiction",
  effectiveDate: "legal.effective_date",
} as const;

export type LegalPlaceholder = keyof typeof LEGAL_KEYS | "gameName";

const LABELS: Record<LegalPlaceholder, string> = {
  gameName: "game name", operatorName: "operator name", contactEmail: "contact email",
  jurisdiction: "jurisdiction", effectiveDate: "effective date",
};

const PLACEHOLDER = /\{\{(gameName|operatorName|contactEmail|jurisdiction|effectiveDate)\}\}/g;

/**
 * One pass, one regex: a value is never re-scanned, so an operator name that
 * happens to contain `{{...}}` renders literally. An unset value renders as a
 * visible bracketed label — a legal page must never silently blank a party's
 * name — and is reported once in `missing` for the admin warning.
 */
export function renderLegal(
  template: string, values: Partial<Record<LegalPlaceholder, string>>,
): { markdown: string; missing: LegalPlaceholder[] } {
  const missing = new Set<LegalPlaceholder>();
  const markdown = template.replace(PLACEHOLDER, (_m, name: LegalPlaceholder) => {
    const value = values[name]?.trim();
    if (value) return value;
    missing.add(name);
    return `[${LABELS[name]} not set]`;
  });
  return { markdown, missing: [...missing] };
}
