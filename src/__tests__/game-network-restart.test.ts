import { describe, expect, it, vi } from "vitest";
import { Game } from "../game";
import { ConnectionState } from "../webrtc/types";

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

describe("Game network restart behavior", () => {
  it("awaits host teardown before restarting mission", async () => {
    const order: string[] = [];
    const game = Object.create(Game.prototype) as any;
    game.restartMissionTask = null;
    game.networkState = { getSnapshot: vi.fn(() => ({ mode: "network-host" })) };
    game.teardownNetworkSession = vi.fn(async (awaitClose: boolean) => {
      expect(awaitClose).toBe(true);
      order.push("teardown:start");
      await Promise.resolve();
      order.push("teardown:end");
    });
    game.restartSinglePlayerMatch = vi.fn(() => {
      order.push("restart");
    });

    await callRestartFromPauseMenu(game);

    expect(game.teardownNetworkSession).toHaveBeenCalledTimes(1);
    expect(game.restartSinglePlayerMatch).toHaveBeenCalledTimes(1);
    expect(order).toEqual(["teardown:start", "teardown:end", "restart"]);
  });

  it("awaits guest teardown before restarting mission", async () => {
    const order: string[] = [];
    const game = Object.create(Game.prototype) as any;
    game.restartMissionTask = null;
    game.networkState = { getSnapshot: vi.fn(() => ({ mode: "network-guest" })) };
    game.teardownNetworkSession = vi.fn(async () => {
      order.push("teardown");
    });
    game.restartSinglePlayerMatch = vi.fn(() => {
      order.push("restart");
    });

    await callRestartFromPauseMenu(game);

    expect(game.teardownNetworkSession).toHaveBeenCalledTimes(1);
    expect(game.restartSinglePlayerMatch).toHaveBeenCalledTimes(1);
    expect(order).toEqual(["teardown", "restart"]);
  });

  it("skips network teardown in local mode restart", async () => {
    const game = Object.create(Game.prototype) as any;
    game.restartMissionTask = null;
    game.networkState = { getSnapshot: vi.fn(() => ({ mode: "local" })) };
    game.teardownNetworkSession = vi.fn();
    game.restartSinglePlayerMatch = vi.fn();

    await callRestartFromPauseMenu(game);

    expect(game.teardownNetworkSession).not.toHaveBeenCalled();
    expect(game.restartSinglePlayerMatch).toHaveBeenCalledTimes(1);
  });

  it("ignores stale callbacks from a torn-down client", async () => {
    const closeDeferred = createDeferred<void>();
    const staleClient = createMockClient(closeDeferred.promise);

    const networkState = {
      getSnapshot: vi.fn(() => ({
        mode: "network-host",
        connection: { lifecycle: ConnectionState.CONNECTING },
      })),
      updateConnectionLifecycle: vi.fn(),
      appendNetworkMessageLog: vi.fn(),
      reportConnectionError: vi.fn(),
      setWaitingForSnapshot: vi.fn(),
      enqueueResolution: vi.fn(),
      setMode: vi.fn(),
      resetNetworkOnlyState: vi.fn(),
    };

    const game = Object.create(Game.prototype) as any;
    game.webrtcClient = staleClient;
    game.networkClientGeneration = 7;
    game.connectionStartRequested = true;
    game.hasReceivedMatchInit = false;
    game.networkState = networkState;
    game.readSinglePlayerNameFromStorage = vi.fn(() => "Player");
    game.initializeTurnControllers = vi.fn();
    game.notifyNetworkStateChange = vi.fn();
    game.swapToNetworkControllers = vi.fn();
    game.sendPlayerHello = vi.fn();
    game.startNetworkMatchAsHost = vi.fn();
    game.sendMatchInit = vi.fn();
    game.handleMatchInit = vi.fn();
    game.handlePlayerHello = vi.fn();
    game.handleRestartRequest = vi.fn();
    game.deliverCommandToController = vi.fn();
    game.deliverEffectsToSession = vi.fn();
    game.deliverResolutionToController = vi.fn();

    (Game.prototype as any).setupWebRTCCallbacks.call(game, staleClient, 7);

    const teardownPromise = (Game.prototype as any).teardownNetworkSession.call(game, true) as Promise<void>;

    expect(game.webrtcClient).toBeNull();
    expect(game.networkClientGeneration).toBe(8);
    expect(networkState.setMode).toHaveBeenCalledWith("local");

    staleClient.emitState(ConnectionState.CONNECTED);
    staleClient.emitMessage({ type: "player_hello", payload: { name: "Late peer" } });
    staleClient.emitError(new Error("late error"));

    expect(networkState.updateConnectionLifecycle).not.toHaveBeenCalled();
    expect(networkState.appendNetworkMessageLog).not.toHaveBeenCalled();
    expect(networkState.reportConnectionError).not.toHaveBeenCalled();

    closeDeferred.resolve(undefined);
    await teardownPromise;
  });

  it("falls back to timeout when client teardown hangs", async () => {
    vi.useFakeTimers();
    try {
      const neverClose = new Promise<void>(() => { });
      const closeRoom = vi.fn(() => neverClose);
      const client = { closeRoom } as unknown as {
        closeRoom: () => Promise<void>;
      };

      const networkState = {
        setMode: vi.fn(),
        resetNetworkOnlyState: vi.fn(),
      };

      const game = Object.create(Game.prototype) as any;
      game.webrtcClient = client;
      game.networkClientGeneration = 21;
      game.connectionStartRequested = true;
      game.hasReceivedMatchInit = true;
      game.networkState = networkState;
      game.readSinglePlayerNameFromStorage = vi.fn(() => "Player");
      game.initializeTurnControllers = vi.fn();
      game.notifyNetworkStateChange = vi.fn();

      const teardownPromise = (Game.prototype as any).teardownNetworkSession.call(game, true) as Promise<void>;
      await vi.advanceTimersByTimeAsync(3100);
      await teardownPromise;

      expect(closeRoom).toHaveBeenCalledTimes(1);
      expect(game.webrtcClient).toBeNull();
      expect(game.networkClientGeneration).toBe(22);
      expect(networkState.setMode).toHaveBeenCalledWith("local");
      expect(networkState.resetNetworkOnlyState).toHaveBeenCalledTimes(1);
      expect(game.initializeTurnControllers).toHaveBeenCalledTimes(1);
      expect(game.notifyNetworkStateChange).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
