import { randomBytes } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { uuidv7 } from "uuidv7";
import { z } from "zod";
import { PluginError, isInsufficientFundsError, route, type PluginCtx, type PluginTx } from "@gl3/plugin-sdk";
import { payOwner, takeOverFrom } from "@gl3/plugin-properties";
import { casinoMachines, playerStats, players } from "./schema.js";
import { buildRegistry, boundMoves, type GameDef, type GameStep } from "./games.js";
import { assertHouseCanCover, exposureOf, frozenHouse, guardGame, parseAction, readOwnerCash, notifyTakeover, resolveHouse, resolvePayout, type House } from "./engine.js";
import { readMaxBet, readMinBet } from "./settings.js";
import { fromStorableState, toStorableState } from "./state.js";

type Machine = typeof casinoMachines.$inferSelect;
const Money = z.string().regex(/^[1-9]\d{0,17}$/);
const Version = z.object({ id: z.string().uuid(), revision: z.number().int().min(0) });
const MAX_CREDITS = 9_000_000_000_000_000_000n;
const reason = (gameId: string) => `casino.${gameId}.credits`;
const ownerIds = (playerId: string, house: House) => house.ownerId === null ? [playerId] : [playerId, house.ownerId];
function playerId(ctx: PluginCtx): string {
  if (!ctx.player) throw new PluginError("unauthorized", 401);
  return ctx.player.id;
}
async function games(ctx: PluginCtx) { return buildRegistry(ctx, ctx.installedPluginIds); }
function gameFor(registry: Map<string, GameDef>, id: string): GameDef {
  const game = registry.get(id);
  if (!game || !game.machine) throw new PluginError("no_such_machine", 404);
  return game;
}
function view(row: Machine, game?: GameDef, step?: GameStep<unknown>) {
  const state = row.state === null ? null : fromStorableState(row.state);
  return {
    id: row.id, gameId: row.gameId, gameName: game?.name ?? row.gameId,
    credits: row.credits.toString(), wager: row.wager.toString(), revision: row.revision,
    inRound: row.inRound, closed: row.status === "closed", available: game?.machine === true,
    ...(game?.reelDisplay ? { reelDisplay: guardGame(game.id, "view", () => game.reelDisplay!(state)) } : {}),
    ...(!row.inRound && state !== null && game ? { payout: resolvePayout(game, state, row.wager).toString() } : {}),
    view: step?.view ?? (state !== null && game?.view ? guardGame(game.id, "view", () => game.view!(state)) : null),
    moves: row.inRound && game?.moves ? boundMoves(guardGame(game.id, "moves", () => game.moves!(state))) : [],
    ...(step?.animation ? { animation: {
      view: step.animation.view,
      durationMs: Number.isFinite(step.animation.durationMs) ? Math.max(0, Math.min(5000, Math.round(step.animation.durationMs))) : 0,
    } } : {}),
  };
}

/** All writes: location -> sorted player/owner -> machine. No reverse edge. */
async function locked(ctx: PluginCtx, tx: PluginTx, input: z.infer<typeof Version>) {
  const pid = playerId(ctx);
  const [pre] = await tx.db.select().from(casinoMachines).where(and(eq(casinoMachines.id, input.id), eq(casinoMachines.playerId, pid)));
  if (!pre) throw new PluginError("no_machine", 404);
  await tx.locks.location(pre.locationId);
  const house = await frozenHouse(tx, pre.propertyId, readMaxBet(ctx.settings));
  await tx.locks.player(ownerIds(pid, house));
  const [row] = await tx.db.select().from(casinoMachines).where(eq(casinoMachines.id, pre.id)).for("update");
  if (!row || row.status !== "open") throw new PluginError("machine_closed", 409);
  if (row.revision !== input.revision) throw new PluginError("stale_machine", 409);
  return { row, house, pid };
}

async function saveStep(tx: PluginTx, row: Machine, house: House, game: GameDef, step: GameStep<unknown>) {
  // Machine games spend a fixed bet per round; raises would need a separate
  // bounded credit claim, not permission to silently debit the player's cash.
  if (step.wagerDelta !== undefined && step.wagerDelta !== 0n) throw new PluginError("machine_raise_unsupported", 400);
  let credits = row.credits;
  if (step.done) {
    const payout = resolvePayout(game, step.state, row.wager);
    if (credits + payout > MAX_CREDITS) throw new PluginError("machine_credit_limit", 409);
    if (payout > 0n && house.propertyId) {
      const moved = await payOwner(tx, house.propertyId, -payout, reason(row.gameId));
      if (payout + moved > 0n && house.ownerId && await takeOverFrom(tx, house.propertyId, house.ownerId, row.playerId)) {
        const [winner] = await tx.db.select({ username: players.username }).from(players).where(eq(players.id, row.playerId));
        await notifyTakeover(tx, house, { id: row.playerId, username: winner?.username ?? "" }, game.name);
      }
    }
    credits += payout;
  }
  const next = { ...row, credits, state: toStorableState(step.state), inRound: !step.done, revision: row.revision + 1 };
  await tx.db.update(casinoMachines).set({ credits, state: next.state, inRound: next.inRound, revision: next.revision }).where(eq(casinoMachines.id, row.id));
  return next;
}

const read = route({ method: "GET", path: "/api/casino/machine", handler: async ctx => {
  const pid = playerId(ctx);
  const registry = await games(ctx);
  const [row] = await ctx.transaction(tx => tx.db.select().from(casinoMachines).where(and(eq(casinoMachines.playerId, pid), eq(casinoMachines.status, "open"))));
  return { status: 200, body: { machine: row ? view(row, registry.get(row.gameId)) : null } };
} });

