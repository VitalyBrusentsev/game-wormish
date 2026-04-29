import type { TeamId } from "../definitions";
import { nowMs } from "../definitions";
import type { GameSession, MatchInitSnapshot } from "../game/session";
import {
  LocalTurnController,
  RemoteTurnController,
  type TurnDriver,
} from "../game/turn-driver";
import type { TurnCommand } from "../game/network/turn-payload";
import type {
  MatchInitMessage,
  NetworkMessage,
  PlayerHelloMessage,
  TurnCommandMessage,
  TurnEffectsMessage,
} from "../game/network/messages";
import { NetworkTurnRelay } from "../game/network/turn-relay";
import { WebRTCRegistryClient } from "../webrtc/client";
import { ConnectionState } from "../webrtc/types";
import { RegistryClient } from "../webrtc/registry-client";
import { HttpClient } from "../webrtc/http-client";
import {
  NetworkSessionState,
  type NetworkSessionStateSnapshot,
} from "./session-state";

const NETWORK_TEARDOWN_TIMEOUT_MS = 3000;

/**
 * Side-effectful callbacks the orchestrator needs to drive the rest of the
 * game when network events change session/controller/UI state.
 */
export interface NetworkOrchestratorHost {
  /** Returns the current GameSession. May be replaced when a snapshot arrives. */
  getSession(): GameSession;
  /** The shared turnControllers map owned by Game. */
  getTurnControllers(): Map<TeamId, TurnDriver>;
  /** Re-publish the current turnControllers map to the active session. */
  setTurnControllersOnSession(): void;
  /** Host-side: restart session, recenter camera, reset mobile, refresh cursor. */
  startMatchAsHost(): void;
  /** Guest-side: install a new session from the snapshot and refocus everything. */
  applyMatchInitSnapshot(snapshot: MatchInitSnapshot): void;
  /** Restore local-mode setup (single-player name + AI controllers). */
  restoreLocalSetup(): void;
}

export class NetworkOrchestrator {
  readonly state: NetworkSessionState;
  readonly turnRelay: NetworkTurnRelay;

  private webrtcClient: WebRTCRegistryClient | null = null;
  private clientGeneration = 0;
  private connectionStartRequested = false;
  private hasReceivedMatchInit = false;
  private readonly stateChangeCallbacks: ((state: NetworkSessionState) => void)[] = [];

  constructor(
    private readonly host: NetworkOrchestratorHost,
    options: { state?: NetworkSessionState; turnRelay?: NetworkTurnRelay } = {}
  ) {
    this.state = options.state ?? new NetworkSessionState();
    this.turnRelay = options.turnRelay ?? new NetworkTurnRelay(nowMs);
  }

  // ───────────────────────────── State change subscriptions

  onStateChange(callback: (state: NetworkSessionState) => void) {
    this.stateChangeCallbacks.push(callback);
  }

  notifyStateChange() {
    for (const cb of this.stateChangeCallbacks) {
      cb(this.state);
    }
  }

  getSnapshot(): NetworkSessionStateSnapshot {
    return this.state.getSnapshot();
  }

  // ───────────────────────────── Outbound messages

  sendNetworkMessage(message: NetworkMessage) {
    if (!this.webrtcClient) return;
    this.state.appendNetworkMessageLog({ direction: "send", message });
    this.webrtcClient.sendMessage(message);
  }

  canSendNetworkTurnMessage(): boolean {
    if (!this.webrtcClient) return false;
    const snapshot = this.state.getSnapshot();
    if (snapshot.mode === "local") return false;
    return snapshot.connection.lifecycle === "connected";
  }

  handleLocalTurnCommand(command: TurnCommand, meta: { turnIndex: number; teamId: TeamId }) {
    if (!this.canSendNetworkTurnMessage()) return;
    this.turnRelay.handleLocalTurnCommand(
      command,
      meta,
      this.host.getSession().activeWorm,
      (message) => this.sendNetworkMessage(message)
    );
  }

  handleLocalTurnEffects(effects: TurnEffectsMessage["payload"]) {
    if (!this.canSendNetworkTurnMessage()) return;
    this.turnRelay.handleLocalTurnEffects(
      effects,
      (message) => this.sendNetworkMessage(message)
    );
  }

  flushPendingTurnEffects(force = false) {
    if (!this.canSendNetworkTurnMessage()) return;
    this.turnRelay.flushPendingTurnEffects(
      force,
      (message) => this.sendNetworkMessage(message)
    );
  }

