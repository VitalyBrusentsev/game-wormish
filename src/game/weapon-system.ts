import type { PredictedPoint } from "../definitions";
import { GAMEPLAY, WeaponType, WORLD, clamp, nowMs } from "../definitions";
import type { AimInfo } from "../rendering/game-rendering";
import type { Terrain, Worm } from "../entities";
import { Projectile } from "../entities";
import type { Input } from "../utils";
import type { GameState } from "../game-state";

export type AimContext = {
  input: Input;
  state: GameState;
  activeWorm: Worm;
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

export type WeaponChangeContext = {
  previous: WeaponType;
  next: WeaponType;
  input: Input;
  activeWorm: Worm;
};

export function computeAimInfo({ input, state, activeWorm }: AimContext): AimInfo {
  const aimWorm = activeWorm;
  let dx = input.mouseX - aimWorm.x;
  let dy = input.mouseY - aimWorm.y;
  if (state.weapon === WeaponType.Rifle) {
    const len = Math.hypot(dx, dy) || 1;
    const r = GAMEPLAY.rifle.aimRadius;
    if (len > r) {
      dx = (dx / len) * r;
      dy = (dy / len) * r;
    }
  }
  const targetX = aimWorm.x + dx;
  const targetY = aimWorm.y + dy;
  const angle = Math.atan2(targetY - aimWorm.y, targetX - aimWorm.x);
  return { targetX, targetY, angle };
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
  const muzzleOffset = WORLD.wormRadius + 10;
  const sx = activeWorm.x + Math.cos(aim.angle) * muzzleOffset;
  const sy = activeWorm.y + Math.sin(aim.angle) * muzzleOffset;

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
        (x, y, r, dmg) => onExplosion(x, y, r, dmg, WeaponType.Bazooka)
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
        (x, y, r, dmg) => onExplosion(x, y, r, dmg, WeaponType.HandGrenade),
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
        (x, y, r, dmg) => onExplosion(x, y, r, dmg, WeaponType.Rifle)
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
  const muzzleOffset = WORLD.wormRadius + 10;
  const sx = activeWorm.x + Math.cos(aim.angle) * muzzleOffset;
  const sy = activeWorm.y + Math.sin(aim.angle) * muzzleOffset;

  if (weapon === WeaponType.Rifle) {
    const pts: PredictedPoint[] = [];
    const dirx = Math.cos(aim.angle);
    const diry = Math.sin(aim.angle);
    const hit = terrain.raycast(sx, sy, dirx, diry, 2000, 3);
    const maxDist = hit ? hit.dist : 800;
    const step = 16;
    for (let d = 0; d <= maxDist; d += step) {
      const x = sx + dirx * d;
      const y = sy + diry * d;
      const alpha = clamp(1 - d / maxDist, 0.1, 1);
      pts.push({ x, y, alpha });
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

export function handleWeaponChanged({ previous, next, input, activeWorm }: WeaponChangeContext) {
  if (next === WeaponType.Rifle && previous !== WeaponType.Rifle) {
    snapRifleAimToDefault(input, activeWorm);
  } else if (previous === WeaponType.Rifle && next !== WeaponType.Rifle) {
    input.clearMouseWarp();
  }
}

export function shouldPredictPath(state: GameState): boolean {
  return state.phase === "aim" && state.charging;
}

export function resolveCharge01(state: GameState): number {
  return state.getCharge01(nowMs());
}

function snapRifleAimToDefault(input: Input, worm: Worm) {
  const dx = input.mouseX - worm.x;
  const dy = input.mouseY - worm.y;
  const distanceFromWorm = Math.hypot(dx, dy);
  const horizontalFraction = distanceFromWorm > 0 ? Math.abs(dx) / distanceFromWorm : 0;

  let direction = 0;
  if (horizontalFraction > 0.2) {
    direction = dx >= 0 ? 1 : -1;
  }
  if (direction === 0) {
    direction = Math.random() < 0.5 ? -1 : 1;
  }

  const radius = GAMEPLAY.rifle.aimRadius;
  const offset = radius / Math.sqrt(2);
  input.warpMouseTo(worm.x + direction * offset, worm.y - offset);
}
