// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, expect, it } from "vitest";
import type { AttackResponse, CombatTarget } from "@gl3/shared";
import { CombatScene } from "../src/pages/CombatScene.js";

afterEach(cleanup);
const target: CombatTarget = { playerId: "target", username: "Rival", rank: null, health: 100, maxHealth: 100, attackable: true, reason: null };
const hit: AttackResponse = { hit: true, crit: false, damage: 20, armorAbsorbed: 5, targetHealth: 80, targetKilled: false, payout: "0", bulletsSpent: 1, backfire: false, selfDamage: 0, attackerHealth: 100, weapon: "firearm", weaponName: "Pistol" };
function mount(result: AttackResponse) {
  return render(createElement(CombatScene, { target, result, pending: false, failed: false, sequence: 1 }));
}
it("keeps a wounded target standing and displays remaining health and armor", () => {
  const { container } = mount(hit);
  expect(container.querySelector('[data-outcome="hit"]')).not.toBeNull();
  expect(container.querySelector('[data-outcome="fatal"]')).toBeNull();
  expect(screen.getByRole("meter").getAttribute("aria-valuenow")).toBe("80");
  expect(screen.getByText("Armor absorbed 5")).toBeTruthy();
  expect(screen.getByText("Hit landed. The target is still standing.")).toBeTruthy();
});
it("plays defeat only for a confirmed kill", () => {
  const { container } = mount({ ...hit, targetHealth: 0, targetKilled: true });
  expect(container.querySelector('[data-outcome="fatal"]')).not.toBeNull();
  expect(screen.getByText("Target defeated.")).toBeTruthy();
});
it("shows a miss without target damage", () => {
  mount({ ...hit, hit: false, damage: 0, armorAbsorbed: 0, targetHealth: 100 });
  expect(screen.getByText("MISS")).toBeTruthy();
  expect(screen.getByRole("meter").getAttribute("aria-valuenow")).toBe("100");
});
it("directs backfire damage to the attacker", () => {
  const { container } = mount({ ...hit, hit: false, backfire: true, damage: 0, armorAbsorbed: 0, selfDamage: 12, attackerHealth: 88, targetHealth: 100 });
  expect(container.querySelector('[data-outcome="backfire"]')).not.toBeNull();
  expect(screen.getByText("−12")).toBeTruthy();
  expect(screen.getByRole("meter").getAttribute("aria-valuenow")).toBe("100");
});
