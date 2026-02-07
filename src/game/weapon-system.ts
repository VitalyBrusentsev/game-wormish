import type { PredictedPoint } from "../definitions";
import { GAMEPLAY, WeaponType, WORLD, clamp, nowMs } from "../definitions";
import { computeCritterRig, computeWeaponRig } from "../critter/critter-geometry";
import { computeWeaponRotationPoint } from "../weapons/weapon-sprites";
import type { AimInfo } from "../rendering/game-rendering";
import type { Terrain, Worm } from "../entities";
import { Projectile } from "../entities";
import type { Input } from "../utils";
import type { GameState } from "../game-state";

export type AimContext = {
  input: Input;
  state: GameState;
  activeWorm: Worm;
  cameraOffsetX?: number;
  cameraOffsetY?: number;
};

export type FireContext = {
  weapon: WeaponType;
  activeWorm: Worm;
  aim: AimInfo;
  power01: number;
  wind: number;
  projectiles: Projectile[];
  onExplosion: (x: number, y: number, radius: number, damage: number, cause: WeaponType) => void;
};

export type TrajectoryContext = {
  weapon: WeaponType;
  activeWorm: Worm;
  aim: AimInfo;
  power01: number;
  wind: number;
  terrain: Terrain;
  width: number;
  height: number;
};

export function computeAimInfo({
  input,
  state,
  activeWorm,
  cameraOffsetX,
  cameraOffsetY,
}: AimContext): AimInfo {
  const aimWorm = activeWorm;
  const pointerX = input.mouseX - (cameraOffsetX ?? 0);
  const pointerY = input.mouseY - (cameraOffsetY ?? 0);
  let dx = pointerX - aimWorm.x;
  let dy = pointerY - aimWorm.y;
  if (state.weapon === WeaponType.Rifle || state.weapon === WeaponType.Uzi) {
    const len = Math.hypot(dx, dy) || 1;
    const r =
      state.weapon === WeaponType.Rifle ? GAMEPLAY.rifle.aimRadius : GAMEPLAY.uzi.aimRadius;
    if (len > r) {
      dx = (dx / len) * r;
      dy = (dy / len) * r;
    }
  }
  const targetX = aimWorm.x + dx;
  const targetY = aimWorm.y + dy;
  const angle = computeAimAngleFromTarget({ weapon: state.weapon, worm: aimWorm, targetX, targetY });
  return { targetX, targetY, angle };
}

export function computeAimAngleFromTarget(config: {
  weapon: WeaponType;
  worm: Worm;
  targetX: number;
  targetY: number;
}): number {
  const facing = (config.targetX < config.worm.x ? -1 : 1) as -1 | 1;

  const rotationPoint =
    config.weapon === WeaponType.HandGrenade
      ? (() => {
          const rig = computeCritterRig({
            x: config.worm.x,
            y: config.worm.y,
            r: config.worm.radius,
            facing,
            pose: { kind: "aim", weapon: config.weapon, aimAngle: 0 },
          });
          return rig.grenade?.center ?? { x: config.worm.x, y: config.worm.y };
        })()
      : computeWeaponRotationPoint({
          center: { x: config.worm.x, y: config.worm.y },
          weapon: config.weapon,
          facing,
        }) ?? { x: config.worm.x, y: config.worm.y };

  if (config.weapon === WeaponType.HandGrenade) {
    return Math.atan2(config.targetY - rotationPoint.y, config.targetX - rotationPoint.x);
  }

  const barrelLength =
    computeWeaponRig({
      center: { x: config.worm.x, y: config.worm.y },
      weapon: config.weapon,
      aimAngle: 0,
      facing,
    }).length || 0;

  let angle = Math.atan2(config.targetY - rotationPoint.y, config.targetX - rotationPoint.x);
  for (let i = 0; i < 2; i++) {
    const muzzleX = rotationPoint.x + Math.cos(angle) * barrelLength;
    const muzzleY = rotationPoint.y + Math.sin(angle) * barrelLength;
    angle = Math.atan2(config.targetY - muzzleY, config.targetX - muzzleX);
  }
  return angle;
}

export function fireWeapon({
  weapon,
  activeWorm,
  aim,
  power01,
  wind,
  projectiles,
  onExplosion,
}: FireContext) {
  const spawn = computeProjectileSpawnPoint(weapon, activeWorm, aim.angle);
  const sx = spawn.x;
  const sy = spawn.y;

  if (weapon === WeaponType.Bazooka) {
    const speed =
      GAMEPLAY.bazooka.minPower +
      (GAMEPLAY.bazooka.maxPower - GAMEPLAY.bazooka.minPower) * power01;
    const vx = Math.cos(aim.angle) * speed;
    const vy = Math.sin(aim.angle) * speed;
    projectiles.push(
      new Projectile(
        sx,
        sy,
        vx,
        vy,
        WORLD.projectileRadius,
        WeaponType.Bazooka,
        wind,
        (x, y, r, dmg, cause, _impact) => onExplosion(x, y, r, dmg, cause)
      )
    );
  } else if (weapon === WeaponType.HandGrenade) {
    const speed =
      GAMEPLAY.handGrenade.minPower +
      (GAMEPLAY.handGrenade.maxPower - GAMEPLAY.handGrenade.minPower) * power01;
    const vx = Math.cos(aim.angle) * speed;
    const vy = Math.sin(aim.angle) * speed;
    projectiles.push(
      new Projectile(
        sx,
        sy,
        vx,
        vy,
        WORLD.projectileRadius,
        WeaponType.HandGrenade,
        wind,
        (x, y, r, dmg, cause, _impact) => onExplosion(x, y, r, dmg, cause),
        { fuse: GAMEPLAY.handGrenade.fuseMs, restitution: GAMEPLAY.handGrenade.restitution }
      )
    );
  } else if (weapon === WeaponType.Rifle) {
    const speed = GAMEPLAY.rifle.speed;
    const vx = Math.cos(aim.angle) * speed;
    const vy = Math.sin(aim.angle) * speed;
    projectiles.push(
      new Projectile(
        sx,
        sy,
        vx,
        vy,
        GAMEPLAY.rifle.projectileRadius,
        WeaponType.Rifle,
        0,
        (x, y, r, dmg, cause, _impact) => onExplosion(x, y, r, dmg, cause)
      )
    );
  }
}

