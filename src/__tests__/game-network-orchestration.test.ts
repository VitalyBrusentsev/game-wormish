import { describe, expect, it, vi } from "vitest";
import { ConnectionState } from "../webrtc/types";
import { LocalTurnController, RemoteTurnController } from "../game/turn-driver";
import {
  NetworkOrchestrator,
  type NetworkOrchestratorHost,
} from "../network/network-orchestrator";

// Characterization tests for NetworkOrchestrator. They were originally written
// against the methods that lived on `Game`; after extraction the same scenarios
// now exercise the orchestrator directly through its host interface.

type StubState = ReturnType<typeof createStateStub>;

function createStateStub(initial: { mode: "local" | "network-host" | "network-guest"; lifecycle?: ConnectionState; localName?: string }) {
  let mode = initial.mode;
  let lifecycle = initial.lifecycle ?? ConnectionState.DISCONNECTED;
  const localName = initial.localName ?? "Local";
  const log: { direction: string; message: any }[] = [];
  const resolutions: any[] = [];
  return {
    log,
    resolutions,
    setMode: vi.fn((next: typeof mode) => { mode = next; }),
    setPlayerNames: vi.fn(),
    setRemoteName: vi.fn(),
    assignTeams: vi.fn(),
    updateRegistryInfo: vi.fn(),
    updateConnectionLifecycle: vi.fn((next: ConnectionState) => { lifecycle = next; }),
    reportConnectionError: vi.fn(),
    setWaitingForSnapshot: vi.fn(),
    storePendingSnapshot: vi.fn(),
    enqueueResolution: vi.fn((r: any) => { resolutions.push(r); }),
    dequeueResolution: vi.fn(() => resolutions.shift()),
    resetNetworkOnlyState: vi.fn(),
    appendNetworkMessageLog: vi.fn((entry: any) => { log.push(entry); }),
    getSnapshot: vi.fn(() => ({
      mode,
      connection: { lifecycle },
      player: { localName, remoteName: null },
    })),
    _setMode(next: typeof mode) { mode = next; },
    _setLifecycle(next: ConnectionState) { lifecycle = next; },
  };
}

type HostStub = NetworkOrchestratorHost & {
  startMatchAsHost: ReturnType<typeof vi.fn>;
  applyMatchInitSnapshot: ReturnType<typeof vi.fn>;
  restoreLocalSetup: ReturnType<typeof vi.fn>;
  setTurnControllersOnSession: ReturnType<typeof vi.fn>;
  _session: any;
  _controllers: Map<any, any>;
};

function createHostStub(overrides: Partial<{ session: any; controllers: Map<any, any> }> = {}): HostStub {
  const controllers = overrides.controllers ?? new Map();
  let session = overrides.session ?? {
    getTurnIndex: () => 0,
    activeTeam: { id: "Red" },
    activeWorm: { x: 0, y: 0 },
    consumeTurnResolution: () => null,
    applyRemoteTurnEffects: vi.fn(),
    setTurnControllers: vi.fn(),
    toMatchInitSnapshot: vi.fn(() => ({ width: 1, height: 1 })),
  };
  return {
    getSession: () => session,
    getTurnControllers: () => controllers,
    setTurnControllersOnSession: vi.fn(),
    startMatchAsHost: vi.fn(),
    applyMatchInitSnapshot: vi.fn(),
    restoreLocalSetup: vi.fn(),
    _session: session,
    _controllers: controllers,
  } as HostStub;
}

function makeOrchestrator(state: StubState, host: HostStub): NetworkOrchestrator {
  const orch = new NetworkOrchestrator(host, { state: state as any });
  return orch;
}

describe("NetworkOrchestrator.sendNetworkMessage", () => {
  it("appends to log and forwards to webrtc client", () => {
    const state = createStateStub({ mode: "network-host", lifecycle: ConnectionState.CONNECTED });
    const host = createHostStub();
    const orch = makeOrchestrator(state, host);
    const sendMessage = vi.fn();
    (orch as any).webrtcClient = { sendMessage };

    const message = { type: "player_hello", payload: { name: "x", role: "host" } } as any;
    orch.sendNetworkMessage(message);

    expect(state.appendNetworkMessageLog).toHaveBeenCalledWith({ direction: "send", message });
    expect(sendMessage).toHaveBeenCalledWith(message);
  });

  it("is a no-op when no client is connected", () => {
    const state = createStateStub({ mode: "local" });
    const host = createHostStub();
    const orch = makeOrchestrator(state, host);
    orch.sendNetworkMessage({ type: "player_hello", payload: { name: "x", role: "host" } } as any);
    expect(state.appendNetworkMessageLog).not.toHaveBeenCalled();
  });
});

