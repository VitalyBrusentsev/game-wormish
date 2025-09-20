/**
 * Canonical immutable application state (pure data).
 * No DOM handles, timers, or randomness sources outside of rng seed/state.
 */

import type {
  TeamId,
  WormId,
  ProjectileId,
  ParticleId,
  Team,
  Worm,
  Projectile,
  Particle,
  IdRegistry,
  Rect,
  WeaponKind,
} from "./entities";
import type { TerrainModel } from "./terrain-model";

/* Session and phase */

export type Phase = "lobby" | "playing" | "paused" | "victory";

export type Wind = {
  strength: number; // signed -1..1 (scaled by world config)
  lastUpdatedAtMs: number;
};

export type TurnState = {
  currentTeamIndex: number;
  currentWormIndex: number;
  orderMode: "cycle" | "roundRobin";
  turnStartAtMs: number;
  turnDurationMs: number;
  timeNowMs: number;
  wind: Wind;
};

export type VictoryState = {
  winningTeamId: TeamId;
  reason: string;
} | null;

export type Session = {
  phase: Phase;
  turn: TurnState;
  victory: VictoryState;
};

/* World constants/config */

export type World = {
  gravity: number;
  airResistance: number;
  bounds: Rect;
  waterLevelY: number;
  windConfig: { min: number; max: number; changeCooldownMs: number };
};

/* Entities container */

export type Entities = {
  teams: Record<TeamId, Team>;
  worms: Record<WormId, Worm>;
  projectiles: Record<ProjectileId, Projectile>;
  particles: Record<ParticleId, Particle>;
  ids: IdRegistry;
};

/* UI (pure) */

export type CursorKind = "default" | "crosshair" | "wait";

export type UiOverlay =
  | { kind: "message"; text: string }
  | { kind: "banner"; text: string };

export type InputState = {
  moveLeft: boolean;
  moveRight: boolean;
  aimUp: boolean;
  aimDown: boolean;
  fireHeld: boolean;
  lastInputAtMs: number;
};

export type UiState = {
  message: string | null;
  messageUntilMs: number | null;
  cursor: CursorKind;
  overlays: UiOverlay[];
  input: InputState;
  // convenience mirror for active worm weapon (derived or denormalized):
  selectedWeapon?: WeaponKind;
};

/* RNG (deterministic) */

export type RngState = {
  seed: number;
  streamIndex: number;
};

/* Top-level canonical state */

export type AppState = {
  session: Session;
  world: World;
  entities: Entities;
  terrain: TerrainModel;
  rng: RngState;
  ui: UiState;
};