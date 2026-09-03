import type { HospitalStatus, JailStatus } from "@gl3/shared";

/**
 * The server's sentence sweeper ends jail and hospital sentences on a ~2s tick
 * and pushes `player.released` / `player.discharged` over the socket, so the
 * page no longer has to ask. This poll is the backstop for the window where
 * the socket is down (reconnect is 2s, but a server restart can be longer) —
 * without it a mid-reconnect client would sit on a stale "you're jailed"
 * screen. 30s rather than the old 2s: 15× less traffic, and the socket is what
 * makes it feel instant.
 */
export const SENTENCE_SAFETY_POLL_MS = 30_000;

export function jailRefetchInterval(data: JailStatus | undefined): number | false {
  return data?.jailed === true ? SENTENCE_SAFETY_POLL_MS : false;
}

export function hospitalRefetchInterval(data: HospitalStatus | undefined): number | false {
  return data?.hospitalised === true ? SENTENCE_SAFETY_POLL_MS : false;
}
