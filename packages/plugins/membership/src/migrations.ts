/**
 * Unlike bounties/detectives this table was never core-owned: V2's
 * `premiumMembership` was listed in SPEC §"Game content" but no core
 * migration ever created it, so there is nothing to relinquish. No foreign
 * keys — like `p_inventory_shop_stock`, deliberately: an FK is a lock
 * (CLAUDE.md rule 6) and nothing needs one (packages are content rows).
 * One statement per migration (bounties' reasoning).
 */
export const MEMBERSHIP_MIGRATIONS: { name: string; sql: string }[] = [
  {
    name: "0001_packages",
    sql: `CREATE TABLE p_membership_packages (
      id               uuid    PRIMARY KEY,
      name             text    NOT NULL,
      cost_points      bigint  NOT NULL,
      duration_seconds integer NOT NULL
    )`,
  },
];
