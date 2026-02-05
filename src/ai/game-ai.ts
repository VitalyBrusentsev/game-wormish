import { GAMEPLAY, WeaponType, WORLD, clamp, distance, nowMs, type TeamId } from "../definitions";
import type { GameSession } from "../game/session";
import type { Worm } from "../entities";
import type { AimInfo } from "../rendering/game-rendering";
import { computeAimAngleFromTarget, predictTrajectory } from "../game/weapon-system";
import type { AiPersonality, GameAiSettings } from "./types";
import { getWormPersonality } from "./personality-store";

export type AiTurnPlan = {
  weapon: WeaponType;
  angle: number;
  power: number;
  delayMs: number;
  target: Worm;
  score: number;
  cinematic: boolean;
  personality: AiPersonality;
};

type ResolvedAiSettings = {
  personality: AiPersonality;
  minThinkTimeMs: number;
  cinematicChance: number;
  precisionMode: "perfect" | "noisy";
  precisionTopK: number;
  noiseAngleRad: number;
  noisePower: number;
};

type ShotCandidate = {
  weapon: WeaponType;
  angle: number;
  power: number;
  aim: AimInfo;
  impact: { x: number; y: number };
  score: number;
};

const DEFAULT_MIN_THINK_MS = 1000;
const DEFAULT_CINEMATIC_CHANCE = 0.12;

const DEFAULT_PRECISION_TOP_K = 3;
const DEFAULT_NOISE_ANGLE_RAD = 0.05;
const DEFAULT_NOISE_POWER = 0.06;

const TARGETING_WEIGHTS: Record<AiPersonality, { health: number; distance: number }> = {
  Generalist: { health: 0.45, distance: 0.55 },
  Marksman: { health: 0.65, distance: 0.35 },
  Demolisher: { health: 0.4, distance: 0.6 },
  Commando: { health: 0.3, distance: 0.7 },
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

const resolveSettings = (
  activeWorm: Worm,
  settings?: GameAiSettings
): ResolvedAiSettings => {
  const personality = settings?.personality ?? getWormPersonality(activeWorm);
  const precisionMode = settings?.precision?.mode ?? "perfect";
  const precisionTopK = Math.max(1, settings?.precision?.topK ?? DEFAULT_PRECISION_TOP_K);
  const noiseAngleRad = settings?.precision?.noiseAngleRad ?? DEFAULT_NOISE_ANGLE_RAD;
  const noisePower = settings?.precision?.noisePower ?? DEFAULT_NOISE_POWER;
  const minThinkTimeMs = Math.max(0, settings?.minThinkTimeMs ?? DEFAULT_MIN_THINK_MS);
  const cinematicChance = clamp(
    settings?.cinematic?.chance ?? DEFAULT_CINEMATIC_CHANCE,
    0,
    1
  );

  return {
    personality,
    minThinkTimeMs,
    cinematicChance,
    precisionMode,
    precisionTopK,
    noiseAngleRad,
    noisePower,
  };
};

const buildAimFromAngle = (worm: Worm, angle: number): AimInfo => {
  const targetDistance = 120;
  return {
    targetX: worm.x + Math.cos(angle) * targetDistance,
    targetY: worm.y + Math.sin(angle) * targetDistance,
    angle,
  };
};

const selectTarget = (session: GameSession, personality: AiPersonality): Worm | null => {
  const activeTeamId = session.activeTeam.id;
  const enemies: Worm[] = [];
  for (const team of session.teams) {
    if (team.id === activeTeamId) continue;
    for (const worm of team.worms) {
      if (worm.alive) enemies.push(worm);
    }
  }
  if (enemies.length === 0) return null;

  const weights = TARGETING_WEIGHTS[personality];
  const shooter = session.activeWorm;
  const maxDist = Math.max(1, session.width);

  let best: Worm | null = null;
  let bestScore = -Infinity;
  for (const enemy of enemies) {
    const dist = distance(shooter.x, shooter.y, enemy.x, enemy.y);
    const distScore = clamp(1 - dist / maxDist, 0, 1);
    const healthScore = clamp(1 - enemy.health / 100, 0, 1);
    const score =
      distScore * weights.distance +
      healthScore * weights.health +
      (Math.random() * 0.02 - 0.01);
    if (score > bestScore) {
      bestScore = score;
      best = enemy;
    }
  }
  return best;
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

const scoreCandidate = (params: {
  session: GameSession;
  shooter: Worm;
  target: Worm;
  weapon: WeaponType;
  aim: AimInfo;
  angle: number;
  power: number;
  cinematic: boolean;
  personality: AiPersonality;
}): ShotCandidate => {
  const { session, shooter, target, weapon, aim, angle, power, cinematic, personality } = params;
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
  const impact =
    points.length > 0
      ? { x: points[points.length - 1]!.x, y: points[points.length - 1]!.y }
      : { x: shooter.x, y: shooter.y };

  const distToTarget = distance(impact.x, impact.y, target.x, target.y);
  const distToSelf = distance(impact.x, impact.y, shooter.x, shooter.y);

  let damageScore = 0;
  if (weapon === WeaponType.Rifle || weapon === WeaponType.Uzi) {
    const minDist = minDistanceToPath(points, target);
    const hitFactor = clamp(1 - minDist / (WORLD.wormRadius * 1.1), 0, 1);
    const range = distance(shooter.x, shooter.y, target.x, target.y);
    const rangeFactor = clamp(1 - range / 600, 0, 1);
    const base = weaponDamage(weapon) * hitFactor;
    if (weapon === WeaponType.Uzi) {
      const expectedHits = GAMEPLAY.uzi.burstCount * 0.35 * rangeFactor;
      damageScore = base * expectedHits;
    } else {
      damageScore = base;
    }
  } else {
    damageScore = estimateExplosionDamage(distToTarget, weapon);
  }

  const splashRadius = weaponExplosionRadius(weapon);
  const splashProximity = splashRadius > 0
    ? clamp(1 - distToTarget / (splashRadius * 2), 0, 1)
    : 0;
  const selfDamage =
    weapon === WeaponType.Rifle || weapon === WeaponType.Uzi
      ? 0
      : estimateExplosionDamage(distToSelf, weapon);
  const selfPenalty = selfDamage * RISK_MULTIPLIER[personality];

  const arcBonus = cinematic
    ? computeArcOverCoverBonus(session, shooter, target, points)
    : 0;
  const waterBonus = cinematic ? computeWaterKillBonus(session, target, weapon, impact) : 0;

  const baseScore =
    damageScore +
    splashProximity * 22 +
    arcBonus * 18 +
    waterBonus * 70;
  const biased = baseScore * WEAPON_BIAS[personality][weapon];
  const score = biased - selfPenalty * 1.1;

  return {
    weapon,
    angle,
    power,
    aim,
    impact,
    score,
  };
};

const buildCandidates = (params: {
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
          })
        );
      }
    }
  }
  return candidates;
};

