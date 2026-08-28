# Game modes (`GL3_PROFILE`)

> **Audience:** an operator choosing what kind of game a GL3 boot is — the
> flagship hybrid, a faithful V2 port, an MCCodes-style game, or a bare
> engine to migrate an [openPBBG](https://github.com/ChristopherDay/openPBBG)
> game onto.

`GL3_PROFILE` decides which bundled plugins load at boot. Four values parse;
the old `full` value was removed (its successor is `v2`) and fails the boot.

| Profile | Plugins | What it is |
|---|---|---|
| `gl3` (default) | all twenty-seven | The flagship hybrid: framework + V2 gameplay + the MCCodes family, with curated content (blended crime catalog, temple exchanges gated to refills) |
| `v2` | twenty (framework + gameplay) | The faithful Gangster Legends V2 port — the mode formerly named `full` |
| `mccodes` | nineteen (framework + family + `crimes`, `combat`, `travel`, `detectives`) | An MCCodes-style game; `detectives` rides along because `combat` requires it |
| `framework` | the eight game-agnostic ones | GL3 as an engine, no gameplay |

The framework set is openPBBG's module list, one GL3 plugin each: `ranks`,
`notifications`, `news`, `bank`, `mail`, `forum`, `inventory`, `membership`.
The gameplay set is the V2 game: `crimes`, `bullets`, `travel`, `gangs`,
`combat`, `bounties`, `detectives`, `oc`, `theft`, `properties`, `casino`,
`blackjack`. The MCCodes family is `mccodes-attributes` plus the six that
require it: `gym`, `houses`, `education`, `jobs`, `temple`, `progression`.

What else rides the profile switch:

| | gameplay profiles | `framework` |
|---|---|---|
| Jail & hospital | core routes + sentence sweeper | sweeper not started |
| Wealth tax | daily loop on player and gang **bank** balances (cash is never taxed) | not started |
| Nav | per loaded plugin | no Crimes category, no Bullets/Location HUD stats |

Sample content is seeded per **loaded plugin**, not per profile: crimes seed
only when the `crimes` plugin loads (the catalog differs — `v2` seeds the
historical three cooldown crimes, `gl3`/`mccodes` seed eight blended
brave+cooldown+formula crimes), towns only with `travel` or `bullets`, items
only with `inventory`, and the MCCodes family content (houses, courses, jobs)
seeds in a second pass after plugin migrations. Temple exchanges seed only on
`gl3`, where the catalog is curated to refills. Ranks always seed.

```bash
# compose: a framework boot. Note the shipped app profile requires
# GL3_NPM_TOKEN in .env (the plugins installer service), and its
# PLUGIN_PACKAGES default installs @gl3-plugins/market — override it
# (e.g. PLUGIN_PACKAGES="") for a truly bare engine.
GL3_PROFILE=framework docker compose --profile app up

# from source
GL3_PROFILE=framework npm run dev
```

## Adding gameplay back, piece by piece

Gameplay and family plugins are selectable under `framework` — the same
`PLUGIN_IDS` variable that selects optional compiled-in plugins:

```bash
GL3_PROFILE=framework PLUGIN_IDS=crimes
```

A plugin's cross-plugin requirements are declared on its manifest
(`requires`) and enforced at boot: loading `combat` without `detectives`
fails the boot with a message naming both — the days of discovering the
missing table as a runtime `relation does not exist` are over. The real
dependency clusters:

- `combat` requires `inventory` and `detectives`
- `bounties` requires `combat`; `properties` requires `combat`
- `casino` requires `properties`; `blackjack` requires `casino`
- `bullets` requires `properties` and `travel`
- `crimes`, `theft`, `travel` require `membership` (framework — always loaded)
- `gym`, `houses`, `education`, `jobs`, `temple`, `progression` each require
  `mccodes-attributes`

In practice: `combat` pulls `detectives` with it, `casino` pulls the
properties chain, the bullet shop pulls travel, and any family plugin pulls
`mccodes-attributes`. Name them all in `PLUGIN_IDS`; the boot error tells you
exactly what is missing if you do not.

## Migrating an openPBBG database

`gl3-migrate` handles a framework-shaped source natively: the schema
fingerprint requires only the account tables, the game tables' absence is
reported (not fatal), every games phase skips, and the plugin-table migrators
check the target — a framework-profile GL3 that never created `p_bounties_*`
skips those sections and says so in the report:

```bash
gl3-migrate --mysql mysql://user:pass@host/openpbbg_db --pg postgres://...
```

An MCCodes v2 source uses the same CLI with the dialect flag: add
`--mccodes`. The [migrator README](https://github.com/GL3PBBG/GL3/tree/main/apps/migrate)
documents the report fields (`missingSourceTables`,
`absentTargetTables`) both sides produce.
