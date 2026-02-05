import { GAMEPLAY, WeaponType, WORLD, clamp, distance } from "../definitions";
import type { GameSession } from "../game/session";
import type { Worm } from "../entities";
import type { AimInfo } from "../rendering/game-rendering";
import { computeAimAngleFromTarget, predictTrajectory } from "../game/weapon-system";
import type { AiPersonality } from "./types";

export type AiShotDebug = {
  weapon: WeaponType;
  angle: number;
  power: number;
  impact: { x: number; y: number };
  distToTarget: number;
  distToSelf: number;
  damageScore: number;
  splashProximity: number;
  selfDamage: number;
  selfPenalty: number;
  weaponBias: number;
  arcBonus: number;
  waterBonus: number;
  baseScore: number;
  biasedScore: number;
  score: number;
  baseAngle: number;
  angleOffset: number;
  simFacing: -1 | 1;
  bazookaDirectHitDist: number | null;
  hitFactor: number | null;
  rangeFactor: number | null;
  expectedHits: number | null;
};

export type ShotCandidate = {
  weapon: WeaponType;
  angle: number;
  power: number;
  aim: AimInfo;
  impact: { x: number; y: number };
  score: number;
  debug: AiShotDebug;
};

const WEAPON_BIAS: Record<AiPersonality, Record<WeaponType, number>> = {
  Generalist: {
    [WeaponType.Bazooka]: 1,
    [WeaponType.HandGrenade]: 1,
    [WeaponType.Rifle]: 1,
    [WeaponType.Uzi]: 1,
  },
  Marksman: {
    [WeaponType.Bazooka]: 1.1,
    [WeaponType.HandGrenade]: 0.85,
    [WeaponType.Rifle]: 1.35,
    [WeaponType.Uzi]: 0.8,
  },
  Demolisher: {
    [WeaponType.Bazooka]: 1.25,
    [WeaponType.HandGrenade]: 1.35,
    [WeaponType.Rifle]: 0.85,
    [WeaponType.Uzi]: 0.75,
  },
  Commando: {
    [WeaponType.Bazooka]: 0.95,
    [WeaponType.HandGrenade]: 0.8,
    [WeaponType.Rifle]: 1.05,
    [WeaponType.Uzi]: 1.4,
  },
};

const RISK_MULTIPLIER: Record<AiPersonality, number> = {
  Generalist: 1,
  Marksman: 1.2,
  Demolisher: 1,
  Commando: 0.8,
};

const ANGLE_OFFSETS = [-0.5, -0.35, -0.2, -0.1, 0, 0.1, 0.2, 0.35, 0.5];
const POWER_STEPS = [0.35, 0.5, 0.65, 0.8, 0.95];

export const buildAimFromAngle = (worm: Worm, angle: number): AimInfo => {
  const targetDistance = 120;
  return {
    targetX: worm.x + Math.cos(angle) * targetDistance,
    targetY: worm.y + Math.sin(angle) * targetDistance,
    angle,
  };
};

const weaponExplosionRadius = (weapon: WeaponType): number => {
  switch (weapon) {
    case WeaponType.Bazooka:
      return GAMEPLAY.bazooka.explosionRadius;
    case WeaponType.HandGrenade:
      return GAMEPLAY.handGrenade.explosionRadius;
    default:
      return 0;
  }
};

const weaponDamage = (weapon: WeaponType): number => {
  switch (weapon) {
    case WeaponType.Bazooka:
      return GAMEPLAY.bazooka.damage;
    case WeaponType.HandGrenade:
      return GAMEPLAY.handGrenade.damage;
    case WeaponType.Rifle:
      return GAMEPLAY.rifle.directDamage;
    case WeaponType.Uzi:
      return GAMEPLAY.uzi.directDamage;
    default:
      return 0;
  }
};

const estimateExplosionDamage = (d: number, weapon: WeaponType): number => {
  const radius = weaponExplosionRadius(weapon);
  if (radius <= 0 || d > radius) return 0;
  const t = clamp(1 - d / radius, 0, 1);
  return weaponDamage(weapon) * Math.pow(t, 0.6);
};