describe("NetworkOrchestrator.canSendNetworkTurnMessage", () => {
  it("requires both a client and an active connection", () => {
    const cases: Array<{ client: any; mode: "local" | "network-host" | "network-guest"; lifecycle: ConnectionState; expected: boolean }> = [
      { client: null, mode: "network-host", lifecycle: ConnectionState.CONNECTED, expected: false },
      { client: {}, mode: "local", lifecycle: ConnectionState.CONNECTED, expected: false },
      { client: {}, mode: "network-host", lifecycle: ConnectionState.CONNECTING, expected: false },
      { client: {}, mode: "network-host", lifecycle: ConnectionState.CONNECTED, expected: true },
      { client: {}, mode: "network-guest", lifecycle: ConnectionState.CONNECTED, expected: true },
    ];
    for (const c of cases) {
      const state = createStateStub({ mode: c.mode, lifecycle: c.lifecycle });
      const host = createHostStub();
      const orch = makeOrchestrator(state, host);
      (orch as any).webrtcClient = c.client;
      expect(orch.canSendNetworkTurnMessage()).toBe(c.expected);
    }
  });
});

describe("NetworkOrchestrator.swapToNetworkControllers", () => {
  it("assigns Red local / Blue remote when host", () => {
    const state = createStateStub({ mode: "network-host", lifecycle: ConnectionState.CONNECTED });
    const host = createHostStub();
    const orch = makeOrchestrator(state, host);

    orch.swapToNetworkControllers();

    expect(state.assignTeams).toHaveBeenCalledWith("Red", "Blue");
    expect(host._controllers.get("Red")).toBeInstanceOf(LocalTurnController);
    expect(host._controllers.get("Blue")).toBeInstanceOf(RemoteTurnController);
    expect(host.setTurnControllersOnSession).toHaveBeenCalled();
  });

  it("assigns Blue local / Red remote when guest", () => {
    const state = createStateStub({ mode: "network-guest", lifecycle: ConnectionState.CONNECTED });
    const host = createHostStub();
    const orch = makeOrchestrator(state, host);

    orch.swapToNetworkControllers();

    expect(state.assignTeams).toHaveBeenCalledWith("Blue", "Red");
    expect(host._controllers.get("Blue")).toBeInstanceOf(LocalTurnController);
    expect(host._controllers.get("Red")).toBeInstanceOf(RemoteTurnController);
  });

  it("does nothing in local mode", () => {
    const state = createStateStub({ mode: "local" });
    const host = createHostStub();
    const orch = makeOrchestrator(state, host);

    orch.swapToNetworkControllers();

    expect(state.assignTeams).not.toHaveBeenCalled();
    expect(host._controllers.size).toBe(0);
  });
});

describe("NetworkOrchestrator.deliverCommandToController", () => {
  it("forwards command to the remote controller for the active team", () => {
    const state = createStateStub({ mode: "network-host", lifecycle: ConnectionState.CONNECTED });
    const remote = new RemoteTurnController();
    const receiveCommand = vi.spyOn(remote, "receiveCommand");
    const host = createHostStub({
      controllers: new Map([["Blue", remote]]),
      session: { getTurnIndex: () => 3, activeTeam: { id: "Blue" } },
    });
    const orch = makeOrchestrator(state, host);

    const cmd = { type: "set-weapon", weapon: 0, atMs: 1 } as any;
    orch.deliverCommandToController({ turnIndex: 3, teamId: "Blue", command: cmd } as any);

    expect(receiveCommand).toHaveBeenCalledWith(3, cmd);
  });

  it("ignores commands for stale turn or non-active team", () => {
    const state = createStateStub({ mode: "network-host", lifecycle: ConnectionState.CONNECTED });
    const remote = new RemoteTurnController();
    const receiveCommand = vi.spyOn(remote, "receiveCommand");
    const host = createHostStub({
      controllers: new Map([["Blue", remote]]),
      session: { getTurnIndex: () => 3, activeTeam: { id: "Blue" } },
    });
    const orch = makeOrchestrator(state, host);

    orch.deliverCommandToController({ turnIndex: 2, teamId: "Blue", command: {} } as any);
    orch.deliverCommandToController({ turnIndex: 3, teamId: "Red", command: {} } as any);

    expect(receiveCommand).not.toHaveBeenCalled();
  });
});

