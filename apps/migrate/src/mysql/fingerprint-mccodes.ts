import type mysql from "mysql2/promise";
import { fingerprintSchema, type FingerprintResult } from "./fingerprint.js";

/**
 * The MCCodes v2 source's preflight (B1 Task 6, audit §5's 63-table
 * catalog). REQUIRED covers the three tables no MCCodes install can lack,
 * keyed on the columns the players migrator's first query names — `userid`,
 * not V2's `U_id`, is what separates the dialects before a single row
 * moves, which is exactly what a wrong-dialect mistake must do: fail loudly
 * at the fingerprint, never migrate the wrong game.
 *
 * No gameColumns: MCCodes has no framework-vs-game variant the way GL2's
 * openPBBG does — stock ships courses/jobs empty but the TABLES exist.
 */
const REQUIRED_TABLES = ["users", "userstats", "settings"] as const;

const REQUIRED_COLUMNS: Record<(typeof REQUIRED_TABLES)[number], string[]> = {
  users: ["userid", "username", "userpass"],
  userstats: ["userid", "strength"],
  settings: ["conf_name"],
};

/** All 63 tables from audit §5, in its four groups' order. */
const KNOWN_TABLES = [
  // Identity & progression (8)
  "users", "userstats", "staff_roles", "users_roles", "coursesdone",
  "inventory", "challengesbeaten", "votes",
  // Content — all ship EMPTY except cities/houses (14)
  "cities", "houses", "courses", "crimes", "crimegroups", "itemtypes", "items",
  "shops", "shopitems", "jobs", "jobranks", "orgcrimes", "polls", "papercontent",
  // Social & economy state (21)
  "gangs", "gangevents", "gangwars", "surrenders", "applications",
  "friendslist", "contactlist", "blacklist", "mail", "events", "announcements",
  "forum_forums", "forum_topics", "forum_posts", "preports", "referals",
  "crystalmarket", "itemmarket", "challengebots", "dps_accepted", "willps_accepted",
  // Logs & system (20)
  "fedjail", "stafflog", "staffnotelogs", "jaillogs", "unjaillogs", "attacklogs",
  "cashxferlogs", "bankxferlogs", "crystalxferlogs", "itemxferlogs",
  "itembuylogs", "itemselllogs", "imarketaddlogs", "imbuylogs", "imremovelogs",
  "oclogs", "settings", "cron_times", "logs_cron_fails", "logs_cron_runtimes",
];

export function fingerprintMccodesSchema(pool: mysql.Pool): Promise<FingerprintResult> {
  return fingerprintSchema(pool, {
    requiredTables: REQUIRED_TABLES,
    requiredColumns: REQUIRED_COLUMNS,
    knownTables: KNOWN_TABLES,
  });
}