export function predictTrajectory({
  weapon,
  activeWorm,
  aim,
  power01,
  wind,
  terrain,
  width,
  height,
}: TrajectoryContext): PredictedPoint[] {
  const spawn = computeProjectileSpawnPoint(weapon, activeWorm, aim.angle);
  const sx = spawn.x;
  const sy = spawn.y;

  if (weapon === WeaponType.Rifle || weapon === WeaponType.Uzi) {
    const pts: PredictedPoint[] = [];
    const dirx = Math.cos(aim.angle);
    const diry = Math.sin(aim.angle);
    const maxRayDist =
      weapon === WeaponType.Rifle
        ? Math.max(800, GAMEPLAY.rifle.speed * GAMEPLAY.rifle.maxLifetime)
        : GAMEPLAY.uzi.maxDistance;
    const hit = terrain.raycast(sx, sy, dirx, diry, maxRayDist, 3);
    const maxDist = hit?.dist ?? maxRayDist;
    const step = 16;
    for (let d = 0; d <= maxDist; d += step) {
      const x = sx + dirx * d;
      const y = sy + diry * d;
      const alpha = clamp(1 - d / maxDist, 0.1, 1);
      pts.push({ x, y, alpha });
    }
    return pts;
  }

  if (weapon === WeaponType.HandGrenade) {
    const speed =
      GAMEPLAY.handGrenade.minPower +
      (GAMEPLAY.handGrenade.maxPower - GAMEPLAY.handGrenade.minPower) * power01;
    const vx = Math.cos(aim.angle) * speed;
    const vy = Math.sin(aim.angle) * speed;

    const projectile = new Projectile(
      sx,
      sy,
      vx,
      vy,
      WORLD.projectileRadius,
      WeaponType.HandGrenade,
      wind,
      () => undefined,
      {
        fuse: GAMEPLAY.handGrenade.fuseMs,
        restitution: GAMEPLAY.handGrenade.restitution,
      }
    );

    const specHG = {
      gravity: WORLD.gravity,
      explosionRadius: GAMEPLAY.handGrenade.explosionRadius,
      damage: GAMEPLAY.handGrenade.damage,
    };
    const dt = 1 / 60;
    const maxT = Math.max(3.2, GAMEPLAY.handGrenade.fuseMs / 1000 + 0.25);
    const steps = Math.floor(maxT / dt);
    const pts: PredictedPoint[] = [];

    for (let i = 0; i < steps; i++) {
      projectile.update(dt, terrain, specHG);
      if (i % 2 === 0) {
        const t = i * dt;
        const alpha = clamp(1 - t / maxT, 0.15, 1);
        pts.push({ x: projectile.x, y: projectile.y, alpha });
      }
      if (projectile.exploded) break;
    }
    return pts;
  }

  const speed =
    weapon === WeaponType.Bazooka
      ? GAMEPLAY.bazooka.minPower +
        (GAMEPLAY.bazooka.maxPower - GAMEPLAY.bazooka.minPower) * power01
      : GAMEPLAY.handGrenade.minPower +
        (GAMEPLAY.handGrenade.maxPower - GAMEPLAY.handGrenade.minPower) * power01;
  let vx = Math.cos(aim.angle) * speed;
  let vy = Math.sin(aim.angle) * speed;
  const ax = wind;
  const ay = WORLD.gravity;

  const pts: PredictedPoint[] = [];
  let x = sx;
  let y = sy;
  const dt = 1 / 60;
  const maxT = 3.0;
  const steps = Math.floor(maxT / dt);
  for (let i = 0; i < steps; i++) {
    vy += ay * dt;
    vx += ax * dt;
    x += vx * dt;
    y += vy * dt;

    if (i % 2 === 0) {
      const t = i * dt;
      const alpha = clamp(1 - t / maxT, 0.15, 1);
      pts.push({ x, y, alpha });
    }

    if (terrain.circleCollides(x, y, WORLD.projectileRadius)) break;
    if (x < -50 || x > width + 50 || y > height + 50) break;
  }
  return pts;
}

export function shouldPredictPath(state: GameState): boolean {
  return state.phase === "aim" && state.charging;
}

export function resolveCharge01(state: GameState): number {
  return state.getCharge01(nowMs());
}

export function computeProjectileSpawnPoint(
  weapon: WeaponType,
  worm: Worm,
  aimAngle: number
): { x: number; y: number } {
  if (weapon === WeaponType.HandGrenade) {
    const facing = (worm.facing < 0 ? -1 : 1) as -1 | 1;
    const rig = computeCritterRig({
      x: worm.x,
      y: worm.y,
      r: worm.radius,
      facing,
      pose: { kind: "aim", weapon, aimAngle },
    });
    const hold = rig.grenade?.center ?? { x: worm.x, y: worm.y };
    return { x: hold.x, y: hold.y };
  }

  const facing = (worm.facing < 0 ? -1 : 1) as -1 | 1;
  return computeWeaponRig({
    center: { x: worm.x, y: worm.y },
    weapon,
    aimAngle,
    facing,
  }).muzzle;
}
