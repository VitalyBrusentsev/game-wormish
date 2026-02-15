import type { TeamId, PredictedPoint } from "./definitions";
import { GAMEPLAY, WeaponType, nowMs, COLORS, WORLD, clamp } from "./definitions";
import { Input, drawArrow, drawCrosshair, drawRoundedRect, drawText } from "./utils";
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
import { getMapGadgetBottomY, renderMapGadget } from "./ui/map-gadget";
import { drawMenuIconSprite } from "./ui/menu-icons";
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
import {
  NetworkSessionState,
  type NetworkLogSetting,
  type NetworkSessionStateSnapshot,
} from "./network/session-state";
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

export type FrameSimulationPolicy = {
  waitingForSync: boolean;
  networkPaused: boolean;
  simulationPaused: boolean;
};

export const computeFrameSimulationPolicy = (
  snapshot: NetworkSessionStateSnapshot,
  overlaysBlocking: boolean
): FrameSimulationPolicy => {
  const waitingForSync =
    snapshot.mode !== "local" &&
    snapshot.bridge.waitingForRemoteSnapshot;
  const networkPaused =
    snapshot.mode !== "local" &&
    (snapshot.connection.lifecycle !== "connected" || waitingForSync);
  const overlayPausesSimulation = overlaysBlocking && snapshot.mode === "local";

  return {
    waitingForSync,
    networkPaused,
    simulationPaused: overlayPausesSimulation || networkPaused,
  };
};

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
const MOBILE_AIM_GESTURE_ZONE_RADIUS_PX = 56;
const MOBILE_AIM_BUTTON_OFFSET_PX = 56;
const MOBILE_AIM_LINE_MAX_PX = 180;
const MOBILE_DEFAULT_AIM_DISTANCE_PX = 140;
const MOBILE_DEFAULT_AIM_ANGLE_UP_DEG = 30;
const MATCH_RESULT_DIALOG_DELAY_MS = 1000;
const SETTINGS_BUTTON_SIZE_PX = 48;
const SETTINGS_BUTTON_PADDING_PX = 14;
const SETTINGS_ICON_WIDTH_PX = 28;
const SETTINGS_ICON_HEIGHT_PX = SETTINGS_ICON_WIDTH_PX * (132 / 160);
const SETTINGS_GHOST_CLICK_SUPPRESSION_MS = 650;
const SETTINGS_GHOST_CLICK_RADIUS_PX = 36;
const NETWORK_TEARDOWN_TIMEOUT_MS = 3000;
const DEFAULT_MENU_SFX_LEVEL = 0.9;
const DEFAULT_MENU_MUSIC_LEVEL = 0.6;

type Rect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

type MobileMovementAssistState = {
  destinationX: number;
  accumulatorMs: number;
  stuckSteps: number;
  jumpRequested: boolean;
};

