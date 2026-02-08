import type { GameSession } from "../game/session";
import type { Team } from "../game/team-manager";
import { Worm } from "../entities";
import { planAiTurn, type AiTurnPlan } from "./game-ai";
import { setWormPersonality } from "./personality-store";
import { PlannerTerrain } from "./planner-worker-terrain";
import type {
  AiPlannerRequest,
  AiPlannerResponse,
  AiPlannerSnapshot,
  AiPlannerTargetRef,
  AiPlannerTurnPlan,
} from "./planner-worker-types";

type SimState = {
  phase: AiPlannerSnapshot["phase"];
  timeLeftMs: (_nowMs: number, _turnLimitMs: number) => number;
};

const cloneWorm = (worm: AiPlannerSnapshot["teams"][number]["worms"][number]): Worm => {
  const copy = new Worm(worm.x, worm.y, worm.team, worm.name);
  copy.vx = worm.vx;
  copy.vy = worm.vy;
  copy.radius = worm.radius;
  copy.health = worm.health;
  copy.alive = worm.alive;
  copy.facing = worm.facing;
  copy.onGround = worm.onGround;
  copy.age = worm.age;
  setWormPersonality(copy, worm.personality);
  return copy;
};

const buildSimSession = (snapshot: AiPlannerSnapshot): GameSession | null => {
  const terrain = new PlannerTerrain(snapshot.terrain);
  const teams: Team[] = snapshot.teams.map((team) => ({
    id: team.id,
    worms: team.worms.map(cloneWorm),
  }));
  const activeTeam = teams.find((team) => team.id === snapshot.activeTeamId);
  if (!activeTeam) return null;
  const activeWorm = activeTeam.worms[snapshot.activeWormIndex];
  if (!activeWorm) return null;

  const state: SimState = {
    phase: snapshot.phase,
    timeLeftMs: () => snapshot.timeLeftMs,
  };

  return {
    width: snapshot.width,
    height: snapshot.height,
    wind: snapshot.wind,
    terrain: terrain as unknown as GameSession["terrain"],
    teams,
    activeTeam,
    activeWorm,
    state: state as unknown as GameSession["state"],
  } as GameSession;
};

const findTargetRef = (teams: Team[], target: Worm): AiPlannerTargetRef | null => {
  for (const team of teams) {
    const wormIndex = team.worms.findIndex((worm) => worm === target);
    if (wormIndex >= 0) {
      return {
        teamId: team.id,
        wormIndex,
      };
    }
  }
  return null;
};

const toWorkerPlan = (simSession: GameSession, plan: AiTurnPlan): AiPlannerTurnPlan | null => {
  const targetRef = findTargetRef(simSession.teams, plan.target);
  if (!targetRef) return null;

  const workerPlan: AiPlannerTurnPlan = {
    weapon: plan.weapon,
    angle: plan.angle,
    power: plan.power,
    delayMs: plan.delayMs,
    targetRef,
    score: plan.score,
    cinematic: plan.cinematic,
    personality: plan.personality,
  };

  if (plan.debug) workerPlan.debug = plan.debug;
  if (plan.moves && plan.moves.length > 0) {
    workerPlan.moves = plan.moves.map((step) => ({
      move: step.move,
      dtMs: step.dtMs,
      jump: step.jump,
    }));
    workerPlan.movedMs = plan.movedMs ?? plan.moves.reduce((sum, step) => sum + step.dtMs, 0);
  }
  if (plan.panicShot) workerPlan.panicShot = true;
  if (plan.panicStrategy) workerPlan.panicStrategy = plan.panicStrategy;

  return workerPlan;
};

const postResponse = (response: AiPlannerResponse) => {
  (globalThis as unknown as { postMessage: (message: AiPlannerResponse) => void }).postMessage(
    response
  );
};

const handlePlanTurn = (request: Extract<AiPlannerRequest, { kind: "plan-turn" }>) => {
  const simSession = buildSimSession(request.snapshot);
  if (!simSession) {
    postResponse({
      kind: "plan-turn-error",
      requestId: request.requestId,
      message: "Unable to build AI simulation session",
    });
    return;
  }

  const plan = planAiTurn(simSession, request.settings);
  const workerPlan = plan ? toWorkerPlan(simSession, plan) : null;
  postResponse({
    kind: "plan-turn-result",
    requestId: request.requestId,
    plan: workerPlan,
  });
};

globalThis.addEventListener("message", (event: MessageEvent<AiPlannerRequest>) => {
  const message = event.data;
  if (!message || message.kind !== "plan-turn") return;
  try {
    handlePlanTurn(message);
  } catch (error) {
    postResponse({
      kind: "plan-turn-error",
      requestId: message.requestId,
      message: error instanceof Error ? error.message : "Unknown AI planner worker error",
    });
  }
});
