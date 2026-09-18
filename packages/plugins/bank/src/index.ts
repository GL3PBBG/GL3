import { definePlugin, InsufficientFundsError, PluginError, route } from "@gl3/plugin-sdk";
import { z } from "zod";

/**
 * Ported from `apps/server/src/game/bank/routes.ts` and `service.ts`: paths,
 * status codes, error strings, response bodies and the `bank.transacted`
 * event are byte-identical. `apps/server/test/bank.test.ts`'s `app.inject`
 * block is unchanged and is the proof.
 *
 * Three deliberate differences from core:
 *  - No post-commit `SELECT cash, bank`. `applyBalanceChange` returns the new
 *    balance, and both directions touch both columns, so both numbers are
 *    already in hand.
 *  - No `players` read for `actorName`; `ctx.player.username` has it. Between
 *    them these are why this plugin, unlike `news` and `ranks`, needs no
 *    `schema.ts` mirroring core-owned tables.
 *  - `recordScore` is gone from the module. `tx.economy.applyBalanceChange`
 *    buffers a leaderboard write per changed kind and flushes it after
 *    commit (core-events design §B1), which covers exactly the `cash` and
 *    `bank` writes core made by hand.
 *
 * `@gl3/shared` is off-limits to a plugin package, so `MoneySchema`'s regex is
 * restated below rather than imported.
 */
const AmountSchema = z.object({
  amount: z.string().regex(/^-?\d+$/, "must be an integer string"),
});

type Direction = "deposit" | "withdraw";

/**
 * Two literal-path routes from one factory, mirroring core's `routes.ts:12`.
 * NOT one route with a `:direction` param — that would match paths core's two
 * never matched.
 */
const bankRoute = (direction: Direction) =>
  route({
    method: "POST",
    path: `/api/bank/${direction}`,
    body: AmountSchema,
    // accessInJail defaults to true. Core's bank routes never call
    // releaseIfExpired, so gating here would add a 423 to a route that has
    // never returned one.
    handler: async (ctx, { body }) => {
      const player = ctx.player;
      if (player === null) throw new PluginError("unauthorized", 401);

      const amount = BigInt(body.amount);
      // Kept in the handler, not as a zod `.refine()`: the loader answers
      // every schema failure with `invalid_request`, which would silently
      // drop this distinct error string.
      if (amount <= 0n) throw new PluginError("amount_must_be_positive", 400);

      return ctx.transaction(async (tx) => {
        // The optional account-open fee (C spec §5.4, audit §7 item 6): when
        // `bank.open_fee` is non-zero, a deposit requires the one-time
        // `bank.opened` timer — MCCodes' 50k gate, admin-tunable, and the one
        // idea worth borrowing from its banks. Zero (the default) skips the
        // timer read entirely: every existing bank byte stays identical, the
        // proof being bank.test.ts unchanged. Cluster B pre-opens migrated
        // players who held either MCCodes account.
        if (direction === "deposit") {
          const openFee = Number(ctx.settings.get("open_fee") ?? "0");
          if (openFee > 0 && (await tx.timers.get(player.id, "bank.opened")) === null) {
            throw new PluginError("account_not_opened", 409);
          }
        }

        let cash: bigint;
        let bank: bigint;
        try {
          // Two ledger legs in ONE transaction — the "one balance, one ledger
          // row" rule applied twice. No cooldown and no queue: bank has no V2
          // cooldown and no randomness to protect from a retry; the row lock
          // applyBalanceChange already takes on player_stats is what makes two
          // concurrent requests against the same player safe.
          if (direction === "deposit") {
            cash = await tx.economy.applyBalanceChange({
              playerId: player.id, amount: -amount, kind: "cash", reason: "bank.deposit",
            });
            bank = await tx.economy.applyBalanceChange({
              playerId: player.id, amount, kind: "bank", reason: "bank.deposit",
            });
          } else {
            bank = await tx.economy.applyBalanceChange({
              playerId: player.id, amount: -amount, kind: "bank", reason: "bank.withdraw",
            });
            cash = await tx.economy.applyBalanceChange({
              playerId: player.id, amount, kind: "cash", reason: "bank.withdraw",
            });
          }
        } catch (error) {
          if (error instanceof InsufficientFundsError) {
            throw new PluginError("insufficient_funds", 409);
          }
          throw error;
        }

        // Buffered here, published after commit — events are facts, not
        // commands. The audience is PRIVATE: bank state is not broadcast,
        // unlike news.posted's { kind: "global" }.
        await tx.events.publishCore({
          type: "bank.transacted",
          actorId: player.id,
          actorName: player.username,
          audience: { kind: "player", playerId: player.id },
          direction,
          amount: amount.toString(),
          cash: cash.toString(),
          bank: bank.toString(),
        });

        return { status: 200, body: { cash: cash.toString(), bank: bank.toString() } };
      });
    },
  });

