# Error codes

Every refusal is a single snake_case code with no explanatory oracle: a caller
learns *that* they were refused, not which of several conditions failed. Refused
states that share a cause share a code (a pending, failed, or expired detective
report is all just "no report").

This table is maintained by hand for now; add a row in the same PR that adds a
code. Longer term it should be generated from the zod schemas, which are the source
of truth. Seed rows below are from the combat area; other plugins' codes are still
to be catalogued.

| Code | Status | Route(s) | Meaning |
|---|---|---|---|
| `target_elsewhere` | 409 | `POST /api/combat/attack/:targetId` | Target is not in the caller's town |
| `same_gang` | 409 | `POST /api/combat/attack/:targetId` | Target is a gangmate |
| `protected` | 409 | `POST /api/combat/attack/:targetId` | Target has newbie protection |
| `no_detective_report` | 409 | `POST /api/combat/attack/:targetId` | Underground town and no active report on the target |
| `invalid_combat_mode` | 400 | admin towns route (travel plugin) | `combat_mode` outside the enum |

## Conventions

- 4xx refusals on attack burn the cooldown (claim-before-transaction rule).
- Zod validation failures on bodies and route params return a clean 400 before any
  database read.