const minDistanceToPath = (points: { x: number; y: number }[], target: Worm): number => {
  let min = Infinity;
  for (const point of points) {
    const d = distance(point.x, point.y, target.x, target.y);
    if (d < min) min = d;
  }
  return min;
};

const closestPointToWorm = (
  points: { x: number; y: number }[],
  worm: Worm
): { x: number; y: number; dist: number } | null => {
  if (points.length === 0) return null;
  let best: { x: number; y: number; dist: number } | null = null;
  for (const point of points) {
    const d = distance(point.x, point.y, worm.x, worm.y);
    if (!best || d < best.dist) best = { x: point.x, y: point.y, dist: d };
  }
  return best;
};

const computeArcOverCoverBonus = (
  session: GameSession,
  shooter: Worm,
  target: Worm,
  points: { x: number; y: number }[]
): number => {
  if (points.length < 3) return 0;
  let apexY = Infinity;
  for (const point of points) {
    if (point.y < apexY) apexY = point.y;
  }

  const terrain = session.terrain;
  const start = Math.min(shooter.x, target.x);
  const end = Math.max(shooter.x, target.x);
  const step = 8;
  let minTerrainY = Infinity;
  for (let x = start; x <= end; x += step) {
    const ix = clamp(Math.round(x - terrain.worldLeft), 0, terrain.heightMap.length - 1);
    const y = terrain.heightMap[ix] ?? session.height;
    if (y < minTerrainY) minTerrainY = y;
  }
  if (!Number.isFinite(minTerrainY) || !Number.isFinite(apexY)) return 0;

  const clearance = minTerrainY - apexY;
  if (clearance <= 6) return 0;
  return clamp(clearance / 80, 0, 1);
};

const computeWaterKillBonus = (
  session: GameSession,
  target: Worm,
  weapon: WeaponType,
  impact: { x: number; y: number }
): number => {
  const waterLine = session.height - 8;
  if (target.y < waterLine - 120) return 0;
  const dist = distance(impact.x, impact.y, target.x, target.y);
  const radius = weaponExplosionRadius(weapon);
  if (radius <= 0 || dist > radius) return 0;
  if (impact.y >= target.y - 2) return 0;
  const pushDown = clamp((target.y - impact.y) / 60, 0, 1);
  return pushDown * clamp(1 - dist / radius, 0, 1);
};

