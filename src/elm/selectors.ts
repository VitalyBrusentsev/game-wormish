/**
 * Pure selectors and derived computations over AppState.
 * No side effects; do not mutate inputs.
 */

import type { AppState } from "./state";
import type { WormId, TeamId, Worm, Projectile } from "./entities";

/* Time left in the current turn */
export function getTimeLeftMs(state: AppState): number {
  const { turn } = state.session;
  const elapsed = Math.max(0, turn.timeNowMs - turn.turnStartAtMs);
  const left = Math.max(0, turn.turnDurationMs - elapsed);
  return left;
}

/* Current wind strength */
export function getWind(state: AppState): number {
  return state.session.turn.wind.strength;
}

/* Current victory status (null when game is not over) */
export function getVictoryStatus(state: AppState) {
  return state.session.victory;
}

/* All projectiles as an array (copy) */
export function getProjectileList(state: AppState): Projectile[] {
  return Object.values(state.entities.projectiles);
}

/* All worms belonging to a team */
export function getWormsByTeam(state: AppState, teamId: TeamId): Worm[] {
  const worms = state.entities.worms;
  const list: Worm[] = [];
  for (const w of Object.values(worms)) {
    if (w.teamId === teamId) list.push(w);
  }
  return list;
}

/* Charge ratio for a worm's current weapon based on chargeStartAtMs (0..1 triangle wave like legacy) */
export function getChargeRatio(state: AppState, wormId: WormId, nowMs = state.session.turn.timeNowMs): number {
  const worm = state.entities.worms[wormId];
  if (!worm || worm.weapon.chargeStartAtMs == null) return 0;
  const elapsed = Math.max(0, nowMs - worm.weapon.chargeStartAtMs);
  const speed = 1 / 1400; // 1/ms (legacy triangle wave period = 2s)
  const t = elapsed * speed;
  const frac = t % 2;
  return frac < 1 ? frac : 2 - frac;
}