import { GAMEPLAY, WeaponType, clamp, nowMs } from "../definitions";
import type { GameSession } from "../game/session";
import { computeAimAngleFromTarget } from "../game/weapon-system";
import { Worm } from "../entities";
import type { AiPersonality } from "./types";
import {
  buildAimFromAngle,
  buildCandidates,
  scoreCandidate,
  type AiShotDebug,
  type ShotCandidate,
} from "./shot-scoring";

export type ResolvedAiSettings = {
  personality: AiPersonality;
  minThinkTimeMs: number;
  cinematicChance: number;
  precisionMode: "perfect" | "noisy";
  precisionTopK: number;
  noiseAngleRad: number;
  noisePower: number;
  debugEnabled: boolean;
  debugTopN: number;
  movementEnabled: boolean;
};

const MOVE_STEP_MS = 260;
const MAX_MOVE_BUDGET_MS = 9000;
const PANIC_WINDOW_MS = 2500;
const PANIC_THINK_MS = 250;
const TURN_SAFETY_MS = 150;

export type AiMoveStep = {
  move: -1 | 1;
  dtMs: number;
  jump: boolean;
};

export type AiTurnDebug = {
  shooter: { x: number; y: number; health: number; facing: -1 | 1 };
  target: { x: number; y: number; health: number; facing: -1 | 1 };
  wind: number;
  cinematic: boolean;
  settings: {
    personality: AiPersonality;
    precisionMode: "perfect" | "noisy";
    precisionTopK: number;
    noiseAngleRad: number;
    noisePower: number;
  };
  candidates: {
    count: number;
    top: AiShotDebug[];
    bestByWeapon: Partial<Record<WeaponType, AiShotDebug>>;
  };
  chosen: AiShotDebug;
  fired: AiShotDebug;
  movement?: {
    enabled: boolean;
    budgetMs: number;
    usedMs: number;
    steps: Array<
      AiMoveStep & {
        from: { x: number; y: number };
        to: { x: number; y: number };
        stuck: boolean;
      }
    >;
    outcome: "shot" | "panic-shot" | "no-shot";
  };
};

export type MovementPlan = {
  steps: Array<
    AiMoveStep & {
      from: { x: number; y: number };
      to: { x: number; y: number };
      stuck: boolean;
    }
  >;
  usedMs: number;
  budgetMs: number;
  plannedShooter: Worm;
};

export type ShotPlan = {
  candidates: ShotCandidate[];
  chosen: ShotCandidate;
  fired: ShotCandidate;
};

export type PanicPlan = {
  candidate: ShotCandidate;
  delayMs: number;
};

const chooseCandidate = (candidates: ShotCandidate[], settings: ResolvedAiSettings): ShotCandidate | null => {
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
): { angle: number; power: number } => {
  const angleNoise = (Math.random() * 2 - 1) * settings.noiseAngleRad;
  const powerNoise = (Math.random() * 2 - 1) * settings.noisePower;
  const angle = candidate.angle + angleNoise;
  const power =
    candidate.weapon === WeaponType.Rifle || candidate.weapon === WeaponType.Uzi
      ? 1
      : clamp(candidate.power + powerNoise, 0, 1);
  return { angle, power };
};

export const planShot = (params: {
  session: GameSession;
  shooter: Worm;
  target: Worm;
  cinematic: boolean;
  settings: ResolvedAiSettings;
}): ShotPlan | null => {
  const { session, shooter, target, cinematic, settings } = params;
  const candidates = buildCandidates({
    session,
    shooter,
    target,
    personality: settings.personality,
    cinematic,
  });
  if (candidates.length === 0) return null;

  const bestScore = candidates.reduce((max, candidate) => Math.max(max, candidate.score), -Infinity);
  // Treat <= 0 as "no viable shot" to avoid deterministic ties causing silly "shoot at feet" behavior.
  if (!Number.isFinite(bestScore) || bestScore <= 0) return null;

  const chosen = chooseCandidate(candidates, settings);
  if (!chosen) return null;

  const fired =
    settings.precisionMode === "noisy"
      ? (() => {
          const noisy = applyPrecisionNoise(chosen, settings);
          const baseAngle = chosen.debug.baseAngle;
          const aim = buildAimFromAngle(shooter, noisy.angle);
          return scoreCandidate({
            session,
            shooter,
            target,
            weapon: chosen.weapon,
            aim,
            angle: noisy.angle,
            power: noisy.power,
            cinematic,
            personality: settings.personality,
            baseAngle,
            angleOffset: noisy.angle - baseAngle,
          });
        })()
      : chosen;

  return { candidates, chosen, fired };
};

