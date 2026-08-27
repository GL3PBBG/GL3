import { describe, expect, it } from "vitest";
import { registerVerifiedPlayer } from "./helpers/register.js";
import { bootTestServer } from "./helpers/server.js";

describe("gym page feed", () => {
  it("GET /api/gym serves the values feed and the page declares against it", async () => {
    const server = await bootTestServer();
    try {
      const { token } = await registerVerifiedPlayer(server);
      const res = await server.app.inject({
        method: "GET",
        url: "/api/gym",
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(200);
      const { values } = res.json() as { values: Record<string, string> };
      expect(Number(values.energyMax)).toBeGreaterThan(0);
      expect(values.strength).toBeDefined();

      // The declared page parses through the all-or-nothing payload schema.
      const payload = await server.app.inject({
        method: "GET",
        url: "/api/plugins",
        headers: { authorization: `Bearer ${token}` },
      });
      const pages = (payload.json() as { pages: { pluginId: string; id: string }[] }).pages;
      expect(pages.some((p) => p.pluginId === "gym")).toBe(true);
    } finally {
      await server.close();
    }
  });
});
