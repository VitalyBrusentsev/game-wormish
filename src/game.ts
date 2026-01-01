import type { TeamId, PredictedPoint } from "./definitions";
import { GAMEPLAY, WeaponType, nowMs, COLORS, WORLD, clamp } from "./definitions";
import { Input, drawText } from "./utils";
import type { Worm } from "./entities";
import { HelpOverlay } from "./ui/help-overlay";
import { StartMenuOverlay } from "./ui/start-menu-overlay";
import { NetworkMatchDialog } from "./ui/network-match-dialog";
import {
  renderAimHelpers,
  renderBackground,
  renderGameOver,
  renderHUD,
  type AimInfo,
} from "./rendering/game-rendering";
import { renderNetworkStatusHUD } from "./ui/network-status-hud";
import { renderNetworkLogHUD } from "./ui/network-log-hud";
import type { Team } from "./game/team-manager";
import {
  GameSession,
  type SessionCallbacks,
  type MatchInitSnapshot,
} from "./game/session";
import {
  LocalTurnController,
  RemoteTurnController,
  type TurnDriver,
} from "./game/turn-driver";
import { NetworkSessionState } from "./network/session-state";
import type { TurnCommand } from "./game/network/turn-payload";
import type {
  MatchInitMessage,
  NetworkMessage,
  PlayerHelloMessage,
  TurnCommandMessage,
  TurnResolutionMessage,
} from "./game/network/messages";
import { applyAimThrottle, type AimThrottleState } from "./game/network/aim-throttle";
import { applyMoveThrottle, flushMoveThrottle, type MoveThrottleState } from "./game/network/move-throttle";
import { WebRTCRegistryClient } from "./webrtc/client";
import { ConnectionState } from "./webrtc/types";
import { RegistryClient } from "./webrtc/registry-client";
import { HttpClient } from "./webrtc/http-client";

let initialMenuDismissed = false;

export class Game {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  width: number;
  height: number;

  input: Input;
  session: GameSession;

  private helpOverlay: HelpOverlay;
  private startMenu: StartMenuOverlay;
  private networkDialog: NetworkMatchDialog;
  private helpOpenedFromMenu = false;
  private startMenuOpenedAtMs: number | null = null;

  private readonly networkState: NetworkSessionState;
  private webrtcClient: WebRTCRegistryClient | null = null;
  private networkStateChangeCallbacks: ((state: NetworkSessionState) => void)[] = [];
  private readonly registryUrl: string;
  private connectionStartRequested = false;

  private readonly cameraPadding = 48;
  private cameraOffsetX = 0;
  private cameraOffsetY = 0;
  private cameraShakeTime = 0;
  private cameraShakeDuration = 0;
  private cameraShakeMagnitude = 0;
  private cameraX = 0;
  private cameraVelocityX = 0;
  private cameraTargetX = 0;
  private lastTurnStartMs = -1;

  private readonly frameTimes: number[] = [];
  private frameTimeSum = 0;
  private fps = 0;
  private readonly frameSampleSize = 60;

  private running = false;
  private frameHandle: number | null = null;
  private readonly frameCallback: FrameRequestCallback;

  private lastTimeMs = 0;

  private readonly pointerDownFocusHandler = () => this.canvas.focus();
  private readonly mouseDownFocusHandler = () => this.canvas.focus();
  private readonly touchStartFocusHandler = () => this.canvas.focus();

  private readonly sessionCallbacks: SessionCallbacks = {
    onExplosion: (info) => this.handleSessionExplosion(info),
    onRestart: () => this.resetCameraShake(),
    onTurnCommand: (command, meta) => this.handleLocalTurnCommand(command, meta),
  };

  private readonly turnControllers = new Map<TeamId, TurnDriver>();
  private aimThrottleState: AimThrottleState | null = null;
  private moveThrottleState: MoveThrottleState | null = null;

  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
    
    // Determine registry URL based on environment
    const isDev = window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1";
    this.registryUrl = isDev
      ? "http://127.0.0.1:8787"
      : "https://wormish-current-time-production.installcreator.workers.dev";
    this.canvas = document.createElement("canvas");
    this.canvas.width = width;
    this.canvas.height = height;
    const ctx = this.canvas.getContext("2d");
    if (!ctx) throw new Error("2D context not available");
    this.ctx = ctx;

    this.input = new Input();
    this.input.attach(this.canvas);

    this.networkState = new NetworkSessionState();

    const groundWidth = WORLD.groundWidth;
    this.session = new GameSession(groundWidth, height, {
      horizontalPadding: 0,
      callbacks: this.sessionCallbacks,
    });

    this.initializeTurnControllers();
    this.cameraX = this.clampCameraX(this.activeWorm.x - this.width / 2);
    this.cameraTargetX = this.cameraX;
    this.lastTurnStartMs = this.session.state.turnStartMs;

