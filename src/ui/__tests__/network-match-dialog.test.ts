import { describe, expect, it } from "vitest";
import { ConnectionState } from "../../webrtc/types";
import type { NetworkSessionStateSnapshot } from "../../network/session-state";
import { deriveDialogStateFromSnapshot, type DialogState } from "../network-match-dialog";

type SnapshotOverride = {
  mode?: NetworkSessionStateSnapshot["mode"];
  registry?: Partial<NetworkSessionStateSnapshot["registry"]>;
  connection?: Partial<NetworkSessionStateSnapshot["connection"]>;
};

const buildSnapshot = (overrides: SnapshotOverride): NetworkSessionStateSnapshot => {
  const registry = {
    baseUrl: null,
    code: "",
    hostUserName: "",
    guestUserName: "",
    joinCode: null,
    token: "",
    expiresAt: 0,
    role: "host",
    status: "idle" as const,
    lastSnapshot: null,
    lastSnapshotAt: null,
    lastCandidatePollAt: null,
    ...(overrides.registry ?? {}),
  } as NetworkSessionStateSnapshot["registry"];

  const connection = {
    lifecycle: ConnectionState.IDLE,
    peerConnection: null,
    dataChannel: null,
    bufferedLocalCandidates: [],
    pendingRemoteCandidates: [],
    remoteDescriptionType: null,
    lastError: null,
    lastStateChangeAt: null,
    iceConnectionFailures: 0,
    ...(overrides.connection ?? {}),
  } as NetworkSessionStateSnapshot["connection"];

  const snapshot: NetworkSessionStateSnapshot = {
    mode: overrides.mode ?? "local",
    player: {
      localName: null,
      remoteName: null,
      role: "local",
      localTeamId: null,
      remoteTeamId: null,
    },
    registry,
    connection,
    bridge: {
      networkReady: false,
      waitingForRemoteSnapshot: true,
      pendingSnapshot: null,
      pendingResolutions: [],
    },
  };

  return snapshot;
};

const landingState: DialogState = { kind: "landing", roomCode: "", joinCode: "", hostName: "" };

describe("deriveDialogStateFromSnapshot", () => {
  it("creates hosting state after room creation", () => {
    const snapshot = buildSnapshot({
      mode: "network-host",
      registry: { code: "ABCD12", joinCode: "987654", hostUserName: "Alice" },
      connection: { lifecycle: ConnectionState.CREATED },
    });

    const result = deriveDialogStateFromSnapshot(landingState, snapshot);

    expect(result.kind).toBe("hosting");
    if (result.kind === "hosting") {
      expect(result.phase).toBe("room-ready");
      expect(result.roomCode).toBe("ABCD12");
      expect(result.joinCode).toBe("987654");
    }
  });

  it("promotes hosting state to connecting", () => {
    const snapshot = buildSnapshot({
      mode: "network-host",
      registry: { code: "ABCD12", joinCode: "987654", hostUserName: "Alice" },
      connection: { lifecycle: ConnectionState.CONNECTING },
    });

    const result = deriveDialogStateFromSnapshot(landingState, snapshot);

    expect(result.kind).toBe("hosting");
    if (result.kind === "hosting") {
      expect(result.phase).toBe("connecting");
    }
  });

  it("shows guest when room is found", () => {
    const snapshot = buildSnapshot({
      mode: "network-guest",
      registry: { code: "ABCD12", hostUserName: "Alice" },
    });

    const result = deriveDialogStateFromSnapshot(landingState, snapshot);

    expect(result.kind).toBe("joining");
    if (result.kind === "joining") {
      expect(result.phase).toBe("found-room");
      expect(result.hostName).toBe("Alice");
      expect(result.roomCode).toBe("ABCD12");
    }
  });

  it("moves guest flow into connecting after join", () => {
    const snapshot = buildSnapshot({
      mode: "network-guest",
      registry: { code: "ABCD12", hostUserName: "Alice" },
      connection: { lifecycle: ConnectionState.JOINED },
    });

    const result = deriveDialogStateFromSnapshot(landingState, snapshot);

    expect(result.kind).toBe("joining");
    if (result.kind === "joining") {
      expect(result.phase).toBe("connecting");
    }
  });

  it("resets to landing when returning to local", () => {
    const snapshot = buildSnapshot({ mode: "local" });

    const result = deriveDialogStateFromSnapshot(
      { kind: "hosting", phase: "connecting", roomCode: "ABCD12", joinCode: "999999", hostName: "Alice", expiresAt: null },
      snapshot
    );

    expect(result.kind).toBe("landing");
  });

  it("preserves join code that was typed before lookup", () => {
    const snapshot = buildSnapshot({
      mode: "network-guest",
      registry: { code: "ABCD12", hostUserName: "Alice", joinCode: null },
    });

    const current: DialogState = {
      kind: "joining",
      phase: "found-room",
      roomCode: "ABCD12",
      joinCode: "123456",
      hostName: "Alice",
      expiresAt: null,
    };

    const result = deriveDialogStateFromSnapshot(current, snapshot);

    expect(result.kind).toBe("joining");
    if (result.kind === "joining") {
      expect(result.joinCode).toBe("123456");
    }
  });
});
