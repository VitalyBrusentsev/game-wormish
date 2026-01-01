import type { TeamId } from "../definitions";
import type { MatchInitSnapshot } from "../game/session";
import type { TurnResolution } from "../game/network/turn-payload";
import type { NetworkMessage } from "../game/network/messages";
import { nowMs } from "../definitions";
import {
  ConnectionState as WebRTCConnectionState,
  type RoomInfo,
  type RoomSnapshot,
} from "../webrtc/types";

export type SessionMode = "local" | "network-host" | "network-guest";

export type PlayerRole = "unknown" | "local" | "host" | "guest";

export interface PlayerIdentity {
  localName: string | null;
  remoteName: string | null;
  role: PlayerRole;
  localTeamId: TeamId | null;
  remoteTeamId: TeamId | null;
}

export interface RegistryRoomState
  extends Pick<RoomInfo, "code" | "hostUserName" | "guestUserName" | "role" | "token" | "expiresAt"> {
  baseUrl: string | null;
  joinCode: string | null;
  status: RoomSnapshot["status"] | "idle";
  lastSnapshot: RoomSnapshot | null;
  lastSnapshotAt: number | null;
  lastCandidatePollAt: number | null;
}

export interface WebRTCConnectionInfo {
  lifecycle: WebRTCConnectionState;
  peerConnection: RTCPeerConnection | null;
  dataChannel: RTCDataChannel | null;
  bufferedLocalCandidates: RTCIceCandidateInit[];
  pendingRemoteCandidates: RTCIceCandidateInit[];
  remoteDescriptionType: "offer" | "answer" | null;
  lastError: string | null;
  lastStateChangeAt: number | null;
  iceConnectionFailures: number;
}

export interface NetworkMatchBridgeState {
  networkReady: boolean;
  waitingForRemoteSnapshot: boolean;
  pendingSnapshot: MatchInitSnapshot | null;
  pendingResolutions: TurnResolution[];
}

export type NetworkLogDirection = "send" | "recv";

export interface NetworkLogEntry {
  atMs: number;
  direction: NetworkLogDirection;
  text: string;
}

export interface NetworkDebugState {
  showLog: boolean;
  recentMessages: NetworkLogEntry[];
}

export interface NetworkSessionStateSnapshot {
  mode: SessionMode;
  player: PlayerIdentity;
  registry: RegistryRoomState;
  connection: WebRTCConnectionInfo;
  bridge: NetworkMatchBridgeState;
  debug: NetworkDebugState;
}

const jsonClone = <T>(value: T): T => {
  if (value === null || value === undefined) return value;
  return JSON.parse(JSON.stringify(value));
};

const createPlayerIdentity = (): PlayerIdentity => ({
  localName: null,
  remoteName: null,
  role: "local",
  localTeamId: null,
  remoteTeamId: null,
});

const createRegistryState = (): RegistryRoomState => ({
  baseUrl: null,
  code: "",
  hostUserName: "",
  guestUserName: "",
  joinCode: null,
  token: "",
  expiresAt: 0,
  role: "host",
  status: "idle",
  lastSnapshot: null,
  lastSnapshotAt: null,
  lastCandidatePollAt: null,
});

const createConnectionInfo = (): WebRTCConnectionInfo => ({
  lifecycle: WebRTCConnectionState.IDLE,
  peerConnection: null,
  dataChannel: null,
  bufferedLocalCandidates: [],
  pendingRemoteCandidates: [],
  remoteDescriptionType: null,
  lastError: null,
  lastStateChangeAt: null,
  iceConnectionFailures: 0,
});

const createBridgeState = (): NetworkMatchBridgeState => ({
  networkReady: false,
  waitingForRemoteSnapshot: true,
  pendingSnapshot: null,
  pendingResolutions: [],
});

const createDebugState = (): NetworkDebugState => ({
  showLog: false,
  recentMessages: [],
});

const createSnapshot = (): NetworkSessionStateSnapshot => ({
  mode: "local",
  player: createPlayerIdentity(),
  registry: createRegistryState(),
  connection: createConnectionInfo(),
  bridge: createBridgeState(),
  debug: createDebugState(),
});

const candidateKey = (candidate: RTCIceCandidateInit) => {
  const cand = candidate.candidate ?? "";
  const mid = candidate.sdpMid ?? "";
  const idx = candidate.sdpMLineIndex ?? -1;
  return `${cand}|${mid}|${idx}`;
};

