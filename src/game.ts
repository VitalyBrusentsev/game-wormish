import type { TeamId, PredictedPoint } from "./definitions";
import { GAMEPLAY, WeaponType, nowMs, COLORS, WORLD, clamp } from "./definitions";
import { Input, drawArrow, drawCircle, drawCrosshair, drawText } from "./utils";
import type { Worm } from "./entities";
import { HelpOverlay } from "./ui/help-overlay";
import { StartMenuOverlay } from "./ui/start-menu-overlay";
import { MatchResultOverlay } from "./ui/match-result-overlay";
import { NetworkMatchDialog, PLAYER_NAME_STORAGE_KEY } from "./ui/network-match-dialog";
import { gameEvents } from "./events/game-events";
import { DamageFloaters } from "./ui/damage-floaters";
import { ActiveWormArrow } from "./ui/active-worm-arrow";
import { TurnCountdownOverlay } from "./ui/turn-countdown";
import {
  renderAimHelpers,
  renderBackground,
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
import { AiTurnController } from "./game/ai-turn-controller";
import { assignAiTeamPersonalities } from "./ai/personality-assignment";
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
import { detectControlProfile, type ControlProfile } from "./mobile/control-profile";
import { MobileControlsOverlay, type MobileAimMode } from "./ui/mobile-controls";
import { MobileGestureController } from "./mobile/mobile-gesture-controller";
import {
  didMovementGetStuck,
  isForwardProgressBlocked,
} from "./movement/stuck-detection";

let initialMenuDismissed = false;

export type SinglePlayerTeamSide = "left" | "right";

export type SinglePlayerConfig = {
  playerTeamColor?: TeamId;
  playerStartSide?: SinglePlayerTeamSide;
};

export type GameOptions = {
  singlePlayer?: SinglePlayerConfig;
};

type ResolvedSinglePlayerConfig = {
  playerTeamColor: TeamId;
  playerStartSide: SinglePlayerTeamSide;
};

const resolveSinglePlayerConfig = (config?: SinglePlayerConfig): ResolvedSinglePlayerConfig => ({
  playerTeamColor: config?.playerTeamColor ?? "Blue",
  playerStartSide: config?.playerStartSide ?? "left",
});

const oppositeTeamId = (teamId: TeamId): TeamId => (teamId === "Red" ? "Blue" : "Red");

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

const replaceWinnerInMessage = (message: string | null, teamLabels?: Partial<Record<TeamId, string>>) => {
  if (!message) return null;

  const match = /^(Red|Blue) wins!/.exec(message);
  if (!match) return message;

  const teamId = match[1] as TeamId;
  const teamName = cleanPlayerName(teamLabels?.[teamId] ?? null);
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

const MOBILE_WORLD_ZOOM = 0.8;
const MOBILE_AIM_STAGE_ZOOM_MULTIPLIER = 0.7;
const MOBILE_GHOST_REACH_PX = 8;
const MOBILE_ASSIST_MOVE_STEP_MS = 120;
const MOBILE_ASSIST_STUCK_STEPS = 3;
const MOBILE_WORM_TOUCH_RADIUS_PX = 44;
const MOBILE_AIM_BUTTON_OFFSET_PX = 56;
const MOBILE_AIM_LINE_MAX_PX = 180;
const MOBILE_DEFAULT_AIM_DISTANCE_PX = 140;
const MOBILE_DEFAULT_AIM_ANGLE_UP_DEG = 30;
const MATCH_RESULT_DIALOG_DELAY_MS = 1000;

type MobileMovementAssistState = {
  destinationX: number;
  accumulatorMs: number;
  stuckSteps: number;
  jumpRequested: boolean;
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
  private matchResultDialog: MatchResultOverlay;
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
  private readonly singlePlayer: ResolvedSinglePlayerConfig;
  private singlePlayerName: string | null = null;
  private aimThrottleState: AimThrottleState | null = null;
  private moveThrottleState: MoveThrottleState | null = null;
  private pendingTurnEffects: TurnEffectsMessage["payload"] | null = null;
  private pendingTurnEffectsNextFlushAtMs = 0;
  private readonly turnEffectsFlushIntervalMs = 1000;
  private controlProfile: ControlProfile = "desktop";
  private worldZoom = 1;
  private mobileControls: MobileControlsOverlay | null = null;
  private mobileGestures: MobileGestureController | null = null;
  private mobileAimMode: MobileAimMode = "idle";
  private mobileAimZoomLocked = false;
  private mobileWeaponPickerOpen = false;
  private mobileAimButtonVisible = false;
  private mobileAimTarget: { x: number; y: number } | null = null;
  private mobileMovementGhostX: number | null = null;
  private mobileDraggingMovement = false;
  private mobileMovementAssist: MobileMovementAssistState | null = null;
  private matchResultDialogTimerId: number | null = null;

  constructor(width: number, height: number, options?: GameOptions) {
    this.width = width;
    this.height = height;
    this.singlePlayer = resolveSinglePlayerConfig(options?.singlePlayer);
    this.singlePlayerName = this.readSinglePlayerNameFromStorage();

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
    this.session = new GameSession(groundWidth, height, {
      horizontalPadding: 0,
      teamOrder: this.getSinglePlayerTeamOrder(),
    });

    this.initializeTurnControllers();
    this.refreshControlProfile();
    const initialWorldViewport = this.getWorldViewportSize();
    this.cameraX = this.clampCameraX(this.activeWorm.x - initialWorldViewport.width / 2);
    this.cameraTargetX = this.cameraX;
    this.cameraY = this.clampCameraY(this.activeWorm.y - initialWorldViewport.height / 2);
    this.cameraTargetY = this.cameraY;
    this.lastTurnStartMs = this.session.state.turnStartMs;

    this.helpOverlay = new HelpOverlay({
      onClose: (pausedMs, reason) => this.handleHelpClosed(pausedMs, reason),
    });

    this.networkDialog = new NetworkMatchDialog({
      onCreateRoom: async (playerName) => {
        this.singlePlayerName = cleanPlayerName(playerName);
        await this.createHostRoom({ registryUrl: this.registryUrl, playerName });
      },
      onLookupRoom: async (roomCode) => {
        await this.lookupRoom({ registryUrl: this.registryUrl, roomCode });
      },
      onJoinRoom: async (roomCode, joinCode, playerName) => {
        this.singlePlayerName = cleanPlayerName(playerName);
        await this.joinRoom({ registryUrl: this.registryUrl, playerName, roomCode, joinCode });
      },
      onCancel: () => {
        this.cancelNetworkSetup();
        this.restoreStartMenuAfterNetworkDialog();
      },
      onClose: (reason) => {
        if (reason === "escape") {
          this.input.consumeKey("Escape");
        }
        this.restoreStartMenuAfterNetworkDialog();
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
        this.restartSinglePlayerMatch();
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

    this.matchResultDialog = new MatchResultOverlay({
      onNewGame: () => {
        this.hideMatchResultDialog();
        this.restartMatchFromGameOver();
        this.canvas.focus();
        this.updateCursor();
      },
      onBack: () => {
        this.returnToStartModeFromGameOver();
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
    const playerTeamId = this.getSinglePlayerPlayerTeamId();
    for (const team of this.session.teams) {
      if (team.id === playerTeamId) {
        this.turnControllers.set(team.id, new LocalTurnController());
      } else {
        this.turnControllers.set(team.id, new AiTurnController());
      }
    }
    this.session.setTurnControllers(this.turnControllers);
    this.assignAiWormPersonalities();
  }

  private assignAiWormPersonalities() {
    for (const team of this.session.teams) {
      const controller = this.turnControllers.get(team.id);
      if (controller?.type !== "ai") continue;
      const enemyTeams = this.session.teams.filter((enemyTeam) => enemyTeam.id !== team.id);
      assignAiTeamPersonalities({
        team,
        enemyTeams,
        random: Math.random,
      });
    }
  }

  private refreshControlProfile() {
    const nextProfile = detectControlProfile();
    this.controlProfile = nextProfile;
    this.updateCanvasInterpolation();
    this.applyWorldZoom(this.getDesiredWorldZoom());

    if (nextProfile === "mobile-portrait") {
      this.ensureMobileControllers();
      this.canvas.style.touchAction = "none";
    } else {
      this.disposeMobileControllers();
      this.canvas.style.touchAction = "";
      this.resetMobileTransientState();
    }
  }

  private updateCanvasInterpolation() {
    this.canvas.classList.remove("canvas--mobile-smooth");
    this.ctx.imageSmoothingEnabled = true;
    this.ctx.imageSmoothingQuality = "high";
  }

  private ensureMobileControllers() {
    if (!this.mobileControls) {
      this.mobileControls = new MobileControlsOverlay({
        onToggleWeaponPicker: () => this.handleMobileToggleWeaponPicker(),
        onSelectWeapon: (weapon) => this.handleMobileSelectWeapon(weapon),
        onAimButton: () => this.handleMobileAimButton(),
        onCancel: () => this.handleMobileCancel(),
        onPrimary: () => this.handleMobilePrimary(),
        onJump: () => this.handleMobileJump(),
      });
    }
    if (this.canvas.parentElement) {
      this.mobileControls.mount();
    }

    if (!this.mobileGestures) {
      this.mobileGestures = new MobileGestureController(this.canvas, {
        isEnabled: () => this.canUseMobilePanning(),
        isAimGestureActive: () => this.mobileAimMode === "aim",
        screenToWorld: (screenX, screenY) => this.screenToWorld(screenX, screenY),
        canStartWormInteraction: (worldX, worldY) =>
          this.mobileAimMode === "idle" && this.canStartWormInteraction(worldX, worldY),
        onTap: (worldX, worldY) => this.handleMobileTap(worldX, worldY),
        onPan: (dx, dy) => this.panCameraByScreenDelta(dx, dy),
        onMovementDragStart: (worldX, worldY) => this.handleMobileMovementDragStart(worldX, worldY),
        onMovementDrag: (worldX, worldY) => this.handleMobileMovementDrag(worldX, worldY),
        onMovementDragEnd: (worldX, worldY) => this.handleMobileMovementDragEnd(worldX, worldY),
        onAimGesture: (worldX, worldY) => this.handleMobileAimGesture(worldX, worldY),
      });
    }
  }

  private disposeMobileControllers() {
    this.mobileGestures?.dispose();
    this.mobileGestures = null;
    this.mobileControls?.dispose();
    this.mobileControls = null;
  }

  private resetMobileTransientState() {
    this.mobileAimMode = "idle";
    this.mobileAimZoomLocked = false;
    this.mobileWeaponPickerOpen = false;
    this.mobileAimButtonVisible = false;
    this.mobileAimTarget = null;
    this.mobileDraggingMovement = false;
    this.mobileMovementGhostX = null;
    this.mobileMovementAssist = null;
  }

  private isMobileProfile() {
    return this.controlProfile === "mobile-portrait";
  }

  private getDesiredWorldZoom() {
    const baseZoom = this.isMobileProfile() ? MOBILE_WORLD_ZOOM : 1;
    if (!this.isMobileProfile()) return baseZoom;
    if (this.mobileAimZoomLocked || this.mobileAimMode === "aim" || this.mobileAimMode === "charge") {
      return baseZoom * MOBILE_AIM_STAGE_ZOOM_MULTIPLIER;
    }
    return baseZoom;
  }

  private applyWorldZoom(nextZoomRaw: number) {
    const nextZoom = clamp(nextZoomRaw, 0.35, 2);
    if (Math.abs(nextZoom - this.worldZoom) < 1e-6) return;

    const prevViewport = this.getWorldViewportSize();
    const cameraCenterX = this.cameraX + prevViewport.width / 2;
    const cameraCenterY = this.cameraY + prevViewport.height / 2;
    const targetCenterX = this.cameraTargetX + prevViewport.width / 2;
    const targetCenterY = this.cameraTargetY + prevViewport.height / 2;

    this.worldZoom = nextZoom;
    const nextViewport = this.getWorldViewportSize();
    const bounds = this.getCameraBounds();
    this.cameraX = clamp(cameraCenterX - nextViewport.width / 2, bounds.minX, bounds.maxX);
    this.cameraY = clamp(cameraCenterY - nextViewport.height / 2, bounds.minY, bounds.maxY);
    this.cameraTargetX = clamp(targetCenterX - nextViewport.width / 2, bounds.minX, bounds.maxX);
    this.cameraTargetY = clamp(targetCenterY - nextViewport.height / 2, bounds.minY, bounds.maxY);
    this.cameraVelocityX = 0;
    this.cameraVelocityY = 0;
  }

  private updateWorldZoomForMobileStage() {
    this.applyWorldZoom(this.getDesiredWorldZoom());
  }

  private getWorldViewportSize() {
    return {
      width: this.width / this.worldZoom,
      height: this.height / this.worldZoom,
    };
  }

  private hasBlockingOverlay() {
    return (
      this.helpOverlay.isVisible() ||
      this.startMenu.isVisible() ||
      this.matchResultDialog.isVisible() ||
      this.networkDialog.isVisible()
    );
  }

  private isActiveTeamLocallyControlled() {
    return this.turnControllers.get(this.activeTeam.id)?.type === "local";
  }

  private canUseMobilePanning() {
    if (!this.isMobileProfile()) return false;
    if (this.hasBlockingOverlay()) return false;
    if (!initialMenuDismissed) return false;
    return true;
  }

  private canUseMobileControls() {
    if (!this.canUseMobilePanning()) return false;
    if (!this.isActiveTeamLocallyControlled()) return false;
    if (!this.session.isLocalTurnActive()) return false;
    if (this.session.state.phase !== "aim") return false;

    const networkSnapshot = this.networkState.getSnapshot();
    if (networkSnapshot.mode === "local") return true;
    if (networkSnapshot.bridge.waitingForRemoteSnapshot) return false;
    return networkSnapshot.connection.lifecycle === "connected";
  }

  private screenToWorld(screenX: number, screenY: number) {
    return {
      x: (screenX - this.cameraOffsetX) / this.worldZoom + this.cameraX,
      y: (screenY - this.cameraOffsetY) / this.worldZoom + this.cameraY,
    };
  }

  private worldToScreen(worldX: number, worldY: number) {
    return {
      x: (worldX - this.cameraX) * this.worldZoom + this.cameraOffsetX,
      y: (worldY - this.cameraY) * this.worldZoom + this.cameraOffsetY,
    };
  }

  private panCameraByScreenDelta(deltaScreenX: number, deltaScreenY: number) {
    const bounds = this.getCameraBounds();
    this.cameraTargetX = clamp(
      this.cameraTargetX - deltaScreenX / this.worldZoom,
      bounds.minX,
      bounds.maxX
    );
    this.cameraTargetY = clamp(
      this.cameraTargetY - deltaScreenY / this.worldZoom,
      bounds.minY,
      bounds.maxY
    );
  }

  private canStartWormInteraction(worldX: number, worldY: number) {
    if (!this.canUseMobileControls()) return false;
    const active = this.activeWorm;
    if (!active.alive) return false;
    const maxR = Math.max(MOBILE_WORM_TOUCH_RADIUS_PX, active.radius * 2.8);
    const dist = Math.hypot(worldX - active.x, worldY - active.y);
    return dist <= maxR;
  }

  private handleMobileTap(worldX: number, worldY: number) {
    if (!this.canUseMobileControls()) return;
    if (!this.canStartWormInteraction(worldX, worldY)) return;
    this.mobileAimButtonVisible = true;
    this.mobileWeaponPickerOpen = false;
  }

  private handleMobileToggleWeaponPicker() {
    if (!this.canUseMobileControls()) return;
    if (this.mobileAimMode === "charge") return;
    this.mobileWeaponPickerOpen = !this.mobileWeaponPickerOpen;
  }

  private handleMobileSelectWeapon(weapon: WeaponType) {
    if (!this.canUseMobileControls()) return;
    if (this.mobileAimMode === "charge") return;
    this.session.setWeaponCommand(weapon);
    this.mobileWeaponPickerOpen = false;
  }

  private handleMobileAimButton() {
    if (!this.canUseMobileControls()) return;
    if (this.mobileAimMode !== "idle") return;
    this.mobileAimMode = "aim";
    this.mobileAimZoomLocked = true;
    this.mobileAimButtonVisible = false;
    this.mobileWeaponPickerOpen = false;
    const defaultTarget = this.getMobileDefaultAimTarget();
    this.mobileAimTarget = defaultTarget;
    this.session.setAimTargetCommand(defaultTarget.x, defaultTarget.y);
  }

  private handleMobileCancel() {
    if (!this.canUseMobileControls()) return;
    if (this.mobileAimMode === "charge") {
      this.session.cancelChargeCommand();
      this.mobileAimMode = "aim";
      return;
    }
    if (this.mobileAimMode === "aim") {
      this.mobileAimMode = "idle";
      this.mobileAimZoomLocked = false;
      this.mobileAimButtonVisible = false;
      this.mobileWeaponPickerOpen = false;
      this.mobileAimTarget = null;
    }
  }

  private handleMobilePrimary() {
    if (!this.canUseMobileControls()) return;
    if (this.mobileAimMode === "aim") {
      const weapon = this.session.state.weapon;
      if (weapon === WeaponType.Bazooka || weapon === WeaponType.HandGrenade) {
        if (this.session.startChargeCommand()) {
          this.mobileAimMode = "charge";
          this.mobileWeaponPickerOpen = false;
        }
        return;
      }
      if (this.session.fireCurrentWeaponCommand({ instantPower01: 1 })) {
        this.mobileAimMode = "idle";
        this.mobileAimButtonVisible = false;
        this.mobileAimTarget = null;
      }
      return;
    }
    if (this.mobileAimMode === "charge") {
      if (this.session.fireCurrentWeaponCommand()) {
        this.mobileAimMode = "idle";
        this.mobileAimButtonVisible = false;
        this.mobileAimTarget = null;
      }
    }
  }

  private handleMobileJump() {
    const movement = this.mobileMovementAssist;
    if (!movement) return;
    movement.jumpRequested = true;
  }

  private handleMobileAimGesture(worldX: number, worldY: number) {
    if (!this.canUseMobileControls()) return;
    if (this.mobileAimMode !== "aim") return;
    this.mobileAimTarget = { x: worldX, y: worldY };
    this.session.setAimTargetCommand(worldX, worldY);
  }

  private getMobileDefaultAimTarget() {
    const worm = this.activeWorm;
    const facing: -1 | 1 = worm.facing < 0 ? -1 : 1;
    const upAngle = (MOBILE_DEFAULT_AIM_ANGLE_UP_DEG * Math.PI) / 180;
    const angle = facing < 0 ? -Math.PI + upAngle : -upAngle;
    return {
      x: worm.x + Math.cos(angle) * MOBILE_DEFAULT_AIM_DISTANCE_PX,
      y: worm.y + Math.sin(angle) * MOBILE_DEFAULT_AIM_DISTANCE_PX,
    };
  }

  private handleMobileMovementDragStart(worldX: number, _worldY: number) {
    if (!this.canUseMobileControls()) return;
    if (this.mobileAimMode !== "idle") return;
    this.mobileDraggingMovement = true;
    this.mobileAimButtonVisible = false;
    this.mobileWeaponPickerOpen = false;
    this.mobileMovementGhostX = clamp(worldX, this.session.terrain.worldLeft, this.session.terrain.worldRight);
  }

  private handleMobileMovementDrag(worldX: number, _worldY: number) {
    if (!this.mobileDraggingMovement) return;
    this.mobileMovementGhostX = clamp(worldX, this.session.terrain.worldLeft, this.session.terrain.worldRight);
  }

  private handleMobileMovementDragEnd(worldX: number, _worldY: number) {
    if (!this.mobileDraggingMovement) return;
    this.mobileDraggingMovement = false;
    const destinationX = clamp(worldX, this.session.terrain.worldLeft, this.session.terrain.worldRight);
    if (Math.abs(destinationX - this.activeWorm.x) <= MOBILE_GHOST_REACH_PX) {
      this.mobileMovementGhostX = null;
      return;
    }
    this.mobileMovementAssist = {
      destinationX,
      accumulatorMs: 0,
      stuckSteps: 0,
      jumpRequested: false,
    };
    this.mobileMovementGhostX = destinationX;
    this.mobileAimButtonVisible = false;
  }

  private stopMobileMovementAssist(clearGhost: boolean) {
    this.mobileMovementAssist = null;
    this.mobileDraggingMovement = false;
    if (clearGhost) this.mobileMovementGhostX = null;
  }

  private updateMobileMovementAssist(dt: number) {
    const movement = this.mobileMovementAssist;
    if (!movement) return;
    if (!this.canUseMobileControls()) {
      this.stopMobileMovementAssist(true);
      return;
    }
    if (this.mobileAimMode !== "idle") {
      this.stopMobileMovementAssist(true);
      return;
    }

    const worm = this.activeWorm;
    if (Math.abs(movement.destinationX - worm.x) <= MOBILE_GHOST_REACH_PX) {
      this.stopMobileMovementAssist(true);
      return;
    }

    movement.accumulatorMs += dt * 1000;
    while (movement.accumulatorMs >= MOBILE_ASSIST_MOVE_STEP_MS) {
      movement.accumulatorMs -= MOBILE_ASSIST_MOVE_STEP_MS;
      const toward = movement.destinationX < worm.x ? -1 : 1;
      const direction = (toward < 0 ? -1 : 1) as -1 | 1;
      const before = { x: worm.x, y: worm.y };
      const moved = this.session.recordMovementStepCommand(
        direction,
        MOBILE_ASSIST_MOVE_STEP_MS,
        movement.jumpRequested,
        { movementSmoothingMode: "ai" }
      );
      movement.jumpRequested = false;
      if (!moved) {
        this.stopMobileMovementAssist(true);
        return;
      }
      const after = { x: worm.x, y: worm.y };
      const stuck =
        didMovementGetStuck(before, after) ||
        isForwardProgressBlocked(before, after, direction);
      movement.stuckSteps = stuck ? movement.stuckSteps + 1 : 0;
      if (movement.stuckSteps >= MOBILE_ASSIST_STUCK_STEPS) {
        this.stopMobileMovementAssist(true);
        return;
      }
      if (Math.abs(movement.destinationX - worm.x) <= MOBILE_GHOST_REACH_PX) {
        this.stopMobileMovementAssist(true);
        return;
      }
    }
  }

  private syncMobileControls() {
    if (!this.mobileControls) return;

    if (!this.isMobileProfile()) {
      this.mobileControls.setState({
        visible: false,
        weapon: this.session.state.weapon,
        canSelectWeapon: false,
        weaponPickerOpen: false,
        mode: "idle",
        showAimButton: false,
        aimButtonX: 0,
        aimButtonY: 0,
        showJumpButton: false,
      });
      return;
    }

    if (this.session.state.phase !== "aim") {
      this.mobileAimMode = "idle";
      this.mobileAimButtonVisible = false;
      this.mobileWeaponPickerOpen = false;
      this.mobileAimTarget = null;
      this.stopMobileMovementAssist(false);
    }

    if (this.mobileAimMode === "charge" && !this.session.state.charging) {
      this.mobileAimMode = this.session.state.phase === "aim" ? "aim" : "idle";
    }

    if (this.mobileAimMode === "aim" || this.mobileAimMode === "charge") {
      if (!this.mobileAimTarget) {
        const aim = this.session.getRenderAimInfo();
        this.mobileAimTarget = { x: aim.targetX, y: aim.targetY };
      }
    } else {
      this.mobileAimTarget = null;
    }

    const canUse = this.canUseMobileControls();
    const visible = canUse;
    const showAimButton = canUse && this.mobileAimMode === "idle" && this.mobileAimButtonVisible;
    const aimAnchor = this.worldToScreen(
      this.activeWorm.x,
      this.activeWorm.y - this.activeWorm.radius - MOBILE_AIM_BUTTON_OFFSET_PX
    );

    this.mobileControls.setState({
      visible,
      weapon: this.session.state.weapon,
      canSelectWeapon: canUse && this.mobileAimMode !== "charge",
      weaponPickerOpen: canUse && this.mobileAimMode !== "charge" && this.mobileWeaponPickerOpen,
      mode: canUse ? this.mobileAimMode : "idle",
      showAimButton,
      aimButtonX: aimAnchor.x,
      aimButtonY: aimAnchor.y,
      showJumpButton: canUse && this.mobileMovementAssist !== null,
    });
  }

  private restartSinglePlayerMatch() {
    this.session.restart();
    this.assignAiWormPersonalities();
    this.resetMobileTransientState();
  }

  private restartMatchFromGameOver() {
    this.clearMatchResultDialogTimer();
    const snapshot = this.networkState.getSnapshot();
    if (snapshot.mode === "local") {
      this.restartSinglePlayerMatch();
      return;
    }
    if (snapshot.mode === "network-host") {
      this.restartNetworkMatchAsHost();
      return;
    }
    this.sendNetworkMessage({ type: "match_restart_request", payload: {} });
  }

  private returnToStartModeFromGameOver() {
    this.clearMatchResultDialogTimer();
    this.hideMatchResultDialog();
    if (this.networkState.getSnapshot().mode !== "local") {
      this.cancelNetworkSetup();
    }
    this.restartSinglePlayerMatch();
    initialMenuDismissed = false;
    this.showStartMenu("start", false);
  }

  setTurnController(teamId: TeamId, controller: TurnDriver) {
    this.turnControllers.set(teamId, controller);
    this.session.setTurnControllers(this.turnControllers);
  }

  private getSinglePlayerPlayerTeamId(): TeamId {
    return this.singlePlayer.playerTeamColor;
  }

  private getSinglePlayerComputerTeamId(): TeamId {
    return oppositeTeamId(this.getSinglePlayerPlayerTeamId());
  }

  private getSinglePlayerTeamOrder(): readonly [TeamId, TeamId] {
    const playerTeamId = this.getSinglePlayerPlayerTeamId();
    const computerTeamId = this.getSinglePlayerComputerTeamId();
    return this.singlePlayer.playerStartSide === "left"
      ? [playerTeamId, computerTeamId]
      : [computerTeamId, playerTeamId];
  }

  private getSinglePlayerTeamLabels(): Record<TeamId, string> {
    const playerTeamId = this.getSinglePlayerPlayerTeamId();
    const computerTeamId = this.getSinglePlayerComputerTeamId();
    const playerName = this.singlePlayerName ?? "Player";
    return {
      [playerTeamId]: playerName,
      [computerTeamId]: "Computer",
    } as Record<TeamId, string>;
  }

  private readSinglePlayerNameFromStorage(): string | null {
    try {
      return cleanPlayerName(window.localStorage.getItem(PLAYER_NAME_STORAGE_KEY));
    } catch {
      return null;
    }
  }

  private getDisplayedTeamLabels(
    snapshot: NetworkSessionStateSnapshot
  ): Partial<Record<TeamId, string>> | null {
    if (snapshot.mode === "local") {
      return this.getSinglePlayerTeamLabels();
    }
    return getNetworkTeamNames(snapshot);
  }

  private getAliveWormCount(teamId: TeamId) {
    const team = this.session.teams.find((entry) => entry.id === teamId);
    if (!team) return 0;
    return team.worms.reduce((count, worm) => count + (worm.alive ? 1 : 0), 0);
  }

  private showMatchResultDialog(winner: TeamId | "Nobody") {
    const teamLabels = this.getDisplayedTeamLabels(this.networkState.getSnapshot());
    const winnerLabel =
      winner === "Nobody" ? "Nobody" : cleanPlayerName(teamLabels?.[winner] ?? null) ?? winner;
    const wormsLeft = winner === "Nobody" ? 0 : this.getAliveWormCount(winner);
    this.matchResultDialog.show({ winnerLabel, wormsLeft });
  }

  private scheduleMatchResultDialog(winner: TeamId | "Nobody") {
    this.clearMatchResultDialogTimer();
    this.matchResultDialogTimerId = window.setTimeout(() => {
      this.matchResultDialogTimerId = null;
      if (this.session.state.phase !== "gameover") return;
      this.showMatchResultDialog(winner);
      this.updateCursor();
    }, MATCH_RESULT_DIALOG_DELAY_MS);
  }

  private clearMatchResultDialogTimer() {
    if (this.matchResultDialogTimerId === null) return;
    window.clearTimeout(this.matchResultDialogTimerId);
    this.matchResultDialogTimerId = null;
  }

  private hideMatchResultDialog() {
    this.matchResultDialog.hide();
  }

  mount(parent: HTMLElement) {
    parent.appendChild(this.canvas);
    this.canvas.tabIndex = 0;
    this.canvas.focus();
    this.canvas.addEventListener("pointerdown", this.pointerDownFocusHandler);
    this.canvas.addEventListener("mousedown", this.mouseDownFocusHandler);
    this.canvas.addEventListener("touchstart", this.touchStartFocusHandler);
    this.sound.attachUnlockGestures(this.canvas, { signal: this.eventAbort.signal });
    if (this.isMobileProfile()) {
      this.ensureMobileControllers();
    }
  }

  resize(width: number, height: number) {
    const nextWidth = width | 0;
    const nextHeight = height | 0;
    if (nextWidth === this.width && nextHeight === this.height) return;
    const worldViewport = this.getWorldViewportSize();
    const centerX = this.cameraX + worldViewport.width / 2;
    this.width = nextWidth;
    this.height = nextHeight;
    this.canvas.width = this.width;
    this.canvas.height = this.height;
    this.refreshControlProfile();
    const nextWorldViewport = this.getWorldViewportSize();
    this.cameraX = this.clampCameraX(centerX - nextWorldViewport.width / 2);
    this.cameraTargetX = this.cameraX;
    this.cameraY = this.clampCameraY(this.activeWorm.y - nextWorldViewport.height / 2);
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
    this.clearMatchResultDialogTimer();
    this.startMenu.dispose();
    this.matchResultDialog.dispose();
    this.networkDialog.dispose();
    this.helpOverlay.dispose();
    this.disposeMobileControllers();
    this.input.detach();
    this.canvas.style.touchAction = "";
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
    this.singlePlayerName = this.readSinglePlayerNameFromStorage();
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
    this.session.restart({ startingTeamIndex: 0, teamOrder: ["Red", "Blue"] });
    this.lastTurnStartMs = this.session.state.turnStartMs;
    const worldViewport = this.getWorldViewportSize();
    this.cameraX = this.clampCameraX(this.activeWorm.x - worldViewport.width / 2);
    this.cameraTargetX = this.cameraX;
    this.cameraVelocityX = 0;
    this.cameraY = this.clampCameraY(this.activeWorm.y - worldViewport.height / 2);
    this.cameraTargetY = this.cameraY;
    this.cameraVelocityY = 0;
    this.resetMobileTransientState();
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
    const worldViewport = this.getWorldViewportSize();
    this.cameraX = this.clampCameraX(this.activeWorm.x - worldViewport.width / 2);
    this.cameraTargetX = this.cameraX;
    this.cameraVelocityX = 0;
    this.cameraY = this.clampCameraY(this.activeWorm.y - worldViewport.height / 2);
    this.cameraTargetY = this.cameraY;
    this.cameraVelocityY = 0;
    this.resetMobileTransientState();
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
    this.turnControllers.clear();
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

  private restoreStartMenuAfterNetworkDialog() {
    if (initialMenuDismissed) return;
    window.setTimeout(() => {
      if (initialMenuDismissed) return;
      if (this.networkDialog.isVisible()) return;
      this.showStartMenu("start", false);
      this.updateCursor();
    }, 0);
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

    if (this.matchResultDialog.isVisible()) {
      if (escapePressed) {
        this.input.consumeKey("Escape");
        this.returnToStartModeFromGameOver();
        this.canvas.focus();
        this.updateCursor();
      }
      return;
    }

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
      this.input.consumeKey("KeyR");
      this.hideMatchResultDialog();
      this.restartMatchFromGameOver();
      this.updateCursor();
      return;
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

    gameEvents.on(
      "match.restarted",
      () => {
        this.clearMatchResultDialogTimer();
        this.hideMatchResultDialog();
        this.resetCameraShake();
        this.updateCursor();
      },
      { signal }
    );

    gameEvents.on(
      "match.gameover",
      (event) => {
        this.scheduleMatchResultDialog(event.winner);
      },
      { signal }
    );

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
    const viewWidth = this.getWorldViewportSize().width;
    const minX = 0;
    const maxX = Math.max(0, groundWidth - viewWidth);

    const groundHeight = this.session.height;
    const viewHeight = this.getWorldViewportSize().height;

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
    const viewWidth = this.getWorldViewportSize().width;
    const base = Math.min(240, Math.max(120, viewWidth * 0.2));
    return Math.min(base, viewWidth * 0.45);
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
    const worldViewport = this.getWorldViewportSize();
    this.cameraTargetX = clamp(projectile.x - worldViewport.width / 2, bounds.minX, bounds.maxX);
    this.cameraTargetY = clamp(projectile.y - worldViewport.height / 2, bounds.minY, bounds.maxY);
    return true;
  }

  private focusCameraOnActiveWorm() {
    const worldViewport = this.getWorldViewportSize();
    const margin = this.getCameraMargin();
    const bounds = this.getCameraBounds();
    const wormX = this.activeWorm.x;
    const wormY = this.activeWorm.y;
    const leftEdge = this.cameraX + margin;
    const rightEdge = this.cameraX + worldViewport.width - margin;
    const topEdge = this.cameraY + margin;
    const bottomEdge = this.cameraY + worldViewport.height - margin;
    let targetX = this.cameraTargetX;
    let targetY = this.cameraTargetY;

    if (wormX < leftEdge) {
      targetX = wormX - margin;
    } else if (wormX > rightEdge) {
      targetX = wormX - (worldViewport.width - margin);
    } else {
      // return; // Don't return here because we need to check Y
    }

    if (wormY < topEdge) {
      targetY = wormY - margin;
    } else if (wormY > bottomEdge) {
      targetY = wormY - (worldViewport.height - margin);
    }

    this.cameraTargetX = clamp(targetX, bounds.minX, bounds.maxX);
    this.cameraTargetY = clamp(targetY, bounds.minY, bounds.maxY);
  }

  private updateTurnFocus() {
    const turnStartMs = this.session.state.turnStartMs;
    if (turnStartMs === this.lastTurnStartMs) return;
    this.lastTurnStartMs = turnStartMs;
    if (this.isMobileProfile()) {
      this.mobileAimMode = "idle";
      this.mobileAimZoomLocked = false;
      this.mobileAimButtonVisible = false;
      this.mobileWeaponPickerOpen = false;
      this.mobileAimTarget = null;
      this.stopMobileMovementAssist(true);
      this.updateWorldZoomForMobileStage();
    }
    this.focusCameraOnActiveWorm();
  }

  private updateCursor() {
    if (this.isMobileProfile()) {
      this.canvas.style.cursor = "default";
      return;
    }
    if (
      this.helpOverlay.isVisible() ||
      this.startMenu.isVisible() ||
      this.matchResultDialog.isVisible() ||
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

  private getTerrainSurfaceY(worldX: number) {
    const terrain = this.session.terrain;
    const idx = clamp(Math.round(worldX - terrain.worldLeft), 0, terrain.heightMap.length - 1);
    const topSolidY = terrain.heightMap[idx] ?? terrain.height;
    return topSolidY - this.activeWorm.radius;
  }

  private renderMobileMovementGhost(ctx: CanvasRenderingContext2D) {
    if (!this.isMobileProfile()) return;
    const ghostX = this.mobileMovementGhostX;
    if (ghostX === null) return;
    if (this.session.state.phase !== "aim") return;
    const worm = this.activeWorm;
    if (!worm.alive) return;
    const ghostY = this.getTerrainSurfaceY(ghostX);
    const toward = ghostX < worm.x ? -1 : 1;
    const direction = (toward < 0 ? -1 : 1) as -1 | 1;
    const ringCol = this.mobileMovementAssist
      ? "rgba(150, 255, 200, 0.95)"
      : "rgba(255, 250, 170, 0.95)";
    ctx.save();
    ctx.globalAlpha = 0.9;
    ctx.strokeStyle = ringCol;
    ctx.lineWidth = 2;
    drawCircle(ctx, ghostX, ghostY, worm.radius * 0.92);
    ctx.stroke();
    drawArrow(
      ctx,
      worm.x,
      worm.y - worm.radius * 1.8,
      direction < 0 ? Math.PI : 0,
      Math.max(24, Math.min(140, Math.abs(ghostX - worm.x))),
      ringCol,
      3
    );
    ctx.restore();
  }

  private renderMobileAimDragCrosshair(ctx: CanvasRenderingContext2D, aim: AimInfo) {
    if (!this.isMobileProfile()) return;
    if (this.mobileAimMode !== "aim" && this.mobileAimMode !== "charge") return;
    if (this.session.state.phase !== "aim") return;
    const worm = this.activeWorm;
    if (!worm.alive) return;

    const target = { x: aim.targetX, y: aim.targetY };
    const dx = target.x - worm.x;
    const dy = target.y - worm.y;
    const len = Math.hypot(dx, dy) || 1;
    const clampedLen = Math.min(len, MOBILE_AIM_LINE_MAX_PX);
    const ex = worm.x + (dx / len) * clampedLen;
    const ey = worm.y + (dy / len) * clampedLen;

    ctx.save();
    ctx.strokeStyle = "rgba(255, 228, 145, 0.9)";
    ctx.lineWidth = 2;
    ctx.setLineDash([6, 4]);
    ctx.beginPath();
    ctx.moveTo(worm.x, worm.y);
    ctx.lineTo(ex, ey);
    ctx.stroke();
    ctx.setLineDash([]);
    drawCrosshair(ctx, ex, ey, 10, "#ffe891", 2);
    ctx.restore();
  }

  private renderWorldWater(ctx: CanvasRenderingContext2D) {
    const worldViewport = this.getWorldViewportSize();
    const worldBottom = this.cameraY + worldViewport.height + this.cameraPadding / this.worldZoom;
    const waterTopY = this.session.height - 30;
    const fillHeight = Math.max(40, worldBottom - waterTopY + 120);
    const terrain = this.session.terrain;
    const padX = Math.max(200, terrain.width * 0.1);
    const x = terrain.worldLeft - padX;
    const w = terrain.worldRight - terrain.worldLeft + padX * 2;

    ctx.save();
    ctx.fillStyle = COLORS.water;
    ctx.fillRect(x, waterTopY, w, fillHeight);
    ctx.restore();
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
    renderBackground(ctx, this.width, this.height, this.cameraPadding, false);
    ctx.restore();

    ctx.save();
    // Apply camera transform
    ctx.translate(this.cameraOffsetX, this.cameraOffsetY);
    ctx.scale(this.worldZoom, this.worldZoom);
    ctx.translate(-this.cameraX, -this.cameraY);
    this.renderWorldWater(ctx);
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
    this.renderMobileAimDragCrosshair(ctx, aim);
    this.renderMobileMovementGhost(ctx);

    renderAimHelpers({
      ctx,
      state,
      activeWorm: this.activeWorm,
      aim,
      predictedPath: this.predictPath(),
      showDesktopAssist: !this.isMobileProfile(),
    });
    ctx.restore();

    ctx.save();
    ctx.translate(this.cameraOffsetX, this.cameraOffsetY);
    const displayTeamLabels = this.getDisplayedTeamLabels(networkSnapshot);
    const teamDisplayOrder =
      networkSnapshot.mode === "local" ? this.getSinglePlayerTeamOrder() : undefined;
    const teamLabels = displayTeamLabels ?? undefined;
    const activeTeamLabel = displayTeamLabels?.[this.activeTeam.id] ?? undefined;
    const networkMicroStatus = getNetworkMicroStatus(networkSnapshot) ?? undefined;
    const displayMessage = replaceWinnerInMessage(this.session.message, displayTeamLabels ?? undefined);
    renderHUD(
      {
        ctx,
        width: this.width,
        height: this.height,
        state: this.session.state,
        now,
        activeTeamId: this.activeTeam.id,
        ...(teamDisplayOrder ? { teamDisplayOrder } : {}),
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
      this.matchResultDialog.isVisible() ||
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
      showRadar: initialMenuDismissed,
      ...(this.isMobileProfile() ? { maxWidthPx: Math.floor(this.width * 0.5) } : {}),
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
      this.matchResultDialog.isVisible() ||
      this.networkDialog.isVisible();
    const networkSnapshot = this.networkState.getSnapshot();
    const waitingForSync =
      networkSnapshot.mode !== "local" &&
      networkSnapshot.bridge.waitingForRemoteSnapshot;
    const networkPaused =
      networkSnapshot.mode !== "local" &&
      (networkSnapshot.connection.lifecycle !== "connected" || waitingForSync);
    this.updateTurnFocus();
    this.updateWorldZoomForMobileStage();
    const followingProjectile = this.updatePassiveProjectileFocus();
    this.updateCamera(
      dt,
      !this.isMobileProfile() && !overlaysBlocking && !followingProjectile
    );
    const worldViewport = this.getWorldViewportSize();
    this.sound.setListener({
      centerX: this.cameraX + worldViewport.width / 2,
      viewportWidth: worldViewport.width,
    });
    this.sound.update();
    const worldCameraOffsetX = this.cameraOffsetX - this.cameraX * this.worldZoom;
    const worldCameraOffsetY = this.cameraOffsetY - this.cameraY * this.worldZoom;
    if (networkPaused) {
      this.session.pauseFor(dt * 1000);
    }
    this.session.updateActiveTurnDriver(dt, {
      allowInput: !overlaysBlocking && !waitingForSync,
      allowLocalInput: !this.isMobileProfile(),
      input: this.input,
      camera: { offsetX: worldCameraOffsetX, offsetY: worldCameraOffsetY, zoom: this.worldZoom },
    });
    if (!networkPaused) {
      this.updateMobileMovementAssist(dt);
    } else {
      this.stopMobileMovementAssist(false);
    }
    if (!overlaysBlocking && !networkPaused) {
      this.session.update(dt);
    }
    this.flushPendingTurnEffects(false);
    this.flushTurnResolution();
    this.updateCameraShake(dt);
    this.syncMobileControls();
    this.render();
    this.input.update();
    this.lastTimeMs = timeMs;
    if (this.running) {
      this.frameHandle = requestAnimationFrame(this.frameCallback);
    }
  }
}
