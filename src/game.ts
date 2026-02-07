import type { TeamId, PredictedPoint } from "./definitions";
import { GAMEPLAY, WeaponType, nowMs, COLORS, WORLD, clamp } from "./definitions";
import { Input, drawText } from "./utils";
import type { Worm } from "./entities";
import { HelpOverlay } from "./ui/help-overlay";
import { StartMenuOverlay } from "./ui/start-menu-overlay";
import { NetworkMatchDialog } from "./ui/network-match-dialog";
import { gameEvents } from "./events/game-events";
import { DamageFloaters } from "./ui/damage-floaters";
import { ActiveWormArrow } from "./ui/active-worm-arrow";
import { TurnCountdownOverlay } from "./ui/turn-countdown";
import {
  renderAimHelpers,
  renderBackground,
  renderGameOver,
  renderHUD,
  type AimInfo,
} from "./rendering/game-rendering";
import { renderNetworkLogHUD } from "./ui/network-log-hud";
import { renderMapGadget } from "./ui/map-gadget";
import type { Team } from "./game/team-manager";
import {
  GameSession,
  type MatchInitSnapshot,
  type UziBurstSnapshot,
} from "./game/session";
import {
  LocalTurnController,
  RemoteTurnController,
  type TurnDriver,
} from "./game/turn-driver";
import { NetworkSessionState, type NetworkSessionStateSnapshot } from "./network/session-state";
import type { TurnCommand } from "./game/network/turn-payload";
import type {
  MatchInitMessage,
  NetworkMessage,
  PlayerHelloMessage,
  TurnCommandMessage,
  TurnEffectsMessage,
  TurnResolutionMessage,
} from "./game/network/messages";
import { applyAimThrottle, type AimThrottleState } from "./game/network/aim-throttle";
import { applyMoveThrottle, flushMoveThrottle, type MoveThrottleState } from "./game/network/move-throttle";
import { WebRTCRegistryClient } from "./webrtc/client";
import { ConnectionState } from "./webrtc/types";
import { RegistryClient } from "./webrtc/registry-client";
import { HttpClient } from "./webrtc/http-client";
import { SoundSystem, type SoundLevels, type SoundSnapshot } from "./audio/sound-system";

let initialMenuDismissed = false;

const cleanPlayerName = (name: string | null) => {
  const cleaned = name?.trim();
  return cleaned ? cleaned : null;
};

const getNetworkTeamNames = (snapshot: NetworkSessionStateSnapshot) => {
  if (snapshot.mode === "local") return null;

  const localTeamId = snapshot.player.localTeamId;
  const remoteTeamId = snapshot.player.remoteTeamId;
  const localName = cleanPlayerName(snapshot.player.localName);
  const remoteName = cleanPlayerName(snapshot.player.remoteName);

  const names: Partial<Record<TeamId, string>> = {};
  if (localTeamId && localName) names[localTeamId] = localName;
  if (remoteTeamId && remoteName) names[remoteTeamId] = remoteName;
  return names;
};

const getNetworkTeamName = (snapshot: NetworkSessionStateSnapshot, teamId: TeamId) => {
  if (snapshot.mode === "local") return null;
  const localName = cleanPlayerName(snapshot.player.localName);
  const remoteName = cleanPlayerName(snapshot.player.remoteName);
  if (snapshot.player.localTeamId === teamId) return localName;
  if (snapshot.player.remoteTeamId === teamId) return remoteName;
  return null;
};

type NetworkMicroStatus = { text: string; color: string; opponentSide: "left" | "right" };

