/**
 * Minimal initializer for the Elm-style AppState.
 * Pure data only; safe to use in unit tests (no DOM).
 */

import type { AppState } from "./state";
import type { TerrainModel } from "./terrain-model";
import type { IdRegistry, TeamId, WormId, ProjectileId, ParticleId } from "./entities";
import { WORLD as LEGACY_WORLD, GAMEPLAY as LEGACY_GAMEPLAY } from "../definitions";

export type InitOptions = {
  width: number;
  height: number;
  nowMs: number;
  seed: number;
  windStrength: number; // -1..1 (scaled by world)
  turnDurationMs: number;
};

const defaults: InitOptions = {
  width: 800,
  height: 600,
  nowMs: 0,
  seed: 1,
  windStrength: 0,
  turnDurationMs: LEGACY_GAMEPLAY.turnTimeMs,
};

// Branded id helpers (runtime numbers, typed as branded ids)
const asTeamId = (n: number) => n as unknown as TeamId;
const asWormId = (n: number) => n as unknown as WormId;
const asProjectileId = (n: number) => n as unknown as ProjectileId;
const asParticleId = (n: number) => n as unknown as ParticleId;

function makeIds(): IdRegistry {
  return {
    nextTeamId: asTeamId(1),
    nextWormId: asWormId(1),
    nextProjectileId: asProjectileId(1),
    nextParticleId: asParticleId(1),
  };
}

function makeTerrain(width: number, height: number, nowMs: number): TerrainModel {
  // Keep tiny default mask; tests may override dimensions.
  const size = Math.max(1, width * height);
  return {
    kind: "mask",
    width,
    height,
    solidMask: new Uint8Array(size),
    deformationQueue: [],
    lastModifiedAtMs: nowMs,
  };
}

/**
 * Create a minimal valid AppState with no entities.
 * Accepts partial overrides for convenient testing.
 */
export function initialAppState(partial?: Partial<InitOptions>): AppState {
  const cfg = { ...defaults, ...partial };

  return {
    session: {
      phase: "playing",
      turn: {
        currentTeamIndex: 0,
        currentWormIndex: 0,
        orderMode: "cycle",
        turnStartAtMs: cfg.nowMs,
        turnDurationMs: cfg.turnDurationMs,
        timeNowMs: cfg.nowMs,
        wind: { strength: cfg.windStrength, lastUpdatedAtMs: cfg.nowMs },
      },
      victory: null,
    },
    world: {
      gravity: LEGACY_WORLD.gravity,
      airResistance: 0, // no explicit air resistance in legacy constants
      bounds: { x: 0, y: 0, width: cfg.width, height: cfg.height },
      waterLevelY: cfg.height - 40,
      windConfig: { min: -1, max: 1, changeCooldownMs: 0 },
    },
    entities: {
      teams: {},
      worms: {},
      projectiles: {},
      particles: {},
      ids: makeIds(),
    },
    terrain: makeTerrain(cfg.width, cfg.height, cfg.nowMs),
    rng: {
      seed: cfg.seed,
      streamIndex: 0,
    },
    ui: {
      message: null,
      messageUntilMs: null,
      cursor: "default",
      overlays: [],
      input: {
        moveLeft: false,
        moveRight: false,
        aimUp: false,
        aimDown: false,
        fireHeld: false,
        lastInputAtMs: cfg.nowMs,
      }
    },
  };
}