const open = route({ method: "POST", path: "/api/casino/machine/open", accessInJail: false,
  body: z.object({ gameId: z.string().min(1).max(80), credits: Money, wager: Money }).strict(),
  handler: async (ctx, { body }) => {
    const pid = playerId(ctx), game = gameFor(await games(ctx), body.gameId);
    const credits = BigInt(body.credits), wager = BigInt(body.wager);
    return ctx.transaction(async tx => {
      const [stats] = await tx.db.select().from(playerStats).where(eq(playerStats.playerId, pid));
      if (!stats?.locationId) throw new PluginError("no_location", 409);
      await tx.locks.location(stats.locationId);
      const house = await resolveHouse(tx, game.id, stats.locationId, readMaxBet(ctx.settings));
      await tx.locks.player(ownerIds(pid, house));
      const [current] = await tx.db.select().from(playerStats).where(eq(playerStats.playerId, pid));
      if (current?.locationId !== stats.locationId) throw new PluginError("location_changed", 409);
      const [existing] = await tx.db.select().from(casinoMachines).where(and(eq(casinoMachines.playerId, pid), eq(casinoMachines.status, "open")));
      if (existing) throw new PluginError("machine_open", 409);
      if (house.ownerId === pid) throw new PluginError("own_house", 409);
      if (wager < readMinBet(ctx.settings)) throw new PluginError("wager_below_min", 400);
      if (wager > house.maxBet) throw new PluginError("wager_above_max", 400);
      if (credits < wager) throw new PluginError("insufficient_credits", 409);
      const id = uuidv7();
      try { await tx.economy.applyBalanceChange({ playerId: pid, amount: -credits, kind: "cash", reason: reason(game.id), refId: id }); }
      catch (error) { if (isInsufficientFundsError(error)) throw new PluginError("insufficient_funds", 409); throw error; }
      const [row] = await tx.db.insert(casinoMachines).values({ id, playerId: pid, gameId: game.id, locationId: stats.locationId, propertyId: house.propertyId, credits, wager }).returning();
      return { status: 200, body: { machine: view(row!, game) } };
    });
  },
});

const spin = route({ method: "POST", path: "/api/casino/machine/spin", accessInJail: false,
  body: Version.extend({ wager: Money }).strict(), handler: async (ctx, { body }) => {
    const registry = await games(ctx);
    return ctx.transaction(async tx => {
      const { row, house } = await locked(ctx, tx, body);
      const game = gameFor(registry, row.gameId), wager = BigInt(body.wager);
      if (row.inRound) throw new PluginError("round_open", 409);
      if (house.ownerId === row.playerId) throw new PluginError("own_house", 409);
      if (wager < readMinBet(ctx.settings)) throw new PluginError("wager_below_min", 400);
      if (wager > house.maxBet) throw new PluginError("wager_above_max", 400);
      if (wager > row.credits) throw new PluginError("insufficient_credits", 409);
      if (row.credits - wager + exposureOf(wager, game.maxPayoutMultiplier) > MAX_CREDITS) throw new PluginError("machine_credit_limit", 409);
      assertHouseCanCover(wager, game.maxPayoutMultiplier, await readOwnerCash(tx, house.ownerId));
      const step = guardGame(game.id, "start", () => game.start({ wager, seed: randomBytes(32).toString("hex") }));
      // Only money actually wagered goes to the owner and attracts the skim.
      if (house.propertyId) await payOwner(tx, house.propertyId, wager, reason(game.id));
      const next = await saveStep(tx, { ...row, credits: row.credits - wager, wager }, house, game, step);
      await tx.db.update(casinoMachines).set({ wager }).where(eq(casinoMachines.id, row.id));
      return { status: 200, body: { machine: view(next, game, step) } };
    });
  },
});

const act = route({ method: "POST", path: "/api/casino/machine/act", accessInJail: false,
  body: Version.extend({ action: z.unknown() }).strict(), handler: async (ctx, { body }) => {
    const registry = await games(ctx);
    return ctx.transaction(async tx => {
      const { row, house } = await locked(ctx, tx, body);
      if (!row.inRound) throw new PluginError("round_finished", 409);
      const game = gameFor(registry, row.gameId);
      const action = parseAction(game.action, body.action);
      const step = guardGame(game.id, "act", () => game.act(fromStorableState(row.state), action));
      const next = await saveStep(tx, row, house, game, step);
      return { status: 200, body: { machine: view(next, game, step) } };
    });
  },
});

// Always accessible, including jail and an uninstalled game. Cash-out during
// an unfinished round forfeits only that bet, never the unplayed credits.
const cashout = route({ method: "POST", path: "/api/casino/machine/cashout", body: Version.strict(),
  handler: async (ctx, { body }) => ctx.transaction(async tx => {
    const { row, pid } = await locked(ctx, tx, body);
    if (row.credits > 0n) await tx.economy.applyBalanceChange({ playerId: pid, amount: row.credits, kind: "cash", reason: reason(row.gameId), refId: row.id });
    await tx.db.update(casinoMachines).set({ credits: 0n, status: "closed", inRound: false, revision: row.revision + 1 }).where(eq(casinoMachines.id, row.id));
    return { status: 200, body: { machine: null, cashedOut: row.credits.toString() } };
  }),
});

export const machineRoutes = [read, open, spin, act, cashout];