type MobileMovementGhostSprite = {
  canvas: HTMLCanvasElement;
  anchorX: number;
  anchorY: number;
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
  private helpOverlayPausesSimulation = false;
  private startMenuOpenedAtMs: number | null = null;
  private startMenuPausesSimulation = false;

  private readonly networkState: NetworkSessionState;
  private webrtcClient: WebRTCRegistryClient | null = null;
  private networkStateChangeCallbacks: ((state: NetworkSessionState) => void)[] = [];
  private readonly registryUrl: string;
  private connectionStartRequested = false;
  private hasReceivedMatchInit = false;
  private networkClientGeneration = 0;
  private restartMissionTask: Promise<void> | null = null;

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
  private pageLifecycleHidden = false;
  private backgroundSuspendedAtMs: number | null = null;

  private lastTimeMs = 0;

  private readonly pointerDownFocusHandler = () => this.canvas.focus();
  private readonly pointerDownSettingsHandler = (event: PointerEvent) => {
    if (!event.isPrimary) return;
    if (event.pointerType === "mouse" && event.button !== 0) return;
    if (!this.isSettingsButtonVisible()) return;

    const pointer = this.clientToCanvasPoint(event.clientX, event.clientY);
    if (!pointer) return;
    if (!this.isPointInsideRect(pointer.x, pointer.y, this.getSettingsButtonScreenBounds())) return;

    if (event.pointerType !== "mouse") {
      this.armSettingsGhostClickSuppression(event.clientX, event.clientY);
    }
    this.openPauseMenu();
    event.preventDefault();
    event.stopPropagation();
  };
  private readonly globalClickSuppressionHandler = (event: MouseEvent) => {
    if (!this.shouldSuppressSettingsGhostClick(event)) return;
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
    this.clearSettingsGhostClickSuppression();
  };
  private readonly mouseDownFocusHandler = () => this.canvas.focus();
  private readonly touchStartFocusHandler = () => this.canvas.focus();
  private readonly visibilityChangeHandler = () => {
    this.syncBackgroundSuspension();
  };
  private readonly pageHideHandler = () => {
    this.pageLifecycleHidden = true;
    this.syncBackgroundSuspension();
  };
  private readonly pageShowHandler = () => {
    this.pageLifecycleHidden = false;
    this.syncBackgroundSuspension();
  };

  private readonly eventAbort = new AbortController();
  private readonly damageFloaters = new DamageFloaters();
  private readonly activeWormArrow = new ActiveWormArrow();
  private readonly turnCountdown = new TurnCountdownOverlay();
  private readonly sound = new SoundSystem();
  private lastMenuSfxLevel = DEFAULT_MENU_SFX_LEVEL;
  private lastMenuMusicLevel = DEFAULT_MENU_MUSIC_LEVEL;

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
  private mobileMovementGhostSprite: MobileMovementGhostSprite | null = null;
  private mobileDraggingMovement = false;
  private mobileMovementAssist: MobileMovementAssistState | null = null;
  private matchResultDialogTimerId: number | null = null;
  private settingsGhostClickUntilMs = 0;
  private settingsGhostClickClientPoint: { x: number; y: number } | null = null;

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
    this.sound.setLevels({ music: 0 });

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
        void this.restartMissionFromPauseMenu()
          .catch(() => { })
          .finally(() => {
            this.canvas.focus();
            this.updateCursor();
          });
      },
      onNetworkMatch: () => {
        this.hideStartMenu();
        this.networkDialog.show("host");
      },
      getAudioToggles: () => this.getMenuAudioToggles(),
      onToggleSound: (enabled) => this.setMenuSoundEnabled(enabled),
      onToggleMusic: (enabled) => this.setMenuMusicEnabled(enabled),
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
    this.ensureMobileControllers();

    if (nextProfile === "mobile-portrait") {
      this.canvas.style.touchAction = "none";
    } else {
      this.disposeMobileGestures();
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

    if (!this.isMobileProfile()) {
      this.disposeMobileGestures();
      return;
    }

    if (!this.mobileGestures) {
      this.mobileGestures = new MobileGestureController(this.canvas, {
        isEnabled: () => this.canUseMobilePanning(),
        canStartAimGesture: (canvasX, canvasY) => this.canStartMobileAimGesture(canvasX, canvasY),
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

  private disposeMobileGestures() {
    this.mobileGestures?.dispose();
    this.mobileGestures = null;
  }

  private disposeMobileControllers() {
    this.disposeMobileGestures();
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
    this.mobileMovementGhostSprite = null;
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
    if (!this.canUseWeaponSelector()) return false;
    if (!this.canUseMobilePanning()) return false;
    return true;
  }

  private canUseWeaponSelector() {
    if (this.hasBlockingOverlay()) return false;
    if (!initialMenuDismissed) return false;
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

  private clientToCanvasPoint(clientX: number, clientY: number) {
    const rect = this.canvas.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;
    return {
      x: (clientX - rect.left) * (this.canvas.width / rect.width),
      y: (clientY - rect.top) * (this.canvas.height / rect.height),
    };
  }

  private isPointInsideRect(x: number, y: number, rect: Rect) {
    return x >= rect.x && x <= rect.x + rect.width && y >= rect.y && y <= rect.y + rect.height;
  }

  private isSettingsButtonVisible() {
    return initialMenuDismissed && !this.hasBlockingOverlay();
  }

  private getSettingsButtonLayoutBounds(): Rect {
    return {
      x: this.width - SETTINGS_BUTTON_PADDING_PX - SETTINGS_BUTTON_SIZE_PX,
      y: this.height - SETTINGS_BUTTON_PADDING_PX - SETTINGS_BUTTON_SIZE_PX,
      width: SETTINGS_BUTTON_SIZE_PX,
      height: SETTINGS_BUTTON_SIZE_PX,
    };
  }

  private getSettingsButtonScreenBounds(): Rect {
    const layout = this.getSettingsButtonLayoutBounds();
    return {
      x: layout.x + this.cameraOffsetX,
      y: layout.y + this.cameraOffsetY,
      width: layout.width,
      height: layout.height,
    };
  }

  private openPauseMenu() {
    this.showStartMenu(initialMenuDismissed ? "pause" : "start", initialMenuDismissed);
    this.updateCursor();
  }

  private armSettingsGhostClickSuppression(clientX: number, clientY: number) {
    this.settingsGhostClickUntilMs = nowMs() + SETTINGS_GHOST_CLICK_SUPPRESSION_MS;
    this.settingsGhostClickClientPoint = { x: clientX, y: clientY };
  }

  private clearSettingsGhostClickSuppression() {
    this.settingsGhostClickUntilMs = 0;
    this.settingsGhostClickClientPoint = null;
  }

  private shouldSuppressSettingsGhostClick(event: MouseEvent) {
    if (this.settingsGhostClickUntilMs <= 0 || this.settingsGhostClickClientPoint === null) return false;
    if (nowMs() > this.settingsGhostClickUntilMs) {
      this.clearSettingsGhostClickSuppression();
      return false;
    }
    const point = this.settingsGhostClickClientPoint;
    const dx = event.clientX - point.x;
    const dy = event.clientY - point.y;
    return dx * dx + dy * dy <= SETTINGS_GHOST_CLICK_RADIUS_PX * SETTINGS_GHOST_CLICK_RADIUS_PX;
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

  private canStartMobileAimGesture(canvasX: number, canvasY: number) {
    if (!this.canUseMobileControls()) return false;
    if (this.mobileAimMode !== "aim") return false;
    const aim = this.session.getRenderAimInfo();
    const anchorWorld = this.getMobileAimAnchorWorldPoint(aim);
    const anchor = this.worldToScreen(anchorWorld.x, anchorWorld.y);
    const dx = canvasX - anchor.x;
    const dy = canvasY - anchor.y;
    return dx * dx + dy * dy <= MOBILE_AIM_GESTURE_ZONE_RADIUS_PX * MOBILE_AIM_GESTURE_ZONE_RADIUS_PX;
  }

  private handleMobileTap(worldX: number, worldY: number) {
    if (!this.canUseMobileControls()) return;
    if (!this.canStartWormInteraction(worldX, worldY)) return;
    this.mobileAimButtonVisible = true;
    this.mobileWeaponPickerOpen = false;
  }

  private handleMobileToggleWeaponPicker() {
    if (!this.canUseWeaponSelector()) return;
    if (this.mobileAimMode === "charge" || this.session.state.charging) return;
    this.mobileWeaponPickerOpen = !this.mobileWeaponPickerOpen;
  }

  private handleMobileSelectWeapon(weapon: WeaponType) {
    if (!this.canUseWeaponSelector()) return;
    if (this.mobileAimMode === "charge" || this.session.state.charging) return;
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
    this.captureMobileMovementGhostSprite();
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
      this.mobileMovementGhostSprite = null;
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
    if (clearGhost) {
      this.mobileMovementGhostX = null;
      this.mobileMovementGhostSprite = null;
    }
  }

  private captureMobileMovementGhostSprite() {
    const worm = this.activeWorm;
    if (!worm.alive) {
      this.mobileMovementGhostSprite = null;
      return;
    }

    const spriteSize = Math.max(112, Math.ceil(worm.radius * 8));
    const spriteCanvas = this.canvas.ownerDocument.createElement("canvas");
    spriteCanvas.width = spriteSize;
    spriteCanvas.height = spriteSize;
    const spriteCtx = spriteCanvas.getContext("2d");
    if (!spriteCtx) {
      this.mobileMovementGhostSprite = null;
      return;
    }

    const anchorX = spriteSize * 0.5;
    const anchorY = Math.round(spriteSize * 0.58);
    const clipTop = Math.max(0, Math.floor(anchorY - 44));
    spriteCtx.save();
    spriteCtx.beginPath();
    spriteCtx.rect(0, clipTop, spriteSize, spriteSize - clipTop);
    spriteCtx.clip();
    spriteCtx.translate(anchorX - worm.x, anchorY - worm.y);
    worm.render(spriteCtx, false, null);
    spriteCtx.restore();
    this.mobileMovementGhostSprite = { canvas: spriteCanvas, anchorX, anchorY };
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

    const canUseMobile = this.canUseMobileControls();
    const canUseWeaponSelector = this.canUseWeaponSelector();
    const canSelectWeapon =
      canUseWeaponSelector && this.mobileAimMode !== "charge" && !this.session.state.charging;
    if (!canSelectWeapon) {
      this.mobileWeaponPickerOpen = false;
    }
    const visible = canUseWeaponSelector || canUseMobile;
    const showAimButton = canUseMobile && this.mobileAimMode === "idle" && this.mobileAimButtonVisible;
    const aimAnchor = this.worldToScreen(
      this.activeWorm.x,
      this.activeWorm.y - this.activeWorm.radius - MOBILE_AIM_BUTTON_OFFSET_PX
    );

    this.mobileControls.setState({
      visible,
      weapon: this.session.state.weapon,
      canSelectWeapon,
      weaponPickerOpen: canSelectWeapon && this.mobileWeaponPickerOpen,
      mode: canUseMobile ? this.mobileAimMode : "idle",
      showAimButton,
      aimButtonX: aimAnchor.x,
      aimButtonY: aimAnchor.y,
      showJumpButton: canUseMobile && this.mobileMovementAssist !== null,
    });
  }

  private restartSinglePlayerMatch() {
    this.session.restart();
    this.assignAiWormPersonalities();
    this.resetMobileTransientState();
  }

  private restartMissionFromPauseMenu(): Promise<void> {
    if (this.restartMissionTask) {
      return this.restartMissionTask;
    }

    const task = (async () => {
      if (this.networkState.getSnapshot().mode !== "local") {
        await this.teardownNetworkSession(true);
      }
      this.restartSinglePlayerMatch();
    })();
    this.restartMissionTask = task;
    void task.then(
      () => {
        if (this.restartMissionTask === task) {
          this.restartMissionTask = null;
        }
      },
      () => {
        if (this.restartMissionTask === task) {
          this.restartMissionTask = null;
        }
      }
    );
    return task;
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

  private isPageBackgrounded() {
    return this.pageLifecycleHidden || document.visibilityState === "hidden";
  }

  private cancelScheduledFrame() {
    if (this.frameHandle === null) return;
    cancelAnimationFrame(this.frameHandle);
    this.frameHandle = null;
  }

  private syncBackgroundSuspension() {
    if (this.isPageBackgrounded()) {
      this.enterBackgroundSuspension();
      return;
    }
    this.exitBackgroundSuspension();
  }

  private enterBackgroundSuspension() {
    if (this.backgroundSuspendedAtMs !== null) return;
    this.backgroundSuspendedAtMs = nowMs();
    this.session.setSimulationPaused(true);
    this.stopMobileMovementAssist(false);
    this.cancelScheduledFrame();
    this.lastTimeMs = 0;
  }

  private exitBackgroundSuspension() {
    const suspendedAtMs = this.backgroundSuspendedAtMs;
    if (suspendedAtMs === null) return;
    this.backgroundSuspendedAtMs = null;

    const networkSnapshot = this.networkState.getSnapshot();
    if (networkSnapshot.mode === "local") {
      const pausedForMs = Math.max(0, nowMs() - suspendedAtMs);
      if (pausedForMs > 0) {
        this.session.pauseFor(pausedForMs);
      }
    }

    this.session.setSimulationPaused(false);
    this.lastTimeMs = 0;
    if (this.running && this.frameHandle === null) {
      this.frameHandle = requestAnimationFrame(this.frameCallback);
    }
  }

  mount(parent: HTMLElement) {
    parent.appendChild(this.canvas);
    this.canvas.tabIndex = 0;
    this.canvas.focus();
    window.addEventListener("click", this.globalClickSuppressionHandler, {
      capture: true,
      signal: this.eventAbort.signal,
    });
    this.canvas.addEventListener("pointerdown", this.pointerDownSettingsHandler, { capture: true });
    this.canvas.addEventListener("pointerdown", this.pointerDownFocusHandler);
    this.canvas.addEventListener("mousedown", this.mouseDownFocusHandler);
    this.canvas.addEventListener("touchstart", this.touchStartFocusHandler);
    document.addEventListener("visibilitychange", this.visibilityChangeHandler, {
      signal: this.eventAbort.signal,
    });
    window.addEventListener("pagehide", this.pageHideHandler, {
      signal: this.eventAbort.signal,
    });
    window.addEventListener("pageshow", this.pageShowHandler, {
      signal: this.eventAbort.signal,
    });
    this.sound.attachUnlockGestures(this.canvas, { signal: this.eventAbort.signal });
    this.ensureMobileControllers();
    this.syncBackgroundSuspension();
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
    this.syncBackgroundSuspension();
  }

  dispose() {
    this.cancelScheduledFrame();
    this.running = false;
    this.backgroundSuspendedAtMs = null;
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
    this.canvas.removeEventListener("pointerdown", this.pointerDownSettingsHandler, { capture: true });
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

  private getMenuAudioToggles() {
    const snapshot = this.sound.getSnapshot();
    return {
      soundOn: snapshot.enabled && snapshot.levels.sfx > 0,
      musicOn: snapshot.enabled && snapshot.levels.music > 0,
    };
  }

  private setMenuSoundEnabled(enabled: boolean) {
    const snapshot = this.sound.getSnapshot();
    if (enabled) {
      this.sound.setEnabled(true);
      const nextLevel = this.lastMenuSfxLevel > 0 ? this.lastMenuSfxLevel : DEFAULT_MENU_SFX_LEVEL;
      this.sound.setLevels({ sfx: nextLevel });
      void this.sound.unlock().catch(() => { });
      return;
    }

    if (snapshot.levels.sfx > 0) {
      this.lastMenuSfxLevel = snapshot.levels.sfx;
    }
    this.sound.setLevels({ sfx: 0 });
  }

  private setMenuMusicEnabled(enabled: boolean) {
    const snapshot = this.sound.getSnapshot();
    if (enabled) {
      this.sound.setEnabled(true);
      const nextLevel = this.lastMenuMusicLevel > 0 ? this.lastMenuMusicLevel : DEFAULT_MENU_MUSIC_LEVEL;
      this.sound.setLevels({ music: nextLevel });
      void this.sound.unlock().catch(() => { });
      return;
    }

    if (snapshot.levels.music > 0) {
      this.lastMenuMusicLevel = snapshot.levels.music;
    }
    this.sound.setLevels({ music: 0 });
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

  private setActiveWebRTCClient(client: WebRTCRegistryClient): number {
    const previousClient = this.webrtcClient;
    this.webrtcClient = client;
    this.networkClientGeneration += 1;
    if (previousClient && previousClient !== client) {
      void this.closeWebRTCClient(previousClient);
    }
    return this.networkClientGeneration;
  }

  private isActiveWebRTCClient(client: WebRTCRegistryClient, generation: number): boolean {
    return this.webrtcClient === client && this.networkClientGeneration === generation;
  }

  private async closeWebRTCClient(client: WebRTCRegistryClient | null): Promise<void> {
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

  private resetNetworkSessionToLocal() {
    this.connectionStartRequested = false;
    this.hasReceivedMatchInit = false;
    this.networkState.setMode("local");
    this.networkState.resetNetworkOnlyState();
    this.singlePlayerName = this.readSinglePlayerNameFromStorage();
    this.initializeTurnControllers();
    this.notifyNetworkStateChange();
  }

  private async teardownNetworkSession(awaitClose: boolean): Promise<void> {
    const client = this.webrtcClient;
    if (client) {
      this.webrtcClient = null;
      this.networkClientGeneration += 1;
    }

    this.resetNetworkSessionToLocal();

    if (awaitClose) {
      await this.closeWebRTCClient(client);
      return;
    }

    void this.closeWebRTCClient(client);
  }

  async createHostRoom(config: { registryUrl: string; playerName: string }): Promise<void> {
    this.networkState.setMode("network-host");
    this.networkState.setPlayerNames(config.playerName);
    this.networkState.updateRegistryInfo({ baseUrl: config.registryUrl });
    this.connectionStartRequested = false;
    this.hasReceivedMatchInit = false;
    this.startNetworkMatchAsHost();

    const iceServers: RTCIceServer[] = [{ urls: "stun:stun.l.google.com:19302" }];
    const client = new WebRTCRegistryClient({
      registryApiUrl: config.registryUrl,
      iceServers,
    });
    const clientGeneration = this.setActiveWebRTCClient(client);

    this.setupWebRTCCallbacks(client, clientGeneration);

    try {
      await client.createRoom(config.playerName);
      if (!this.isActiveWebRTCClient(client, clientGeneration)) {
        void this.closeWebRTCClient(client);
        return;
      }

      const roomInfo = client.getRoomInfo();
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

      await this.startConnection(client, clientGeneration);
    } catch (error) {
      if (!this.isActiveWebRTCClient(client, clientGeneration)) {
        void this.closeWebRTCClient(client);
        return;
      }

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
    const client = new WebRTCRegistryClient({
      registryApiUrl: config.registryUrl,
      iceServers,
    });
    const clientGeneration = this.setActiveWebRTCClient(client);

    this.setupWebRTCCallbacks(client, clientGeneration);

    try {
      await client.joinRoom(config.roomCode, config.joinCode, config.playerName);
      if (!this.isActiveWebRTCClient(client, clientGeneration)) {
        void this.closeWebRTCClient(client);
        return;
      }

      const roomInfo = client.getRoomInfo();
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

      await this.startConnection(client, clientGeneration);
    } catch (error) {
      if (!this.isActiveWebRTCClient(client, clientGeneration)) {
        void this.closeWebRTCClient(client);
        return;
      }

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

  async startConnection(
    client: WebRTCRegistryClient | null = this.webrtcClient,
    clientGeneration = this.networkClientGeneration
  ): Promise<void> {
    if (!client) {
      throw new Error("No WebRTC client initialized");
    }
    if (!this.isActiveWebRTCClient(client, clientGeneration)) {
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
      if (!this.isActiveWebRTCClient(client, clientGeneration)) {
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      this.networkState.reportConnectionError(message);
      this.connectionStartRequested = false;
      this.notifyNetworkStateChange();
      throw error;
    }
  }

  cancelNetworkSetup(): void {
    void this.teardownNetworkSession(false);
  }

  private setupWebRTCCallbacks(client: WebRTCRegistryClient, clientGeneration: number) {
    if (!this.isActiveWebRTCClient(client, clientGeneration)) return;

    client.onStateChange((state: ConnectionState) => {
      if (!this.isActiveWebRTCClient(client, clientGeneration)) return;
      const previousLifecycle = this.networkState.getSnapshot().connection.lifecycle;
      this.networkState.updateConnectionLifecycle(state as any, Date.now());

      if (state === ConnectionState.CONNECTED && previousLifecycle !== ConnectionState.CONNECTED) {
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

    client.onMessage((message: NetworkMessage) => {
      if (!this.isActiveWebRTCClient(client, clientGeneration)) return;
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

    client.onError((error: Error) => {
      if (!this.isActiveWebRTCClient(client, clientGeneration)) return;
      this.networkState.reportConnectionError(error.message);
      this.notifyNetworkStateChange();
    });

    client.onDebugEvent((_event) => {
      if (!this.isActiveWebRTCClient(client, clientGeneration)) return;
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
    while (true) {
      const resolution = this.networkState.dequeueResolution();
      if (!resolution) return;
      const controller = this.turnControllers.get(resolution.actingTeamId);
      if (controller && controller.type === "remote") {
        (controller as RemoteTurnController).receiveResolution(resolution);
        continue;
      }
      this.networkState.enqueueResolution(resolution);
      return;
    }
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

  setNetworkLogSetting(setting: NetworkLogSetting) {
    this.networkState.setNetworkLogSetting(setting);
  }

  getNetworkLogSetting(): NetworkLogSetting {
    return this.networkState.getNetworkLogSetting();
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
    if (!opened) return;

    this.helpOverlayPausesSimulation = this.shouldPauseForOverlayTime();
    if (this.session.state.charging) {
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
      this.startMenuPausesSimulation = this.shouldPauseForOverlayTime();
    }
    this.startMenu.show(mode, closeable);
  }

  private hideStartMenu() {
    if (!this.startMenu.isVisible()) return;
    if (this.startMenuOpenedAtMs !== null && this.startMenuPausesSimulation) {
      const pausedFor = nowMs() - this.startMenuOpenedAtMs;
      if (pausedFor > 0) {
        this.session.pauseFor(pausedFor);
      }
    }
    this.startMenuOpenedAtMs = null;
    this.startMenuPausesSimulation = false;
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
      this.helpOverlayPausesSimulation = false;
      this.showStartMenu(this.startMenu.getMode(), initialMenuDismissed);
      this.updateCursor();
      return;
    }
    if (pausedFor > 0 && this.helpOverlayPausesSimulation) {
      this.session.pauseFor(pausedFor);
    }
    this.helpOverlayPausesSimulation = false;
    this.canvas.focus();
    this.updateCursor();
  }

  private shouldPauseForOverlayTime() {
    return this.networkState.getSnapshot().mode === "local";
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
      this.openPauseMenu();
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

  getNetworkLogText(): string {
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
    return [header, ...lines].join("\n");
  }

  private copyNetworkLogToClipboard() {
    const text = this.getNetworkLogText();

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

  private getTerrainSurfaceY(worldX: number, radius: number) {
    const terrain = this.session.terrain;
    const idx = clamp(Math.round(worldX - terrain.worldLeft), 0, terrain.heightMap.length - 1);
    const topSolidY = terrain.heightMap[idx] ?? terrain.height;
    const approxY = topSolidY - radius;
    if (!terrain.circleCollides(worldX, approxY, radius)) return approxY;
    const resolved = terrain.resolveCircle(worldX, approxY, radius, Math.max(24, radius + 18));
    return resolved.y;
  }

  private renderMobileMovementGhost(ctx: CanvasRenderingContext2D) {
    if (!this.isMobileProfile()) return;
    const ghostX = this.mobileMovementGhostX;
    if (ghostX === null) return;
    if (this.session.state.phase !== "aim") return;
    const worm = this.activeWorm;
    if (!worm.alive) return;
    const wormSurfaceY = this.getTerrainSurfaceY(worm.x, worm.radius);
    const verticalOffset = worm.y - wormSurfaceY;
    const ghostY = this.getTerrainSurfaceY(ghostX, worm.radius) + verticalOffset;
    const markerCol = this.mobileMovementAssist
      ? "rgba(150, 255, 200, 0.95)"
      : "rgba(255, 250, 170, 0.95)";

    const ghostSprite = this.mobileMovementGhostSprite;
    if (ghostSprite) {
      ctx.save();
      ctx.globalAlpha = this.mobileMovementAssist ? 0.58 : 0.5;
      ctx.drawImage(
        ghostSprite.canvas,
        ghostX - ghostSprite.anchorX,
        ghostY - ghostSprite.anchorY
      );
      ctx.restore();
    } else {
      const bodyW = worm.radius * 2.2;
      const bodyH = worm.radius * 2.4;
      ctx.save();
      ctx.globalAlpha = 0.42;
      ctx.fillStyle = markerCol;
      drawRoundedRect(
        ctx,
        ghostX - bodyW * 0.5,
        ghostY - bodyH * 0.85,
        bodyW,
        bodyH,
        bodyW * 0.35
      );
      ctx.fill();
      ctx.restore();
    }

    const dx = ghostX - worm.x;
    const dy = ghostY - worm.y;
    const length = Math.hypot(dx, dy);
    if (length > 1e-6) {
      drawArrow(
        ctx,
        worm.x,
        worm.y,
        Math.atan2(dy, dx),
        length,
        markerCol,
        3
      );
    }
  }

  private renderMobileAimDragCrosshair(ctx: CanvasRenderingContext2D, aim: AimInfo) {
    if (!this.isMobileProfile()) return;
    if (this.mobileAimMode !== "aim" && this.mobileAimMode !== "charge") return;
    if (this.session.state.phase !== "aim") return;
    const worm = this.activeWorm;
    if (!worm.alive) return;

    const target = this.getMobileAimAnchorWorldPoint(aim);

    ctx.save();
    ctx.strokeStyle = "rgba(255, 228, 145, 0.9)";
    ctx.lineWidth = 2;
    ctx.setLineDash([6, 4]);
    ctx.beginPath();
    ctx.moveTo(worm.x, worm.y);
    ctx.lineTo(target.x, target.y);
    ctx.stroke();
    ctx.setLineDash([]);
    drawCrosshair(ctx, target.x, target.y, 10, "#ffe891", 2);
    ctx.restore();
  }

  private getMobileAimAnchorWorldPoint(aim: AimInfo) {
    const worm = this.activeWorm;
    const dx = aim.targetX - worm.x;
    const dy = aim.targetY - worm.y;
    const len = Math.hypot(dx, dy);
    if (len <= MOBILE_AIM_LINE_MAX_PX || len <= 1e-6) {
      return { x: aim.targetX, y: aim.targetY };
    }
    const scale = MOBILE_AIM_LINE_MAX_PX / len;
    return {
      x: worm.x + dx * scale,
      y: worm.y + dy * scale,
    };
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

  private renderSettingsButton(ctx: CanvasRenderingContext2D) {
    if (!this.isSettingsButtonVisible()) return;

    const bounds = this.getSettingsButtonLayoutBounds();
    ctx.save();
    drawRoundedRect(ctx, bounds.x, bounds.y, bounds.width, bounds.height, 12);
    const bg = ctx.createLinearGradient(bounds.x, bounds.y, bounds.x, bounds.y + bounds.height);
    bg.addColorStop(0, "rgba(72, 78, 88, 0.92)");
    bg.addColorStop(1, "rgba(34, 38, 44, 0.95)");
    ctx.fillStyle = bg;
    ctx.fill();
    ctx.strokeStyle = "rgba(255,255,255,0.22)";
    ctx.lineWidth = 1.5;
    ctx.stroke();

    const iconX = bounds.x + (bounds.width - SETTINGS_ICON_WIDTH_PX) * 0.5;
    const iconY = bounds.y + (bounds.height - SETTINGS_ICON_HEIGHT_PX) * 0.5;
    drawMenuIconSprite({
      ctx,
      icon: "settings",
      x: iconX,
      y: iconY,
      width: SETTINGS_ICON_WIDTH_PX,
      height: SETTINGS_ICON_HEIGHT_PX,
    });
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
    const isMobileProfile = this.isMobileProfile();

    renderAimHelpers({
      ctx,
      state,
      activeWorm: this.activeWorm,
      aim,
      predictedPath: this.predictPath(),
      showDesktopAssist: !isMobileProfile,
    });
    ctx.restore();

    ctx.save();
    ctx.translate(this.cameraOffsetX, this.cameraOffsetY);
    const mobileMapMaxWidthPx = isMobileProfile ? Math.floor(this.width * 0.5) : undefined;
    const timeLabelY = isMobileProfile
      ? Math.min(
          this.height - 12,
          getMapGadgetBottomY({
            viewportWidth: this.width,
            terrain: this.session.terrain,
            ...(mobileMapMaxWidthPx !== undefined ? { maxWidthPx: mobileMapMaxWidthPx } : {}),
          }) + 16
        )
      : undefined;
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
        showChargeHint: !isMobileProfile,
        ...(timeLabelY !== undefined ? { timeLabelY } : {}),
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
      ...(mobileMapMaxWidthPx !== undefined ? { maxWidthPx: mobileMapMaxWidthPx } : {}),
    });

    renderNetworkLogHUD(ctx, this.width, this.height, this.networkState);

    this.renderSettingsButton(ctx);

    const fpsText = `FPS: ${Math.round(this.fps)}`;
    drawText(ctx, fpsText, 12, this.height - 12, COLORS.white, 12, "left", "bottom");
    ctx.restore();
  }

  frame(timeMs: number) {
    this.frameHandle = null;
    if (this.backgroundSuspendedAtMs !== null) {
      this.lastTimeMs = 0;
      return;
    }
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
    const overlaysBlocking = this.hasBlockingOverlay();
    const networkSnapshot = this.networkState.getSnapshot();
    const simulationPolicy = computeFrameSimulationPolicy(networkSnapshot, overlaysBlocking);
    this.session.setSimulationPaused(simulationPolicy.simulationPaused);
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
    if (simulationPolicy.networkPaused) {
      this.session.pauseFor(dt * 1000);
    }
    this.deliverResolutionToController();
    this.session.updateActiveTurnDriver(dt, {
      allowInput: !overlaysBlocking && !simulationPolicy.waitingForSync,
      allowLocalInput: !this.isMobileProfile(),
      input: this.input,
      camera: { offsetX: worldCameraOffsetX, offsetY: worldCameraOffsetY, zoom: this.worldZoom },
    });
    if (!simulationPolicy.networkPaused) {
      this.updateMobileMovementAssist(dt);
    } else {
      this.stopMobileMovementAssist(false);
    }
    if (!simulationPolicy.simulationPaused) {
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
