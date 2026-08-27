import { z } from "zod";
import { definePlugin, InsufficientFundsError, PluginError, route, type PluginTx } from "@gl3/plugin-sdk";

/**
 * The crystal temple, as a points shop (C spec §4.6, audit §4.10): exactly
 * three exchanges, settings-driven with MCCodes' seed defaults, every points
 * debit ledgered. One-directional by design — points buy energy refills, IQ
 * and money; nothing buys points (that would loop with the money rate). No
 * brave or will refill either, exactly like the source. The money rate is
 * item 14's faucet-audit concern: 200/point is MCCodes' default, not a
 * recommendation — the C spec's numbers belong to each game's admin.
 */

const PointsSchema = z.object({
  points: z.string().regex(/^\d+$/, "must be a nonnegative integer string"),
}).strict();

async function debitPoints(
  tx: PluginTx,
  playerId: string, points: bigint, reason: string,
): Promise<void> {
  try {
    await tx.economy.applyBalanceChange(
      { playerId, amount: -points, kind: "points", reason },
    );
  } catch (error) {
    if (error instanceof InsufficientFundsError) throw new PluginError("insufficient_points", 409);
    throw error;
  }
}

/**
 * The curation seam (gl3-hybrid spec §2): `exchanges` is a comma-list of
 * `refill|iq|money` naming what this game offers. UNSET means all three —
 * the faithful MCCodes default. The gl3 profile seeds "refill": points ->
 * IQ or cash turns a season prize into scoring power (see NOTES.md,
 * "Points are not a game balance"). Admin-editable like any setting.
 */
function assertExchangeEnabled(
  ctx: { settings: { get(key: string): string | null } }, exchange: string,
): void {
  const raw = ctx.settings.get("exchanges");
  if (raw === null) return;
  const enabled = raw.split(",").map((s) => s.trim()).filter(Boolean);
  if (!enabled.includes(exchange)) throw new PluginError("exchange_disabled", 403);
}

const refillRoute = route({
  method: "POST",
  path: "/api/temple/refill",
  handler: async (ctx) => {
    const player = ctx.player;
    if (player === null) throw new PluginError("unauthorized", 401);
    assertExchangeEnabled(ctx, "refill");

    // Offered only when the energy pool is declared — the opt-in property:
    // a game with no attribute family has nothing to refill.
    if (ctx.attributePools.get("energy") === null) {
      throw new PluginError("energy_not_declared", 409);
    }
    const price = BigInt(ctx.settings.get("refill_points") ?? "12");

    return ctx.transaction(async (tx) => {
      await tx.locks.player([player.id]);
      const attrs = await tx.attributes.read(player.id);
      if (attrs.energy >= attrs.energyMax) throw new PluginError("already_full", 409);
      await debitPoints(tx, player.id, price, "temple.refill");
      await tx.attributes.grant(player.id, "energy", attrs.energyMax - attrs.energy);
      return { status: 200, body: { energy: attrs.energyMax, cost: price.toString() } };
    });
  },
});

const iqRoute = route({
  method: "POST",
  path: "/api/temple/iq",
  body: PointsSchema,
  handler: async (ctx, { body }) => {
    const player = ctx.player;
    if (player === null) throw new PluginError("unauthorized", 401);
    assertExchangeEnabled(ctx, "iq");
    const points = BigInt(body.points);
    if (points <= 0n) throw new PluginError("amount_must_be_positive", 400);
    const perPoint = Number(ctx.settings.get("iq_per_point") ?? "5");

    return ctx.transaction(async (tx) => {
      await tx.locks.player([player.id]);
      await debitPoints(tx, player.id, points, "temple.iq");
      const iq = await tx.attributes.train(player.id, "iq", BigInt(points * BigInt(perPoint)));
      return { status: 200, body: { iq: iq.toString(), cost: points.toString() } };
    });
  },
});

const moneyRoute = route({
  method: "POST",
  path: "/api/temple/money",
  body: PointsSchema,
  handler: async (ctx, { body }) => {
    const player = ctx.player;
    if (player === null) throw new PluginError("unauthorized", 401);
    assertExchangeEnabled(ctx, "money");
    const points = BigInt(body.points);
    if (points <= 0n) throw new PluginError("amount_must_be_positive", 400);
    const perPoint = BigInt(ctx.settings.get("money_per_point") ?? "200");

    return ctx.transaction(async (tx) => {
      await tx.locks.player([player.id]);
      await debitPoints(tx, player.id, points, "temple.money");
      const cash = await tx.economy.applyBalanceChange(
        { playerId: player.id, amount: points * perPoint, kind: "cash", reason: "temple.money" },
      );
      return { status: 200, body: { cash: cash.toString(), cost: points.toString() } };
    });
  },
});

export default definePlugin({
  id: "temple",
  version: "1.0.0",
  basePaths: ["/api/temple"],
  requires: ["mccodes-attributes"],
  routes: [refillRoute, iqRoute, moneyRoute],
});