const chooseCandidate = (
  candidates: ShotCandidate[],
  settings: ResolvedAiSettings
): ShotCandidate | null => {
  if (candidates.length === 0) return null;
  const sorted = [...candidates].sort((a, b) => b.score - a.score);
  if (settings.precisionMode === "perfect") {
    return sorted[0]!;
  }
  const top = sorted.slice(0, settings.precisionTopK);
  let total = 0;
  const weights = top.map((candidate) => {
    const weight = Math.max(0.001, candidate.score + 0.001);
    total += weight;
    return weight;
  });
  let roll = Math.random() * total;
  for (let i = 0; i < top.length; i++) {
    roll -= weights[i]!;
    if (roll <= 0) return top[i]!;
  }
  return top[0]!;
};

const applyPrecisionNoise = (
  candidate: ShotCandidate,
  settings: ResolvedAiSettings
): ShotCandidate => {
  if (settings.precisionMode !== "noisy") return candidate;
  const angleNoise = (Math.random() * 2 - 1) * settings.noiseAngleRad;
  const powerNoise = (Math.random() * 2 - 1) * settings.noisePower;
  return {
    ...candidate,
    angle: candidate.angle + angleNoise,
    power: clamp(candidate.power + powerNoise, 0, 1),
  };
};

export const planAiTurn = (
  session: GameSession,
  settings?: GameAiSettings
): AiTurnPlan | null => {
  if (session.state.phase !== "aim") return null;
  const shooter = session.activeWorm;
  const resolved = resolveSettings(shooter, settings);
  const target = selectTarget(session, resolved.personality);
  if (!target) return null;

  const cinematic = Math.random() < resolved.cinematicChance;
  const candidates = buildCandidates({
    session,
    shooter,
    target,
    personality: resolved.personality,
    cinematic,
  });
  const chosen = chooseCandidate(candidates, resolved);
  if (!chosen) return null;
  const adjusted = applyPrecisionNoise(chosen, resolved);

  return {
    weapon: adjusted.weapon,
    angle: adjusted.angle,
    power: adjusted.power,
    delayMs: resolved.minThinkTimeMs,
    target,
    score: adjusted.score,
    cinematic,
    personality: resolved.personality,
  };
};

export const playTurnWithGameAi = (
  session: GameSession,
  settings?: GameAiSettings
): AiTurnPlan | null => {
  const plan = planAiTurn(session, settings);
  if (!plan) return null;
  const expectedTurn = session.getTurnIndex();
  const expectedWorm = session.activeWorm;
  const executeAt = nowMs() + plan.delayMs;

  const fire = () => {
    if (session.getTurnIndex() !== expectedTurn) return;
    if (session.activeWorm !== expectedWorm) return;
    if (session.state.phase !== "aim") return;
    session.debugSetWeapon(plan.weapon);
    session.debugShoot(plan.angle, plan.power);
  };

  const delay = Math.max(0, executeAt - nowMs());
  setTimeout(fire, delay);
  return plan;
};

export const playTurnWithGameAiForTeam = (
  session: GameSession,
  teamId: TeamId,
  settings?: GameAiSettings
): AiTurnPlan | null => {
  if (session.activeTeam.id !== teamId) return null;
  return playTurnWithGameAi(session, settings);
};
