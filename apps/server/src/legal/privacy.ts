/**
 * Generic browser-game Privacy Policy, shipped with the GL3 engine as a
 * starting point — not legal advice. Same placeholder set and rendering
 * rules as {@link TERMS_TEMPLATE}.
 */
export const PRIVACY_TEMPLATE = `# Privacy Policy

_Effective {{effectiveDate}}_

{{operatorName}} operates {{gameName}}. This policy explains what we collect when you play and why.

## 1. What we collect

We collect your username, email address and a password hash (never your actual password). We record the IP address and request metadata of your signup and your most recent activity, for abuse prevention and rate limiting, along with presence timestamps such as when you were last seen. If you use our mobile app and enable notifications, we store the device token it registers. We also keep gameplay records — crimes, combat, mail, forum posts and transactions.

## 2. Why we collect it

We use this data to run the game, verify your email address, let you reset your password, detect and stop cheating and abuse, and send notifications you have chosen to receive.

## 3. Email

Your email address is used only to verify your account and to let you reset your password. We do not use it for marketing.

## 4. Sharing

Push notifications are delivered through Expo's push notification service. Hosting providers process data on our behalf to run {{gameName}}. We do not sell your personal data, and we disclose it to anyone else only where the law requires it.

## 5. Retention

We keep your data for as long as your account exists. Deleting your account from the profile page removes your account and its data immediately, except gang, forum and news records and messages you sent, which are kept without your name, and game records that reference you only by outcome (a bounty you claimed, a property you released), which are kept with the reference removed; server logs expire on their own schedule. Some game records tied to your account — course progress, employment, weapon condition and heist participation among them — may remain in the game's records after deletion. They no longer identify you, they are not shown to other players as yours, and they stay until the operator removes them.

## 6. Your rights

Access and deletion are self-service from your profile page. If you cannot sign in — for example because your account has been banned — email {{contactEmail}} and we will delete your account on request. To correct your data — for example your email address or username — contact {{contactEmail}}. If you live in {{jurisdiction}} or another region with its own data protection law, you may have additional statutory rights.

## 7. Children

{{gameName}} is not directed at children under 13. If you believe a child has given us data, contact us and we will remove it.

## 8. Changes

Any change to this policy is posted here with a new effective date.

## 9. Contact

Questions about this policy can be sent to {{contactEmail}}.

_This document is a template supplied with the GL3 engine. {{operatorName}} is responsible for its contents._
`;
