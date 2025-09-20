/**
 * Discriminated union of all messages that can change the AppState.
 * Pure data only; used by the update reducer.
 */

import type {
  TeamId,
  WormId,
  ProjectileId,
  ParticleId,
  Worm,
  Projectile,
  Particle,
  Vec2,
  WeaponKind,
  WeaponProjectileKind,
} from "./entities";
import type { TerrainDeformOp } from "./terrain-model";

/* Core message union */

export type Msg =
  // Time and loop
  | { type: "TickAdvanced"; nowMs: number; dtMs: number }
  | { type: "TimerElapsed"; timerId: string }
  | { type: "WindChanged"; strength: number }

  // Input
  | { type: "Input.Move"; direction: -1 | 1; pressed: boolean }
  | { type: "Input.Aim"; deltaRad: number }
  | { type: "Input.FirePressed"; nowMs: number }
  | { type: "Input.FireReleased"; nowMs: number }
  | { type: "Input.SelectWeapon"; weapon: WeaponKind }
  | { type: "Input.Jump"; strength: number }
  | { type: "Game.Paused" }
  | { type: "Game.Resumed" }

  // Turn / system / UI
  | { type: "Turn.Started"; nowMs: number }
  | { type: "Turn.Advanced"; nowMs: number }
  | { type: "Team.Eliminated"; teamId: TeamId }
  | { type: "Game.VictoryAchieved"; winningTeamId: TeamId; reason: string }
  | { type: "UI.MessageSet"; text: string; untilMs?: number }
  | { type: "UI.MessageCleared" }

  // Projectiles
  | { type: "Projectile.Spawned"; id: ProjectileId; data: Projectile }
  | { type: "Projectile.Moved"; id: ProjectileId; newPos: Vec2; newVel: Vec2 }
  | { type: "Projectile.Collided"; id: ProjectileId; point: Vec2; normal: Vec2 | null }
  | { type: "Projectile.FuseElapsed"; id: ProjectileId }
  | {
      type: "Projectile.Exploded";
      id: ProjectileId;
      center: Vec2;
      radius: number;
      damage: number;
      knockback: number;
    }
  | { type: "Projectile.Removed"; id: ProjectileId }

  // Terrain and particles
  | { type: "Terrain.DeformRequested"; op: TerrainDeformOp; reason: string }
  | { type: "Terrain.Deformed"; appliedOps: TerrainDeformOp[]; pixelsCleared?: number }
  | { type: "Particle.Spawned"; id: ParticleId; data: Particle }
  | { type: "Particle.Advanced"; id: ParticleId; newPos: Vec2; newVel: Vec2; alive: boolean }
  | { type: "Particle.Culled"; ids: ParticleId[] }

  // Worms
  | { type: "Worm.Spawned"; id: WormId; data: Worm }
  | {
      type: "Worm.Moved";
      id: WormId;
      newPos: Vec2;
      newVel: Vec2;
      onGround: boolean;
      facing: -1 | 1;
    }
  | {
      type: "Worm.Damaged";
      id: WormId;
      amount: number;
      source: { kind: "explosion" | "fall" | "rifle"; pos?: Vec2 };
    }
  | { type: "Worm.Died"; id: WormId; cause: string }
  | { type: "Worm.WeaponSelected"; id: WormId; weapon: WeaponKind }
  | { type: "Worm.ChargeStarted"; id: WormId; atMs: number }
  | { type: "Worm.ChargeUpdated"; id: WormId; chargeMs: number }
  | {
      type: "Worm.Fired";
      id: WormId;
      projectileId: ProjectileId;
      initialVel: Vec2;
      kind: WeaponProjectileKind;
      fuseMs?: number;
    }
  | { type: "Worm.Jumped"; id: WormId; vel: Vec2 };