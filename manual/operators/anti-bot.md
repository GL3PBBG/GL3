# Anti-bot: detection, challenges, and same-IP blocks

> **Audience:** an operator moderating a live game.

GL3's API is an open JSON surface by design — the SPA and every plugin speak
it, so a determined player can script it. The anti-bot toolkit does not try
to make scripting impossible; it makes it **visible and actionable** while
leaving ordinary players untouched. Four layers, all opt-in or invisible
until you use them.

## 1. Client addresses behind a proxy: `CLIENT_IP_HEADER`

If your origin is only reachable through a trusted proxy (a Cloudflare
zero-trust tunnel is the canonical setup), every connection reaches GL3 from
the tunnel's address — rate-limit buckets collapse into one shared bucket and
every player looks like one machine. Set:

```
CLIENT_IP_HEADER=cf-connecting-ip
```

and GL3 reads the real client address from that header for rate limiting and
the telemetry below.

**Only set this when the origin genuinely cannot be reached directly.** On a
directly reachable origin the header is client-forgeable, and trusting it
lets anyone impersonate any address. GL3 never auto-detects the header for
that reason. Leave it unset in development.

## 2. Telemetry

`players.signup_ip` and `players.last_ip` record where an account was created
and where it last acted. `last_ip` rides the existing throttled presence
write (at most once a minute per player), so the columns cost nothing in
steady state. Accounts predating the feature hold `NULL` until their next
login.

## 3. The anti-bot admin section

Grant the `anti-bot` module to a moderator role (Admin → roles) and an
**Anti-bot** tab appears in the admin panel:

- **Suspects** — every player's last 24 hours of ledger activity, scored for
  bot-likeness: many actions, metronomic inter-action gaps, active around the
  clock. A script fires at cooldown-expiry with second-level precision at
  4 AM; a human plays in ragged bursts. The score **orders rows for your
  review — it proves nothing by itself**, and nothing automated acts on it.
  There is deliberately no auto-ban: a devoted human grinder can look
  bot-like, and that judgment stays with you. (`?hours=` up to 168 on the
  API for a longer window.)
- **IP clusters** — accounts sharing a signup or last-seen address. Two
  siblings on one router are legal; ten accounts funnelling cash to one are
  not. Read this next to the economy dashboard.
- **Require human check** — the challenge flag, below.
- The existing **players** section's ban tool is the enforcement lever.

## 4. The challenge flag

"Require human check" on a username flags the account: every **mutating**
request (anything that is not a read) answers `409 challenge_required` until
the player solves a simple arithmetic question at `/challenge`. Reads,
`/api/challenge` itself, and login/logout stay open, so the player is never
locked out of understanding what happened. Wrong answers burn the question
and mint a fresh one; the flag survives until solved or cleared.

Honest players solve it in five seconds and lose nothing. A bot script
stalls at its next action — and whether the account then goes quiet, solves
it instantly at 4 AM, or resumes its metronomic pattern is itself the
evidence you were looking for. The arithmetic is deliberately trivial for a
human; it is friction and a tripwire, not a Turing test.

## 5. Same-IP transfer blocks

Two voluntary player→player value handovers exist in a stock GL3 game:
property transfers and membership gifts. Both **refuse by default** when
giver and receiver share a signup or last-seen address, with
`409 same_ip_blocked` — the cheapest multi-account funnel, closed out of the
box.

To allow same-household trading, set either key to `false` in the settings
table (Admin → the owning plugin's settings, or SQL):

| Setting | Covers |
| --- | --- |
| `properties.block_same_ip_transfer` | `POST /api/properties/:id/transfer` |
| `membership.block_same_ip_transfer` | `POST /api/membership/gift` |

The check compares only non-null addresses: legacy accounts with no recorded
IP never match. Indirect flows (gang banks, bounties, losing on purpose at a
casino table) are not covered — watch the IP-cluster and economy views for
those.

## What this deliberately does not do

No CAPTCHAs on normal play, no proof-of-work, no client fingerprinting, no
automatic bans, and no gating of reads. Each of those either punishes humans
more than bots or starts an arms race the bots win. The posture is: record,
surface, let a human decide, and make the decision cheap.