const getNetworkMicroStatus = (snapshot: NetworkSessionStateSnapshot): NetworkMicroStatus | null => {
  if (snapshot.mode === "local") return null;

  const remoteTeamId = snapshot.player.remoteTeamId;
  const localTeamId = snapshot.player.localTeamId;
  const opponentSide: "left" | "right" =
    remoteTeamId === "Red"
      ? "left"
      : remoteTeamId === "Blue"
        ? "right"
        : localTeamId === "Blue"
          ? "left"
          : "right";

  if (snapshot.bridge.networkReady && snapshot.bridge.waitingForRemoteSnapshot) {
    return {
      text: snapshot.mode === "network-guest" ? "Waiting for host sync..." : "Waiting for sync...",
      color: "#FFFF00",
      opponentSide,
    };
  }

  switch (snapshot.connection.lifecycle) {
    case "idle":
      return { text: "Idle", color: "#888888", opponentSide };
    case "creating":
    case "joining":
      return { text: "Setting up...", color: "#FFA500", opponentSide };
    case "created":
    case "joined":
      return { text: "Waiting...", color: "#FFFF00", opponentSide };
    case "connecting":
      return { text: "Connecting...", color: "#FFA500", opponentSide };
    case "connected":
      return { text: "Connected", color: "#00FF00", opponentSide };
    case "disconnected":
      return { text: "Disconnected", color: "#FF6600", opponentSide };
    case "error": {
      const details = snapshot.connection.lastError?.trim();
      return { text: details ? `Error: ${details}` : "Error", color: "#FF0000", opponentSide };
    }
  }

  return { text: "Unknown", color: COLORS.white, opponentSide };
};

const replaceWinnerInMessage = (
  message: string | null,
  snapshot: NetworkSessionStateSnapshot
) => {
  if (!message) return null;
  if (snapshot.mode === "local") return message;

  const match = /^(Red|Blue) wins!/.exec(message);
  if (!match) return message;

  const teamId = match[1] as TeamId;
  const teamName = getNetworkTeamName(snapshot, teamId);
  if (!teamName) return message;

  const winnerToken = match[1];
  if (!winnerToken) return message;
  return message.replace(winnerToken, teamName);
};

const uziHash01 = (v: number) => {
  const x = Math.sin(v) * 10000;
  return x - Math.floor(x);
};

const uziHashSigned = (v: number) => uziHash01(v) * 2 - 1;

