import { integer, pgTable, primaryKey, text, uuid } from "drizzle-orm/pg-core";

export const idMap = pgTable("id_map", {
  v2Table: text("v2_table").notNull(),
  v2Id: integer("v2_id").notNull(),
  v3Id: uuid("v3_id").notNull(),
}, (t) => ({ pk: primaryKey({ columns: [t.v2Table, t.v2Id] }) }));