    this.helpOverlay = new HelpOverlay({
      onClose: (pausedMs, reason) => this.handleHelpClosed(pausedMs, reason),
    });

    this.networkDialog = new NetworkMatchDialog({
      onCreateRoom: async (playerName) => {
        await this.createHostRoom({ registryUrl: this.registryUrl, playerName });
      },
      onLookupRoom: async (roomCode) => {
        await this.lookupRoom({ registryUrl: this.registryUrl, roomCode });
      },
      onJoinRoom: async (roomCode, joinCode, playerName) => {
        await this.joinRoom({ registryUrl: this.registryUrl, playerName, roomCode, joinCode });
      },
      onCancel: () => {
        this.cancelNetworkSetup();
      },
      onClose: (reason) => {
        if (reason === "escape") {
          this.input.consumeKey("Escape");
        }
        this.hideStartMenu();
        this.canvas.focus();
        this.updateCursor();
      },
    });

    this.onNetworkStateChange((state) => {
      this.networkDialog.updateFromNetworkState(state);
      const snapshot = state.getSnapshot();
      if (snapshot.connection.lifecycle === "connected") {
        this.networkDialog.hide();
        initialMenuDismissed = true;
        this.canvas.focus();
        this.updateCursor();
      }
    });
    
    this.startMenu = new StartMenuOverlay({
      onHelp: () => {
        this.helpOpenedFromMenu = true;
        this.hideStartMenu();
        this.showHelp();
      },
      onStart: () => {
        this.hideStartMenu();
        initialMenuDismissed = true;
        this.canvas.focus();
        this.updateCursor();
      },
      onRestart: () => {
        this.hideStartMenu();
        initialMenuDismissed = true;
        this.session.restart();
        this.canvas.focus();
        this.updateCursor();
      },
      onNetworkMatch: () => {
        this.hideStartMenu();
        this.networkDialog.show("host");
      },
      onClose: (reason) => {
        if (reason === "escape") {
          this.input.consumeKey("Escape");
        }
        this.canvas.focus();
        this.updateCursor();
      },
    });
    if (!initialMenuDismissed) {
      this.showStartMenu("start", false);
    }

    this.updateCursor();

