import { pgEnum } from "drizzle-orm/pg-core";

/** Which balance a ledger row moves. Spec §2.5 transactions.balance_kind. */
export const balanceKind = pgEnum("balance_kind", ["cash", "bank", "points"]);
