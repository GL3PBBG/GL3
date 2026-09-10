import { describe, expect, it } from "vitest";
import { formatCountdown, hallOfFameOrder, RoundPrizes } from "../src/pages/Rounds.js";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { keys } from "@gl3/client";
import type { RoundDto } from "@gl3/shared";

describe("formatCountdown", () => {
  it("renders an ended round as ended, never as a negative duration", () => {
    expect(formatCountdown(0)).toBe("ended");
  });
  it("renders seconds", () => {
    expect(formatCountdown(45)).toBe("45s");
  });
  it("renders days", () => {
    expect(formatCountdown(3 * 86_400 + 3_600)).toBe("3d 1h");
  });
  it("renders an open-ended round as no end date", () => {
    expect(formatCountdown(null)).toBe("no end date");
  });
});

describe("query keys", () => {
  it("keeps the round board and the all-time board in separate cache entries", () => {
    expect(keys.leaderboard("cash", "round")).not.toEqual(keys.leaderboard("cash", "all"));
    expect(keys.roundStandings("r1", "cash")).not.toEqual(keys.leaderboard("cash", "round"));
  });
  it("nests standings under the rounds prefix so one invalidation covers every board", () => {
    expect(keys.roundStandings("r1", "cash").slice(0, 1)).toEqual([...keys.rounds()]);
  });
});

function makeRound(overrides: Partial<RoundDto> = {}): RoundDto {
  return {
    id: "0190000000000000000000000a",
    name: "Round",
    startsAt: "2026-07-01T00:00:00Z",
    endsAt: "2026-08-01T00:00:00Z",
    secondsRemaining: null,
    finalizedAt: "2026-08-01T00:00:00Z",
    payoutPoints: null,
    ...overrides,
  };
}

describe("round prize display", () => {
  const renderPrizes = (payoutPoints: string[] | null) => renderToStaticMarkup(createElement(RoundPrizes, { round: makeRound({ payoutPoints }) }));
  it("shows the configured places and explains qualification and payout", () => {
    const html = renderPrizes(["700", "300"]);
    expect(html).toContain("#1");
    expect(html).toContain("700");
    expect(html).toContain("#2");
    expect(html).toContain("300");
    expect(html).toContain("You must gain experience to qualify");
    expect(html).toContain("credited automatically");
    expect(html).toContain("Cash and Bank standings do not award prizes");
  });
  it("distinguishes disabled prizes from unknown historical prizes", () => {
    expect(renderPrizes([])).toContain("No points prizes");
    expect(renderPrizes(["0", "0"])).toContain("No points prizes");
    expect(renderPrizes(null)).toContain("Prize details were not recorded");
  });
});

describe("hallOfFameOrder", () => {
  it("orders finished rounds newest first with open-ended rounds last", () => {
    const older = makeRound({ id: "0190000000000000000000000a", name: "Older", endsAt: "2026-07-01T00:00:00Z" });
    const newer = makeRound({ id: "0190000000000000000000000c", name: "Newer", endsAt: "2026-08-01T00:00:00Z" });
    const openEnded = makeRound({ id: "0190000000000000000000000b", name: "Open-ended", endsAt: null });

    expect(hallOfFameOrder([older, openEnded, newer])).toEqual([newer, older, openEnded]);
  });

  it("breaks ties between equal end dates by newest id first", () => {
    const sameEndOld = makeRound({ id: "0190000000000000000000000a", endsAt: "2026-08-01T00:00:00Z" });
    const sameEndNew = makeRound({ id: "0190000000000000000000000c", endsAt: "2026-08-01T00:00:00Z" });

    expect(hallOfFameOrder([sameEndOld, sameEndNew])).toEqual([sameEndNew, sameEndOld]);
  });

  it("does not mutate the input array", () => {
    const rounds = [makeRound({ id: "a", endsAt: "2026-07-01T00:00:00Z" }), makeRound({ id: "b", endsAt: "2026-08-01T00:00:00Z" })];
    const copy = [...rounds];
    hallOfFameOrder(rounds);
    expect(rounds).toEqual(copy);
  });
});