describe("NetworkOrchestrator.deliverEffectsToSession", () => {
  it("applies effects only when turn and team match", () => {
    const state = createStateStub({ mode: "network-host", lifecycle: ConnectionState.CONNECTED });
    const apply = vi.fn();
    const host = createHostStub({
      session: {
        getTurnIndex: () => 5,
        activeTeam: { id: "Blue" },
        applyRemoteTurnEffects: apply,
      },
    });
    const orch = makeOrchestrator(state, host);

    orch.deliverEffectsToSession({ turnIndex: 5, actingTeamId: "Blue", effects: [] } as any);
    expect(apply).toHaveBeenCalledTimes(1);

    orch.deliverEffectsToSession({ turnIndex: 4, actingTeamId: "Blue", effects: [] } as any);
    orch.deliverEffectsToSession({ turnIndex: 5, actingTeamId: "Red", effects: [] } as any);
    expect(apply).toHaveBeenCalledTimes(1);
  });
});

describe("NetworkOrchestrator.deliverResolutionToController", () => {
  it("drains queued resolutions to remote controllers", () => {
    const state = createStateStub({ mode: "network-host", lifecycle: ConnectionState.CONNECTED });
    const remote = new RemoteTurnController();
    const receiveResolution = vi.spyOn(remote, "receiveResolution");
    const host = createHostStub({ controllers: new Map([["Blue", remote]]) });
    const orch = makeOrchestrator(state, host);

    state.resolutions.push({ actingTeamId: "Blue", turnIndex: 1, result: {} });
    state.resolutions.push({ actingTeamId: "Blue", turnIndex: 2, result: {} });

    orch.deliverResolutionToController();

    expect(receiveResolution).toHaveBeenCalledTimes(2);
    expect(state.resolutions).toEqual([]);
  });

  it("re-queues resolutions when no remote controller is available", () => {
    const state = createStateStub({ mode: "network-host", lifecycle: ConnectionState.CONNECTED });
    const host = createHostStub({ controllers: new Map([["Blue", new LocalTurnController()]]) });
    const orch = makeOrchestrator(state, host);

    const r = { actingTeamId: "Blue", turnIndex: 1, result: {} };
    state.resolutions.push(r);

    orch.deliverResolutionToController();

    expect(state.resolutions).toEqual([r]);
    expect(state.enqueueResolution).toHaveBeenCalledWith(r);
  });
});

describe("NetworkOrchestrator.handleRestartRequest", () => {
  it("triggers host restart only when in host mode", () => {
    const state = createStateStub({ mode: "network-host" });
    const host = createHostStub();
    const orch = makeOrchestrator(state, host);
    const restartSpy = vi.spyOn(orch, "restartMatchAsHost").mockImplementation(() => {});

    orch.handleRestartRequest();
    expect(restartSpy).toHaveBeenCalledTimes(1);

    state._setMode("network-guest");
    orch.handleRestartRequest();
    expect(restartSpy).toHaveBeenCalledTimes(1);
  });
});

