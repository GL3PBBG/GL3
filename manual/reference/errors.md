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
| `same_gang` | 409 | `POST /api/combat/attack/:targetId`, `POST /api/bounties` | Target is a gangmate |
| `protected` | 409 | `POST /api/combat/attack/:targetId` | Newbie protection — mutual: below the exp threshold you can neither be attacked nor attack |
| `no_detective_report` | 409 | `POST /api/combat/attack/:targetId` | Underground town and no active report on the target |
| `invalid_combat_mode` | 400 | `POST /api/admin/travel/locations`, `POST /api/admin/travel/locations/update` | `combat_mode` outside the enum |
| `self_attack` | 400 | `POST /api/combat/attack/:targetId` | Caller targeted themselves |
| `cooldown` | 429 | `POST /api/combat/attack/:targetId` | Attack cooldown live (`retry-after` header carries the wait) |
| `no_such_target` | 404 | `POST /api/combat/attack/:targetId` | Target id resolves to no player |
| `hospitalised` / `jailed` | 423 | `POST /api/combat/attack/:targetId` | The *caller* is in hospital / jail |
| `target_hospitalised` / `target_jailed` | 409 | `POST /api/combat/attack/:targetId` | The *target* is in hospital / jail |
| `insufficient_energy` | 409 | `POST /api/combat/attack/:targetId` | Attribute-pool cost unpayable (`core.actionCost`) |
| `insufficient_bullets` | 409 | `POST /api/combat/attack/:targetId` | Fewer bullets than the shot needs |
| `weapon_not_found` | 404 | gunsmith repair route | No such weapon in the caller's inventory |
| `insufficient_funds` | 409 | gunsmith repair route | Repair price exceeds cash |

## Conventions

- 4xx refusals on attack burn the cooldown (claim-before-transaction rule) —
  except `unauthorized` and `self_attack`, which are checked before the
  cooldown is claimed.
- Zod validation failures on bodies and route params return a clean 400 before any
  database read.
