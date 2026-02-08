import { GAMEPLAY, WeaponType, clamp, distance, nowMs, type TeamId } from "../definitions";
import type { GameSession } from "../game/session";
import { Worm } from "../entities";
import { predictTrajectory } from "../game/weapon-system";
import type { AiPersonality, GameAiSettings } from "./types";
import { getWormPersonality } from "./personality-store";
import type { AiShotDebug } from "./shot-scoring";
import { buildCandidates } from "./shot-scoring";
import {
  planMovement,
  planPanicShot,
  planShot,
  timeLeftMsForTurn,
  type AiMoveStep,
  type PanicShotStrategy,
  type AiTurnDebug,
  type ResolvedAiSettings,
} from "./turn-planning";

export type AiTurnPlan = {
  weapon: WeaponType;
  angle: number;
  power: number;
  delayMs: number;
  target: Worm;
  score: number;
  cinematic: boolean;
  personality: AiPersonality;
  debug?: AiTurnDebug;
  moves?: AiMoveStep[];
  movedMs?: number;
  panicShot?: boolean;
  panicStrategy?: PanicShotStrategy;
};

const DEFAULT_MIN_THINK_MS = 1500;
const DEFAULT_CINEMATIC_CHANCE = 0.12;
const FIRE_SAFETY_MS = 220;
const PANIC_FIRE_SAFETY_MS = 80;

const DEFAULT_PRECISION_TOP_K = 3;
const DEFAULT_NOISE_ANGLE_RAD = 0.05;
const DEFAULT_NOISE_POWER = 0.06;

const DEFAULT_DEBUG_TOP_N = 6;

const TARGETING_WEIGHTS: Record<AiPersonality, { health: number; distance: number }> = {
  Generalist: { health: 0.45, distance: 0.55 },
  Marksman: { health: 0.65, distance: 0.35 },
  Demolisher: { health: 0.4, distance: 0.6 },
  Commando: { health: 0.3, distance: 0.7 },
};

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
  const debugEnabled = settings?.debug?.enabled ?? false;
  const debugTopN = Math.max(1, settings?.debug?.topN ?? DEFAULT_DEBUG_TOP_N);
  const movementEnabled = settings?.movement?.enabled ?? true;
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
    debugEnabled,
    debugTopN,
    movementEnabled,
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

const isLikelySelfHit = (
  session: GameSession,
  shooter: Worm,
  shot: { weapon: WeaponType; angle: number; power: number }
): boolean => {
  if (shot.weapon !== WeaponType.Bazooka && shot.weapon !== WeaponType.HandGrenade) return false;
  const aim = {
    angle: shot.angle,
    targetX: shooter.x + Math.cos(shot.angle) * 120,
    targetY: shooter.y + Math.sin(shot.angle) * 120,
  };
  const previousFacing = shooter.facing;
  shooter.facing = aim.targetX < shooter.x ? -1 : 1;
  const points = predictTrajectory({
    weapon: shot.weapon,
    activeWorm: shooter,
    aim,
    power01: shot.power,
    wind: session.wind,
    terrain: session.terrain,
    width: session.width,
    height: session.height,
  });
  shooter.facing = previousFacing;
  if (points.length === 0) return true;
  const impact = points[points.length - 1]!;
  const radius =
    shot.weapon === WeaponType.Bazooka
      ? GAMEPLAY.bazooka.explosionRadius
      : GAMEPLAY.handGrenade.explosionRadius;
  const dist = distance(impact.x, impact.y, shooter.x, shooter.y);
  return dist < radius * 0.85;
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
  const timeLeftMs = timeLeftMsForTurn(session);

  const movement = planMovement({
    session,
    shooter,
    target,
    cinematic,
    settings: resolved,
    timeLeftMs,
  });

  const plannedShooter = movement.plannedShooter;
  const shot = planShot({
    session,
    shooter: plannedShooter,
    target,
    cinematic,
    settings: resolved,
  });

  const moveSteps = movement.steps.map((step) => ({
    move: step.move,
    dtMs: step.dtMs,
    jump: step.jump,
  }));

  const panicStrategy: PanicShotStrategy = movement.craterStuck ? "escape-arc" : "default";
  const panic = shot
    ? null
    : planPanicShot({
        session,
        shooter: plannedShooter,
        target,
        cinematic,
        settings: resolved,
        strategy: panicStrategy,
      });
  const firedCandidate = shot?.fired ?? panic!.candidate;
  const panicShot = !shot;
  const baseDelayMs = panicShot ? panic!.delayMs : resolved.minThinkTimeMs;
  const safetyMs = panicShot ? PANIC_FIRE_SAFETY_MS : FIRE_SAFETY_MS;
  const availableDelayMs = Math.max(0, timeLeftMs - movement.usedMs - safetyMs);
  const delayMs = Math.min(baseDelayMs, availableDelayMs);

  let debug: AiTurnDebug | undefined;
  if (resolved.debugEnabled) {
    const candidatesForDebug =
      shot?.candidates ??
      buildCandidates({
        session,
        shooter: plannedShooter,
        target,
        personality: resolved.personality,
        cinematic,
      });
    const sorted = [...candidatesForDebug].sort((a, b) => b.score - a.score);
    const top = sorted.slice(0, resolved.debugTopN).map((candidate) => candidate.debug);
    const bestByWeapon: Partial<Record<WeaponType, AiShotDebug>> = {};
    for (const candidate of sorted) {
      if (!bestByWeapon[candidate.weapon]) bestByWeapon[candidate.weapon] = candidate.debug;
    }

    debug = {
      shooter: {
        x: shooter.x,
        y: shooter.y,
        health: shooter.health,
        facing: (shooter.facing < 0 ? -1 : 1) as -1 | 1,
      },
      target: {
        x: target.x,
        y: target.y,
        health: target.health,
        facing: (target.facing < 0 ? -1 : 1) as -1 | 1,
      },
      wind: session.wind,
      cinematic,
      settings: {
        personality: resolved.personality,
        precisionMode: resolved.precisionMode,
        precisionTopK: resolved.precisionTopK,
        noiseAngleRad: resolved.noiseAngleRad,
        noisePower: resolved.noisePower,
      },
      candidates: {
        count: candidatesForDebug.length,
        top,
        bestByWeapon,
      },
      chosen: shot?.chosen.debug ?? firedCandidate.debug,
      fired: firedCandidate.debug,
      movement: {
        enabled: resolved.movementEnabled,
        budgetMs: movement.budgetMs,
        usedMs: movement.usedMs,
        steps: movement.steps,
        outcome: shot ? "shot" : "panic-shot",
      },
    };
  }

  const plan: AiTurnPlan = {
    weapon: firedCandidate.weapon,
    angle: firedCandidate.angle,
    power: firedCandidate.power,
    delayMs,
    target,
    score: firedCandidate.score,
    cinematic,
    personality: resolved.personality,
  };
  if (debug) plan.debug = debug;
  if (moveSteps.length > 0) {
    plan.moves = moveSteps;
    plan.movedMs = movement.usedMs;
  }
  if (panicShot) {
    plan.panicShot = true;
    plan.panicStrategy = panicStrategy;
  }
  return plan;
};

