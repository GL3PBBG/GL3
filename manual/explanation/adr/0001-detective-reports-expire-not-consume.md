# 0001. Detective reports expire by time; attacking does not consume them

- **Date:** 2026-08-18
- **Status:** accepted

> Example ADR, extracted from the location-combat-modes design doc (§0) to show the
> format. The design doc remains the full record; the ADR is the one decision.

## Context

Underground towns require an active detective report to attack a resident. V2, the
reference implementation, expired the report on the first shot, hit or miss. GL3
needed to decide whether to copy that consumption rule.

## Options considered

**Consume on shot (V2-exact).** Faithful to the reference, but V2 combat was
one-volley-one-kill; GL3 combat is multi-shot whittling, so per-shot consumption
would price a kill at `report cost × shots` - an order of magnitude off.

**Time expiry only.** The report's expiry window acts as the licence to shoot. Keeps
the detectives table write-free from the combat path.

## Decision

Reports expire by time only (`expires_at`, materialised at hire). Attacking neither
consumes nor writes to the report row.

## Consequences

- A single report funds a whole kill within its window - capital and patience price
  the hit, not per-shot fees.
- Combat's dependency on detectives stays read-only, preserving the one-way
  plugin-coupling rule.
- Consumption-on-shot remains possible later as a per-town or global setting; the
  check order and column make it a small addition (recorded as out of scope in the
  design doc, §6).