const clampAngleToNotDown = (angle: number): number => {
  // In this coordinate system, positive sin(angle) means aiming down.
  if (Math.sin(angle) <= -0.05) return angle;
  const dir = Math.cos(angle) < 0 ? -1 : 1;
  return dir < 0 ? -Math.PI + 0.35 : -0.35;
};

export const planPanicShot = (params: {
  session: GameSession;
  shooter: Worm;
  target: Worm;
  cinematic: boolean;
  settings: ResolvedAiSettings;
}): PanicPlan => {
  const { session, shooter, target, cinematic, settings } = params;
  const weapon = WeaponType.Bazooka;
  const baseAngle = computeAimAngleFromTarget({
    weapon,
    worm: shooter,
    targetX: target.x,
    targetY: target.y,
  });
  const angle = clampAngleToNotDown(baseAngle);
  const power = 0.85;
  const aim = buildAimFromAngle(shooter, angle);
  const candidate = scoreCandidate({
    session,
    shooter,
    target,
    weapon,
    aim,
    angle,
    power,
    cinematic,
    personality: settings.personality,
    baseAngle,
    angleOffset: angle - baseAngle,
  });
  const delayMs = Math.min(settings.minThinkTimeMs, PANIC_THINK_MS);
  return { candidate, delayMs };
};

const simulateMove = (worm: Worm, session: GameSession, step: AiMoveStep): { stuck: boolean } => {
  const beforeX = worm.x;
  const beforeY = worm.y;

  // Mirror `Session.applyActiveWormMovement()` so our sim matches the real movement command.
  const maxStepMs = 8;
  let remainingMs = Math.max(0, Math.floor(step.dtMs));
  let first = true;
  while (remainingMs > 0) {
    const stepMs = Math.min(maxStepMs, remainingMs);
    worm.update(stepMs / 1000, session.terrain, step.move, step.jump && first);
    remainingMs -= stepMs;
    first = false;
  }

  const moved = Math.hypot(worm.x - beforeX, worm.y - beforeY);
  return { stuck: moved < 1.5 };
};

const cloneWormForSim = (worm: Worm): Worm => {
  const sim = new Worm(worm.x, worm.y, worm.team, worm.name);
  sim.vx = worm.vx;
  sim.vy = worm.vy;
  sim.radius = worm.radius;
  sim.health = worm.health;
  sim.alive = worm.alive;
  sim.facing = worm.facing;
  sim.onGround = worm.onGround;
  sim.age = worm.age;
  return sim;
};

export const planMovement = (params: {
  session: GameSession;
  shooter: Worm;
  target: Worm;
  cinematic: boolean;
  settings: ResolvedAiSettings;
  timeLeftMs: number;
}): MovementPlan => {
  const { session, shooter, target, cinematic, settings, timeLeftMs } = params;
  if (!settings.movementEnabled) {
    return { steps: [], usedMs: 0, budgetMs: 0, plannedShooter: shooter };
  }

  const budgetMs = clamp(
    Math.min(MAX_MOVE_BUDGET_MS, timeLeftMs - settings.minThinkTimeMs - TURN_SAFETY_MS),
    0,
    MAX_MOVE_BUDGET_MS
  );
  if (budgetMs <= 0 || timeLeftMs <= PANIC_WINDOW_MS) {
    return { steps: [], usedMs: 0, budgetMs, plannedShooter: shooter };
  }

  const plannedShooter = cloneWormForSim(shooter);
  const steps: MovementPlan["steps"] = [];
  let usedMs = 0;
  let stuckSteps = 0;

  const maxSteps = Math.min(24, Math.floor(budgetMs / Math.max(1, MOVE_STEP_MS)));
  const waterLine = session.height - 8;
  for (let i = 0; i < maxSteps; i++) {
    const shot = planShot({ session, shooter: plannedShooter, target, cinematic, settings });
    if (shot) break;

    const move = (target.x < plannedShooter.x ? -1 : 1) as -1 | 1;
    const jump = stuckSteps >= 2;
    const dtMs = Math.min(MOVE_STEP_MS, budgetMs - usedMs);
    if (dtMs <= 0) break;

    const from = { x: plannedShooter.x, y: plannedShooter.y };
    const res = simulateMove(plannedShooter, session, { move, dtMs, jump });
    const to = { x: plannedShooter.x, y: plannedShooter.y };
    steps.push({ move, dtMs, jump, from, to, stuck: res.stuck });
    usedMs += dtMs;

    stuckSteps = res.stuck ? stuckSteps + 1 : 0;

    // Don't happily march into water for a "no shot" situation.
    if (plannedShooter.y >= waterLine - 2) break;
  }

  return { steps, usedMs, budgetMs, plannedShooter };
};

export const timeLeftMsForTurn = (session: GameSession): number => {
  return session.state.timeLeftMs(nowMs(), GAMEPLAY.turnTimeMs);
};

