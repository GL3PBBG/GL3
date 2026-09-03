import { describe, expect, it } from "vitest";
import type { GangMemberDto } from "@gl3/shared";
import {
  canGrant, canInvite, canKick, canTransfer, canWithdraw, hasPermission, memberOf, roleOf,
} from "../src/lib/gang.js";

function member(
  playerId: string,
  role: GangMemberDto["role"],
  permissions: GangMemberDto["permissions"] = [],
): GangMemberDto {
  return {
    playerId,
    username: playerId,
    role,
    permissions,
    joinedAt: "2026-01-01T00:00:00.000Z",
  };
}

// The server expands leadership's permissions in the roster it serves, so
// `boss` here carries the full list — and `bossWithoutRows` is the same
// player as the server would have described them before that expansion
// existed. Both must read as fully permitted.
const boss = member("boss", "boss", ["invite", "kick", "bank.withdraw", "edit_info", "grant_permissions"]);
const bossWithoutRows = member("boss", "boss");
const underboss = member("underboss", "underboss");
const kicker = member("kicker", "member", ["kick"]);
const plain = member("plain", "member");

const ROSTER = [boss, underboss, kicker, plain];

describe("roleOf / memberOf", () => {
  it("finds a member's row and role", () => {
    expect(memberOf(ROSTER, "kicker")).toBe(kicker);
    expect(roleOf(ROSTER, "underboss")).toBe("underboss");
    expect(roleOf(ROSTER, "plain")).toBe("member");
  });

  it("returns null for someone outside the gang rather than guessing", () => {
    expect(memberOf(ROSTER, "outsider")).toBeUndefined();
    expect(roleOf(ROSTER, "outsider")).toBeNull();
  });
});

describe("hasPermission", () => {
  // Mirrors hasGangPermission's bypass: leadership is permitted with no
  // gang_permissions row at all. Dropping this would hide every gang button
  // from a boss whose roster row happened to arrive unexpanded.
  it("grants leadership everything without a row", () => {
    expect(hasPermission(bossWithoutRows, "kick")).toBe(true);
    expect(hasPermission(bossWithoutRows, "grant_permissions")).toBe(true);
    expect(hasPermission(underboss, "bank.withdraw")).toBe(true);
  });

  it("grants a plain member only what they hold", () => {
    expect(hasPermission(kicker, "kick")).toBe(true);
    expect(hasPermission(kicker, "invite")).toBe(false);
    expect(hasPermission(plain, "kick")).toBe(false);
  });

  it("refuses a viewer who is not in the gang", () => {
    expect(hasPermission(undefined, "kick")).toBe(false);
  });
});

describe("canInvite / canGrant / canWithdraw", () => {
  it("reads the matching permission", () => {
    expect(canInvite(member("x", "member", ["invite"]))).toBe(true);
    expect(canInvite(plain)).toBe(false);
    expect(canGrant(member("x", "member", ["grant_permissions"]))).toBe(true);
    expect(canGrant(kicker)).toBe(false);
    expect(canWithdraw(member("x", "member", ["bank.withdraw"]))).toBe(true);
    expect(canWithdraw(plain)).toBe(false);
  });

  it("lets leadership do all three", () => {
    expect([canInvite(underboss), canGrant(underboss), canWithdraw(underboss)]).toEqual([true, true, true]);
  });
});

describe("canKick", () => {
  it("needs the kick permission", () => {
    expect(canKick(kicker, plain)).toBe(true);
    expect(canKick(plain, kicker)).toBe(false);
  });

  // The server answers 409 cannot_kick_boss; offering the button would only
  // produce that error.
  it("never offers to kick the boss", () => {
    expect(canKick(underboss, boss)).toBe(false);
    expect(canKick(boss, boss)).toBe(false);
  });

  it("does not offer self-kick — leaving is its own action", () => {
    expect(canKick(kicker, kicker)).toBe(false);
  });

  it("lets the boss kick a plain member", () => {
    expect(canKick(boss, plain)).toBe(true);
  });
});

describe("canTransfer", () => {
  it("is boss-only — an underboss's permission bypass does not reach it", () => {
    expect(canTransfer(boss, plain)).toBe(true);
    expect(canTransfer(underboss, plain)).toBe(false);
    expect(canTransfer(member("x", "member", ["grant_permissions"]), plain)).toBe(false);
  });

  it("refuses transferring to yourself, which the server 409s", () => {
    expect(canTransfer(boss, boss)).toBe(false);
  });

  it("refuses a viewer who is not in the gang", () => {
    expect(canTransfer(undefined, plain)).toBe(false);
  });
});