export const playTurnWithGameAi = (
  session: GameSession,
  settings?: GameAiSettings
): AiTurnPlan | null => {
  const plan = planAiTurn(session, settings);
  if (!plan) return null;
  return executeAiTurnPlan(session, plan, settings);
};

export const executeAiTurnPlan = (
  session: GameSession,
  plan: AiTurnPlan,
  settings?: GameAiSettings
): AiTurnPlan => {
  const expectedTurn = session.getTurnIndex();
  const expectedWorm = session.activeWorm;
  const movementTotalMs = plan.movedMs ?? 0;
  const pauseStartAt = nowMs() + movementTotalMs;
  const executeAt = pauseStartAt + plan.delayMs;

  const stillValid = () =>
    session.getTurnIndex() === expectedTurn &&
    session.activeWorm === expectedWorm &&
    session.state.phase === "aim";

  if (plan.moves && plan.moves.length > 0) {
    let offsetMs = 0;
    for (const step of plan.moves) {
      const scheduledAt = offsetMs;
      setTimeout(() => {
        if (!stillValid()) return;
        session.debugMove(step.move, step.dtMs, step.jump);
      }, scheduledAt);
      offsetMs += step.dtMs;
    }
  }

  const beginPreShotVisuals = () => {
    if (!stillValid()) return;
    session.debugSetWeapon(plan.weapon);
    session.beginAiPreShotVisual({
      weapon: plan.weapon,
      targetAngle: plan.angle,
      power01: plan.power,
      durationMs: Math.max(0, executeAt - nowMs()),
    });
  };

  const visualDelay = Math.max(0, pauseStartAt - nowMs());
  setTimeout(beginPreShotVisuals, visualDelay);

  const fire = () => {
    if (!stillValid()) return;
    const shooter = session.activeWorm;
    const resolved = resolveSettings(shooter, settings);
    const target = plan.target.alive ? plan.target : selectTarget(session, resolved.personality);
    let shot = { weapon: plan.weapon, angle: plan.angle, power: plan.power };

    if (isLikelySelfHit(session, shooter, shot) && target) {
      const recovered = planShot({
        session,
        shooter,
        target,
        cinematic: plan.cinematic,
        settings: resolved,
      })?.fired;
      if (recovered) {
        shot = {
          weapon: recovered.weapon,
          angle: recovered.angle,
          power: recovered.power,
        };
      } else {
        const panic = planPanicShot({
          session,
          shooter,
          target,
          cinematic: plan.cinematic,
          settings: resolved,
          strategy: plan.panicStrategy ?? "default",
        });
        shot = {
          weapon: panic.candidate.weapon,
          angle: panic.candidate.angle,
          power: panic.candidate.power,
        };
      }
    }

    session.clearAiPreShotVisual();
    session.debugSetWeapon(shot.weapon);
    session.debugShoot(shot.angle, shot.power);
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