describe("NetworkOrchestrator setupWebRTCCallbacks message dispatch", () => {
  function makeClient() {
    const handlers: { state?: any; message?: any; error?: any; debug?: any } = {};
    return {
      onStateChange: (cb: any) => { handlers.state = cb; },
      onMessage: (cb: any) => { handlers.message = cb; },
      onError: (cb: any) => { handlers.error = cb; },
      onDebugEvent: (cb: any) => { handlers.debug = cb; },
      handlers,
    };
  }

  function setup(mode: "network-host" | "network-guest") {
    const state = createStateStub({ mode, lifecycle: ConnectionState.DISCONNECTED });
    const host = createHostStub();
    const orch = makeOrchestrator(state, host);
    const client = makeClient();
    (orch as any).webrtcClient = client;
    (orch as any).clientGeneration = 1;
    const notifySpy = vi.spyOn(orch, "notifyStateChange");

    orch.setupWebRTCCallbacks(client as any, 1);
    return { orch, client, state, host, notifySpy };
  }

  it("routes match_init through host.applyMatchInitSnapshot", () => {
    const { client, host, state } = setup("network-guest");
    const snapshot = { width: 1, height: 1 } as any;
    client.handlers.message({ type: "match_init", payload: { snapshot } });
    expect(host.applyMatchInitSnapshot).toHaveBeenCalledWith(snapshot);
    expect(state.appendNetworkMessageLog).toHaveBeenCalledWith({
      direction: "recv",
      message: { type: "match_init", payload: { snapshot } },
    });
  });

  it("routes player_hello, restart, command, effects, and resolution", () => {
    const { client, orch, state } = setup("network-host");
    const helloSpy = vi.spyOn(orch, "handlePlayerHello");
    const restartSpy = vi.spyOn(orch, "handleRestartRequest").mockImplementation(() => {});
    const cmdSpy = vi.spyOn(orch, "deliverCommandToController");
    const effectsSpy = vi.spyOn(orch, "deliverEffectsToSession");
    const resSpy = vi.spyOn(orch, "deliverResolutionToController");

    const hello = { type: "player_hello", payload: { name: "Peer", role: "guest" } };
    client.handlers.message(hello);
    expect(helloSpy).toHaveBeenCalledWith(hello);

    client.handlers.message({ type: "match_restart_request", payload: {} });
    expect(restartSpy).toHaveBeenCalled();

    const cmdPayload = { turnIndex: 0, teamId: "Red", command: {} };
    client.handlers.message({ type: "turn_command", payload: cmdPayload });
    expect(cmdSpy).toHaveBeenCalledWith(cmdPayload);

    const effectsPayload = { turnIndex: 0, actingTeamId: "Red", effects: [] };
    client.handlers.message({ type: "turn_effects", payload: effectsPayload });
    expect(effectsSpy).toHaveBeenCalledWith(effectsPayload);

    const resPayload = { actingTeamId: "Red", turnIndex: 0, result: {} };
    client.handlers.message({ type: "turn_resolution", payload: resPayload });
    expect(state.enqueueResolution).toHaveBeenCalledWith(resPayload);
    expect(resSpy).toHaveBeenCalled();
  });

  it("on host CONNECT: swaps controllers, says hello, restarts match, sends match_init", () => {
    const { client, orch, host, state, notifySpy } = setup("network-host");
    const swapSpy = vi.spyOn(orch, "swapToNetworkControllers");
    const helloSpy = vi.spyOn(orch, "sendPlayerHello").mockImplementation(() => {});
    const initSpy = vi.spyOn(orch, "sendMatchInit").mockImplementation(() => {});

    let lifecycle = ConnectionState.DISCONNECTED;
    state.getSnapshot.mockImplementation(() => ({
      mode: "network-host",
      connection: { lifecycle },
      player: { localName: "Host", remoteName: null },
    }));
    state.updateConnectionLifecycle.mockImplementation((next: ConnectionState) => {
      lifecycle = next;
    });

    client.handlers.state(ConnectionState.CONNECTED);

    expect(swapSpy).toHaveBeenCalled();
    expect(helloSpy).toHaveBeenCalled();
    expect(host.startMatchAsHost).toHaveBeenCalled();
    expect(state.setWaitingForSnapshot).toHaveBeenCalledWith(false);
    expect(initSpy).toHaveBeenCalled();
    expect(notifySpy).toHaveBeenCalled();
  });

  it("on guest CONNECT: swaps, says hello, waits for snapshot when none received yet", () => {
    const { client, orch, host, state } = setup("network-guest");
    const swapSpy = vi.spyOn(orch, "swapToNetworkControllers");
    const helloSpy = vi.spyOn(orch, "sendPlayerHello").mockImplementation(() => {});

    let lifecycle = ConnectionState.DISCONNECTED;
    state.getSnapshot.mockImplementation(() => ({
      mode: "network-guest",
      connection: { lifecycle },
      player: { localName: "Guest", remoteName: null },
    }));
    state.updateConnectionLifecycle.mockImplementation((next: ConnectionState) => {
      lifecycle = next;
    });

    client.handlers.state(ConnectionState.CONNECTED);

    expect(swapSpy).toHaveBeenCalled();
    expect(helloSpy).toHaveBeenCalled();
    expect(host.startMatchAsHost).not.toHaveBeenCalled();
    expect(state.setWaitingForSnapshot).toHaveBeenCalledWith(true);
  });

  it("does not re-trigger CONNECT effects when state changes from CONNECTED to CONNECTED", () => {
    const { client, orch, state } = setup("network-host");
    const swapSpy = vi.spyOn(orch, "swapToNetworkControllers");
    const initSpy = vi.spyOn(orch, "sendMatchInit").mockImplementation(() => {});

    let lifecycle = ConnectionState.CONNECTED;
    state.getSnapshot.mockImplementation(() => ({
      mode: "network-host",
      connection: { lifecycle },
      player: { localName: "Host", remoteName: null },
    }));
    state.updateConnectionLifecycle.mockImplementation((next: ConnectionState) => {
      lifecycle = next;
    });

    client.handlers.state(ConnectionState.CONNECTED);

    expect(swapSpy).not.toHaveBeenCalled();
    expect(initSpy).not.toHaveBeenCalled();
  });

  it("reports errors via reportConnectionError", () => {
    const { client, state, notifySpy } = setup("network-host");
    client.handlers.error(new Error("boom"));
    expect(state.reportConnectionError).toHaveBeenCalledWith("boom");
    expect(notifySpy).toHaveBeenCalled();
  });
});