export class NetworkSessionState {
  private state: NetworkSessionStateSnapshot = createSnapshot();
  private readonly bufferedLocalCandidateKeys = new Set<string>();
  private readonly pendingRemoteCandidateKeys = new Set<string>();
  private readonly logLimit = 50;

  getSnapshot(): NetworkSessionStateSnapshot {
    return {
      mode: this.state.mode,
      player: { ...this.state.player },
      registry: {
        ...this.state.registry,
        lastSnapshot: this.state.registry.lastSnapshot
          ? jsonClone(this.state.registry.lastSnapshot)
          : null,
      },
      connection: {
        ...this.state.connection,
        bufferedLocalCandidates: [...this.state.connection.bufferedLocalCandidates],
        pendingRemoteCandidates: [...this.state.connection.pendingRemoteCandidates],
      },
      bridge: {
        networkReady: this.state.bridge.networkReady,
        waitingForRemoteSnapshot: this.state.bridge.waitingForRemoteSnapshot,
        pendingSnapshot: this.state.bridge.pendingSnapshot
          ? jsonClone(this.state.bridge.pendingSnapshot)
          : null,
        pendingResolutions: [...this.state.bridge.pendingResolutions],
      },
      debug: {
        showLog: this.state.debug.showLog,
        recentMessages: this.state.debug.recentMessages.map((entry) => ({ ...entry })),
      },
    };
  }

  setMode(mode: SessionMode) {
    if (this.state.mode === mode) return;
    this.state.mode = mode;
    if (mode === "local") {
      this.resetNetworkOnlyState();
      this.state.player.role = "local";
    } else if (mode === "network-host") {
      this.state.player.role = "host";
      this.state.registry.role = "host";
    } else {
      this.state.player.role = "guest";
      this.state.registry.role = "guest";
    }
  }

  setPlayerNames(localName: string | null, remoteName: string | null = this.state.player.remoteName) {
    this.state.player.localName = localName;
    this.state.player.remoteName = remoteName;
  }

  setRemoteName(remoteName: string | null) {
    this.state.player.remoteName = remoteName;
  }

  assignTeams(localTeamId: TeamId | null, remoteTeamId: TeamId | null = null) {
    this.state.player.localTeamId = localTeamId;
    this.state.player.remoteTeamId = remoteTeamId;
  }

  updateRegistryInfo(partial: Partial<RegistryRoomState>) {
    this.state.registry = { ...this.state.registry, ...partial };
  }

  recordRoomSnapshot(snapshot: RoomSnapshot, polledAt: number) {
    this.state.registry.lastSnapshot = snapshot;
    this.state.registry.status = snapshot.status;
    this.state.registry.lastSnapshotAt = polledAt;
  }

  updateCandidatePoll(at: number) {
    this.state.registry.lastCandidatePollAt = at;
  }

  updateConnectionLifecycle(state: WebRTCConnectionState, at: number = Date.now()) {
    if (this.state.connection.lifecycle === state) return;
    if (state === WebRTCConnectionState.ERROR) {
      this.state.connection.iceConnectionFailures += 1;
    }
    this.state.connection.lifecycle = state;
    this.state.connection.lastStateChangeAt = at;
    if (state === WebRTCConnectionState.CONNECTED) {
      this.state.bridge.networkReady = true;
      this.state.bridge.waitingForRemoteSnapshot = false;
    }
  }

  attachPeerConnection(connection: RTCPeerConnection | null) {
    this.state.connection.peerConnection = connection;
  }

  attachDataChannel(channel: RTCDataChannel | null) {
    this.state.connection.dataChannel = channel;
  }

  setRemoteDescriptionType(type: "offer" | "answer" | null) {
    this.state.connection.remoteDescriptionType = type;
  }

  reportConnectionError(message: string | null) {
    this.state.connection.lastError = message;
  }

  bufferLocalCandidate(candidate: RTCIceCandidateInit) {
    const key = candidateKey(candidate);
    if (this.bufferedLocalCandidateKeys.has(key)) return;
    this.bufferedLocalCandidateKeys.add(key);
    this.state.connection.bufferedLocalCandidates.push(candidate);
  }

  flushBufferedLocalCandidates(): RTCIceCandidateInit[] {
    const batch = [...this.state.connection.bufferedLocalCandidates];
    this.state.connection.bufferedLocalCandidates.length = 0;
    this.bufferedLocalCandidateKeys.clear();
    return batch;
  }