  flushTurnResolution() {
    if (!this.canSendNetworkTurnMessage()) return;
    const resolution = this.host.getSession().consumeTurnResolution();
    this.turnRelay.flushTurnResolution(
      resolution,
      (message) => this.sendNetworkMessage(message)
    );
  }

  // ───────────────────────────── Client lifecycle

  private setActiveClient(client: WebRTCRegistryClient): number {
    const previousClient = this.webrtcClient;
    this.webrtcClient = client;
    this.clientGeneration += 1;
    if (previousClient && previousClient !== client) {
      void this.closeClient(previousClient);
    }
    return this.clientGeneration;
  }

  private isActiveClient(client: WebRTCRegistryClient, generation: number): boolean {
    return this.webrtcClient === client && this.clientGeneration === generation;
  }

  private async closeClient(client: WebRTCRegistryClient | null): Promise<void> {
    if (!client) return;
    const closePromise = client.closeRoom().catch(() => undefined);
    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    const timeoutPromise = new Promise<void>((resolve) => {
      timeoutId = globalThis.setTimeout(resolve, NETWORK_TEARDOWN_TIMEOUT_MS);
    });

    await Promise.race([closePromise, timeoutPromise]);
    if (timeoutId !== null) {
      globalThis.clearTimeout(timeoutId);
    }
  }

  resetSessionToLocal() {
    this.connectionStartRequested = false;
    this.hasReceivedMatchInit = false;
    this.turnRelay?.reset();
    this.state.setMode("local");
    this.state.resetNetworkOnlyState();
    this.host.restoreLocalSetup();
    this.notifyStateChange();
  }

  async teardownSession(awaitClose: boolean): Promise<void> {
    const client = this.webrtcClient;
    if (client) {
      this.webrtcClient = null;
      this.clientGeneration += 1;
    }

    this.resetSessionToLocal();

    if (awaitClose) {
      await this.closeClient(client);
      return;
    }

    void this.closeClient(client);
  }

  cancelSetup(): void {
    void this.teardownSession(false);
  }

  // ───────────────────────────── Room creation & connection

  async createHostRoom(config: { registryUrl: string; playerName: string }): Promise<void> {
    this.state.setMode("network-host");
    this.state.setPlayerNames(config.playerName);
    this.state.updateRegistryInfo({ baseUrl: config.registryUrl });
    this.connectionStartRequested = false;
    this.hasReceivedMatchInit = false;
    this.host.startMatchAsHost();

    const iceServers: RTCIceServer[] = [{ urls: "stun:stun.l.google.com:19302" }];
    const client = new WebRTCRegistryClient({
      registryApiUrl: config.registryUrl,
      iceServers,
    });
    const clientGeneration = this.setActiveClient(client);

    this.setupWebRTCCallbacks(client, clientGeneration);

    try {
      await client.createRoom(config.playerName);
      if (!this.isActiveClient(client, clientGeneration)) {
        void this.closeClient(client);
        return;
      }

      const roomInfo = client.getRoomInfo();
      if (roomInfo) {
        this.state.updateRegistryInfo({
          code: roomInfo.code,
          joinCode: roomInfo.joinCode ?? null,
          token: roomInfo.token,
          expiresAt: roomInfo.expiresAt,
          hostUserName: roomInfo.hostUserName ?? config.playerName,
        });
        this.notifyStateChange();
      }

      await this.startConnection(client, clientGeneration);
    } catch (error) {
      if (!this.isActiveClient(client, clientGeneration)) {
        void this.closeClient(client);
        return;
      }

      const message = error instanceof Error ? error.message : String(error);
      this.state.reportConnectionError(message);
      this.notifyStateChange();
      throw error;
    }
  }

