import { definePlugin } from "@gl3/plugin-sdk";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { uuidv7 } from "uuidv7";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { FilesystemDriver } from "../src/assets/fs-driver.js";
import { hashBytes } from "../src/assets/image.js";
import { items, players, roleModuleAccess, roles } from "../src/db/schema/index.js";
import { makeJpeg, makePng } from "./helpers/assets.js";
import { resetDb, testDb } from "./helpers/db.js";
import { bootTestServer } from "./helpers/server.js";

/** Declares one slot so the bind route has a plugin scope to validate against. */
const artPlugin = definePlugin({
  id: "artcheck",
  version: "1.0.0",
  basePaths: ["/api/artcheck", "/api/admin/artcheck"],
  providesAssets: [{ slot: "widget", label: "Widget image" }],
});

const { db, sql: conn } = testDb();
let app: FastifyInstance;
let driver: FilesystemDriver;
let closeServer: () => Promise<void>;

async function registerPlayer(username: string): Promise<{ token: string; playerId: string }> {
  const res = await app.inject({
    method: "POST", url: "/api/auth/register",
    payload: { username, password: "hunter2hunter2" },
  });
  return res.json();
}

async function giveRole(playerId: string, moduleKey: string): Promise<void> {
  const roleId = uuidv7();
  await db.insert(roles).values({ id: roleId, name: `role-${moduleKey}-${roleId.slice(0, 8)}` });
  await db.insert(roleModuleAccess).values({ roleId, moduleKey });
  await db.update(players).set({ roleId }).where(eq(players.id, playerId));
}

/** The first registered player auto-becomes Administrator, so most tests want a second. */
async function adminAndPlayer(): Promise<{ admin: { token: string; playerId: string }; other: { token: string; playerId: string } }> {
  const admin = await registerPlayer("FirstAdmin");
  const other = await registerPlayer("SecondPlayer");
  return { admin, other };
}

function upload(token: string, bytes: Buffer, contentType: string) {
  return app.inject({
    method: "POST", url: "/api/admin/assets",
    headers: { authorization: `Bearer ${token}`, "content-type": contentType },
    payload: bytes,
  });
}

beforeEach(async () => {
  await resetDb(db);
  if (!app) ({ app, close: closeServer, assetDriver: driver } = await bootTestServer({ plugins: [artPlugin] }));
});

afterAll(async () => { await closeServer(); await conn.end(); });

describe("POST /api/admin/assets", () => {
  it("401s with no token", async () => {
    const res = await app.inject({
      method: "POST", url: "/api/admin/assets",
      headers: { "content-type": "image/png" }, payload: makePng(4, 4),
    });
    expect(res.statusCode).toBe(401);
  });

  it("403s a player with no grant at all", async () => {
    const { other } = await adminAndPlayer();
    const res = await upload(other.token, makePng(4, 4), "image/png");
    expect(res.statusCode).toBe(403);
  });

  it("stores a PNG and returns its id, url and dimensions", async () => {
    const { admin } = await adminAndPlayer();
    const png = makePng(20, 10);

    const res = await upload(admin.token, png, "image/png");

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body).toMatchObject({ width: 20, height: 10, deduped: false });
    expect(body.url).toBe(`/assets/${hashBytes(png)}`);
    // Round-trips through the very driver the server wrote it with, so this
    // asserts on stored bytes rather than on the response echoing itself.
    expect(await driver.get(hashBytes(png))).toEqual(png);
  });

  it("is idempotent: the same bytes twice return the same id", async () => {
    const { admin } = await adminAndPlayer();
    const png = makePng(6, 6);

    const first = await upload(admin.token, png, "image/png");
    const second = await upload(admin.token, png, "image/png");

    expect(second.json().assetId).toBe(first.json().assetId);
    expect(second.json().deduped).toBe(true);
  });

  it("415s a content-type that is not an accepted image type", async () => {
    const { admin } = await adminAndPlayer();
    const res = await upload(admin.token, Buffer.from("hello"), "text/plain");
    expect(res.statusCode).toBe(415);
  });

  it("400s when the bytes contradict the declared content-type", async () => {
    const { admin } = await adminAndPlayer();

    // A JPEG announced as a PNG. Nothing about the request looks wrong until
    // the magic bytes are read, which is exactly the case a trust-the-header
    // implementation waves through.
    const res = await upload(admin.token, makeJpeg(8, 8), "image/png");

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("content_type_mismatch");
  });

  it("400s a PHP payload dressed as a PNG", async () => {
    const { admin } = await adminAndPlayer();
    const res = await upload(admin.token, Buffer.from("<?php system($_GET['c']); ?>"), "image/png");
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("not_an_image");
  });

  it("413s an image past the dimension limit", async () => {
    const { admin } = await adminAndPlayer();
    // Default cap is 2048 on either side.
    const res = await upload(admin.token, makePng(4096, 4), "image/png");
    expect(res.statusCode).toBe(413);
    expect(res.json().error).toBe("dimensions_too_large");
  });
});