    this.frameCallback = (t) => this.frame(t);
  }

  private initializeTurnControllers() {
    this.turnControllers.clear();
    for (const team of this.session.teams) {
      this.turnControllers.set(team.id, new LocalTurnController());
    }
    this.session.setTurnControllers(this.turnControllers);
  }

  setTurnController(teamId: TeamId, controller: TurnDriver) {
    this.turnControllers.set(teamId, controller);
    this.session.setTurnControllers(this.turnControllers);
  }

  mount(parent: HTMLElement) {
    parent.appendChild(this.canvas);
    this.canvas.tabIndex = 0;
    this.canvas.focus();
    this.canvas.addEventListener("pointerdown", this.pointerDownFocusHandler);
    this.canvas.addEventListener("mousedown", this.mouseDownFocusHandler);
    this.canvas.addEventListener("touchstart", this.touchStartFocusHandler);
  }

  resize(width: number, height: number) {
    const nextWidth = width | 0;
    const nextHeight = height | 0;
    if (nextWidth === this.width && nextHeight === this.height) return;
    const centerX = this.cameraX + this.width / 2;
    this.width = nextWidth;
    this.height = nextHeight;
    this.canvas.width = this.width;
    this.canvas.height = this.height;
    this.cameraX = this.clampCameraX(centerX - this.width / 2);
    this.cameraTargetX = this.cameraX;
    this.cameraVelocityX = 0;
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.lastTimeMs = 0;
    this.frameTimes.length = 0;
    this.frameTimeSum = 0;
    this.fps = 0;
    this.frameHandle = requestAnimationFrame(this.frameCallback);
  }

  dispose() {
    if (this.frameHandle !== null) {
      cancelAnimationFrame(this.frameHandle);
      this.frameHandle = null;
    }
    this.running = false;
    this.cancelNetworkSetup();
    this.startMenu.dispose();
    this.networkDialog.dispose();
    this.helpOverlay.dispose();
    this.input.detach();
    this.canvas.removeEventListener("pointerdown", this.pointerDownFocusHandler);
    this.canvas.removeEventListener("mousedown", this.mouseDownFocusHandler);
    this.canvas.removeEventListener("touchstart", this.touchStartFocusHandler);
    if (this.canvas.parentElement) {
      this.canvas.parentElement.removeChild(this.canvas);
    }
  }

  getNetworkState(): NetworkSessionState {
    return this.networkState;
  }

  onNetworkStateChange(callback: (state: NetworkSessionState) => void) {
    this.networkStateChangeCallbacks.push(callback);
  }

  private notifyNetworkStateChange() {
    for (const cb of this.networkStateChangeCallbacks) {
      cb(this.networkState);
    }
  }

  private sendNetworkMessage(message: NetworkMessage) {
    if (!this.webrtcClient) return;
    this.networkState.appendNetworkMessageLog({ direction: "send", message });
    this.webrtcClient.sendMessage(message);
  }

  private handleLocalTurnCommand(command: TurnCommand, meta: { turnIndex: number; teamId: TeamId }) {
    if (!this.webrtcClient) return;
    const snapshot = this.networkState.getSnapshot();
    if (snapshot.mode === "local") return;
    if (snapshot.connection.lifecycle !== "connected") return;

    if (command.type !== "aim" && command.type !== "move") {
      const flushed = flushMoveThrottle({ state: this.moveThrottleState, nowMs: nowMs() });
      this.moveThrottleState = flushed.nextState;
      for (const movement of flushed.toSend) {
        const message: TurnCommandMessage = {
          type: "turn_command",
          payload: {
            turnIndex: meta.turnIndex,
            teamId: meta.teamId,
            command: movement,
          },
        };
        this.sendNetworkMessage(message);
      }
    }

    if (command.type === "aim") {
      const worm = this.session.activeWorm;
      const decision = applyAimThrottle({
        state: this.aimThrottleState,
        config: {
          minIntervalMs: 60,
          maxIntervalMs: 250,
          diffThreshold: 0.2,
          angleThresholdRad: 0.2,
        },
        nowMs: nowMs(),
        turnIndex: meta.turnIndex,
        teamId: meta.teamId,
        wormX: worm.x,
        wormY: worm.y,
        aim: command.aim,
      });
      this.aimThrottleState = decision.nextState;
      if (!decision.shouldSend) return;
    }

    if (command.type === "move") {
      const decision = applyMoveThrottle({
        state: this.moveThrottleState,
        config: {
          minIntervalMs: 60,
          suppressIdle: true,
        },
        nowMs: nowMs(),
        turnIndex: meta.turnIndex,
        teamId: meta.teamId,
        movement: command,
      });
      this.moveThrottleState = decision.nextState;
      if (decision.toSend.length === 0) return;
      for (const movement of decision.toSend) {
        const message: TurnCommandMessage = {
          type: "turn_command",
          payload: {
            turnIndex: meta.turnIndex,
            teamId: meta.teamId,
            command: movement,
          },
        };
        this.sendNetworkMessage(message);
      }
      return;
    }

    const message: TurnCommandMessage = {
      type: "turn_command",
      payload: {
        turnIndex: meta.turnIndex,
        teamId: meta.teamId,
        command,
      },
    };
    this.sendNetworkMessage(message);
  }

  private flushTurnResolution() {
    if (!this.webrtcClient) return;
    const snapshot = this.networkState.getSnapshot();
    if (snapshot.mode === "local") return;
    if (snapshot.connection.lifecycle !== "connected") return;

    const resolution = this.session.consumeTurnResolution();
    if (!resolution) return;
    const message: TurnResolutionMessage = {
      type: "turn_resolution",
      payload: resolution,
    };
    this.sendNetworkMessage(message);
  }

  async createHostRoom(config: { registryUrl: string; playerName: string }): Promise<void> {
    this.networkState.setMode("network-host");
    this.networkState.setPlayerNames(config.playerName);
    this.networkState.updateRegistryInfo({ baseUrl: config.registryUrl });
    this.connectionStartRequested = false;

    const iceServers: RTCIceServer[] = [{ urls: "stun:stun.l.google.com:19302" }];
    this.webrtcClient = new WebRTCRegistryClient({
      registryApiUrl: config.registryUrl,
      iceServers,
    });

    this.setupWebRTCCallbacks();

    try {
      await this.webrtcClient.createRoom(config.playerName);
      const roomInfo = this.webrtcClient.getRoomInfo();
      if (roomInfo) {
        this.networkState.updateRegistryInfo({
          code: roomInfo.code,
          joinCode: roomInfo.joinCode ?? null,
          token: roomInfo.token,
          expiresAt: roomInfo.expiresAt,
          hostUserName: roomInfo.hostUserName ?? config.playerName,
        });
        this.notifyNetworkStateChange();
      }
      await this.startConnection();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.networkState.reportConnectionError(message);
      this.notifyNetworkStateChange();
      throw error;
    }
  }

  async joinRoom(config: {
    registryUrl: string;
    playerName: string;
    roomCode: string;
    joinCode: string;
  }): Promise<void> {
    this.networkState.setMode("network-guest");
    this.networkState.setPlayerNames(config.playerName);
    this.networkState.updateRegistryInfo({ baseUrl: config.registryUrl });
    this.connectionStartRequested = false;

    const iceServers: RTCIceServer[] = [{ urls: "stun:stun.l.google.com:19302" }];
    this.webrtcClient = new WebRTCRegistryClient({
      registryApiUrl: config.registryUrl,
      iceServers,
    });

    this.setupWebRTCCallbacks();

    try {
      await this.webrtcClient.joinRoom(config.roomCode, config.joinCode, config.playerName);
      const roomInfo = this.webrtcClient.getRoomInfo();
      if (roomInfo) {
        this.networkState.updateRegistryInfo({
          code: roomInfo.code,
          token: roomInfo.token,
          expiresAt: roomInfo.expiresAt,
          guestUserName: roomInfo.guestUserName ?? config.playerName,
          hostUserName: roomInfo.hostUserName ?? "",
        });
        if (roomInfo.hostUserName) {
          this.networkState.setRemoteName(roomInfo.hostUserName);
        }
        this.notifyNetworkStateChange();
      }
      await this.startConnection();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.networkState.reportConnectionError(message);
      this.notifyNetworkStateChange();
      throw error;
    }
  }

  async lookupRoom(config: { registryUrl: string; roomCode: string }): Promise<void> {
    const roomCode = config.roomCode.trim().toUpperCase();
    const registryClient = new RegistryClient(config.registryUrl, new HttpClient());

    try {
      const publicInfo = await registryClient.getPublicRoomInfo(roomCode);
      this.networkState.reportConnectionError(null);
      this.networkState.setMode("network-guest");
      this.networkState.updateRegistryInfo({
        baseUrl: config.registryUrl,
        code: roomCode,
        hostUserName: publicInfo.hostUserName,
        status: publicInfo.status,
        expiresAt: publicInfo.expiresAt,
      });
      this.networkState.setRemoteName(publicInfo.hostUserName);
      this.notifyNetworkStateChange();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.networkState.reportConnectionError(message);
      this.networkState.updateRegistryInfo({ code: roomCode, hostUserName: "" });
      this.notifyNetworkStateChange();
      throw error;
    }
  }

  async startConnection(): Promise<void> {
    if (!this.webrtcClient) {
      throw new Error("No WebRTC client initialized");
    }
    if (this.connectionStartRequested) {
      return;
    }

    const currentState = this.webrtcClient.getConnectionState();
    if (currentState === ConnectionState.CONNECTING || currentState === ConnectionState.CONNECTED) {
      this.connectionStartRequested = true;
      return;
    }

    this.connectionStartRequested = true;

    try {
      await this.webrtcClient.startConnection();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.networkState.reportConnectionError(message);
      this.connectionStartRequested = false;
      this.notifyNetworkStateChange();
      throw error;
    }
  }

  cancelNetworkSetup(): void {
    if (this.webrtcClient) {
      this.webrtcClient.closeRoom().catch(() => {});
      this.webrtcClient = null;
    }
    this.connectionStartRequested = false;
    this.networkState.setMode("local");
    this.networkState.resetNetworkOnlyState();
    this.initializeTurnControllers();
    this.notifyNetworkStateChange();
  }

  private setupWebRTCCallbacks() {
    if (!this.webrtcClient) return;

    this.webrtcClient.onStateChange((state: ConnectionState) => {
      this.networkState.updateConnectionLifecycle(state as any, Date.now());
      
      if (state === "connected") {
        this.swapToNetworkControllers();
        this.sendPlayerHello();
        const snapshot = this.networkState.getSnapshot();
        if (snapshot.mode === "network-host") {
          this.networkState.setWaitingForSnapshot(false);
          this.sendMatchInit();
        } else if (snapshot.mode === "network-guest") {
          this.networkState.setWaitingForSnapshot(true);
        }
      }
      
      this.notifyNetworkStateChange();
    });

    this.webrtcClient.onMessage((message: NetworkMessage) => {
      this.networkState.appendNetworkMessageLog({ direction: "recv", message });
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
      if (message.type === "turn_resolution") {
        this.networkState.enqueueResolution(message.payload);
        this.deliverResolutionToController();
      }
    });

    this.webrtcClient.onError((error: Error) => {
      this.networkState.reportConnectionError(error.message);
      this.notifyNetworkStateChange();
    });

    this.webrtcClient.onDebugEvent((_event) => {
      // Store debug events if needed for diagnostics
    });
  }

  private sendMatchInit() {
    if (!this.webrtcClient) return;
    const message: MatchInitMessage = {
      type: "match_init",
      payload: {
        snapshot: this.session.toMatchInitSnapshot(),
      },
    };
    this.sendNetworkMessage(message);
  }

  private handleRestartRequest() {
    const snapshot = this.networkState.getSnapshot();
    if (snapshot.mode !== "network-host") return;
    this.restartNetworkMatchAsHost();
  }

  private restartNetworkMatchAsHost() {
    this.session.restart({ startingTeamIndex: 0 });
    this.lastTurnStartMs = this.session.state.turnStartMs;
    this.cameraX = this.clampCameraX(this.activeWorm.x - this.width / 2);
    this.cameraTargetX = this.cameraX;
    this.cameraVelocityX = 0;
    this.updateCursor();
    this.sendMatchInit();
  }

  private handleMatchInit(snapshot: MatchInitSnapshot) {
    const state = this.networkState.getSnapshot();
    if (state.mode !== "network-guest") return;
    this.networkState.storePendingSnapshot(snapshot);
    this.applySnapshot(snapshot);
    this.networkState.storePendingSnapshot(null);
    this.networkState.setWaitingForSnapshot(false);
    this.notifyNetworkStateChange();
  }

  private applySnapshot(snapshot: MatchInitSnapshot) {
    if (snapshot.height !== this.height) {
      this.resize(this.width, snapshot.height);
    }
    const nextSession = new GameSession(snapshot.width, this.height, {
      horizontalPadding: snapshot.terrain.horizontalPadding,
      callbacks: this.sessionCallbacks,
    });
    nextSession.loadMatchInitSnapshot(snapshot);
    nextSession.state.turnStartMs = nowMs();
    if (nextSession.state.charging) {
      nextSession.state.chargeStartMs = nextSession.state.turnStartMs;
    }
    this.session = nextSession;
    this.lastTurnStartMs = this.session.state.turnStartMs;
    this.cameraX = this.clampCameraX(this.activeWorm.x - this.width / 2);
    this.cameraTargetX = this.cameraX;
    this.cameraVelocityX = 0;
    this.turnControllers.clear();
    const mode = this.networkState.getSnapshot().mode;
    if (mode === "local") {
      this.initializeTurnControllers();
    } else {
      this.swapToNetworkControllers();
    }
    this.updateCursor();
  }

  private sendPlayerHello() {
    if (!this.webrtcClient) return;
    const snapshot = this.networkState.getSnapshot();
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

  private handlePlayerHello(message: PlayerHelloMessage) {
    const snapshot = this.networkState.getSnapshot();
    if (snapshot.mode === "local") return;
    if (message.payload.name) {
      this.networkState.setRemoteName(message.payload.name);
      this.notifyNetworkStateChange();
    }
  }

  private swapToNetworkControllers() {
    const snapshot = this.networkState.getSnapshot();
    if (snapshot.mode === "local") return;

    const localTeamId: TeamId = snapshot.mode === "network-host" ? "Red" : "Blue";
    const remoteTeamId: TeamId = snapshot.mode === "network-host" ? "Blue" : "Red";

    this.networkState.assignTeams(localTeamId, remoteTeamId);

    this.turnControllers.set(localTeamId, new LocalTurnController());
    this.turnControllers.set(remoteTeamId, new RemoteTurnController());
    this.session.setTurnControllers(this.turnControllers);
  }

  private deliverResolutionToController() {
    const resolution = this.networkState.dequeueResolution();
    if (!resolution) return;
    const controller = this.turnControllers.get(resolution.actingTeamId);
    if (controller && controller.type === "remote") {
      (controller as RemoteTurnController).receiveResolution(resolution);
      return;
    }
    this.networkState.enqueueResolution(resolution);
  }

  private deliverCommandToController(payload: TurnCommandMessage["payload"]) {
    if (payload.turnIndex !== this.session.getTurnIndex()) return;
    if (payload.teamId !== this.session.activeTeam.id) return;
    const controller = this.turnControllers.get(payload.teamId);
    if (controller && controller.type === "remote") {
      (controller as RemoteTurnController).receiveCommand(payload.turnIndex, payload.command);
    }
  }

  get activeTeam(): Team {
    return this.session.activeTeam;
  }

  get activeWorm(): Worm {
    return this.session.activeWorm;
  }

  private get activeWormIndex() {
    return this.session.activeWormIndex;
  }

  private get teams() {
    return this.session.teams;
  }

  private showHelp() {
    const opened = this.helpOverlay.show(nowMs());
    if (opened && this.session.state.charging) {
      this.session.cancelChargeCommand();
    }
  }

  private hideHelp(reason: "manual" | "escape" = "manual") {
    this.helpOverlay.hide(reason);
  }

  private showStartMenu(
    mode: "start" | "pause" = this.startMenu.getMode(),
    closeable = true
  ) {
    if (!this.startMenu.isVisible()) {
      this.startMenuOpenedAtMs = nowMs();
    }
    this.startMenu.show(mode, closeable);
  }

  private hideStartMenu() {
    if (!this.startMenu.isVisible()) return;
    if (this.startMenuOpenedAtMs !== null) {
      const pausedFor = nowMs() - this.startMenuOpenedAtMs;
      if (pausedFor > 0) {
        this.session.state.pauseFor(pausedFor);
      }
    }
    this.startMenuOpenedAtMs = null;
    this.startMenu.hide();
  }

  private handleHelpClosed(pausedFor: number, reason: "manual" | "escape") {
    if (reason === "escape") {
      this.input.consumeKey("Escape");
    }
    if (this.helpOpenedFromMenu) {
      this.helpOpenedFromMenu = false;
      this.showStartMenu(this.startMenu.getMode(), initialMenuDismissed);
      this.updateCursor();
      return;
    }
    if (pausedFor > 0) {
      this.session.state.pauseFor(pausedFor);
    }
    this.canvas.focus();
    this.updateCursor();
  }

  private processInput() {
    if (this.input.pressed("F1")) {
      const wasMenuVisible = this.startMenu.isVisible();
      if (this.helpOverlay.isVisible()) {
        this.hideHelp("escape");
      } else {
        this.helpOpenedFromMenu = wasMenuVisible;
        if (wasMenuVisible) this.hideStartMenu();
        this.showHelp();
      }
      this.updateCursor();
      return;
    }

    if (this.helpOverlay.isVisible()) {
      if (this.input.pressed("Escape")) {
        this.hideHelp("escape");
      }
      this.updateCursor();
      return;
    }

    const escapePressed = this.input.pressed("Escape");

    if (this.startMenu.isVisible()) {
      if (escapePressed && initialMenuDismissed) {
        this.startMenu.requestClose("escape");
        this.updateCursor();
      }
      return;
    }

    if (this.input.pressed("KeyI")) {
      this.networkState.toggleNetworkLog();
      this.input.consumeKey("KeyI");
    }

    if (this.input.pressed("KeyR") && this.session.state.phase === "gameover") {
      const snapshot = this.networkState.getSnapshot();
      if (snapshot.mode !== "local") {
        this.input.consumeKey("KeyR");
        if (snapshot.mode === "network-host") {
          this.restartNetworkMatchAsHost();
        } else {
          this.sendNetworkMessage({ type: "match_restart_request", payload: {} });
        }
      }
    }

    if (escapePressed) {
      this.showStartMenu(initialMenuDismissed ? "pause" : "start", initialMenuDismissed);
      this.updateCursor();
      return;
    }

    this.updateCursor();
  }

  private handleSessionExplosion(info: { cause: WeaponType; radius: number }) {
    if (info.cause === WeaponType.HandGrenade) {
      this.triggerCameraShake(info.radius * 0.7);
    }
  }

  private resetCameraShake() {
    this.cameraShakeTime = 0;
    this.cameraShakeDuration = 0;
    this.cameraShakeMagnitude = 0;
    this.cameraOffsetX = 0;
    this.cameraOffsetY = 0;
  }

  private triggerCameraShake(magnitude: number, duration = 0.4) {
    const clamped = Math.min(Math.abs(magnitude), this.cameraPadding * 0.9);
    this.cameraShakeMagnitude = Math.max(this.cameraShakeMagnitude, clamped);
    this.cameraShakeDuration = Math.max(this.cameraShakeDuration, duration);
    this.cameraShakeTime = Math.max(this.cameraShakeTime, duration);
  }

  private updateCameraShake(dt: number) {
    if (this.cameraShakeTime <= 0) {
      if (this.cameraOffsetX !== 0 || this.cameraOffsetY !== 0) {
        this.cameraOffsetX = 0;
        this.cameraOffsetY = 0;
      }
      this.cameraShakeMagnitude = 0;
      this.cameraShakeDuration = 0;
      return;
    }

    this.cameraShakeTime = Math.max(0, this.cameraShakeTime - dt);
    const denom = this.cameraShakeDuration > 0 ? this.cameraShakeDuration : 1;
    const progress = this.cameraShakeTime / denom;
    const damping = progress * progress;
    const magnitude = this.cameraShakeMagnitude * damping;
    const angle = Math.random() * Math.PI * 2;
    this.cameraOffsetX = Math.cos(angle) * magnitude;
    this.cameraOffsetY = Math.sin(angle) * magnitude;
  }

  private getCameraBounds() {
    const groundWidth = this.session.width;
    const viewWidth = this.width;
    const minVisible = Math.min(groundWidth * 0.5, viewWidth);
    const minX = minVisible - viewWidth;
    const maxX = groundWidth - minVisible;
    return { minX, maxX };
  }

  private clampCameraX(x: number) {
    const { minX, maxX } = this.getCameraBounds();
    return clamp(x, minX, maxX);
  }

  private getCameraMargin() {
    const base = Math.min(240, Math.max(120, this.width * 0.2));
    return Math.min(base, this.width * 0.45);
  }

  private getEdgeScrollDelta(dt: number, bounds: { minX: number; maxX: number }) {
    if (!this.input.mouseInside) return 0;
    const threshold = Math.min(160, Math.max(80, this.width * 0.15));
    if (threshold <= 0) return 0;
    const maxSpeed = 520;
    const mouseX = this.input.mouseX;
    if (mouseX <= threshold && this.cameraX > bounds.minX + 0.5) {
      const t = (threshold - mouseX) / threshold;
      return -maxSpeed * t * dt;
    }
    if (mouseX >= this.width - threshold && this.cameraX < bounds.maxX - 0.5) {
      const t = (mouseX - (this.width - threshold)) / threshold;
      return maxSpeed * t * dt;
    }
    return 0;
  }

  private updateCamera(dt: number, allowEdgeScroll: boolean) {
    const bounds = this.getCameraBounds();
    let targetX = this.cameraTargetX;

    if (allowEdgeScroll) {
      const edgeDelta = this.getEdgeScrollDelta(dt, bounds);
      if (edgeDelta !== 0) {
        targetX += edgeDelta;
      }
    }

    targetX = clamp(targetX, bounds.minX, bounds.maxX);
    this.cameraTargetX = targetX;

    const stiffness = 18;
    const damping = 10;
    const delta = this.cameraTargetX - this.cameraX;
    this.cameraVelocityX += delta * stiffness * dt;
    const decay = Math.exp(-damping * dt);
    this.cameraVelocityX *= decay;
    this.cameraX += this.cameraVelocityX * dt;

    const clampedX = clamp(this.cameraX, bounds.minX, bounds.maxX);
    if (clampedX !== this.cameraX) {
      this.cameraX = clampedX;
      this.cameraVelocityX = 0;
    }
  }

  private updatePassiveProjectileFocus(): boolean {
    const networkSnapshot = this.networkState.getSnapshot();
    if (networkSnapshot.mode === "local") return false;
    const localTeamId = networkSnapshot.player.localTeamId;
    if (!localTeamId) return false;
    if (this.activeTeam.id === localTeamId) return false;
    if (this.session.state.phase !== "projectile") return false;
    if (this.session.projectiles.length === 0) return false;

    const projectile = this.session.projectiles[this.session.projectiles.length - 1]!;
    const bounds = this.getCameraBounds();
    this.cameraTargetX = clamp(projectile.x - this.width / 2, bounds.minX, bounds.maxX);
    return true;
  }

  private focusCameraOnActiveWorm() {
    const margin = this.getCameraMargin();
    const bounds = this.getCameraBounds();
    const wormX = this.activeWorm.x;
    const leftEdge = this.cameraX + margin;
    const rightEdge = this.cameraX + this.width - margin;
    let targetX = this.cameraTargetX;

    if (wormX < leftEdge) {
      targetX = wormX - margin;
    } else if (wormX > rightEdge) {
      targetX = wormX - (this.width - margin);
    } else {
      return;
    }

    this.cameraTargetX = clamp(targetX, bounds.minX, bounds.maxX);
  }

  private updateTurnFocus() {
    const turnStartMs = this.session.state.turnStartMs;
    if (turnStartMs === this.lastTurnStartMs) return;
    this.lastTurnStartMs = turnStartMs;
    this.focusCameraOnActiveWorm();
  }

  private updateCursor() {
    if (this.helpOverlay.isVisible() || this.startMenu.isVisible()) {
      this.canvas.style.cursor = "default";
      return;
    }
    if (this.session.state.weapon === WeaponType.Rifle) {
      this.canvas.style.cursor = "none";
      return;
    }
    if (this.session.state.charging) {
      this.canvas.style.cursor = "crosshair";
      return;
    }
    this.canvas.style.cursor = "crosshair";
  }

  getTeamHealth(id: TeamId) {
    return this.session.getTeamHealth(id);
  }

  predictPath(): PredictedPoint[] {
    return this.session.predictPath();
  }

  private getAimInfo(): AimInfo {
    return this.session.getAimInfo();
  }

  private renderTurnSwitchHighlight(
    ctx: CanvasRenderingContext2D,
    worm: Worm,
    elapsedMs: number
  ) {
    const durationMs = 1400;
    if (elapsedMs > durationMs) return;

    const t = 1 - elapsedMs / durationMs;
    const pulse = 0.55 + 0.45 * Math.sin((elapsedMs / 120) * Math.PI * 2);
    const teamColor = worm.team === "Red" ? "255,77,77" : "77,163,255";
    const innerRadius = worm.radius + 4;
    const outerRadius = worm.radius + 12 + 12 * t * pulse;

    ctx.save();
    const gradient = ctx.createRadialGradient(
      worm.x,
      worm.y,
      innerRadius,
      worm.x,
      worm.y,
      outerRadius
    );
    gradient.addColorStop(0, `rgba(${teamColor}, ${0.3 * t})`);
    gradient.addColorStop(1, `rgba(${teamColor}, 0)`);
    ctx.fillStyle = gradient;
    ctx.beginPath();
    ctx.arc(worm.x, worm.y, outerRadius, 0, Math.PI * 2);
    ctx.fill();

    ctx.strokeStyle = `rgba(${teamColor}, ${0.8 * t})`;
    ctx.lineWidth = 3;
    const ringRadius = worm.radius + 6 + 6 * pulse * t;
    ctx.beginPath();
    ctx.arc(worm.x, worm.y, ringRadius, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }

  render() {
    const now = nowMs();
    const turnElapsedMs = Math.max(0, now - this.session.state.turnStartMs);
    const ctx = this.ctx;
    ctx.save();
    ctx.translate(this.cameraOffsetX, this.cameraOffsetY);
    renderBackground(ctx, this.width, this.height, this.cameraPadding);
    ctx.restore();

    ctx.save();
    ctx.translate(-this.cameraX + this.cameraOffsetX, this.cameraOffsetY);
    this.session.terrain.render(ctx);

    for (const particle of this.session.particles) particle.render(ctx);

    for (let t = 0; t < this.teams.length; t++) {
      const team = this.teams[t]!;
      for (let i = 0; i < team.worms.length; i++) {
        const worm = team.worms[i]!;
        const isActive =
          team.id === this.activeTeam.id &&
          i === this.activeWormIndex &&
          this.session.state.phase !== "gameover";
        worm.render(ctx, isActive);
        if (isActive) {
          this.renderTurnSwitchHighlight(ctx, worm, turnElapsedMs);
        }
      }
    }

    for (const projectile of this.session.projectiles) projectile.render(ctx);

    renderAimHelpers({
      ctx,
      state: this.session.state,
      activeWorm: this.activeWorm,
      aim: this.getAimInfo(),
      predictedPath: this.predictPath(),
    });
    ctx.restore();

    ctx.save();
    ctx.translate(this.cameraOffsetX, this.cameraOffsetY);
    renderHUD({
      ctx,
      width: this.width,
      height: this.height,
      state: this.session.state,
      now,
      activeTeamId: this.activeTeam.id,
      getTeamHealth: (teamId) => this.getTeamHealth(teamId),
      wind: this.session.wind,
      message: this.session.message,
      turnDurationMs: GAMEPLAY.turnTimeMs,
    });

    renderGameOver({
      ctx,
      width: this.width,
      height: this.height,
      message: this.session.message,
      isGameOver: this.session.state.phase === "gameover",
    });

    renderNetworkStatusHUD(ctx, this.width, this.networkState);
    renderNetworkLogHUD(ctx, this.width, this.height, this.networkState);

    const fpsText = `FPS: ${this.fps.toFixed(1)}`;
    drawText(ctx, fpsText, this.width - 12, 12, COLORS.white, 14, "right");
    ctx.restore();
  }

  frame(timeMs: number) {
    if (!this.lastTimeMs) this.lastTimeMs = timeMs;
    let dt = (timeMs - this.lastTimeMs) / 1000;
    if (dt > 0) {
      this.frameTimes.push(dt);
      this.frameTimeSum += dt;
      if (this.frameTimes.length > this.frameSampleSize) {
        const removed = this.frameTimes.shift();
        if (removed !== undefined) this.frameTimeSum -= removed;
      }
      if (this.frameTimeSum > 0) {
        this.fps = this.frameTimes.length / this.frameTimeSum;
      }
    }
    dt = Math.min(dt, 1 / 20);

    this.processInput();
    const overlaysBlocking =
      this.helpOverlay.isVisible() ||
      this.startMenu.isVisible() ||
      this.networkDialog.isVisible();
    const networkSnapshot = this.networkState.getSnapshot();
    const waitingForSync =
      networkSnapshot.mode !== "local" &&
      networkSnapshot.bridge.waitingForRemoteSnapshot;
    this.updateTurnFocus();
    const followingProjectile = this.updatePassiveProjectileFocus();
    this.updateCamera(dt, !overlaysBlocking && !followingProjectile);
    const worldCameraOffsetX = -this.cameraX + this.cameraOffsetX;
    const worldCameraOffsetY = this.cameraOffsetY;
    this.session.updateActiveTurnDriver(dt, {
      allowInput: !overlaysBlocking && !waitingForSync,
      input: this.input,
      camera: { offsetX: worldCameraOffsetX, offsetY: worldCameraOffsetY },
    });
    if (!overlaysBlocking) {
      this.session.update(dt);
    }
    this.flushTurnResolution();
    this.updateCameraShake(dt);
    this.render();
    this.input.update();
    this.lastTimeMs = timeMs;
    if (this.running) {
      this.frameHandle = requestAnimationFrame(this.frameCallback);
    }
  }
}
