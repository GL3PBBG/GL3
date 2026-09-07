import { z } from "zod";

export const LegalDocSchema = z.enum(["terms", "privacy"]);
export type LegalDoc = z.infer<typeof LegalDocSchema>;

/**
 * A rendered legal document. `missing` names the template placeholders the
 * operator has not set (e.g. "operatorName"); the markdown still renders
 * them as a visible `[operator name not set]`, never a silent blank.
 */
export const LegalDocResponseSchema = z.object({
  title: z.string(),
  markdown: z.string(),
  effectiveDate: z.string().nullable(),
  missing: z.array(z.string()),
});
export type LegalDocResponse = z.infer<typeof LegalDocResponseSchema>;