  async joinRoom(config: {
    registryUrl: string;
    playerName: string;
    roomCode: string;
    joinCode: string;
  }): Promise<void> {
    this.state.setMode("network-guest");
    this.state.setPlayerNames(config.playerName);
    this.state.updateRegistryInfo({ baseUrl: config.registryUrl });
    this.connectionStartRequested = false;
    this.hasReceivedMatchInit = false;

    const iceServers: RTCIceServer[] = [{ urls: "stun:stun.l.google.com:19302" }];
    const client = new WebRTCRegistryClient({
      registryApiUrl: config.registryUrl,
      iceServers,
    });
    const clientGeneration = this.setActiveClient(client);

    this.setupWebRTCCallbacks(client, clientGeneration);

    try {
      await client.joinRoom(config.roomCode, config.joinCode, config.playerName);
      if (!this.isActiveClient(client, clientGeneration)) {
        void this.closeClient(client);
        return;
      }

      const roomInfo = client.getRoomInfo();
      if (roomInfo) {
        this.state.updateRegistryInfo({
          code: roomInfo.code,
          token: roomInfo.token,
          expiresAt: roomInfo.expiresAt,
          guestUserName: roomInfo.guestUserName ?? config.playerName,
          hostUserName: roomInfo.hostUserName ?? "",
        });
        if (roomInfo.hostUserName) {
          this.state.setRemoteName(roomInfo.hostUserName);
        }
        this.notifyStateChange();
      }

      await this.startConnection(client, clientGeneration);
    } catch (error) {
      if (!this.isActiveClient(client, clientGeneration)) {
        void this.closeClient(client);
        return;
      }

      const message = error instanceof Error ? error.message : String(error);
      this.state.reportConnectionError(message);
      this.notifyStateChange();
      throw error;
    }
  }

  async lookupRoom(config: { registryUrl: string; roomCode: string }): Promise<void> {
    const roomCode = config.roomCode.trim().toUpperCase();
    const registryClient = new RegistryClient(config.registryUrl, new HttpClient());

    try {
      const publicInfo = await registryClient.getPublicRoomInfo(roomCode);
      this.state.reportConnectionError(null);
      this.state.setMode("network-guest");
      this.state.updateRegistryInfo({
        baseUrl: config.registryUrl,
        code: roomCode,
        hostUserName: publicInfo.hostUserName,
        status: publicInfo.status,
        expiresAt: publicInfo.expiresAt,
      });
      this.state.setRemoteName(publicInfo.hostUserName);
      this.notifyStateChange();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.state.reportConnectionError(message);
      this.state.updateRegistryInfo({ code: roomCode, hostUserName: "" });
      this.notifyStateChange();
      throw error;
    }
  }