  stageRemoteCandidates(candidates: RTCIceCandidateInit[]) {
    for (const candidate of candidates) {
      const key = candidateKey(candidate);
      if (this.pendingRemoteCandidateKeys.has(key)) continue;
      this.pendingRemoteCandidateKeys.add(key);
      this.state.connection.pendingRemoteCandidates.push(candidate);
    }
  }

  consumeRemoteCandidates(): RTCIceCandidateInit[] {
    const batch = [...this.state.connection.pendingRemoteCandidates];
    this.state.connection.pendingRemoteCandidates.length = 0;
    this.pendingRemoteCandidateKeys.clear();
    return batch;
  }

  markNetworkReady(ready: boolean) {
    this.state.bridge.networkReady = ready;
  }

  setWaitingForSnapshot(waiting: boolean) {
    this.state.bridge.waitingForRemoteSnapshot = waiting;
  }

  storePendingSnapshot(snapshot: MatchInitSnapshot | null) {
    this.state.bridge.pendingSnapshot = snapshot;
  }

  enqueueResolution(resolution: TurnResolution) {
    this.state.bridge.pendingResolutions.push(resolution);
  }

  dequeueResolution(): TurnResolution | undefined {
    return this.state.bridge.pendingResolutions.shift();
  }

  resetNetworkOnlyState() {
    this.state.registry = createRegistryState();
    this.resetConnectionArtifacts();
    this.state.bridge = createBridgeState();
    this.state.debug = createDebugState();
  }

  resetConnectionArtifacts() {
    this.state.connection = createConnectionInfo();
    this.bufferedLocalCandidateKeys.clear();
    this.pendingRemoteCandidateKeys.clear();
  }

  toggleNetworkLog() {
    this.state.debug.showLog = !this.state.debug.showLog;
  }

  appendNetworkMessageLog(entry: { direction: NetworkLogDirection; message: NetworkMessage }) {
    const formatted = formatNetworkMessage(entry.message);
    let bytes = 0;
    try {
      bytes = JSON.stringify(entry.message).length;
    } catch {
      bytes = 0;
    }
    const timestamp = nowMs();
    this.state.debug.recentMessages.push({
      atMs: timestamp,
      direction: entry.direction,
      text: bytes > 0 ? `${formatted} bytes=${bytes}` : formatted,
    });
    if (this.state.debug.recentMessages.length > this.logLimit) {
      this.state.debug.recentMessages.splice(
        0,
        this.state.debug.recentMessages.length - this.logLimit
      );
    }
  }
}

const formatNetworkMessage = (message: NetworkMessage): string => {
  switch (message.type) {
    case "match_init": {
      const snapshot = message.payload.snapshot;
      return `match_init turn=${snapshot.turnIndex} size=${snapshot.width}x${snapshot.height} wind=${snapshot.wind.toFixed(
        1
      )}`;
    }
    case "player_hello": {
      return `player_hello role=${message.payload.role} name=${message.payload.name ?? "null"}`;
    }
    case "match_restart_request": {
      return "match_restart_request";
    }
    case "turn_command": {
      const { turnIndex, teamId, command } = message.payload;
      if (command.type === "set-weapon") {
        return `turn_command#${turnIndex} ${teamId} set-weapon ${command.weapon}`;
      }
      if (command.type === "aim") {
        return `turn_command#${turnIndex} ${teamId} aim a=${command.aim.angle.toFixed(
          2
        )} x=${command.aim.targetX.toFixed(1)} y=${command.aim.targetY.toFixed(1)}`;
      }
      if (command.type === "move") {
        return `turn_command#${turnIndex} ${teamId} move=${command.move} jump=${command.jump} dt=${command.dtMs}`;
      }
      if (command.type === "start-charge") {
        return `turn_command#${turnIndex} ${teamId} start-charge`;
      }
      if (command.type === "cancel-charge") {
        return `turn_command#${turnIndex} ${teamId} cancel-charge`;
      }
      return `turn_command#${turnIndex} ${teamId} fire ${command.weapon} p=${command.power.toFixed(
        2
      )} ids=[${command.projectileIds.join(",")}]`;
    }
    case "turn_resolution": {
      const r = message.payload;
      const commandCount = r.commandCount;
      const eventCount = r.projectileEventCount;
      return `turn_resolution#${r.turnIndex} ${r.actingTeamId} -> turn=${
        r.result.turnIndex
      } wind=${r.windAtStart.toFixed(1)}→${r.windAfter.toFixed(1)} cmds=${
        commandCount
      } events=${eventCount} terrain=${r.terrainOperations.length} health=${
        r.wormHealth.length
      }`;
    }
    default:
      return "unknown";
  }
};