const openRoute = route({
  method: "POST",
  path: "/api/bank/open",
  handler: async (ctx) => {
    const player = ctx.player;
    if (player === null) throw new PluginError("unauthorized", 401);

    return ctx.transaction(async (tx) => {
      const openFee = Number(ctx.settings.get("open_fee") ?? "0");
      // Already open, or a zero-fee game where opening was never required:
      // free and idempotent.
      if (openFee === 0 || (await tx.timers.get(player.id, "bank.opened")) !== null) {
        return { status: 200, body: { opened: true, fee: "0" } };
      }
      try {
        await tx.economy.applyBalanceChange({
          playerId: player.id, amount: -BigInt(openFee), kind: "cash", reason: "bank.open",
        });
      } catch (error) {
        if (error instanceof InsufficientFundsError) throw new PluginError("insufficient_funds", 409);
        throw error;
      }
      // A state, not a countdown: far-future expiry, never cleared.
      await tx.timers.set(player.id, "bank.opened", new Date(Date.now() + 100 * 365 * 86_400_000));
      return { status: 200, body: { opened: true, fee: String(openFee) } };
    });
  },
});

/**
 * The read behind `bank.index`'s `keyValueSource` (spec 2026-09-18 §3.1).
 *
 * No `player_stats` SELECT and no `schema.ts` mirror: `ctx.player` IS a fresh
 * read of that row — `plugins/routes.ts:80` calls `loadSnapshot` per request,
 * and `cash`/`bank` come straight off `player_stats` there. Keeping it that
 * way preserves this package's documented property (see the header above)
 * that bank is the one port needing no mirror of a core-owned table.
 *
 * The transaction is opened only when a fee is configured, because the
 * `bank.opened` timer is the one fact `ctx.player` cannot carry. A zero-fee
 * game — the default — serves this route with no database round trip beyond
 * the snapshot every plugin route already takes.
 */
const summaryRoute = route({
  method: "GET",
  path: "/api/bank/summary",
  handler: async (ctx) => {
    const player = ctx.player;
    if (player === null) throw new PluginError("unauthorized", 401);

    // A junk setting must not print "closed — fee $NaN" at a player. Anything
    // that is not a real number means no fee is configured, which is the
    // default and the state openRoute itself treats as already-open.
    const configured = Number(ctx.settings.get("open_fee") ?? "0");
    const openFee = Number.isFinite(configured) ? configured : 0;
    const opened = openFee === 0
      ? true
      : await ctx.transaction(async (tx) => (await tx.timers.get(player.id, "bank.opened")) !== null);

    return {
      status: 200,
      body: {
        values: {
          cash: player.cash.toString(),
          bank: player.bank.toString(),
          account: opened ? "open" : `closed — fee $${openFee}`,
        },
      },
    };
  },
});

export default definePlugin({
  id: "bank",
  version: "1.0.0",
  apiVersion: 1,
  basePaths: ["/api/bank"],
  routes: [bankRoute("deposit"), bankRoute("withdraw"), openRoute, summaryRoute],
  pages: [{
    id: "bank.index",
    path: "/bank",
    // A real view-node page (spec 2026-09-18 §3.1), for clients that render
    // the vocabulary — the Godot client does. apps/web still shows the
    // hand-written Bank page for this id: PluginPage.tsx checks
    // PAGE_OVERRIDES before it ever looks at a view.
    //
    // Two forms rather than one with a direction field, because bank has two
    // routes and this page adds no mutation route of its own. The open button
    // is unconditional: the route answers { opened: true, fee: "0" } when the
    // account is already open or no fee is configured, so a second click is
    // harmless.
    view: {
      kind: "panel",
      title: "Bank",
      children: [
        {
          kind: "keyValueSource",
          source: "GET /api/bank/summary",
          emptyText: "Sign in to see your balances",
          entries: [
            { label: "Cash", key: "cash" },
            { label: "In the bank", key: "bank" },
            { label: "Account", key: "account" },
          ],
        },
        {
          kind: "form", action: "POST /api/bank/deposit", submitLabel: "Deposit",
          fields: [{ name: "amount", label: "Amount", type: "money" }],
        },
        {
          kind: "form", action: "POST /api/bank/withdraw", submitLabel: "Withdraw",
          fields: [{ name: "amount", label: "Amount", type: "money" }],
        },
        { kind: "button", label: "Open an account", action: "POST /api/bank/open" },
      ],
    },
  }],
  worldHooks: [{ id: "bank", kind: "building", label: "Bank", page: "bank.index", model: "bank", footprint: { w: 12, d: 9 }, order: 30 }],
});