const computeUziVisuals = (params: {
  burst: UziBurstSnapshot;
  turnAtMs: number;
  baseAimAngle: number;
}): { angle: number; recoilKick01: number } => {
  const intervalMs = 1000 / Math.max(1, GAMEPLAY.uzi.shotsPerSecond);
  const elapsedMs = Math.max(0, params.turnAtMs - params.burst.startAtMs);
  const shotIndexFloat = intervalMs > 0 ? elapsedMs / intervalMs : 0;
  const lastShotIndex = Math.max(0, params.burst.shotCount - 1);
  const shotIndex = clamp(Math.floor(shotIndexFloat), 0, lastShotIndex);
  const shotPhase01 = clamp(shotIndexFloat - shotIndex, 0, 1);
  const progress01 = lastShotIndex > 0 ? shotIndex / lastShotIndex : 1;

  const ampRad = 0.045 + 0.095 * progress01;
  const seedBase = params.burst.seedBase;
  const stepNoise =
    uziHashSigned(seedBase + shotIndex * 17.13) * 0.85 +
    uziHashSigned(seedBase + shotIndex * 71.77) * 0.55;
  const microNoise =
    Math.sin((elapsedMs + seedBase * 3.1) * 0.06) * 0.65 +
    Math.sin((elapsedMs + seedBase * 1.7) * 0.13) * 0.35;
  const shakeRad = clamp((stepNoise + microNoise * 0.35) * ampRad, -0.22, 0.22);

  const recoilKick01 = Math.exp(-shotPhase01 * 7.5);
  return { angle: params.baseAimAngle + shakeRad, recoilKick01 };
};

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
  private hasReceivedMatchInit = false;

  private readonly cameraPadding = 48;
  private cameraOffsetX = 0;
  private cameraOffsetY = 0;
  private cameraY = 0;
  private cameraTargetY = 0;
  private cameraVelocityY = 0;
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

  private readonly eventAbort = new AbortController();
  private readonly damageFloaters = new DamageFloaters();
  private readonly activeWormArrow = new ActiveWormArrow();
  private readonly turnCountdown = new TurnCountdownOverlay();
  private readonly sound = new SoundSystem();

  private readonly turnControllers = new Map<TeamId, TurnDriver>();
  private aimThrottleState: AimThrottleState | null = null;
  private moveThrottleState: MoveThrottleState | null = null;
  private pendingTurnEffects: TurnEffectsMessage["payload"] | null = null;
  private pendingTurnEffectsNextFlushAtMs = 0;
  private readonly turnEffectsFlushIntervalMs = 1000;

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
    this.subscribeToGameEvents();
    this.session = new GameSession(groundWidth, height, { horizontalPadding: 0 });

    this.initializeTurnControllers();
    this.cameraX = this.clampCameraX(this.activeWorm.x - this.width / 2);
    this.cameraTargetX = this.cameraX;
    this.cameraY = this.clampCameraY(this.activeWorm.y - this.height / 2);
    this.cameraTargetY = this.cameraY;
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
        this.showTurnStartArrowForCurrentTurn(this.session.getTurnIndex() === 0);
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
    this.sound.attachUnlockGestures(this.canvas, { signal: this.eventAbort.signal });
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
    this.cameraY = this.clampCameraY(this.activeWorm.y - this.height / 2);
    this.cameraTargetY = this.cameraY;
    this.cameraVelocityX = 0;
    this.cameraVelocityY = 0;
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
    this.eventAbort.abort();
    this.sound.dispose();
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

  getSoundSnapshot(): SoundSnapshot {
    return this.sound.getSnapshot();
  }

  setSoundEnabled(enabled: boolean) {
    this.sound.setEnabled(enabled);
  }

  setSoundLevels(levels: Partial<SoundLevels>) {
    this.sound.setLevels(levels);
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

  private handleLocalTurnEffects(effects: TurnEffectsMessage["payload"]) {
    if (!this.webrtcClient) return;
    const snapshot = this.networkState.getSnapshot();
    if (snapshot.mode === "local") return;
    if (snapshot.connection.lifecycle !== "connected") return;

    const shouldBatch =
      effects.terrainOperations.every((op) => op.type !== "carve-circle" || op.radius <= 10) &&
      effects.wormHealth.every((change) => change.cause === WeaponType.Uzi);
    if (!shouldBatch) {
      this.flushPendingTurnEffects(true);
      const message: TurnEffectsMessage = {
        type: "turn_effects",
        payload: effects,
      };
      this.sendNetworkMessage(message);
      return;
    }

    const pending = this.pendingTurnEffects;
    if (!pending || pending.turnIndex !== effects.turnIndex || pending.actingTeamId !== effects.actingTeamId) {
      this.flushPendingTurnEffects(true);
      this.pendingTurnEffects = {
        turnIndex: effects.turnIndex,
        actingTeamId: effects.actingTeamId,
        terrainOperations: [...effects.terrainOperations],
        wormHealth: [...effects.wormHealth],
      };
      if (this.pendingTurnEffectsNextFlushAtMs <= 0) {
        this.pendingTurnEffectsNextFlushAtMs = nowMs() + this.turnEffectsFlushIntervalMs;
      }
      return;
    }

    pending.terrainOperations.push(...effects.terrainOperations);
    pending.wormHealth.push(...effects.wormHealth);

    if (pending.terrainOperations.length + pending.wormHealth.length >= 24) {
      this.flushPendingTurnEffects(true);
    }
  }

  private flushPendingTurnEffects(force = false) {
    if (!this.webrtcClient) return;
    const snapshot = this.networkState.getSnapshot();
    if (snapshot.mode === "local") return;
    if (snapshot.connection.lifecycle !== "connected") return;

    const pending = this.pendingTurnEffects;
    if (!pending) return;
    if (pending.terrainOperations.length === 0 && pending.wormHealth.length === 0) {
      this.pendingTurnEffects = null;
      this.pendingTurnEffectsNextFlushAtMs = 0;
      return;
    }

    const now = nowMs();
    if (!force && now < this.pendingTurnEffectsNextFlushAtMs) return;

    const message: TurnEffectsMessage = {
      type: "turn_effects",
      payload: pending,
    };
    this.sendNetworkMessage(message);
    this.pendingTurnEffects = null;
    this.pendingTurnEffectsNextFlushAtMs = now + this.turnEffectsFlushIntervalMs;
  }

  private flushTurnResolution() {
    if (!this.webrtcClient) return;
    const snapshot = this.networkState.getSnapshot();
    if (snapshot.mode === "local") return;
    if (snapshot.connection.lifecycle !== "connected") return;

    const resolution = this.session.consumeTurnResolution();
    if (!resolution) return;
    this.flushPendingTurnEffects(true);
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
    this.hasReceivedMatchInit = false;
    this.startNetworkMatchAsHost();

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
    this.hasReceivedMatchInit = false;

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
      this.webrtcClient.closeRoom().catch(() => { });
      this.webrtcClient = null;
    }
    this.connectionStartRequested = false;
    this.hasReceivedMatchInit = false;
    this.networkState.setMode("local");
    this.networkState.resetNetworkOnlyState();
    this.initializeTurnControllers();
    this.notifyNetworkStateChange();
  }

  private setupWebRTCCallbacks() {
    if (!this.webrtcClient) return;

    this.webrtcClient.onStateChange((state: ConnectionState) => {
      const previousLifecycle = this.networkState.getSnapshot().connection.lifecycle;
      this.networkState.updateConnectionLifecycle(state as any, Date.now());

      if (state === "connected" && previousLifecycle !== "connected") {
        this.swapToNetworkControllers();
        this.sendPlayerHello();
        const snapshot = this.networkState.getSnapshot();
        if (snapshot.mode === "network-host") {
          this.startNetworkMatchAsHost();
          this.networkState.setWaitingForSnapshot(false);
          this.sendMatchInit();
        } else if (snapshot.mode === "network-guest") {
          this.networkState.setWaitingForSnapshot(!this.hasReceivedMatchInit);
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
      if (message.type === "turn_effects") {
        this.deliverEffectsToSession(message.payload);
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
    this.startNetworkMatchAsHost();
    this.sendMatchInit();
  }

  private startNetworkMatchAsHost() {
    const state = this.networkState.getSnapshot();
    if (state.mode !== "network-host") return;
    this.session.restart({ startingTeamIndex: 0 });
    this.lastTurnStartMs = this.session.state.turnStartMs;
    this.cameraX = this.clampCameraX(this.activeWorm.x - this.width / 2);
    this.cameraTargetX = this.cameraX;
    this.cameraVelocityX = 0;
    this.cameraY = this.clampCameraY(this.activeWorm.y - this.height / 2);
    this.cameraTargetY = this.cameraY;
    this.cameraVelocityY = 0;
    this.updateCursor();
  }

  private handleMatchInit(snapshot: MatchInitSnapshot) {
    const state = this.networkState.getSnapshot();
    if (state.mode !== "network-guest") return;
    this.hasReceivedMatchInit = true;
    this.networkState.storePendingSnapshot(snapshot);
    this.applySnapshot(snapshot);
    this.networkState.storePendingSnapshot(null);
    this.networkState.setWaitingForSnapshot(false);
    this.notifyNetworkStateChange();
  }

  private applySnapshot(snapshot: MatchInitSnapshot) {
    // We no longer resize here, allowing the guest to have a different viewport size than the host's logic.
    /*
    if (snapshot.height !== this.height) {
      this.resize(this.width, snapshot.height);
    }
    */
    const nextSession = new GameSession(snapshot.width, snapshot.height, {
      horizontalPadding: snapshot.terrain.horizontalPadding,
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
    this.cameraY = this.clampCameraY(this.activeWorm.y - this.height / 2);
    this.cameraTargetY = this.cameraY;
    this.cameraVelocityY = 0;
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

  private deliverEffectsToSession(payload: TurnEffectsMessage["payload"]) {
    if (payload.turnIndex !== this.session.getTurnIndex()) return;
    if (payload.actingTeamId !== this.session.activeTeam.id) return;
    this.session.applyRemoteTurnEffects(payload);
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

  private showTurnStartArrowForCurrentTurn(initial: boolean) {
    this.activeWormArrow.onTurnStarted(
      {
        source: "system",
        turnIndex: this.session.getTurnIndex(),
        teamId: this.session.activeTeam.id,
        wormIndex: this.session.activeWormIndex,
        wind: this.session.wind,
        weapon: this.session.state.weapon,
        initial,
      },
      nowMs()
    );
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
        this.session.pauseFor(pausedFor);
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
      this.session.pauseFor(pausedFor);
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
      const showLog = this.networkState.getSnapshot().debug.showLog;
      if (showLog) {
        this.copyNetworkLogToClipboard();
      }
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

  private subscribeToGameEvents() {
    const signal = this.eventAbort.signal;
    gameEvents.on(
      "turn.started",
      (event) => {
        const snapshot = this.networkState.getSnapshot();
        if (snapshot.mode === "local") {
          if (!initialMenuDismissed) return;
        } else if (snapshot.connection.lifecycle !== "connected") {
          return;
        }
        this.activeWormArrow.onTurnStarted(event, nowMs());
      },
      { signal }
    );
    gameEvents.on(
      "worm.health.changed",
      (event) => this.damageFloaters.onWormHealthChanged(event, nowMs()),
      { signal }
    );
    gameEvents.on(
      "worm.killed",
      (event) => {
        const team = this.session.teams.find((t) => t.id === event.teamId);
        if (!team) return;
        const saluteDelayMs = 500;
        const startedAtMs = nowMs() + saluteDelayMs;
        for (const worm of team.worms) {
          if (worm.alive) worm.startSalute(startedAtMs);
        }
      },
      { signal }
    );

    gameEvents.on(
      "combat.explosion",
      (event) => this.handleSessionExplosion({ cause: event.cause, radius: event.radius }),
      { signal }
    );

    gameEvents.on(
      "combat.projectile.spawned",
      (event) => {
        this.sound.playProjectileLaunch({
          weapon: event.weapon,
          worldX: event.position.x,
          velocity: event.velocity,
          turnIndex: event.turnIndex,
          projectileId: event.projectileId,
        });
      },
      { signal }
    );

    gameEvents.on(
      "combat.projectile.exploded",
      (event) => {
        this.sound.playProjectileExploded({
          weapon: event.weapon,
          cause: event.cause,
          worldX: event.position.x,
          radius: event.radius,
          impact: event.impact,
          turnIndex: event.turnIndex,
          projectileId: event.projectileId,
        });
      },
      { signal }
    );

    gameEvents.on("match.restarted", () => this.resetCameraShake(), { signal });

    gameEvents.on(
      "turn.command.recorded",
      (event) => {
        if (
          event.command.type === "move" &&
          (event.command.move !== 0 || event.command.jump)
        ) {
          this.activeWormArrow.dismissForTurn({
            turnIndex: event.turnIndex,
            teamId: event.teamId,
            wormIndex: this.session.activeWormIndex,
          });
        }
        if (event.source !== "local-sim") return;
        this.handleLocalTurnCommand(event.command, { turnIndex: event.turnIndex, teamId: event.teamId });
      },
      { signal }
    );

    gameEvents.on(
      "combat.shot.fired",
      (event) => {
        this.activeWormArrow.dismissForTurn({
          turnIndex: event.turnIndex,
          teamId: event.teamId,
          wormIndex: event.wormIndex,
        });
      },
      { signal }
    );

    gameEvents.on(
      "turn.effects.emitted",
      (event) => {
        if (event.source !== "local-sim") return;
        this.handleLocalTurnEffects({
          turnIndex: event.turnIndex,
          actingTeamId: event.actingTeamId,
          terrainOperations: event.terrainOperations,
          wormHealth: event.wormHealth,
        });
      },
      { signal }
    );
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
    const minX = 0;
    const maxX = Math.max(0, groundWidth - viewWidth);

    const groundHeight = this.session.height;
    const viewHeight = this.height;

    // Allow scrolling up to the total height difference
    const maxY = Math.max(0, groundHeight - viewHeight);
    const minY = Math.min(0, groundHeight - viewHeight);

    return { minX, maxX, minY, maxY };
  }

  private clampCameraX(x: number) {
    const { minX, maxX } = this.getCameraBounds();
    return clamp(x, minX, maxX);
  }

  private clampCameraY(y: number) {
    const { minY, maxY } = this.getCameraBounds();
    return clamp(y, minY, maxY);
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
    let targetY = this.cameraTargetY;

    if (allowEdgeScroll) {
      const edgeDelta = this.getEdgeScrollDelta(dt, bounds);
      if (edgeDelta !== 0) {
        targetX += edgeDelta;
      }
    }

    targetX = clamp(targetX, bounds.minX, bounds.maxX);
    this.cameraTargetX = targetX;

    // Y scroll could also be edge-scrolled if we wanted, but for now X is sufficient or we can add Y edge scrolling logic too.
    // Let's just clamp Y target.
    targetY = clamp(targetY, bounds.minY, bounds.maxY);
    this.cameraTargetY = targetY;

    const stiffness = 18;
    const damping = 10;
    const delta = this.cameraTargetX - this.cameraX;
    this.cameraVelocityX += delta * stiffness * dt;
    const deltaY = this.cameraTargetY - this.cameraY;
    this.cameraVelocityY += deltaY * stiffness * dt;
    const decay = Math.exp(-damping * dt);
    this.cameraVelocityX *= decay;
    this.cameraX += this.cameraVelocityX * dt;
    this.cameraVelocityY *= decay;
    this.cameraY += this.cameraVelocityY * dt;

    const clampedX = clamp(this.cameraX, bounds.minX, bounds.maxX);
    const clampedY = clamp(this.cameraY, bounds.minY, bounds.maxY);

    if (clampedX !== this.cameraX) {
      this.cameraX = clampedX;
      this.cameraVelocityX = 0;
    }
    if (clampedY !== this.cameraY) {
      this.cameraY = clampedY;
      this.cameraVelocityY = 0;
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
    this.cameraTargetY = clamp(projectile.y - this.height / 2, bounds.minY, bounds.maxY);
    return true;
  }

  private focusCameraOnActiveWorm() {
    const margin = this.getCameraMargin();
    const bounds = this.getCameraBounds();
    const wormX = this.activeWorm.x;
    const wormY = this.activeWorm.y;
    const leftEdge = this.cameraX + margin;
    const rightEdge = this.cameraX + this.width - margin;
    const topEdge = this.cameraY + margin;
    const bottomEdge = this.cameraY + this.height - margin;
    let targetX = this.cameraTargetX;
    let targetY = this.cameraTargetY;

    if (wormX < leftEdge) {
      targetX = wormX - margin;
    } else if (wormX > rightEdge) {
      targetX = wormX - (this.width - margin);
    } else {
      // return; // Don't return here because we need to check Y
    }

    if (wormY < topEdge) {
      targetY = wormY - margin;
    } else if (wormY > bottomEdge) {
      targetY = wormY - (this.height - margin);
    }

    this.cameraTargetX = clamp(targetX, bounds.minX, bounds.maxX);
    this.cameraTargetY = clamp(targetY, bounds.minY, bounds.maxY);
  }

  private updateTurnFocus() {
    const turnStartMs = this.session.state.turnStartMs;
    if (turnStartMs === this.lastTurnStartMs) return;
    this.lastTurnStartMs = turnStartMs;
    this.focusCameraOnActiveWorm();
  }

  private updateCursor() {
    if (
      this.helpOverlay.isVisible() ||
      this.startMenu.isVisible() ||
      this.session.state.phase === "gameover"
    ) {
      this.canvas.style.cursor = "default";
      return;
    }
    if (
      this.session.state.weapon === WeaponType.Rifle ||
      this.session.state.weapon === WeaponType.Uzi
    ) {
      this.canvas.style.cursor = "none";
      return;
    }
    if (this.session.state.charging) {
      this.canvas.style.cursor = "crosshair";
      return;
    }
    this.canvas.style.cursor = "crosshair";
  }

  private copyNetworkLogToClipboard() {
    const snapshot = this.networkState.getSnapshot();
    const entries = snapshot.debug.recentMessages;
    const lines = entries.map((entry) => {
      const dir = entry.direction === "send" ? "->" : "<-";
      return `${entry.atMs.toFixed(0)} ${dir} ${entry.text}`;
    });
    const header =
      snapshot.mode === "local"
        ? "Network log (local mode)"
        : `Network log (${snapshot.mode}, role=${snapshot.player.role})`;
    const text = [header, ...lines].join("\n");

    const clipboard = navigator.clipboard;
    if (clipboard?.writeText) {
      clipboard.writeText(text).catch(() => {
        this.copyTextFallback(text);
      });
      return;
    }
    this.copyTextFallback(text);
  }

  private copyTextFallback(text: string) {
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.style.position = "fixed";
    textarea.style.left = "-9999px";
    textarea.style.top = "0";
    document.body.appendChild(textarea);
    textarea.focus();
    textarea.select();
    try {
      document.execCommand("copy");
    } catch {
      // ignore
    } finally {
      document.body.removeChild(textarea);
    }
  }

  getTeamHealth(id: TeamId) {
    return this.session.getTeamHealth(id);
  }

  predictPath(): PredictedPoint[] {
    return this.session.predictPath();
  }

  private getAimInfo(): AimInfo {
    return this.session.getRenderAimInfo();
  }

  render() {
    const now = nowMs();
    const networkSnapshot = this.networkState.getSnapshot();
    const ctx = this.ctx;
    const aim = this.getAimInfo();
    const state = this.session.state;
    ctx.save();
    ctx.translate(this.cameraOffsetX, this.cameraOffsetY);
    // Background should probably fill the screen regardless of camera Y? 
    // Or does it scroll? The background function draws a gradient.
    // If we scroll Y, we might see out of bounds.
    // Let's keep background fixed or adjust it. 
    // renderBackground fills rect from 0,0 to width,height. 
    // If we have vertical camera, we probably want the sky to stay fixed or parallax?
    // For now, let's just draw it covering the viewport.
    renderBackground(ctx, this.width, this.height, this.cameraPadding);
    ctx.restore();

    ctx.save();
    // Apply camera transform
    ctx.translate(-this.cameraX + this.cameraOffsetX, -this.cameraY + this.cameraOffsetY);
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
        const showAimPose =
          isActive &&
          (state.phase === "aim" ||
            ((state.phase === "projectile" || state.phase === "post") &&
              state.weapon !== WeaponType.HandGrenade));
        let poseAngle = aim.angle;
        let recoilKick01 = 0;
        if (isActive && state.phase === "projectile" && state.weapon === WeaponType.Uzi) {
          const burst = this.session.getUziBurstSnapshot();
          if (burst) {
            const turnAtMs = Math.max(0, now - state.turnStartMs);
            const visuals = computeUziVisuals({
              burst,
              turnAtMs,
              baseAimAngle: burst.aimAngle,
            });
            poseAngle = visuals.angle;
            recoilKick01 = visuals.recoilKick01;
          }
        }

        const aimPose = showAimPose
          ? {
              weapon: state.weapon,
              angle: poseAngle,
              ...(recoilKick01 > 0 ? { recoil: { kick01: recoilKick01 } } : {}),
            }
          : null;
        worm.render(ctx, isActive, aimPose);
      }
    }

    for (const projectile of this.session.projectiles) projectile.render(ctx);

    this.damageFloaters.render(ctx, this.session, now);
    this.activeWormArrow.render(ctx, this.session, now);

    renderAimHelpers({
      ctx,
      state,
      activeWorm: this.activeWorm,
      aim,
      predictedPath: this.predictPath(),
    });
    ctx.restore();

    ctx.save();
    ctx.translate(this.cameraOffsetX, this.cameraOffsetY);
    const teamLabels = getNetworkTeamNames(networkSnapshot) ?? undefined;
    const activeTeamLabel =
      getNetworkTeamName(networkSnapshot, this.activeTeam.id) ?? undefined;
    const networkMicroStatus = getNetworkMicroStatus(networkSnapshot) ?? undefined;
    const displayMessage = replaceWinnerInMessage(this.session.message, networkSnapshot);
    renderHUD(
      {
        ctx,
        width: this.width,
        height: this.height,
        state: this.session.state,
        now,
        activeTeamId: this.activeTeam.id,
        getTeamHealth: (teamId) => this.getTeamHealth(teamId),
        wind: this.session.wind,
        message: displayMessage,
        turnDurationMs: GAMEPLAY.turnTimeMs,
        ...(networkMicroStatus ? { networkMicroStatus } : {}),
        ...(teamLabels ? { teamLabels } : {}),
        ...(activeTeamLabel ? { activeTeamLabel } : {}),
      }
    );

    const overlaysBlocking =
      this.helpOverlay.isVisible() ||
      this.startMenu.isVisible() ||
      this.networkDialog.isVisible();
    if (!overlaysBlocking) {
      this.turnCountdown.render(ctx, this.session, now, this.width, this.height);
    }

    renderMapGadget({
      ctx,
      viewportWidth: this.width,
      viewportHeight: this.height,
      now,
      terrain: this.session.terrain,
      teams: this.teams,
      projectiles: this.session.projectiles,
    });

    renderGameOver({
      ctx,
      width: this.width,
      height: this.height,
      message: displayMessage,
      isGameOver: this.session.state.phase === "gameover",
    });

    renderNetworkLogHUD(ctx, this.width, this.height, this.networkState);

    const fpsText = `FPS: ${Math.round(this.fps)}`;
    drawText(ctx, fpsText, this.width - 12, this.height - 12, COLORS.white, 12, "right", "bottom");
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
    const networkPaused =
      networkSnapshot.mode !== "local" &&
      (networkSnapshot.connection.lifecycle !== "connected" || waitingForSync);
    this.updateTurnFocus();
    const followingProjectile = this.updatePassiveProjectileFocus();
    this.updateCamera(dt, !overlaysBlocking && !followingProjectile);
    this.sound.setListener({ centerX: this.cameraX + this.width / 2, viewportWidth: this.width });
    this.sound.update();
    const worldCameraOffsetX = -this.cameraX + this.cameraOffsetX;
    const worldCameraOffsetY = -this.cameraY + this.cameraOffsetY;
    if (networkPaused) {
      this.session.pauseFor(dt * 1000);
    }
    this.session.updateActiveTurnDriver(dt, {
      allowInput: !overlaysBlocking && !waitingForSync,
      input: this.input,
      camera: { offsetX: worldCameraOffsetX, offsetY: worldCameraOffsetY },
    });
    if (!overlaysBlocking && !networkPaused) {
      this.session.update(dt);
    }
    this.flushPendingTurnEffects(false);
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
