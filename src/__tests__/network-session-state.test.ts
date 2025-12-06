import { describe, expect, it } from "vitest";
import { WeaponType } from "../definitions";
import type { GameSnapshot } from "../game/session";
import type { TurnResolution } from "../game/network/turn-payload";
import { NetworkSessionState } from "../network/session-state";
import { ConnectionState as WebRTCConnectionState } from "../webrtc/types";

const createGameSnapshot = (): GameSnapshot => ({
  width: 320,
  height: 200,
  wind: 0,
  message: null,
  terrain: {
    width: 320,
    height: 200,
    horizontalPadding: 0,
    solid: [],
    heightMap: [],
  },
  teams: [
    { id: "Red", worms: [] },
    { id: "Blue", worms: [] },
  ],
  state: {
    phase: "aim",
    weapon: WeaponType.Bazooka,
    turnStartMs: 0,
    charging: false,
    chargeStartMs: 0,
  },
  activeTeamIndex: 0,
  activeWormIndex: 0,
});

const createTurnResolution = (): TurnResolution => ({
  actingTeamId: "Red",
  actingTeamIndex: 0,
  actingWormIndex: 0,
  windAtStart: 0,
  windAfter: 0,
  startedAtMs: 100,
  completedAtMs: 200,
  commands: [],
  projectileEvents: [],
  terrainOperations: [],
  wormHealth: [],
  snapshot: createGameSnapshot(),
});

describe("NetworkSessionState", () => {
  it("defaults to local mode with idle registry state", () => {
    const state = new NetworkSessionState();
    const snapshot = state.getSnapshot();

    expect(snapshot.mode).toBe("local");
    expect(snapshot.player.role).toBe("local");
    expect(snapshot.registry.status).toBe("idle");
    expect(snapshot.connection.lifecycle).toBe(WebRTCConnectionState.IDLE);
  });

  it("tracks host and guest role transitions", () => {
    const state = new NetworkSessionState();

    state.setMode("network-host");
    let snapshot = state.getSnapshot();
    expect(snapshot.player.role).toBe("host");
    expect(snapshot.registry.role).toBe("host");

    state.setMode("network-guest");
    snapshot = state.getSnapshot();
    expect(snapshot.player.role).toBe("guest");
    expect(snapshot.registry.role).toBe("guest");

    state.setMode("local");
    snapshot = state.getSnapshot();
    expect(snapshot.player.role).toBe("local");
    expect(snapshot.registry.status).toBe("idle");
    expect(snapshot.connection.bufferedLocalCandidates).toHaveLength(0);
  });

  it("records registry snapshots and candidate polling timestamps", () => {
    const state = new NetworkSessionState();
    const snapshot: Parameters<typeof state.recordRoomSnapshot>[0] = {
      status: "joined",
      offer: null,
      answer: null,
      updatedAt: 1000,
      expiresAt: 2000,
    };

    state.recordRoomSnapshot(snapshot, 1234);
    state.updateCandidatePoll(1500);
    const result = state.getSnapshot();

    expect(result.registry.status).toBe("joined");
    expect(result.registry.lastSnapshot?.updatedAt).toBe(1000);
    expect(result.registry.lastSnapshotAt).toBe(1234);
    expect(result.registry.lastCandidatePollAt).toBe(1500);

    // mutate returned snapshot to ensure state keeps its own copy
    if (result.registry.lastSnapshot) {
      result.registry.lastSnapshot.status = "closed";
    }
    expect(state.getSnapshot().registry.status).toBe("joined");
  });

  it("deduplicates buffered and staged ICE candidates", () => {
    const state = new NetworkSessionState();
    const candidate = { candidate: "cand", sdpMid: "0", sdpMLineIndex: 0 };

    state.bufferLocalCandidate(candidate);
    state.bufferLocalCandidate(candidate);
    const flushed = state.flushBufferedLocalCandidates();
    expect(flushed).toHaveLength(1);
    expect(state.flushBufferedLocalCandidates()).toHaveLength(0);

    state.stageRemoteCandidates([candidate, candidate]);
    const remoteBatch = state.consumeRemoteCandidates();
    expect(remoteBatch).toHaveLength(1);
    expect(state.consumeRemoteCandidates()).toHaveLength(0);
  });

  it("promotes network readiness when connected", () => {
    const state = new NetworkSessionState();
    state.updateConnectionLifecycle(WebRTCConnectionState.CONNECTING, 10);
    let snapshot = state.getSnapshot();
    expect(snapshot.bridge.networkReady).toBe(false);

    state.updateConnectionLifecycle(WebRTCConnectionState.CONNECTED, 20);
    snapshot = state.getSnapshot();
    expect(snapshot.bridge.networkReady).toBe(true);
    expect(snapshot.bridge.waitingForRemoteSnapshot).toBe(false);
    expect(snapshot.connection.lastStateChangeAt).toBe(20);
  });

  it("stores pending snapshots and resolutions safely", () => {
    const state = new NetworkSessionState();
    const pending = createGameSnapshot();
    state.storePendingSnapshot(pending);
    state.enqueueResolution(createTurnResolution());
    state.enqueueResolution(createTurnResolution());

    const first = state.dequeueResolution();
    const second = state.dequeueResolution();
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    expect(state.dequeueResolution()).toBeUndefined();

    const snapshot = state.getSnapshot();
    expect(snapshot.bridge.pendingSnapshot).not.toBeNull();
    if (snapshot.bridge.pendingSnapshot) {
      snapshot.bridge.pendingSnapshot.wind = 999;
    }
    const reread = state.getSnapshot();
    expect(reread.bridge.pendingSnapshot?.wind).toBe(0);
  });
});
