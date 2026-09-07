/**
 * Generic browser-game Terms of Service, shipped with the GL3 engine as a
 * starting point — not legal advice. An operator fills in the four
 * placeholders through the admin panel; an unset one renders as a visible
 * `[... not set]` marker via `renderLegal`, never a silent blank.
 */
export const TERMS_TEMPLATE = `# Terms of Service

_Effective {{effectiveDate}}_

{{gameName}} is operated by {{operatorName}}. By creating an account or playing {{gameName}}, you agree to these terms. If you do not agree, do not use the game.

## 1. Eligibility

You must be at least 13 years old to play, or older where your local law requires it. If you are under 18, you need a parent or guardian's permission to create an account and play.

## 2. Your account

You may keep one account per person. You are responsible for keeping your password secret and for everything that happens under your account. Accounts may not be shared, transferred or sold. Keep the email address on your account current, since it is how we reach you about your account.

## 3. Fair play

You may not use bots, scripts, automation or exploits, and you may not run or control more than one account. You may not harass, threaten or post hateful, illegal or abusive content in your profile, mail or the forum. We may investigate reports of any of this.

## 4. Virtual items and currency

Cash, points, items, properties, ranks and every other in-game feature are part of the game only and have no real-world monetary value. They may be added, changed, rebalanced or removed at any time, and nothing is owed to you if that happens. Seasonal rounds reset standings and prizes on their own schedule.

## 5. Termination

We may suspend or ban an account that breaks these terms. You may delete your account at any time from your profile page; deletion removes your account and its data immediately and cannot be undone.

## 6. No warranty; limitation of liability

{{gameName}} is provided "as is," with no warranty of any kind. To the extent the law allows, {{operatorName}} is not liable for lost progress, downtime or data loss.

## 7. Changes

These terms may change from time to time. Continuing to play after a new effective date means you accept the updated terms.

## 8. Governing law

These terms are governed by the laws of {{jurisdiction}}.

## 9. Contact

Questions about these terms can be sent to {{contactEmail}}.

_This document is a template supplied with the GL3 engine. {{operatorName}} is responsible for its contents._
`;
