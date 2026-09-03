/**
 * Where to send a player who has JUST landed in a facility.
 *
 * State-based rather than event-based on purpose: jail has at least five
 * entry paths (a caught crime, a failed bust, a lost police chase, a heist
 * gone wrong, a jail-page arrest) and hospital at least four (a kill, a
 * backfire, a self-admission, a beating that whittled health to zero), each
 * publishing a different event or none. Every one of them invalidates the
 * jail/hospital query, so the query's `false → true` flip is the one signal
 * that covers all of them, present and future.
 *
 * Only a TRANSITION redirects. A first load (`previous` undefined) never
 * does — a jailed player reloading /bank stays on /bank, and a player who
 * navigates away while serving a sentence is not dragged back — the banner
 * in the Shell is what nags. Jail wins when both flip in one tick: a jailed
 * player's page is the one with a timer they can act on (bust/bail).
 */
export type FacilityState = Readonly<{
  jailed: boolean | undefined;
  hospitalised: boolean | undefined;
}>;

export const JAIL_PATH = "/plugins/jail";
export const HOSPITAL_PATH = "/plugins/hospital";

export function facilityArrival(
  previous: FacilityState, next: FacilityState,
): typeof JAIL_PATH | typeof HOSPITAL_PATH | null {
  if (previous.jailed === false && next.jailed === true) return JAIL_PATH;
  if (previous.hospitalised === false && next.hospitalised === true) return HOSPITAL_PATH;
  return null;
}
