import { describe, expect, it, vi } from "vitest";
import { Game } from "../game";
import { ConnectionState } from "../webrtc/types";
import {
  NetworkOrchestrator,
  type NetworkOrchestratorHost,
} from "../network/network-orchestrator";

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
};

type MockClient = {
  onStateChange: (callback: (state: ConnectionState) => void) => void;
  onMessage: (callback: (message: unknown) => void) => void;
  onError: (callback: (error: Error) => void) => void;
  onDebugEvent: (callback: (event: unknown) => void) => void;
  closeRoom: () => Promise<void>;
  emitState: (state: ConnectionState) => void;
  emitMessage: (message: unknown) => void;
  emitError: (error: Error) => void;
};

const createDeferred = <T>(): Deferred<T> => {
  let resolve: ((value: T | PromiseLike<T>) => void) | null = null;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  if (!resolve) {
    throw new Error("Failed to create deferred promise resolver");
  }
  return { promise, resolve };
};

const callRestartFromPauseMenu = async (game: unknown): Promise<void> => {
  await (Game.prototype as any).restartMissionFromPauseMenu.call(game);
};

const createMockClient = (closePromise: Promise<void>): MockClient => {
  const handlers: {
    stateChange?: (state: ConnectionState) => void;
    message?: (message: unknown) => void;
    error?: (error: Error) => void;
    debug?: (event: unknown) => void;
  } = {};

  return {
    onStateChange: (callback) => {
      handlers.stateChange = callback;
    },
    onMessage: (callback) => {
      handlers.message = callback;
    },
    onError: (callback) => {
      handlers.error = callback;
    },
    onDebugEvent: (callback) => {
      handlers.debug = callback;
    },
    closeRoom: () => closePromise,
    emitState: (state) => {
      handlers.stateChange?.(state);
    },
    emitMessage: (message) => {
      handlers.message?.(message);
    },
    emitError: (error) => {
      handlers.error?.(error);
    },
  };
};

function createOrchestrator(opts: { mode: "network-host" | "network-guest"; lifecycle?: ConnectionState }) {
  const host: NetworkOrchestratorHost & {
    startMatchAsHost: ReturnType<typeof vi.fn>;
    applyMatchInitSnapshot: ReturnType<typeof vi.fn>;
    restoreLocalSetup: ReturnType<typeof vi.fn>;
    setTurnControllersOnSession: ReturnType<typeof vi.fn>;
  } = {
    getSession: () => ({
      getTurnIndex: () => 0,
      activeTeam: { id: "Red" },
      activeWorm: { x: 0, y: 0 },
      consumeTurnResolution: () => null,
      applyRemoteTurnEffects: vi.fn(),
      setTurnControllers: vi.fn(),
      toMatchInitSnapshot: vi.fn(() => ({})),
    }) as any,
    getTurnControllers: () => new Map(),
    setTurnControllersOnSession: vi.fn(),
    startMatchAsHost: vi.fn(),
    applyMatchInitSnapshot: vi.fn(),
    restoreLocalSetup: vi.fn(),
  };
  let lifecycle = opts.lifecycle ?? ConnectionState.DISCONNECTED;
  const state = {
    setMode: vi.fn(),
    setPlayerNames: vi.fn(),
    setRemoteName: vi.fn(),
    assignTeams: vi.fn(),
    updateRegistryInfo: vi.fn(),
    updateConnectionLifecycle: vi.fn((next: ConnectionState) => { lifecycle = next; }),
    reportConnectionError: vi.fn(),
    setWaitingForSnapshot: vi.fn(),
    storePendingSnapshot: vi.fn(),
    enqueueResolution: vi.fn(),
    dequeueResolution: vi.fn(),
    resetNetworkOnlyState: vi.fn(),
    appendNetworkMessageLog: vi.fn(),
    getSnapshot: vi.fn(() => ({ mode: opts.mode, connection: { lifecycle }, player: { localName: "P", remoteName: null } })),
  };
  const orch = new NetworkOrchestrator(host, { state: state as any });
  return { orch, host, state };
}

