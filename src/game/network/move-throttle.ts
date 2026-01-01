import type { TeamId } from "../../definitions";
import type { TurnCommandMovement } from "./turn-payload";

export type MoveThrottleState = {
  turnIndex: number;
  teamId: TeamId;
  move: -1 | 0 | 1;
  lastSentAtMs: number;
  pendingDtMs: number;
  pendingAtMs: number;
};

export type MoveThrottleConfig = {
  minIntervalMs: number;
  suppressIdle: boolean;
};

const cloneMovement = (movement: TurnCommandMovement): TurnCommandMovement => ({
  type: "move",
  move: movement.move,
  jump: movement.jump,
  dtMs: movement.dtMs,
  atMs: movement.atMs,
});

export function flushMoveThrottle(params: {
  state: MoveThrottleState | null;
  nowMs: number;
}): { toSend: TurnCommandMovement[]; nextState: MoveThrottleState | null } {
  const { state } = params;
  if (!state) return { toSend: [], nextState: null };
  if (state.pendingDtMs <= 0) return { toSend: [], nextState: state };
  if (state.move === 0) {
    return {
      toSend: [],
      nextState: {
        ...state,
        pendingDtMs: 0,
      },
    };
  }
  const aggregated: TurnCommandMovement = {
    type: "move",
    move: state.move,
    jump: false,
    dtMs: state.pendingDtMs,
    atMs: state.pendingAtMs,
  };
  return {
    toSend: [aggregated],
    nextState: {
      ...state,
      lastSentAtMs: params.nowMs,
      pendingDtMs: 0,
    },
  };
}

export function applyMoveThrottle(params: {
  state: MoveThrottleState | null;
  config: MoveThrottleConfig;
  nowMs: number;
  turnIndex: number;
  teamId: TeamId;
  movement: TurnCommandMovement;
}): { toSend: TurnCommandMovement[]; nextState: MoveThrottleState | null } {
  const movement = cloneMovement(params.movement);

  const baseState: MoveThrottleState = {
    turnIndex: params.turnIndex,
    teamId: params.teamId,
    move: movement.move,
    lastSentAtMs: params.nowMs,
    pendingDtMs: 0,
    pendingAtMs: movement.atMs,
  };

  if (!params.state) {
    if (params.config.suppressIdle && movement.move === 0 && !movement.jump) {
      return {
        toSend: [],
        nextState: {
          ...baseState,
          lastSentAtMs: params.nowMs,
        },
      };
    }
    return { toSend: [movement], nextState: baseState };
  }

  if (params.state.turnIndex !== params.turnIndex || params.state.teamId !== params.teamId) {
    if (params.config.suppressIdle && movement.move === 0 && !movement.jump) {
      return { toSend: [], nextState: baseState };
    }
    return { toSend: [movement], nextState: baseState };
  }

  if (movement.jump || movement.move !== params.state.move) {
    const flush = flushMoveThrottle({ state: params.state, nowMs: params.nowMs });
    return {
      toSend: [...flush.toSend, movement],
      nextState: {
        ...baseState,
        lastSentAtMs: params.nowMs,
      },
    };
  }

  if (params.config.suppressIdle && movement.move === 0 && !movement.jump) {
    return {
      toSend: [],
      nextState: {
        ...params.state,
        pendingDtMs: 0,
      },
    };
  }

  const pendingDtMs = params.state.pendingDtMs + Math.max(0, movement.dtMs);
  const elapsedMs = params.nowMs - params.state.lastSentAtMs;
  if (elapsedMs < params.config.minIntervalMs) {
    return {
      toSend: [],
      nextState: {
        ...params.state,
        pendingDtMs,
        pendingAtMs: movement.atMs,
      },
    };
  }

  const aggregated: TurnCommandMovement = {
    type: "move",
    move: params.state.move,
    jump: false,
    dtMs: pendingDtMs,
    atMs: movement.atMs,
  };

  return {
    toSend: [aggregated],
    nextState: {
      ...params.state,
      lastSentAtMs: params.nowMs,
      pendingDtMs: 0,
      pendingAtMs: movement.atMs,
    },
  };
}

