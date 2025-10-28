import { beforeEach, describe, expect, it, vi } from "vitest";
import { RoomManager } from "../room-manager";
import { StateManager } from "../state-manager";
import { ConnectionState } from "../types";
import type { DebugEvent, IRegistryClient, IWebRTCManager } from "../types";

describe("RoomManager connection state handling", () => {
  let registryClientMock: {
    postOffer: ReturnType<typeof vi.fn>;
    postCandidate: ReturnType<typeof vi.fn>;
    getRoom: ReturnType<typeof vi.fn>;
    getCandidates: ReturnType<typeof vi.fn>;
    closeRoom: ReturnType<typeof vi.fn>;
  } & Partial<IRegistryClient>;
  let webRTCManagerMock: {
    createPeerConnection: ReturnType<typeof vi.fn>;
    createOffer: ReturnType<typeof vi.fn>;
    setLocalDescription: ReturnType<typeof vi.fn>;
    onIceCandidate: ReturnType<typeof vi.fn>;
    onConnectionStateChange: ReturnType<typeof vi.fn>;
    createDataChannel: ReturnType<typeof vi.fn>;
    addIceCandidate: ReturnType<typeof vi.fn>;
    onDataChannel: ReturnType<typeof vi.fn>;
    createAnswer: ReturnType<typeof vi.fn>;
    setRemoteDescription: ReturnType<typeof vi.fn>;
  } & Partial<IWebRTCManager>;
  let stateManager: StateManager;
  let roomManager: RoomManager;
  let connectionStateHandler: ((state: RTCPeerConnectionState) => void) | null;
  let dataChannel: any;

  beforeEach(() => {
    connectionStateHandler = null;

    registryClientMock = {
      postOffer: vi.fn().mockResolvedValue(undefined),
      postCandidate: vi.fn().mockResolvedValue(undefined),
      getRoom: vi.fn().mockResolvedValue({
        status: "open",
        offer: null,
        answer: null,
        updatedAt: Date.now(),
        expiresAt: Date.now() + 1000,
      }),
      getCandidates: vi.fn().mockResolvedValue({ items: [], mode: "full" }),
      closeRoom: vi.fn().mockResolvedValue(undefined),
    };

    dataChannel = {
      readyState: "open",
      label: "game-data",
    } as RTCDataChannel;

    webRTCManagerMock = {
      createPeerConnection: vi.fn().mockReturnValue({ remoteDescription: null }),
      createOffer: vi.fn().mockResolvedValue({ type: "offer", sdp: "" }),
      setLocalDescription: vi.fn().mockResolvedValue(undefined),
      onIceCandidate: vi.fn(),
      onConnectionStateChange: vi.fn((callback: (state: RTCPeerConnectionState) => void) => {
        connectionStateHandler = callback;
      }),
      createDataChannel: vi.fn().mockReturnValue(dataChannel),
      addIceCandidate: vi.fn(),
      onDataChannel: vi.fn(),
      createAnswer: vi.fn(),
      setRemoteDescription: vi.fn(),
    };

    stateManager = new StateManager();
    stateManager.setRoomInfo({
      code: "ROOM",
      hostUserName: "host",
      role: "host",
      token: "token",
      expiresAt: Date.now() + 1000,
    });

    (globalThis as any).window = {
      setInterval: vi.fn().mockReturnValue(1),
      clearInterval: vi.fn(),
    };

    roomManager = new RoomManager(
      registryClientMock as unknown as IRegistryClient,
      webRTCManagerMock as unknown as IWebRTCManager,
      stateManager,
      []
    );
  });

  const startRoomManager = async () => {
    await roomManager.startConnection();
    if (!connectionStateHandler) {
      throw new Error("Connection state handler was not registered");
    }
    return connectionStateHandler;
  };

  it("transitions to error when the peer connection fails", async () => {
    const stateChanges: ConnectionState[] = [];
    const debugEvents: DebugEvent[] = [];
    roomManager.onStateChange((state) => stateChanges.push(state));
    roomManager.onDebugEvent((event) => debugEvents.push(event));

    const handler = await startRoomManager();

    handler("failed");

    expect(stateChanges).toContain(ConnectionState.ERROR);
    const errorEvents = debugEvents.filter((event) => event.type === "peer-connection-error");
    expect(errorEvents).toHaveLength(1);
    expect(errorEvents[0]).toMatchObject({
      state: "failed",
      reason: "Peer connection failed",
    });
  });

  it("transitions to disconnected on temporary peer disconnections", async () => {
    const stateChanges: ConnectionState[] = [];
    const debugEvents: DebugEvent[] = [];
    roomManager.onStateChange((state) => stateChanges.push(state));
    roomManager.onDebugEvent((event) => debugEvents.push(event));

    const handler = await startRoomManager();

    handler("disconnected");

    expect(stateChanges).toContain(ConnectionState.DISCONNECTED);
    expect(stateChanges).not.toContain(ConnectionState.ERROR);
    expect(debugEvents.filter((event) => event.type === "peer-connection-error")).toHaveLength(0);
  });

  it("keeps error state when the data channel closes after a failure", async () => {
    const stateChanges: ConnectionState[] = [];
    roomManager.onStateChange((state) => stateChanges.push(state));

    const handler = await startRoomManager();

    handler("failed");
    expect(stateChanges[stateChanges.length - 1]).toBe(ConnectionState.ERROR);

    if (typeof (dataChannel as any).onclose === "function") {
      (dataChannel as any).onclose();
    } else {
      throw new Error("Data channel onclose handler was not set");
    }

    expect(stateChanges[stateChanges.length - 1]).toBe(ConnectionState.ERROR);
  });
});