describe("Game.restartMissionFromPauseMenu network teardown sequencing", () => {
  it("awaits host teardown before restarting mission", async () => {
    const order: string[] = [];
    const game = Object.create(Game.prototype) as any;
    game.restartMissionTask = null;
    game.network = {
      state: { getSnapshot: vi.fn(() => ({ mode: "network-host" })) },
      getSnapshot: vi.fn(() => ({ mode: "network-host" })),
      teardownSession: vi.fn(async (awaitClose: boolean) => {
        expect(awaitClose).toBe(true);
        order.push("teardown:start");
        await Promise.resolve();
        order.push("teardown:end");
      }),
    };
    game.restartSinglePlayerMatch = vi.fn(() => {
      order.push("restart");
    });

    await callRestartFromPauseMenu(game);

    expect(game.network.teardownSession).toHaveBeenCalledTimes(1);
    expect(game.restartSinglePlayerMatch).toHaveBeenCalledTimes(1);
    expect(order).toEqual(["teardown:start", "teardown:end", "restart"]);
  });

  it("awaits guest teardown before restarting mission", async () => {
    const order: string[] = [];
    const game = Object.create(Game.prototype) as any;
    game.restartMissionTask = null;
    game.network = {
      state: { getSnapshot: vi.fn(() => ({ mode: "network-guest" })) },
      getSnapshot: vi.fn(() => ({ mode: "network-guest" })),
      teardownSession: vi.fn(async () => {
        order.push("teardown");
      }),
    };
    game.restartSinglePlayerMatch = vi.fn(() => {
      order.push("restart");
    });

    await callRestartFromPauseMenu(game);

    expect(game.network.teardownSession).toHaveBeenCalledTimes(1);
    expect(game.restartSinglePlayerMatch).toHaveBeenCalledTimes(1);
    expect(order).toEqual(["teardown", "restart"]);
  });

  it("skips network teardown in local mode restart", async () => {
    const game = Object.create(Game.prototype) as any;
    game.restartMissionTask = null;
    game.network = {
      state: { getSnapshot: vi.fn(() => ({ mode: "local" })) },
      getSnapshot: vi.fn(() => ({ mode: "local" })),
      teardownSession: vi.fn(),
    };
    game.restartSinglePlayerMatch = vi.fn();

    await callRestartFromPauseMenu(game);

    expect(game.network.teardownSession).not.toHaveBeenCalled();
    expect(game.restartSinglePlayerMatch).toHaveBeenCalledTimes(1);
  });
});

describe("NetworkOrchestrator setupWebRTCCallbacks stale-client safety", () => {
  it("ignores stale callbacks from a torn-down client", async () => {
    const closeDeferred = createDeferred<void>();
    const staleClient = createMockClient(closeDeferred.promise);

    const { orch, state } = createOrchestrator({ mode: "network-host", lifecycle: ConnectionState.CONNECTING });
    (orch as any).webrtcClient = staleClient;
    (orch as any).clientGeneration = 7;
    (orch as any).connectionStartRequested = true;
    (orch as any).hasReceivedMatchInit = false;

    orch.setupWebRTCCallbacks(staleClient as any, 7);

    const teardownPromise = orch.teardownSession(true);

    expect((orch as any).webrtcClient).toBeNull();
    expect((orch as any).clientGeneration).toBe(8);
    expect(state.setMode).toHaveBeenCalledWith("local");

    state.updateConnectionLifecycle.mockClear();
    state.appendNetworkMessageLog.mockClear();
    state.reportConnectionError.mockClear();

    staleClient.emitState(ConnectionState.CONNECTED);
    staleClient.emitMessage({ type: "player_hello", payload: { name: "Late peer" } });
    staleClient.emitError(new Error("late error"));

    expect(state.updateConnectionLifecycle).not.toHaveBeenCalled();
    expect(state.appendNetworkMessageLog).not.toHaveBeenCalled();
    expect(state.reportConnectionError).not.toHaveBeenCalled();

    closeDeferred.resolve(undefined);
    await teardownPromise;
  });
});

describe("NetworkOrchestrator teardown timeout", () => {
  it("falls back to timeout when client teardown hangs", async () => {
    vi.useFakeTimers();
    try {
      const neverClose = new Promise<void>(() => { });
      const closeRoom = vi.fn(() => neverClose);
      const client = { closeRoom } as unknown as { closeRoom: () => Promise<void> };

      const { orch, state, host } = createOrchestrator({ mode: "network-host" });
      (orch as any).webrtcClient = client;
      (orch as any).clientGeneration = 21;
      (orch as any).connectionStartRequested = true;
      (orch as any).hasReceivedMatchInit = true;

      const teardownPromise = orch.teardownSession(true);
      await vi.advanceTimersByTimeAsync(3100);
      await teardownPromise;

      expect(closeRoom).toHaveBeenCalledTimes(1);
      expect((orch as any).webrtcClient).toBeNull();
      expect((orch as any).clientGeneration).toBe(22);
      expect(state.setMode).toHaveBeenCalledWith("local");
      expect(state.resetNetworkOnlyState).toHaveBeenCalledTimes(1);
      expect(host.restoreLocalSetup).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
