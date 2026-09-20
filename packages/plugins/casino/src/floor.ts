import type { InteriorDecl, InteriorPoint, SceneSpawn } from "@gl3/shared";

/**
 * The casino floor (spec 2026-09-20 casino-interior §5.1): what the Godot
 * client builds `casino-floor-v1` to. Metres, x east, y north, origin at the
 * floor centre, entrance in the south wall. Authored once here and read by
 * both the manifest (`worldHooks[].interior`) and the sit route (stations).
 */
const SEAT_OFFSETS: readonly (readonly [number, number])[] = [[-1.8, -0.9], [-1.0, -1.7], [0, -2.0], [1.0, -1.7], [1.8, -0.9]];
const TABLE_CENTRES: readonly { x: number; y: number }[] = [{ x: -6, y: 3 }, { x: 6, y: 3 }, { x: -6, y: -3 }, { x: 6, y: -3 }];
const round3 = (n: number): number => Math.round(n * 1000) / 1000 + 0;

/** Five seat spots on the south arc of a table, each facing its centre; index = seat number. */
export function tableSeats(centre: { x: number; y: number }): SceneSpawn[] {
  // A seat at offset (dx, dy) faces the vector (-dx, -dy); yaw 0 is north (+y),
  // positive counter-clockwise, so yaw = atan2(-vx, vy) = atan2(dx, -dy).
  return SEAT_OFFSETS.map(([dx, dy]) => ({ x: round3(centre.x + dx), y: round3(centre.y + dy), facing: round3(Math.atan2(dx, -dy)) }));
}

const points: InteriorPoint[] = TABLE_CENTRES.map((c, i) => ({
  id: `blackjack-${i + 1}`, kind: "table", label: `Blackjack ${i + 1}`, model: "blackjack-table",
  position: c, facing: Math.PI, seats: tableSeats(c), binding: { gameId: "blackjack", station: i },
}));

export const CASINO_FLOOR: InteriorDecl = {
  sceneKey: "casino-floor-v1",
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
