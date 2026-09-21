import type { InteriorDecl, InteriorPoint, SceneSpawn } from "@gl3/shared";

/**
 * The casino floor (spec 2026-09-21 casino-floor-v2): what the Godot
 * client builds `casino-floor-v2` to. Metres, x east, y north, origin at the
 * floor centre, entrance in the south wall. Authored once here and read by
 * both the manifest (`worldHooks[].interior`) and the sit route (stations).
 *
 * One blackjack table, one Texas Hold'em table (`@gl3-plugins/holdem`, not
 * in this repo — its row is `available: false` until installed) and eight
 * slot machines (`@gl3-plugins/slots`, likewise not installed). A machine
 * point is only a place to stand — a slots session is per player, so it
 * never fills and carries no seat beyond the one stand spot.
 */
const SEAT_OFFSETS: readonly (readonly [number, number])[] = [[-1.8, -0.9], [-1.0, -1.7], [0, -2.0], [1.0, -1.7], [1.8, -0.9]];
const round3 = (n: number): number => Math.round(n * 1000) / 1000 + 0;

/** Five seat spots on the south arc of a table, each facing its centre; index = seat number. */
export function tableSeats(centre: { x: number; y: number }): SceneSpawn[] {
  // A seat at offset (dx, dy) faces the vector (-dx, -dy); yaw 0 is north (+y),
  // positive counter-clockwise, so yaw = atan2(-vx, vy) = atan2(dx, -dy).
  return SEAT_OFFSETS.map(([dx, dy]) => ({ x: round3(centre.x + dx), y: round3(centre.y + dy), facing: round3(Math.atan2(dx, -dy)) }));
}

const blackjack: InteriorPoint = {
  id: "blackjack-1", kind: "table", label: "Blackjack", model: "blackjack-table",
  position: { x: -6, y: 1 }, facing: Math.PI, seats: tableSeats({ x: -6, y: 1 }),
  binding: { gameId: "blackjack", station: 0 },
};

const holdem: InteriorPoint = {
  id: "holdem-1", kind: "table", label: "Texas Hold'em", model: "holdem-table",
  position: { x: 6, y: 1 }, facing: Math.PI, seats: tableSeats({ x: 6, y: 1 }),
  binding: { gameId: "holdem", station: 0 },
};

const SLOT_COUNT = 8;
const slots: InteriorPoint[] = Array.from({ length: SLOT_COUNT }, (_, i) => {
  const x = round3(-10.5 + 3 * i);
  return {
    id: `slots-${i + 1}`, kind: "machine", label: `Slots ${i + 1}`, model: "slot-machine",
    position: { x, y: 7.5 }, facing: Math.PI,
    seats: [{ x, y: 6, facing: 0 }],
    binding: { gameId: "slots", station: i },
  };
});

const points: InteriorPoint[] = [blackjack, holdem, ...slots];

export const CASINO_FLOOR: InteriorDecl = {
  sceneKey: "casino-floor-v2",
  bounds: { minX: -12, minY: -9, maxX: 12, maxY: 9 },
  spawn: { x: 0, y: -7.5, facing: 0 },
  points,
};

/** The stations the floor declares for a game, ascending; `[]` for a game with no table on it. */
export function stationsFor(gameId: string): number[] {
  return CASINO_FLOOR.points
    .filter((p) => p.binding?.gameId === gameId)
    .map((p) => p.binding!.station)
    .sort((a, b) => a - b);
}
