import type { TeamId } from "../../definitions";
import type { WeaponType } from "../../definitions";
import type { GameSnapshot } from "../session";

export interface TurnCommandFireChargedWeapon {
  type: "fire-charged-weapon";
  weapon: WeaponType;
  power: number;
  aim: {
    angle: number;
    targetX: number;
    targetY: number;
  };
  atMs: number;
  projectileIds: number[];
}

export type TurnCommand = TurnCommandFireChargedWeapon;

export interface ProjectileSpawnEvent {
  type: "projectile-spawned";
  id: number;
  weapon: WeaponType;
  position: { x: number; y: number };
  velocity: { x: number; y: number };
  wind: number;
  atMs: number;
}

export interface ProjectileExplosionEvent {
  type: "projectile-exploded";
  id: number;
  weapon: WeaponType;
  position: { x: number; y: number };
  radius: number;
  damage: number;
  cause: WeaponType;
  atMs: number;
}

export interface ProjectileExpiredEvent {
  type: "projectile-expired";
  id: number;
  weapon: WeaponType;
  position: { x: number; y: number };
  reason: "lifetime" | "out-of-bounds";
  atMs: number;
}

export type TurnEvent =
  | ProjectileSpawnEvent
  | ProjectileExplosionEvent
  | ProjectileExpiredEvent;

export interface TerrainCarveOperation {
  type: "carve-circle";
  x: number;
  y: number;
  radius: number;
  atMs: number;
}

export type TerrainOperation = TerrainCarveOperation;

export interface WormHealthChange {
  teamId: TeamId;
  wormIndex: number;
  before: number;
  after: number;
  delta: number;
  cause: WeaponType;
  atMs: number;
  wasAlive: boolean;
  alive: boolean;
}

export interface TurnResolution {
  actingTeamId: TeamId;
  actingTeamIndex: number;
  actingWormIndex: number;
  windAtStart: number;
  windAfter: number;
  startedAtMs: number;
  completedAtMs: number;
  commands: TurnCommand[];
  projectileEvents: TurnEvent[];
  terrainOperations: TerrainOperation[];
  wormHealth: WormHealthChange[];
  snapshot: GameSnapshot;
}
