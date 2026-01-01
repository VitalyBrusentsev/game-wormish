import type { TeamId } from "../../definitions";
import type { TurnCommandAim } from "./turn-payload";

export type AimThrottleState = {
  turnIndex: number;
  teamId: TeamId;
  sentAtMs: number;
  wormX: number;
  wormY: number;
  aim: TurnCommandAim["aim"];
};

export type AimThrottleConfig = {
  minIntervalMs: number;
  maxIntervalMs: number;
  diffThreshold: number;
  angleThresholdRad: number;
};

const normalizeAngleRad = (angle: number): number => {
  let value = angle;
  while (value > Math.PI) value -= Math.PI * 2;
  while (value < -Math.PI) value += Math.PI * 2;
  return value;
};

const computeRelativeAimDelta = (prev: AimThrottleState, next: { wormX: number; wormY: number; aim: TurnCommandAim["aim"] }) => {
  const prevVecX = prev.aim.targetX - prev.wormX;
  const prevVecY = prev.aim.targetY - prev.wormY;
  const nextVecX = next.aim.targetX - next.wormX;
  const nextVecY = next.aim.targetY - next.wormY;
  const deltaX = nextVecX - prevVecX;
  const deltaY = nextVecY - prevVecY;
  const baseLen = Math.hypot(prevVecX, prevVecY);
  const deltaLen = Math.hypot(deltaX, deltaY);
  return baseLen > 1e-3 ? deltaLen / baseLen : deltaLen;
};

export function applyAimThrottle(params: {
  state: AimThrottleState | null;
  config: AimThrottleConfig;
  nowMs: number;
  turnIndex: number;
  teamId: TeamId;
  wormX: number;
  wormY: number;
  aim: TurnCommandAim["aim"];
}): { shouldSend: boolean; nextState: AimThrottleState | null } {
  const nextState: AimThrottleState = {
    turnIndex: params.turnIndex,
    teamId: params.teamId,
    sentAtMs: params.nowMs,
    wormX: params.wormX,
    wormY: params.wormY,
    aim: {
      angle: params.aim.angle,
      targetX: params.aim.targetX,
      targetY: params.aim.targetY,
    },
  };

  if (!params.state) {
    return { shouldSend: true, nextState };
  }

  if (params.state.turnIndex !== params.turnIndex || params.state.teamId !== params.teamId) {
    return { shouldSend: true, nextState };
  }

  const elapsedMs = params.nowMs - params.state.sentAtMs;
  if (elapsedMs < params.config.minIntervalMs) {
    return { shouldSend: false, nextState: params.state };
  }

  const angleDelta = Math.abs(normalizeAngleRad(params.aim.angle - params.state.aim.angle));
  const relativeDelta = computeRelativeAimDelta(params.state, {
    wormX: params.wormX,
    wormY: params.wormY,
    aim: params.aim,
  });

  const significant =
    angleDelta >= params.config.angleThresholdRad || relativeDelta >= params.config.diffThreshold;

  if (significant || elapsedMs >= params.config.maxIntervalMs) {
    return { shouldSend: true, nextState };
  }

  return { shouldSend: false, nextState: params.state };
}

