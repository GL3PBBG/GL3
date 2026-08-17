import { definePlugin } from "@gl3/plugin-sdk";
import { CASINO_MIGRATIONS } from "./migrations.js";

export { casinoSessions } from "./schema.js";

export default definePlugin({
  id: "casino",
  version: "1.0.0",
  basePaths: ["/api/casino"],
  migrations: CASINO_MIGRATIONS,
  tables: { sessions: "p_casino_sessions" },
  routes: [],
});
