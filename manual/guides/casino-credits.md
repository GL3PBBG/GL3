# Casino persistent credits

Requires slots 0.2.0 / Hold’em 0.5.0 and the matching server and web update.
Casino migrations 0007–0008 add machine wallets; 0009 adds nullable seat credits.
Existing rows remain legacy until their hand settles. No backfill takes cash.

## Player flow

Slots: choose credits, sit, spin, hold/respin or collect, spin again, cash out.
Wallets and outcomes survive reloads. A spin reveal is presentation only, with
server results committed before the animation. Cash-out mid-round explicitly
forfeits only that bet and refunds all unused credits.

Hold’em: buy in once, play, keep the remaining stack, choose Play next hand,
or cash out. At least two funded players are required for a new wallet hand.
No next-hand readiness is inferred from a disconnect. Between-hand stacks are
refunded when leaving or when idle seats are removed. Mid-hand leaving remains
deferred until settlement. Blinds are retained through previousState.

## Economy and locks

Cash changes use the existing economy ledger. Machine and table credits are
escrow liabilities, not player cash columns. All new cash legs for a game use
casino.<game>.credits. Cash plus outstanding escrow is the conservation measure.
Machine stakes/payouts retain casino house coverage and takeover semantics.
Slot deposits are not skimmed; actual stakes attract the existing house skim.

Bankroll table pots are player-funded. Sum of returned stacks cannot exceed
sum of funded stacks. Only the difference (poker rake) goes to the owner and
attracts franchise skim. The owner never holds the buy-ins. Legacy/null-credit
hands retain their original behavior. External wagerDelta is rejected for
bankroll games; bets and raises must be within the game's funded stack.

Lock order remains location -> one sorted player/owner set -> machine/table.
Machine writes check revision and status under lock. The partial unique index
allows one open machine per player. New tables/columns introduce no foreign-key
lock edges. Table cash-outs use existing table locks. No shared pot is added.

## Validation

Real Postgres: machine concurrency/refunds/ledger, bankroll settlement, duplicate
buy-ins, deferred and idle refunds, capped pot payouts, and legacy upgrade.
Existing solo and table money, timeout and lock-order regressions pass.
Both packed premium plugins passed dynamic-load API and Chromium checks,
including moving reel frames, hold/reload/repeat spins, card animation, the
next poker hand, cash-out, and mobile overflow. Plugin tests: slots 66,
Hold’em 111. Core casino UI helper tests: 47.

## Release

Deploy server and web together with the new plugin packages. npm upgrades alone
cannot add host routes or UI. Preserve casino wallet/seat tables on rollback;
an old host does not know how to refund retained credits. Before rolling back
to a host predating this change, drain machine wallets and table credits using
the updated cash-out routes.
