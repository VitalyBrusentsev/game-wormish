import type { TeamId, WeaponType } from "../definitions";
import type { Phase } from "../game-state";
import type { AiPersonality, GameAiSettings } from "./types";
import type { AiMoveStep, AiTurnDebug, PanicShotStrategy } from "./turn-planning";

export type AiPlannerWormSnapshot = {
  name: string;
  team: TeamId;
  x: number;
  y: number;
  vx: number;
  vy: number;
  radius: number;
  health: number;
  alive: boolean;
  facing: number;
  onGround: boolean;
  age: number;
  personality: AiPersonality | null;
};

export type AiPlannerTeamSnapshot = {
  id: TeamId;
  worms: AiPlannerWormSnapshot[];
};

export type AiPlannerTerrainSnapshot = {
  width: number;
  height: number;
  worldLeft: number;
  totalWidth: number;
  solid: Uint8Array;
  heightMap: number[];
};

export type AiPlannerSnapshot = {
  phase: Phase;
  width: number;
  height: number;
  wind: number;
  timeLeftMs: number;
  activeTeamId: TeamId;
  activeWormIndex: number;
  terrain: AiPlannerTerrainSnapshot;
  teams: AiPlannerTeamSnapshot[];
};

export type AiPlannerTargetRef = {
  teamId: TeamId;
  wormIndex: number;
};

export type AiPlannerTurnPlan = {
  weapon: WeaponType;
  angle: number;
  power: number;
  delayMs: number;
  targetRef: AiPlannerTargetRef;
  score: number;
  cinematic: boolean;
  personality: AiTurnDebug["settings"]["personality"];
  debug?: AiTurnDebug;
  moves?: AiMoveStep[];
  movedMs?: number;
  panicShot?: boolean;
  panicStrategy?: PanicShotStrategy;
};

export type AiPlannerRequest =
  | {
      kind: "plan-turn";
      requestId: number;
      snapshot: AiPlannerSnapshot;
      settings?: GameAiSettings;
    };

export type AiPlannerResponse =
  | {
      kind: "plan-turn-result";
      requestId: number;
      plan: AiPlannerTurnPlan | null;
    }
  | {
      kind: "plan-turn-error";
      requestId: number;
      message: string;
    };