describe("NetworkOrchestrator.handlePlayerHello", () => {
  it("stores remote name when in network mode", () => {
    const state = createStateStub({ mode: "network-host" });
    const host = createHostStub();
    const orch = makeOrchestrator(state, host);
    const notifySpy = vi.spyOn(orch, "notifyStateChange");

    orch.handlePlayerHello({
      type: "player_hello",
      payload: { name: "Peer", role: "guest" },
    } as any);

    expect(state.setRemoteName).toHaveBeenCalledWith("Peer");
    expect(notifySpy).toHaveBeenCalled();
  });

  it("ignores hello in local mode", () => {
    const state = createStateStub({ mode: "local" });
    const host = createHostStub();
    const orch = makeOrchestrator(state, host);

    orch.handlePlayerHello({
      type: "player_hello",
      payload: { name: "Peer", role: "guest" },
    } as any);

    expect(state.setRemoteName).not.toHaveBeenCalled();
  });
});

describe("NetworkOrchestrator.sendPlayerHello", () => {
  it("sends host role when in host mode", () => {
    const state = createStateStub({ mode: "network-host", localName: "Host" });
    const host = createHostStub();
    const orch = makeOrchestrator(state, host);
    const sendMessage = vi.fn();
    (orch as any).webrtcClient = { sendMessage };

    orch.sendPlayerHello();

    expect(sendMessage).toHaveBeenCalledWith({
      type: "player_hello",
      payload: { name: "Host", role: "host" },
    });
  });

  it("sends guest role when in guest mode", () => {
    const state = createStateStub({ mode: "network-guest", localName: "Guest" });
    const host = createHostStub();
    const orch = makeOrchestrator(state, host);
    const sendMessage = vi.fn();
    (orch as any).webrtcClient = { sendMessage };

    orch.sendPlayerHello();

    expect(sendMessage).toHaveBeenCalledWith({
      type: "player_hello",
      payload: { name: "Guest", role: "guest" },
    });
  });

  it("is a no-op in local mode", () => {
    const state = createStateStub({ mode: "local" });
    const host = createHostStub();
    const orch = makeOrchestrator(state, host);
    const sendMessage = vi.fn();
    (orch as any).webrtcClient = { sendMessage };

    orch.sendPlayerHello();

    expect(sendMessage).not.toHaveBeenCalled();
  });
});

describe("NetworkOrchestrator.resetSessionToLocal", () => {
  it("clears flags, resets relay, restores local mode and controllers", () => {
    const state = createStateStub({ mode: "network-host" });
    const host = createHostStub();
    const orch = makeOrchestrator(state, host);
    (orch as any).connectionStartRequested = true;
    (orch as any).hasReceivedMatchInit = true;
    const relayReset = vi.spyOn(orch.turnRelay, "reset").mockImplementation(() => {});
    const notifySpy = vi.spyOn(orch, "notifyStateChange");

    orch.resetSessionToLocal();

    expect((orch as any).connectionStartRequested).toBe(false);
    expect((orch as any).hasReceivedMatchInit).toBe(false);
    expect(relayReset).toHaveBeenCalled();
    expect(state.setMode).toHaveBeenCalledWith("local");
    expect(state.resetNetworkOnlyState).toHaveBeenCalled();
    expect(host.restoreLocalSetup).toHaveBeenCalled();
    expect(notifySpy).toHaveBeenCalled();
  });
});