  async startConnection(
    client: WebRTCRegistryClient | null = this.webrtcClient,
    clientGeneration = this.clientGeneration
  ): Promise<void> {
    if (!client) {
      throw new Error("No WebRTC client initialized");
    }
    if (!this.isActiveClient(client, clientGeneration)) {
      return;
    }
    if (this.connectionStartRequested) {
      return;
    }

    const currentState = client.getConnectionState();
    if (currentState === ConnectionState.CONNECTING || currentState === ConnectionState.CONNECTED) {
      this.connectionStartRequested = true;
      return;
    }

    this.connectionStartRequested = true;

    try {
      await client.startConnection();
    } catch (error) {
      if (!this.isActiveClient(client, clientGeneration)) {
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      this.state.reportConnectionError(message);
      this.connectionStartRequested = false;
      this.notifyStateChange();
      throw error;
    }
  }

  // ───────────────────────────── WebRTC callbacks (visible for testing)

  setupWebRTCCallbacks(client: WebRTCRegistryClient, clientGeneration: number) {
    if (!this.isActiveClient(client, clientGeneration)) return;

    client.onStateChange((state: ConnectionState) => {
      if (!this.isActiveClient(client, clientGeneration)) return;
      const previousLifecycle = this.state.getSnapshot().connection.lifecycle;
      this.state.updateConnectionLifecycle(state as any, Date.now());

      if (state === ConnectionState.CONNECTED && previousLifecycle !== ConnectionState.CONNECTED) {
        this.swapToNetworkControllers();
        this.sendPlayerHello();
        const snapshot = this.state.getSnapshot();
        if (snapshot.mode === "network-host") {
          this.host.startMatchAsHost();
          this.state.setWaitingForSnapshot(false);
          this.sendMatchInit();
        } else if (snapshot.mode === "network-guest") {
          this.state.setWaitingForSnapshot(!this.hasReceivedMatchInit);
        }
      }

      this.notifyStateChange();
    });

    client.onMessage((message: NetworkMessage) => {
      if (!this.isActiveClient(client, clientGeneration)) return;
      this.state.appendNetworkMessageLog({ direction: "recv", message });
      if (message.type === "match_init") {
        this.handleMatchInit(message.payload.snapshot);
        return;
      }
      if (message.type === "player_hello") {
        this.handlePlayerHello(message);
        return;
      }
      if (message.type === "match_restart_request") {
        this.handleRestartRequest();
        return;
      }
      if (message.type === "turn_command") {
        this.deliverCommandToController(message.payload);
        return;
      }
      if (message.type === "turn_effects") {
        this.deliverEffectsToSession(message.payload);
        return;
      }
      if (message.type === "turn_resolution") {
        this.state.enqueueResolution(message.payload);
        this.deliverResolutionToController();
      }
    });

    client.onError((error: Error) => {
      if (!this.isActiveClient(client, clientGeneration)) return;
      this.state.reportConnectionError(error.message);
      this.notifyStateChange();
    });

    client.onDebugEvent((_event) => {
      if (!this.isActiveClient(client, clientGeneration)) return;
      // Store debug events if needed for diagnostics
    });
  }

  // ───────────────────────────── Match lifecycle messages

  sendMatchInit() {
    if (!this.webrtcClient) return;
    const message: MatchInitMessage = {
      type: "match_init",
      payload: {
        snapshot: this.host.getSession().toMatchInitSnapshot(),
      },
    };
    this.sendNetworkMessage(message);
  }

  handleRestartRequest() {
    const snapshot = this.state.getSnapshot();
    if (snapshot.mode !== "network-host") return;
    this.restartMatchAsHost();
  }

  restartMatchAsHost() {
    this.host.startMatchAsHost();
    this.sendMatchInit();
  }

  handleMatchInit(snapshot: MatchInitSnapshot) {
    const state = this.state.getSnapshot();
    if (state.mode !== "network-guest") return;
    this.hasReceivedMatchInit = true;
    this.state.storePendingSnapshot(snapshot);
    this.host.applyMatchInitSnapshot(snapshot);
    this.state.storePendingSnapshot(null);
    this.state.setWaitingForSnapshot(false);
    this.notifyStateChange();
  }

  sendPlayerHello() {
    if (!this.webrtcClient) return;
    const snapshot = this.state.getSnapshot();
    if (snapshot.mode === "local") return;
    const message: PlayerHelloMessage = {
      type: "player_hello",
      payload: {
        name: snapshot.player.localName,
        role: snapshot.mode === "network-host" ? "host" : "guest",
      },
    };
    this.sendNetworkMessage(message);
  }

  handlePlayerHello(message: PlayerHelloMessage) {
    const snapshot = this.state.getSnapshot();
    if (snapshot.mode === "local") return;
    if (message.payload.name) {
      this.state.setRemoteName(message.payload.name);
      this.notifyStateChange();
    }
  }

  // ───────────────────────────── Controller routing

  swapToNetworkControllers() {
    const snapshot = this.state.getSnapshot();
    if (snapshot.mode === "local") return;

    const localTeamId: TeamId = snapshot.mode === "network-host" ? "Red" : "Blue";
    const remoteTeamId: TeamId = snapshot.mode === "network-host" ? "Blue" : "Red";

    this.state.assignTeams(localTeamId, remoteTeamId);
    const controllers = this.host.getTurnControllers();
    controllers.clear();
    controllers.set(localTeamId, new LocalTurnController());
    controllers.set(remoteTeamId, new RemoteTurnController());
    this.host.setTurnControllersOnSession();
  }

  deliverResolutionToController() {
    const controllers = this.host.getTurnControllers();
    while (true) {
      const resolution = this.state.dequeueResolution();
      if (!resolution) return;
      const controller = controllers.get(resolution.actingTeamId);
      if (controller && controller.type === "remote") {
        (controller as RemoteTurnController).receiveResolution(resolution);
        continue;
      }
      this.state.enqueueResolution(resolution);
      return;
    }
  }

  deliverCommandToController(payload: TurnCommandMessage["payload"]) {
    const session = this.host.getSession();
    if (payload.turnIndex !== session.getTurnIndex()) return;
    if (payload.teamId !== session.activeTeam.id) return;
    const controller = this.host.getTurnControllers().get(payload.teamId);
    if (controller && controller.type === "remote") {
      (controller as RemoteTurnController).receiveCommand(payload.turnIndex, payload.command);
    }
  }

  deliverEffectsToSession(payload: TurnEffectsMessage["payload"]) {
    const session = this.host.getSession();
    if (payload.turnIndex !== session.getTurnIndex()) return;
    if (payload.actingTeamId !== session.activeTeam.id) return;
    session.applyRemoteTurnEffects(payload);
  }

  // ───────────────────────────── Internal accessors (for tests / migrations)

  getActiveClient(): WebRTCRegistryClient | null {
    return this.webrtcClient;
  }

  getClientGeneration(): number {
    return this.clientGeneration;
  }
}