export const scoreCandidate = (params: {
  session: GameSession;
  shooter: Worm;
  target: Worm;
  weapon: WeaponType;
  aim: AimInfo;
  angle: number;
  power: number;
  cinematic: boolean;
  personality: AiPersonality;
  baseAngle: number;
  angleOffset: number;
}): ShotCandidate => {
  const {
    session,
    shooter,
    target,
    weapon,
    aim,
    angle,
    power,
    cinematic,
    personality,
    baseAngle,
    angleOffset,
  } = params;

  // `predictTrajectory()` uses `activeWorm.facing` to compute muzzle/hold points.
  // In real firing, facing is derived from aim target X at the moment of the fire command.
  const previousFacing = shooter.facing;
  const simFacing = (aim.targetX < shooter.x ? -1 : 1) as -1 | 1;
  shooter.facing = simFacing;
  const points = predictTrajectory({
    weapon,
    activeWorm: shooter,
    aim,
    power01: power,
    wind: session.wind,
    terrain: session.terrain,
    width: session.width,
    height: session.height,
  });
  shooter.facing = previousFacing;

  const impact =
    points.length > 0
      ? { x: points[points.length - 1]!.x, y: points[points.length - 1]!.y }
      : { x: shooter.x, y: shooter.y };

  // Bazooka explodes on worm hit, but the trajectory predictor currently only stops on terrain.
  // Approximate direct hits by checking the closest simulated point to the target worm.
  const bazookaHit =
    weapon === WeaponType.Bazooka
      ? closestPointToWorm(points, target)
      : null;
  const bazookaDirectHitDist = bazookaHit?.dist ?? null;
  const effectiveImpact =
    bazookaHit && bazookaHit.dist <= target.radius + WORLD.projectileRadius
      ? { x: bazookaHit.x, y: bazookaHit.y }
      : impact;

  const distToTarget = distance(effectiveImpact.x, effectiveImpact.y, target.x, target.y);
  const distToSelf = distance(effectiveImpact.x, effectiveImpact.y, shooter.x, shooter.y);

  let damageScore = 0;
  let hitFactor: number | null = null;
  let rangeFactor: number | null = null;
  let expectedHits: number | null = null;
  if (weapon === WeaponType.Rifle || weapon === WeaponType.Uzi) {
    const minDist = minDistanceToPath(points, target);
    hitFactor = clamp(1 - minDist / (WORLD.wormRadius * 1.1), 0, 1);
    const range = distance(shooter.x, shooter.y, target.x, target.y);
    rangeFactor = clamp(1 - range / 600, 0, 1);
    const base = weaponDamage(weapon) * hitFactor;
    if (weapon === WeaponType.Uzi) {
      expectedHits = GAMEPLAY.uzi.burstCount * 0.35 * rangeFactor;
      damageScore = base * expectedHits;
    } else {
      damageScore = base;
    }
  } else {
    damageScore = estimateExplosionDamage(distToTarget, weapon);
  }

  const splashRadius = weaponExplosionRadius(weapon);
  const splashProximity =
    splashRadius > 0 ? clamp(1 - distToTarget / (splashRadius * 2), 0, 1) : 0;
  const selfDamage =
    weapon === WeaponType.Rifle || weapon === WeaponType.Uzi
      ? 0
      : estimateExplosionDamage(distToSelf, weapon);
  const selfPenalty = selfDamage * RISK_MULTIPLIER[personality];

  const arcBonus = cinematic ? computeArcOverCoverBonus(session, shooter, target, points) : 0;
  const waterBonus = cinematic ? computeWaterKillBonus(session, target, weapon, effectiveImpact) : 0;

  const baseScore = damageScore + splashProximity * 22 + arcBonus * 18 + waterBonus * 70;
  const weaponBias = WEAPON_BIAS[personality][weapon];
  const biased = baseScore * weaponBias;
  const score = biased - selfPenalty * 1.1;

  return {
    weapon,
    angle,
    power,
    aim,
    impact: effectiveImpact,
    score,
    debug: {
      weapon,
      angle,
      power,
      impact: effectiveImpact,
      distToTarget,
      distToSelf,
      damageScore,
      splashProximity,
      selfDamage,
      selfPenalty,
      weaponBias,
      arcBonus,
      waterBonus,
      baseScore,
      biasedScore: biased,
      score,
      baseAngle,
      angleOffset,
      simFacing,
      bazookaDirectHitDist,
      hitFactor,
      rangeFactor,
      expectedHits,
    },
  };
};

export const buildCandidates = (params: {
  session: GameSession;
  shooter: Worm;
  target: Worm;
  personality: AiPersonality;
  cinematic: boolean;
}): ShotCandidate[] => {
  const { session, shooter, target, personality, cinematic } = params;
  const candidates: ShotCandidate[] = [];
  const weapons = [
    WeaponType.Bazooka,
    WeaponType.HandGrenade,
    WeaponType.Rifle,
    WeaponType.Uzi,
  ];

  for (const weapon of weapons) {
    const baseAngle = computeAimAngleFromTarget({
      weapon,
      worm: shooter,
      targetX: target.x,
      targetY: target.y,
    });

    if (weapon === WeaponType.Rifle || weapon === WeaponType.Uzi) {
      const aim = buildAimFromAngle(shooter, baseAngle);
      candidates.push(
        scoreCandidate({
          session,
          shooter,
          target,
          weapon,
          aim,
          angle: baseAngle,
          power: 1,
          cinematic,
          personality,
          baseAngle,
          angleOffset: 0,
        })
      );
      continue;
    }

    for (const offset of ANGLE_OFFSETS) {
      const angle = baseAngle + offset;
      for (const power of POWER_STEPS) {
        const aim = buildAimFromAngle(shooter, angle);
        candidates.push(
          scoreCandidate({
            session,
            shooter,
            target,
            weapon,
            aim,
            angle,
            power,
            cinematic,
            personality,
            baseAngle,
            angleOffset: offset,
          })
        );
      }
    }
  }
  return candidates;
};

