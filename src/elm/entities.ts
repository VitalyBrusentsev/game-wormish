/**
 * Core entity and utility types for the Elm-style model.
 * Pure data only; no behavior or DOM references.
 */

/* Utility branded ID types */
export type Brand<T, B> = T & { __brand: B };

export type TeamId = Brand<number, "TeamId">;
export type WormId = Brand<number, "WormId">;
export type ProjectileId = Brand<number, "ProjectileId">;
export type ParticleId = Brand<number, "ParticleId">;

/* Basic math/geometry/color */
export type Vec2 = { x: number; y: number };
export type Rect = { x: number; y: number; width: number; height: number };
export type Color = { r: number; g: number; b: number; a?: number };

/* Weapons */
export type WeaponKind = "Bazooka" | "Hand Grenade" | "Rifle";
export type WeaponProjectileKind = "bazookaRocket" | "grenade" | "rifleBullet";

/* Collections identity registry */
export type IdRegistry = {
  nextTeamId: TeamId;
  nextWormId: WormId;
  nextProjectileId: ProjectileId;
  nextParticleId: ParticleId;
};

/* Team */
export type Team = {
  id: TeamId;
  name: string;
  color: Color;
  wormIds: WormId[];
  isAlive: boolean;
};

/* Worm */
export type WormStatus = {
  isActive: boolean;
  isTakingTurn: boolean;
  isStunned: boolean;
  invulnerableUntilMs: number | null;
};

export type WeaponState = {
  selected: WeaponKind;
  chargeStartAtMs: number | null;
  rifleAmmo: number;
  bazookaAmmo: number;
  grenadeAmmo: number;
};

export type Worm = {
  id: WormId;
  teamId: TeamId;
  position: Vec2;
  velocity: Vec2;
  angleRad: number;
  health: number;
  isAlive: boolean;
  facing: -1 | 1;
  onGround: boolean;
  weapon: WeaponState;
  status: WormStatus;
};

/* Projectile */
export type Projectile = {
  id: ProjectileId;
  kind: WeaponProjectileKind;
  position: Vec2;
  velocity: Vec2;
  bornAtMs: number;
  fuseMs: number | null;
  ownerWormId: WormId | null;
  ttlMs: number | null;
  exploded: boolean;
  hasCollided: boolean;
};

/* Particle (model-level particles; visual-only particles are effects) */
export type Particle = {
  id: ParticleId;
  position: Vec2;
  velocity: Vec2;
  color: Color;
  size: number;
  ttlMs: number;
  bornAtMs: number;
  gravityScale: number;
};