describe("PUT /api/admin/assets/bind", () => {
  async function uploadedId(token: string, png = makePng(7, 7)): Promise<string> {
    const res = await upload(token, png, "image/png");
    return res.json().assetId;
  }

  function bind(token: string, body: unknown) {
    return app.inject({
      method: "PUT", url: "/api/admin/assets/bind",
      headers: { authorization: `Bearer ${token}` }, payload: body as never,
    });
  }

  it("binds an asset to a core slot", async () => {
    const { admin } = await adminAndPlayer();
    const assetId = await uploadedId(admin.token);
    const itemId = uuidv7();
    await db.insert(items).values({ id: itemId, name: "Bat", itemType: "weapon", effects: {} });

    const res = await bind(admin.token, { scope: "core", entityId: itemId, slot: "item", assetId });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ bound: true });
  });

  it("binds to a slot a plugin declared", async () => {
    const { admin } = await adminAndPlayer();
    const assetId = await uploadedId(admin.token);

    const res = await bind(admin.token, {
      scope: "artcheck", entityId: uuidv7(), slot: "widget", assetId,
    });

    expect(res.statusCode).toBe(200);
  });

  it("400s an undeclared slot", async () => {
    const { admin } = await adminAndPlayer();
    const assetId = await uploadedId(admin.token);

    // `entity_assets` has no foreign key to catch this, so the registry lookup
    // is the only thing between a typo and a row nothing will ever read.
    const res = await bind(admin.token, {
      scope: "artcheck", entityId: uuidv7(), slot: "not-declared", assetId,
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("unknown_slot");
  });

  it("403s a grant for a different scope", async () => {
    const { admin, other } = await adminAndPlayer();
    const assetId = await uploadedId(admin.token);
    await giveRole(other.playerId, "artcheck");

    // The `artcheck` grant binds artcheck art and must not reach core's items:
    // the permission is per scope, not blanket admin.
    const res = await bind(other.token, {
      scope: "core", entityId: uuidv7(), slot: "item", assetId,
    });

    expect(res.statusCode).toBe(403);
  });

  it("lets a scoped grant bind its own scope", async () => {
    const { admin, other } = await adminAndPlayer();
    const assetId = await uploadedId(admin.token);
    await giveRole(other.playerId, "artcheck");

    const res = await bind(other.token, {
      scope: "artcheck", entityId: uuidv7(), slot: "widget", assetId,
    });

    expect(res.statusCode).toBe(200);
  });

  it("unbinds with a null assetId", async () => {
    const { admin } = await adminAndPlayer();
    const assetId = await uploadedId(admin.token);
    const entityId = uuidv7();
    await bind(admin.token, { scope: "artcheck", entityId, slot: "widget", assetId });

    const res = await bind(admin.token, { scope: "artcheck", entityId, slot: "widget", assetId: null });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ bound: false });
  });

  it("400s a malformed body rather than reaching Postgres", async () => {
    const { admin } = await adminAndPlayer();
    const res = await bind(admin.token, { scope: "core", entityId: "not-a-uuid", slot: "item", assetId: null });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("invalid_request");
  });
});

describe("GET /assets/:key", () => {
  it("serves the stored bytes with an immutable cache header, unauthenticated", async () => {
    const { admin } = await adminAndPlayer();
    const png = makePng(5, 5);
    await upload(admin.token, png, "image/png");

    // No Authorization header: art is public on purpose, because putting auth
    // in front of an <img> defeats browser caching for no gain.
    const res = await app.inject({ method: "GET", url: `/assets/${hashBytes(png)}` });

    expect(res.statusCode).toBe(200);
    expect(res.headers["cache-control"]).toBe("public, max-age=31536000, immutable");
    expect(res.headers["content-type"]).toContain("image/png");
    expect(Buffer.from(res.rawPayload)).toEqual(png);
  });

  it("404s a well-formed key that was never stored", async () => {
    const res = await app.inject({ method: "GET", url: `/assets/${"a".repeat(64)}` });
    expect(res.statusCode).toBe(404);
  });

  it("400s a key that is not a bare content hash, so traversal never reaches the driver", async () => {
    const res = await app.inject({ method: "GET", url: "/assets/..%2f..%2fetc%2fpasswd" });
    expect(res.statusCode).toBe(400);
  });
});
