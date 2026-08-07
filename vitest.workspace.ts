import { defineWorkspace } from "vitest/config";

// apps/server is appended in Task 3, when that package first exists.
export default defineWorkspace(["packages/*"]);
