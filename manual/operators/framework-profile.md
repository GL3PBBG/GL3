# The framework profile

> **Audience:** an operator who wants GL3 as a game engine — not as the
> gangster game — most commonly to migrate an [openPBBG](https://github.com/ChristopherDay/openPBBG)
> game onto it.

`GL3_PROFILE` decides which bundled plugins load at boot:

| | `full` (default) | `framework` |
|---|---|---|
| Plugins | all twenty | the eight game-agnostic ones |
| Jail & hospital | core routes + sweeper | not registered |
| Wealth tax | daily loop on player and gang cash | not started |
| Sample content | crimes, cities, items seeded | ranks and items only |
| Nav | the full game | no Crimes category, no Bullets/Location HUD stats |

The framework set is openPBBG's module list, one GL3 plugin each: `ranks`,
`notifications`, `news`, `bank`, `mail`, `forum`, `inventory`, `membership`.
Everything else — `crimes`, `bullets`, `travel`, `gangs`, `combat`,
`bounties`, `detectives`, `oc`, `theft`, `properties`, `casino`, `blackjack` —
is gameplay, loaded only by `full`.

```bash
# compose: a framework boot
GL3_PROFILE=framework docker compose --profile app up

# from source
GL3_PROFILE=framework npm run dev
```

## Adding gameplay back, piece by piece

Gameplay plugins are selectable under `framework` — the same `PLUGIN_IDS`
variable that selects optional compiled-in plugins:

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

In practice: `combat` pulls `detectives` with it, `casino` pulls the
properties chain, and the bullet shop pulls travel. Name them all in
`PLUGIN_IDS`; the boot error tells you exactly what is missing if you do not.

## Migrating an openPBBG database

`gl3-migrate` handles a framework-shaped source natively: the schema
fingerprint requires only the account tables, the game tables' absence is
reported (not fatal), every games phase skips, and the plugin-table migrators
check the target — a framework-profile GL3 that never created `p_bounties_*`
skips those sections and says so in the report:

```bash
gl3-migrate --mysql mysql://user:pass@host/openpbbg_db --pg postgres://...
```

The [migrator README](https://github.com/rondlite/GL3/tree/main/apps/migrate)
documents the report fields (`missingSourceTables`,
`absentTargetTables`) both sides produce.
