import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { Redis } from "ioredis";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { crimes } from "../src/db/schema/content.js";
import { resetDb, testDb } from "./helpers/db.js";
import { registerVerifiedPlayer } from "./helpers/register.js";
import { bootTestServer } from "./helpers/server.js";
import { uuidv7 } from "uuidv7";

const { db, sql: conn } = testDb();
let app: FastifyInstance;
let redis: Redis;
let closeServer: () => Promise<void>;
let adminToken: string;

beforeEach(async () => {
  await resetDb(db);
  if (!app) ({ app, close: closeServer, redis } = await bootTestServer());
  adminToken = (await registerVerifiedPlayer({ app, redis }, { username: "Founder" })).token;
});

afterAll(async () => { await closeServer(); await conn.end(); });

const auth = () => ({ authorization: `Bearer ${adminToken}` });

describe("crimes admin", () => {
  it("lists seeded crimes", async () => {
    const crimeId = uuidv7();
    await db.insert(crimes).values({
      id: crimeId, name: "Pickpocket", description: "Lift a wallet.",
      cooldownSeconds: 30, minPayout: 50n, maxPayout: 250n,
      minBullets: 0, maxBullets: 0, expReward: 5n,
      minLevel: 0, sort: 10, jailChancePercent: 0, jailSeconds: 0,
    });

    const list = await app.inject({ method: "GET", url: "/api/admin/crimes/list", headers: auth() });
    expect(list.statusCode).toBe(200);
    const row = list.json().rows.find((r: { id: string }) => r.id === crimeId);
    expect(row).toBeDefined();
    expect(row).toMatchObject({
      id: crimeId, name: "Pickpocket",
      cooldownSeconds: "30", minPayout: "50", maxPayout: "250",
      expReward: "5", jailChancePercent: "0", jailSeconds: "0",
    });
    // The seeded crime above has a NULL success_formula — every V2-migrated
    // catalog does. The table renderer parses this response with
    // TableRowsResponseSchema (`z.record(z.string())`), so a raw null in any
    // cell kills the WHOLE admin table client-side. Parse exactly as the
    // client does; this is what broke the live crimes admin page on a
    // migrated database (2026-08-27).
    expect(row.successFormula).toBe("");
    const { TableRowsResponseSchema } = await import("@gl3/shared");
    expect(() => TableRowsResponseSchema.parse(list.json())).not.toThrow();
  });

  // Wire-level proof of the edit-UX fix: the served admin payload must carry
  // prefillForm on the update form's crime select (picking the crime seeds
  // the form from the selected row) and the formula column in the table —
  // the client renders exactly what this payload declares, so a dropped
  // field here is a silently blank edit form there.
  it("serves the admin page with a prefilling update form and a formula column", async () => {
    const res = await app.inject({ method: "GET", url: "/api/admin/plugins", headers: auth() });
    expect(res.statusCode).toBe(200);
    const crimesSection = res.json().sections.find((s: { pluginId: string }) => s.pluginId === "crimes");
    expect(crimesSection).toBeDefined();
    const adminPage = crimesSection.pages.find((p: { id: string }) => p.id === "crimes-admin");
    expect(adminPage).toBeDefined();

    const table = adminPage.view.children.find(
      (c: { kind: string }) => c.kind === "table",
    );
    expect(table.columns.map((c: { key: string }) => c.key)).toContain("successFormula");

    const updateForm = adminPage.view.children.find(
      (c: { kind: string; action?: string }) => c.kind === "form" && c.action === "POST /api/admin/crimes/update",
    );
    const crimeSelect = updateForm.fields.find((f: { name: string }) => f.name === "id");
    expect(crimeSelect).toMatchObject({ type: "select", prefillForm: true });
  });

  it("updates a crime and persists the change", async () => {
    const crimeId = uuidv7();
    await db.insert(crimes).values({
      id: crimeId, name: "Pickpocket", description: "Lift a wallet.",
      cooldownSeconds: 30, minPayout: 50n, maxPayout: 250n,
      minBullets: 0, maxBullets: 0, expReward: 5n,
      minLevel: 0, sort: 10, jailChancePercent: 0, jailSeconds: 0,
    });

    const res = await app.inject({
      method: "POST", url: "/api/admin/crimes/update", headers: auth(),
      payload: {
        id: crimeId,
        cooldownSeconds: 60, minPayout: "100", maxPayout: "500",
        expReward: "10", jailChancePercent: 10, jailSeconds: 45,
      },
    });
    expect(res.statusCode).toBe(204);

    const [row] = await db.select().from(crimes).where(eq(crimes.id, crimeId));
    expect(row?.cooldownSeconds).toBe(60);
    expect(row?.minPayout).toBe(100n);
    expect(row?.maxPayout).toBe(500n);
    expect(row?.expReward).toBe(10n);
    expect(row?.jailChancePercent).toBe(10);
    expect(row?.jailSeconds).toBe(45);
  });

  it("lists description and the bullet range so the update form can prefill them", async () => {
    const crimeId = uuidv7();
    await db.insert(crimes).values({
      id: crimeId, name: "Armoured Van", description: "Take the van.",
      cooldownSeconds: 300, minPayout: 2000n, maxPayout: 9000n,
      minBullets: 1, maxBullets: 5, expReward: 40n,
      minLevel: 0, sort: 30, jailChancePercent: 40, jailSeconds: 120,
    });
    const list = await app.inject({ method: "GET", url: "/api/admin/crimes/list", headers: auth() });
    const row = list.json().rows.find((r: { id: string }) => r.id === crimeId);
    expect(row).toMatchObject({ description: "Take the van.", minBullets: "1", maxBullets: "5" });
    const { TableRowsResponseSchema } = await import("@gl3/shared");
    expect(() => TableRowsResponseSchema.parse(list.json())).not.toThrow();
  });

  it("updates name, description and the bullet range", async () => {
    // V2's admin edits every column (crimes.admin.php:112); the port's
    // update route had left these four out with a comment calling the
    // bullet range "the crime's cost" — it is the success reward.
    const crimeId = uuidv7();
    await db.insert(crimes).values({
      id: crimeId, name: "Pickpocket", description: "Lift a wallet.",
      cooldownSeconds: 30, minPayout: 50n, maxPayout: 250n,
      minBullets: 0, maxBullets: 0, expReward: 5n,
      minLevel: 0, sort: 10, jailChancePercent: 0, jailSeconds: 0,
    });
    const base = {
      id: crimeId, cooldownSeconds: 30, minPayout: "50", maxPayout: "250",
      expReward: "5", jailChancePercent: 0, jailSeconds: 0,
    };
    const res = await app.inject({
      method: "POST", url: "/api/admin/crimes/update", headers: auth(),
      payload: { ...base, name: "Purse Snatch", description: "Grab and run.", minBullets: 1, maxBullets: 3 },
    });
    expect(res.statusCode).toBe(204);
    let [row] = await db.select().from(crimes).where(eq(crimes.id, crimeId));
    expect(row).toMatchObject({ name: "Purse Snatch", description: "Grab and run.", minBullets: 1, maxBullets: 3 });

    // Absent leaves them alone (the crimeExpReward shape).
    const untouched = await app.inject({
      method: "POST", url: "/api/admin/crimes/update", headers: auth(), payload: base,
    });
    expect(untouched.statusCode).toBe(204);
    [row] = await db.select().from(crimes).where(eq(crimes.id, crimeId));
    expect(row).toMatchObject({ name: "Purse Snatch", description: "Grab and run.", minBullets: 1, maxBullets: 3 });

    // An inverted range is refused at update just as it is at create.
    const inverted = await app.inject({
      method: "POST", url: "/api/admin/crimes/update", headers: auth(),
      payload: { ...base, minBullets: 5, maxBullets: 2 },
    });
    expect(inverted.statusCode).toBe(400);
    // A one-sided change is checked against the stored other side: raising
    // minBullets above the current maxBullets is the same inverted range.
    const oneSided = await app.inject({
      method: "POST", url: "/api/admin/crimes/update", headers: auth(),
      payload: { ...base, minBullets: 9 },
    });
    expect(oneSided.statusCode).toBe(400);
    [row] = await db.select().from(crimes).where(eq(crimes.id, crimeId));
    expect(row).toMatchObject({ minBullets: 1, maxBullets: 3 });
  });

  it("serves bullet-range and name/description fields on the update form", async () => {
    const res = await app.inject({ method: "GET", url: "/api/admin/plugins", headers: auth() });
    const section = res.json().sections.find((s: { pluginId: string }) => s.pluginId === "crimes");
    const page = section.pages.find((p: { id: string }) => p.id === "crimes-admin");
    const form = page.view.children.find(
      (c: { kind: string; action?: string }) => c.kind === "form" && c.action === "POST /api/admin/crimes/update",
    );
    const names = form.fields.map((f: { name: string }) => f.name);
    expect(names).toEqual(expect.arrayContaining(["name", "description", "minBullets", "maxBullets"]));
    const table = page.view.children.find((c: { kind: string }) => c.kind === "table");
    expect(table.columns.map((c: { key: string }) => c.key)).toContain("minBullets");
  });

  it("lists a crime's brave cost as a string cell", async () => {
    const crimeId = uuidv7();
    await db.insert(crimes).values({
      id: crimeId, name: "Pickpocket", description: "Lift a wallet.",
      cooldownSeconds: 30, minPayout: 50n, maxPayout: 250n,
      minBullets: 0, maxBullets: 0, expReward: 5n, braveCost: 4,
      minRank: 0, sort: 10, jailChancePercent: 0, jailSeconds: 0,
    });

    const list = await app.inject({ method: "GET", url: "/api/admin/crimes/list", headers: auth() });
    expect(list.statusCode).toBe(200);
    const row = list.json().rows.find((r: { id: string }) => r.id === crimeId);
    expect(row?.braveCost).toBe("4");
  });

  it("creates a crime with a brave cost and persists it", async () => {
    const res = await app.inject({
      method: "POST", url: "/api/admin/crimes", headers: auth(),
      payload: {
        name: "Brave job", description: "Takes nerve.",
        cooldownSeconds: 30, minPayout: "50", maxPayout: "100",
        minBullets: 0, maxBullets: 0, expReward: "5", braveCost: 7,
        jailChancePercent: 0, jailSeconds: 0,
      },
    });
    expect(res.statusCode).toBe(201);
    const [row] = await db.select().from(crimes).where(eq(crimes.id, res.json().id));
    expect(row?.braveCost).toBe(7);
  });

  it("updates a crime's brave cost and leaves it alone when the field is absent", async () => {
    const crimeId = uuidv7();
    await db.insert(crimes).values({
      id: crimeId, name: "Pickpocket", description: "Lift a wallet.",
      cooldownSeconds: 30, minPayout: 50n, maxPayout: 250n,
      minBullets: 0, maxBullets: 0, expReward: 5n, braveCost: 2,
      minRank: 0, sort: 10, jailChancePercent: 0, jailSeconds: 0,
    });

    const res = await app.inject({
      method: "POST", url: "/api/admin/crimes/update", headers: auth(),
      payload: {
        id: crimeId,
        cooldownSeconds: 30, minPayout: "50", maxPayout: "250",
        expReward: "5", braveCost: 9, jailChancePercent: 0, jailSeconds: 0,
      },
    });
    expect(res.statusCode).toBe(204);
    const [row] = await db.select().from(crimes).where(eq(crimes.id, crimeId));
    expect(row?.braveCost).toBe(9);

    // Absent key: untouched (the crimeExpReward/successFormula contract).
    const omit = await app.inject({
      method: "POST", url: "/api/admin/crimes/update", headers: auth(),
      payload: {
        id: crimeId,
        cooldownSeconds: 30, minPayout: "50", maxPayout: "250",
        expReward: "5", jailChancePercent: 0, jailSeconds: 0,
      },
    });
    expect(omit.statusCode).toBe(204);
    const [after] = await db.select().from(crimes).where(eq(crimes.id, crimeId));
    expect(after?.braveCost).toBe(9);
  });

  it("404s an update to an unknown id", async () => {
    const res = await app.inject({
      method: "POST", url: "/api/admin/crimes/update", headers: auth(),
      payload: {
        id: "00000000-0000-7000-8000-000000000000",
        cooldownSeconds: 30, minPayout: "50", maxPayout: "100",
        expReward: "5", jailChancePercent: 0, jailSeconds: 0,
      },
    });
    expect(res.statusCode).toBe(404);
  });

  it("400s when maxPayout < minPayout", async () => {
    const crimeId = uuidv7();
    await db.insert(crimes).values({
      id: crimeId, name: "Pickpocket", description: "Lift a wallet.",
      cooldownSeconds: 30, minPayout: 50n, maxPayout: 250n,
      minBullets: 0, maxBullets: 0, expReward: 5n,
      minLevel: 0, sort: 10, jailChancePercent: 0, jailSeconds: 0,
    });
    const res = await app.inject({
      method: "POST", url: "/api/admin/crimes/update", headers: auth(),
      payload: {
        id: crimeId,
        cooldownSeconds: 30, minPayout: "500", maxPayout: "100",
        expReward: "5", jailChancePercent: 0, jailSeconds: 0,
      },
    });
    expect(res.statusCode).toBe(400);
  });

  it("creates a crime and lists it", async () => {
    const res = await app.inject({
      method: "POST", url: "/api/admin/crimes", headers: auth(),
      payload: {
        name: "Bank job", description: "Walk in, walk out.",
        cooldownSeconds: 300, minPayout: "1000", maxPayout: "5000",
        minBullets: 0, maxBullets: 10, expReward: "50",
        jailChancePercent: 25, jailSeconds: 600,
      },
    });
    expect(res.statusCode).toBe(201);
    const { id } = res.json() as { id: string };

    const [row] = await db.select().from(crimes).where(eq(crimes.id, id));
    expect(row).toMatchObject({
      name: "Bank job", description: "Walk in, walk out.",
      cooldownSeconds: 300, minPayout: 1000n, maxPayout: 5000n,
      minBullets: 0, maxBullets: 10, expReward: 50n,
      jailChancePercent: 25, jailSeconds: 600,
    });

    const list = await app.inject({ method: "GET", url: "/api/admin/crimes/list", headers: auth() });
    expect(list.json().rows.map((r: { id: string }) => r.id)).toContain(id);
  });

  // `sort` is NOT NULL and orders the player-facing crime list, but the admin
  // form does not ask for it — so create has to derive one. Appending after
  // the current max is the only choice that never collides with a seeded row.
  it("appends a created crime after the highest existing sort", async () => {
    await db.insert(crimes).values({
      id: uuidv7(), name: "Pickpocket", description: "Lift a wallet.",
      cooldownSeconds: 30, minPayout: 50n, maxPayout: 250n,
      minBullets: 0, maxBullets: 0, expReward: 5n,
      minLevel: 0, sort: 42, jailChancePercent: 0, jailSeconds: 0,
    });
    const res = await app.inject({
      method: "POST", url: "/api/admin/crimes", headers: auth(),
      payload: {
        name: "Bank job", description: "", cooldownSeconds: 300,
        minPayout: "1000", maxPayout: "5000", minBullets: 0, maxBullets: 0,
        expReward: "50", jailChancePercent: 0, jailSeconds: 0,
      },
    });
    expect(res.statusCode).toBe(201);
    const [row] = await db.select().from(crimes).where(eq(crimes.id, res.json().id));
    expect(row?.sort).toBe(43);
  });

  it("400s a create where maxPayout < minPayout", async () => {
    const res = await app.inject({
      method: "POST", url: "/api/admin/crimes", headers: auth(),
      payload: {
        name: "Backwards", description: "", cooldownSeconds: 30,
        minPayout: "500", maxPayout: "100", minBullets: 0, maxBullets: 0,
        expReward: "5", jailChancePercent: 0, jailSeconds: 0,
      },
    });
    expect(res.statusCode).toBe(400);
  });

  it("400s a create where maxBullets < minBullets", async () => {
    const res = await app.inject({
      method: "POST", url: "/api/admin/crimes", headers: auth(),
      payload: {
        name: "Backwards bullets", description: "", cooldownSeconds: 30,
        minPayout: "50", maxPayout: "100", minBullets: 10, maxBullets: 1,
        expReward: "5", jailChancePercent: 0, jailSeconds: 0,
      },
    });
    expect(res.statusCode).toBe(400);
  });

  it("403s a non-admin", async () => {
    const p = await registerVerifiedPlayer({ app, redis }, { username: "Pleb" });
    const res = await app.inject({
      method: "GET", url: "/api/admin/crimes/list",
      headers: { authorization: `Bearer ${p.token}` },
    });
    expect(res.statusCode).toBe(403);
  });

  it("deletes a crime, cascading its log", async () => {
    const create = await app.inject({
      method: "POST", url: "/api/admin/crimes", headers: auth(),
      payload: {
        name: "Doomed caper", description: "", cooldownSeconds: 30,
        minPayout: "1", maxPayout: "2", minBullets: 0, maxBullets: 0,
        expReward: "1", jailChancePercent: 0, jailSeconds: 0,
      },
    });
    const { id } = create.json();
    const del = await app.inject({ method: "DELETE", url: `/api/admin/crimes/${id}`, headers: auth() });
    expect(del.statusCode).toBe(204);
    expect(await db.select().from(crimes).where(eq(crimes.id, id))).toEqual([]);
  });

  it("404s deleting an unknown crime", async () => {
    const del = await app.inject({ method: "DELETE", url: `/api/admin/crimes/${uuidv7()}`, headers: auth() });
    expect(del.statusCode).toBe(404);
  });

  it("403s a non-admin creating a crime", async () => {
    const p = await registerVerifiedPlayer({ app, redis }, { username: "Pleb2" });
    const res = await app.inject({
      method: "POST", url: "/api/admin/crimes",
      headers: { authorization: `Bearer ${p.token}` },
      payload: {
        name: "Sneak", description: "", cooldownSeconds: 30,
        minPayout: "1", maxPayout: "2", minBullets: 0, maxBullets: 0,
        expReward: "1", jailChancePercent: 0, jailSeconds: 0,
      },
    });
    expect(res.statusCode).toBe(403);
  });

  // B0 Task 2: the success_formula dialect's authoring-time validation —
  // invalid formulas 400 here, never silently at resolve time (audit §7
  // item 5). crimeExpReward rides the same optional-field pattern.
  describe("success formula + crime exp reward (B0)", () => {
    const base = {
      name: "Formula job", description: "", cooldownSeconds: 30,
      minPayout: "50", maxPayout: "100", minBullets: 0, maxBullets: 0,
      expReward: "5", jailChancePercent: 0, jailSeconds: 0,
    };

    it("400s a create whose formula is outside the dialect", async () => {
      const res = await app.inject({
        method: "POST", url: "/api/admin/crimes", headers: auth(),
        payload: { ...base, successFormula: "rand(1,100)" },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe("invalid_formula");
      expect(String(res.json().message)).toContain("rand");
    });

    it("creates with a valid formula + crime exp reward, defaults absent ones", async () => {
      const res = await app.inject({
        method: "POST", url: "/api/admin/crimes", headers: auth(),
        payload: { ...base, successFormula: "min(95, 10 + CRIMEXP / 100)", crimeExpReward: "7" },
      });
      expect(res.statusCode).toBe(201);
      const [row] = await db.select().from(crimes).where(eq(crimes.id, res.json().id));
      expect(row?.successFormula).toBe("min(95, 10 + CRIMEXP / 100)");
      expect(row?.crimeExpReward).toBe(7n);
    });

    it("update sets and clears the formula; absent fields leave columns alone", async () => {
      const crimeId = uuidv7();
      await db.insert(crimes).values({
        id: crimeId, name: "Pickpocket", description: "", cooldownSeconds: 30,
        minPayout: 50n, maxPayout: 250n, minBullets: 0, maxBullets: 0,
        expReward: 5n, minLevel: 0, sort: 10, jailChancePercent: 0, jailSeconds: 0,
        crimeExpReward: 9n, successFormula: "min(50, LEVEL * 10)",
      });
      const update = {
        id: crimeId, cooldownSeconds: 30, minPayout: "50", maxPayout: "250",
        expReward: "5", jailChancePercent: 0, jailSeconds: 0,
      };

      // Omitting both fields leaves them untouched.
      const keep = await app.inject({
        method: "POST", url: "/api/admin/crimes/update", headers: auth(), payload: update });
      expect(keep.statusCode).toBe(204);
      let [row] = await db.select().from(crimes).where(eq(crimes.id, crimeId));
      expect(row?.successFormula).toBe("min(50, LEVEL * 10)");
      expect(row?.crimeExpReward).toBe(9n);

      // Empty string clears the formula back to the skill-chance path.
      const clear = await app.inject({
        method: "POST", url: "/api/admin/crimes/update", headers: auth(),
        payload: { ...update, successFormula: "" } });
      expect(clear.statusCode).toBe(204);
      [row] = await db.select().from(crimes).where(eq(crimes.id, crimeId));
      expect(row?.successFormula).toBeNull();
      expect(row?.crimeExpReward).toBe(9n); // still untouched
    });

    it("400s an update whose formula does not parse", async () => {
      const crimeId = uuidv7();
      await db.insert(crimes).values({
        id: crimeId, name: "Pickpocket", description: "", cooldownSeconds: 30,
        minPayout: 50n, maxPayout: 250n, minBullets: 0, maxBullets: 0,
        expReward: 5n, minLevel: 0, sort: 10, jailChancePercent: 0, jailSeconds: 0,
      });
      const res = await app.inject({
        method: "POST", url: "/api/admin/crimes/update", headers: auth(),
        payload: {
          id: crimeId, cooldownSeconds: 30, minPayout: "50", maxPayout: "250",
          expReward: "5", jailChancePercent: 0, jailSeconds: 0,
          successFormula: "LEVEL ~ 2",
        },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe("invalid_formula");
    });
  });
});
