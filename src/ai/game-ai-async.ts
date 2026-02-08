import type { TeamId } from "../definitions";
import { GAMEPLAY, nowMs } from "../definitions";
import type { Worm } from "../entities";
import type { GameSession } from "../game/session";
import {
  executeAiTurnPlan,
  planAiTurn,
  type AiTurnPlan,
} from "./game-ai";
import { getWormPersonality } from "./personality-store";
import { aiPlannerWorkerClient } from "./planner-worker-client";
import type {
  AiPlannerSnapshot,
  AiPlannerTargetRef,
  AiPlannerTurnPlan,
} from "./planner-worker-types";
import type { GameAiSettings } from "./types";

const buildPlannerSnapshot = (session: GameSession): AiPlannerSnapshot => {
  const totalWidth = Math.floor(
    session.terrain.solid.length / Math.max(1, session.terrain.height)
  );
  return {
    phase: session.state.phase,
    width: session.width,
    height: session.height,
    wind: session.wind,
    timeLeftMs: session.state.timeLeftMs(nowMs(), GAMEPLAY.turnTimeMs),
    activeTeamId: session.activeTeam.id,
    activeWormIndex: session.activeWormIndex,
    terrain: {
      width: session.terrain.width,
      height: session.terrain.height,
      worldLeft: session.terrain.worldLeft,
      totalWidth,
      solid: new Uint8Array(session.terrain.solid),
      heightMap: [...session.terrain.heightMap],
    },
    teams: session.teams.map((team) => ({
      id: team.id,
      worms: team.worms.map((worm) => ({
        name: worm.name,
        team: worm.team,
        x: worm.x,
        y: worm.y,
        vx: worm.vx,
        vy: worm.vy,
        radius: worm.radius,
        health: worm.health,
        alive: worm.alive,
        facing: worm.facing,
        onGround: worm.onGround,
        age: worm.age,
        personality: getWormPersonality(worm),
      })),
    })),
  };
};

const resolveTargetRef = (session: GameSession, targetRef: AiPlannerTargetRef): Worm | null => {
  const team = session.teams.find((entry) => entry.id === targetRef.teamId);
  if (!team) return null;
  return team.worms[targetRef.wormIndex] ?? null;
};

const hydrateWorkerPlan = (
  session: GameSession,
  workerPlan: AiPlannerTurnPlan
): AiTurnPlan | null => {
  const target = resolveTargetRef(session, workerPlan.targetRef);
  if (!target) return null;

  const plan: AiTurnPlan = {
    weapon: workerPlan.weapon,
    angle: workerPlan.angle,
    power: workerPlan.power,
    delayMs: workerPlan.delayMs,
    target,
    score: workerPlan.score,
    cinematic: workerPlan.cinematic,
    personality: workerPlan.personality,
  };
  if (workerPlan.debug) plan.debug = workerPlan.debug;
  if (workerPlan.moves) plan.moves = workerPlan.moves;
  if (workerPlan.movedMs !== undefined) plan.movedMs = workerPlan.movedMs;
  if (workerPlan.panicShot) plan.panicShot = true;
  if (workerPlan.panicStrategy) plan.panicStrategy = workerPlan.panicStrategy;
  return plan;
};

const isStillSameTurn = (
  session: GameSession,
  expectedTurn: number,
  expectedTeamId: TeamId,
  expectedWorm: Worm
) =>
  session.getTurnIndex() === expectedTurn &&
  session.activeTeam.id === expectedTeamId &&
  session.activeWorm === expectedWorm &&
  session.state.phase === "aim";

export const playTurnWithGameAiAsync = async (
  session: GameSession,
  settings?: GameAiSettings
): Promise<AiTurnPlan | null> => {
  if (session.state.phase !== "aim") return null;

  const expectedTurn = session.getTurnIndex();
  const expectedTeamId = session.activeTeam.id;
  const expectedWorm = session.activeWorm;

  let plan: AiTurnPlan | null = null;
  let workerFailed = false;
  if (aiPlannerWorkerClient.isAvailable()) {
    try {
      const snapshot = buildPlannerSnapshot(session);
      const workerPlan = await aiPlannerWorkerClient.planTurn(snapshot, settings);
      if (workerPlan) {
        plan = hydrateWorkerPlan(session, workerPlan);
        if (!plan) workerFailed = true;
      } else {
        return null;
      }
    } catch {
      workerFailed = true;
    }
  }

  if (workerFailed || !aiPlannerWorkerClient.isAvailable()) {
    if (!isStillSameTurn(session, expectedTurn, expectedTeamId, expectedWorm)) return null;
    plan = planAiTurn(session, settings);
  }

  if (!plan) return null;
  if (!isStillSameTurn(session, expectedTurn, expectedTeamId, expectedWorm)) return null;
  return executeAiTurnPlan(session, plan, settings);
};

export const playTurnWithGameAiForTeamAsync = async (
  session: GameSession,
  teamId: TeamId,
  settings?: GameAiSettings
): Promise<AiTurnPlan | null> => {
  if (session.activeTeam.id !== teamId) return null;
  return playTurnWithGameAiAsync(session, settings);
};
