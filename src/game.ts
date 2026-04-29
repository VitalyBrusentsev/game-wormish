import type { TeamId, PredictedPoint } from "./definitions";
import { WeaponType, nowMs, WORLD, clamp } from "./definitions";
import { Input, drawArrow, drawCrosshair, drawRoundedRect } from "./utils";
import type { Worm } from "./entities";
import { HelpOverlay } from "./ui/help-overlay";
import { StartMenuOverlay } from "./ui/start-menu-overlay";
import { MatchResultOverlay } from "./ui/match-result-overlay";
import { NetworkMatchDialog, PLAYER_NAME_STORAGE_KEY } from "./ui/network-match-dialog";
import { gameEvents } from "./events/game-events";
import { DamageFloaters } from "./ui/damage-floaters";
import { ActiveWormArrow } from "./ui/active-worm-arrow";
import { TurnCountdownOverlay } from "./ui/turn-countdown";
import type { AimInfo } from "./rendering/game-rendering";
import { drawMenuIconSprite } from "./ui/menu-icons";
import type { Team } from "./game/team-manager";
import {
  GameSession,
  type MatchInitSnapshot,
} from "./game/session";
import {
  LocalTurnController,
  type TurnDriver,
} from "./game/turn-driver";
import { AiTurnController } from "./game/ai-turn-controller";
import { assignAiTeamPersonalities } from "./ai/personality-assignment";
import {
  NetworkSessionState,
  type NetworkLogSetting,
  type NetworkSessionStateSnapshot,
} from "./network/session-state";
import { NetworkOrchestrator } from "./network/network-orchestrator";
import { SoundSystem, type SoundLevels, type SoundSnapshot } from "./audio/sound-system";
import { detectControlProfile, type ControlProfile } from "./mobile/control-profile";
import { MobileControlsOverlay } from "./ui/mobile-controls";
import { MobileGestureController } from "./mobile/mobile-gesture-controller";
import {
  MobileGameplayController,
  type MobileGameplayContext,
  type MobileMovementGhostSprite,
} from "./mobile/mobile-gameplay-controller";
import { parseJoinLinkHash } from "./network/join-link";
import {
  computeFrameSimulationPolicy,
  rebaseOverlayOpenedAtMs,
} from "./game/frame-policy";
import {
  cleanPlayerName,
  getNetworkTeamNames,
} from "./game/player-display";
import {
  oppositeTeamId,
  resolveSinglePlayerConfig,
  type GameOptions,
  type ResolvedSinglePlayerConfig,
} from "./game/single-player-config";
import { GameCamera } from "./game/game-camera";
import { renderGameScene } from "./rendering/game-scene-renderer";

export {
  computeFrameSimulationPolicy,
  rebaseOverlayOpenedAtMs,
} from "./game/frame-policy";
export type {
  GameOptions,
  SinglePlayerConfig,
  SinglePlayerTeamSide,
} from "./game/single-player-config";

let initialMenuDismissed = false;

const MATCH_RESULT_DIALOG_DELAY_MS = 1000;
const MOBILE_FULLSCREEN_TOP_UI_OFFSET_PX = 44;
const SETTINGS_BUTTON_SIZE_PX = 48;
const SETTINGS_BUTTON_PADDING_PX = 14;
const SETTINGS_ICON_WIDTH_PX = 28;
const SETTINGS_ICON_HEIGHT_PX = SETTINGS_ICON_WIDTH_PX * (132 / 160);
const SETTINGS_GHOST_CLICK_SUPPRESSION_MS = 650;
const SETTINGS_GHOST_CLICK_RADIUS_PX = 36;
const DEFAULT_MENU_SFX_LEVEL = 0.9;
const DEFAULT_MENU_MUSIC_LEVEL = 0.6;

type Rect = {
  x: number;
  y: number;
  width: number;
  height: number;
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

  private readonly network: NetworkOrchestrator;
  private readonly registryUrl: string;
  private restartMissionTask: Promise<void> | null = null;

  private camera!: GameCamera;
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
  private controlProfile: ControlProfile = "desktop";
  private readonly mobileGameplay = new MobileGameplayController();
  private mobileControls: MobileControlsOverlay | null = null;
  private mobileGestures: MobileGestureController | null = null;
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

    this.network = new NetworkOrchestrator({
      getSession: () => this.session,
      getTurnControllers: () => this.turnControllers,
      setTurnControllersOnSession: () => this.session.setTurnControllers(this.turnControllers),
      startMatchAsHost: () => this.startNetworkMatchAsHost(),
      applyMatchInitSnapshot: (snapshot) => this.applySnapshot(snapshot),
      restoreLocalSetup: () => {
        this.singlePlayerName = this.readSinglePlayerNameFromStorage();
        this.initializeTurnControllers();
      },
    });

    const groundWidth = WORLD.groundWidth;
    this.subscribeToGameEvents();
    this.session = new GameSession(groundWidth, height, {
      horizontalPadding: 0,
      teamOrder: this.getSinglePlayerTeamOrder(),
    });
    this.camera = new GameCamera({
      viewportWidth: width,
      viewportHeight: height,
      worldWidth: this.session.width,
      worldHeight: this.session.height,
    });

    this.initializeTurnControllers();
    this.refreshControlProfile();
    this.camera.centerOn(this.activeWorm);
    this.lastTurnStartMs = this.session.state.turnStartMs;

    this.helpOverlay = new HelpOverlay({
      onClose: (pausedMs, reason) => this.handleHelpClosed(pausedMs, reason),
    });

    this.networkDialog = new NetworkMatchDialog({
      onCreateRoom: async (playerName) => {
        this.singlePlayerName = cleanPlayerName(playerName);
        await this.network.createHostRoom({ registryUrl: this.registryUrl, playerName });
      },
      onLookupRoom: async (roomCode) => {
        await this.network.lookupRoom({ registryUrl: this.registryUrl, roomCode });
      },
      onJoinRoom: async (roomCode, joinCode, playerName) => {
        this.singlePlayerName = cleanPlayerName(playerName);
        await this.network.joinRoom({ registryUrl: this.registryUrl, playerName, roomCode, joinCode });
      },
      onCancel: () => {
        this.network.cancelSetup();
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

    const startedFromJoinLink = this.tryStartJoinFromShareLink();
    if (!initialMenuDismissed && !startedFromJoinLink) {
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
          this.mobileGameplay.getSnapshot().aimMode === "idle" &&
          this.canStartWormInteraction(worldX, worldY),
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
    this.mobileGameplay.resetTransientState();
  }

  private isMobileProfile() {
    return this.controlProfile === "mobile-portrait";
  }

  private isStandaloneDisplayMode() {
    if (typeof window.matchMedia === "function") {
      try {
        if (window.matchMedia("(display-mode: standalone)").matches) return true;
        if (window.matchMedia("(display-mode: fullscreen)").matches) return true;
      } catch {
        // ignore and fallback
      }
    }
    const standaloneNavigator = navigator as Navigator & { standalone?: boolean };
    return standaloneNavigator.standalone === true;
  }

  private getMobileTopUiOffsetPx() {
    if (!this.isMobileProfile()) return 0;
    if (!this.isStandaloneDisplayMode()) return 0;
    return MOBILE_FULLSCREEN_TOP_UI_OFFSET_PX;
  }

  private getDesiredWorldZoom() {
    return this.mobileGameplay.getDesiredWorldZoom(this.isMobileProfile());
  }

  private applyWorldZoom(nextZoomRaw: number) {
    this.camera.setZoom(nextZoomRaw);
  }

  private updateWorldZoomForMobileStage() {
    this.applyWorldZoom(this.getDesiredWorldZoom());
  }

  private getWorldViewportSize() {
    return this.camera.getWorldViewportSize();
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
    return this.mobileGameplay.canUsePanning(this.getMobileGameplayContext());
  }

  private getMobileGameplayContext(): MobileGameplayContext {
    const networkSnapshot = this.network.getSnapshot();
    const networkReady =
      networkSnapshot.mode === "local"
        ? true
        : !networkSnapshot.bridge.waitingForRemoteSnapshot &&
          networkSnapshot.connection.lifecycle === "connected";

    return {
      isMobileProfile: this.isMobileProfile(),
      overlaysBlocking: this.hasBlockingOverlay(),
      initialMenuDismissed,
      isActiveTeamLocallyControlled: this.isActiveTeamLocallyControlled(),
      isLocalTurnActive: this.session.isLocalTurnActive(),
      networkReady,
      phase: this.session.state.phase,
      charging: this.session.state.charging,
      weapon: this.session.state.weapon,
      activeWorm: this.activeWorm,
      terrainLeft: this.session.terrain.worldLeft,
      terrainRight: this.session.terrain.worldRight,
      topUiOffsetPx: this.getMobileTopUiOffsetPx(),
      getAimInfo: () => this.session.getRenderAimInfo(),
      worldToScreen: (worldX, worldY) => this.worldToScreen(worldX, worldY),
      setWeapon: (weapon) => this.session.setWeaponCommand(weapon),
      setAimTarget: (worldX, worldY) => this.session.setAimTargetCommand(worldX, worldY),
      startCharge: () => this.session.startChargeCommand(),
      cancelCharge: () => this.session.cancelChargeCommand(),
      fireCurrentWeapon: (options) => this.session.fireCurrentWeaponCommand(options),
      recordMovementStep: (direction, durationMs, jump) =>
        this.session.recordMovementStepCommand(direction, durationMs, jump, {
          movementSmoothingMode: "ai",
        }),
      captureMovementGhostSprite: () => this.captureMobileMovementGhostSprite(),
    };
  }

  private screenToWorld(screenX: number, screenY: number) {
    return this.camera.screenToWorld(screenX, screenY);
  }

  private worldToScreen(worldX: number, worldY: number) {
    return this.camera.worldToScreen(worldX, worldY);
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
      x: layout.x + this.camera.offsetX,
      y: layout.y + this.camera.offsetY,
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
    this.camera.panByScreenDelta(deltaScreenX, deltaScreenY);
  }

  private canStartWormInteraction(worldX: number, worldY: number) {
    return this.mobileGameplay.canStartWormInteraction(
      this.getMobileGameplayContext(),
      worldX,
      worldY
    );
  }

  private canStartMobileAimGesture(canvasX: number, canvasY: number) {
    return this.mobileGameplay.canStartAimGesture(
      this.getMobileGameplayContext(),
      canvasX,
      canvasY
    );
  }

  private handleMobileTap(worldX: number, worldY: number) {
    this.mobileGameplay.handleTap(this.getMobileGameplayContext(), worldX, worldY);
  }

  private handleMobileToggleWeaponPicker() {
    this.mobileGameplay.handleToggleWeaponPicker(this.getMobileGameplayContext());
  }

  private handleMobileSelectWeapon(weapon: WeaponType) {
    this.mobileGameplay.handleSelectWeapon(this.getMobileGameplayContext(), weapon);
  }

  private handleMobileAimButton() {
    this.mobileGameplay.handleAimButton(this.getMobileGameplayContext());
  }

  private handleMobileCancel() {
    this.mobileGameplay.handleCancel(this.getMobileGameplayContext());
  }

  private handleMobilePrimary() {
    this.mobileGameplay.handlePrimary(this.getMobileGameplayContext());
  }

  private handleMobileJump() {
    this.mobileGameplay.handleJump();
  }

  private handleMobileAimGesture(worldX: number, worldY: number) {
    this.mobileGameplay.handleAimGesture(this.getMobileGameplayContext(), worldX, worldY);
  }

  private handleMobileMovementDragStart(worldX: number, _worldY: number) {
    this.mobileGameplay.handleMovementDragStart(this.getMobileGameplayContext(), worldX);
  }

  private handleMobileMovementDrag(worldX: number, _worldY: number) {
    this.mobileGameplay.handleMovementDrag(this.getMobileGameplayContext(), worldX);
  }

  private handleMobileMovementDragEnd(worldX: number, _worldY: number) {
    this.mobileGameplay.handleMovementDragEnd(this.getMobileGameplayContext(), worldX);
  }

  private stopMobileMovementAssist(clearGhost: boolean) {
    this.mobileGameplay.stopMovementAssist(clearGhost);
  }

  private captureMobileMovementGhostSprite(): MobileMovementGhostSprite | null {
    const worm = this.activeWorm;
    if (!worm.alive) {
      return null;
    }

    const spriteSize = Math.max(112, Math.ceil(worm.radius * 8));
    const spriteCanvas = this.canvas.ownerDocument.createElement("canvas");
    spriteCanvas.width = spriteSize;
    spriteCanvas.height = spriteSize;
    const spriteCtx = spriteCanvas.getContext("2d");
    if (!spriteCtx) {
      return null;
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
    return { canvas: spriteCanvas, anchorX, anchorY };
  }

  private updateMobileMovementAssist(dt: number) {
    this.mobileGameplay.updateMovementAssist(this.getMobileGameplayContext(), dt);
  }

  private syncMobileControls() {
    if (!this.mobileControls) return;
    this.mobileControls.setState(this.mobileGameplay.sync(this.getMobileGameplayContext()));
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
      if (this.network.getSnapshot().mode !== "local") {
        await this.network.teardownSession(true);
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
    const snapshot = this.network.getSnapshot();
    if (snapshot.mode === "local") {
      this.restartSinglePlayerMatch();
      return;
    }
    if (snapshot.mode === "network-host") {
      this.network.restartMatchAsHost();
      return;
    }
    this.network.sendNetworkMessage({ type: "match_restart_request", payload: {} });
  }

  private returnToStartModeFromGameOver() {
    this.clearMatchResultDialogTimer();
    this.hideMatchResultDialog();
    if (this.network.getSnapshot().mode !== "local") {
      this.network.cancelSetup();
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
    const teamLabels = this.getDisplayedTeamLabels(this.network.getSnapshot());
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

    const networkSnapshot = this.network.getSnapshot();
    if (networkSnapshot.mode === "local") {
      const pausedForMs = Math.max(0, nowMs() - suspendedAtMs);
      if (pausedForMs > 0) {
        this.session.pauseFor(pausedForMs);
        this.startMenuOpenedAtMs = rebaseOverlayOpenedAtMs(
          this.startMenuOpenedAtMs,
          pausedForMs
        );
        this.helpOverlay.shiftOpenedAtMs(pausedForMs);
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
    const centerX = this.camera.x + worldViewport.width / 2;
    this.width = nextWidth;
    this.height = nextHeight;
    this.canvas.width = this.width;
    this.canvas.height = this.height;
    this.refreshControlProfile();
    this.camera.resizeKeepingCenter(this.width, this.height, this.activeWorm.y, centerX);
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
    this.network.cancelSetup();
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
    return this.network.state;
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
    this.network.onStateChange(callback);
  }

  private tryStartJoinFromShareLink(): boolean {
    const joinLink = parseJoinLinkHash(window.location.hash);
    if (!joinLink) {
      return false;
    }

    this.clearJoinLinkHash();
    this.hideStartMenu();
    this.networkDialog.show("guest");
    this.networkDialog.prepareJoinFromShareLink(joinLink);

    void this.network.lookupRoom({ registryUrl: this.registryUrl, roomCode: joinLink.roomCode })
      .catch(() => { })
      .finally(() => {
        this.networkDialog.completeJoinLinkLookup();
      });

    return true;
  }

  private clearJoinLinkHash() {
    if (!window.location.hash) {
      return;
    }
    const nextUrl = `${window.location.pathname}${window.location.search}`;
    window.history.replaceState(window.history.state, document.title, nextUrl);
  }

  private startNetworkMatchAsHost() {
    const state = this.network.getSnapshot();
    if (state.mode !== "network-host") return;
    this.session.restart({ startingTeamIndex: 0, teamOrder: ["Red", "Blue"] });
    this.lastTurnStartMs = this.session.state.turnStartMs;
    this.camera.setWorldSize(this.session.width, this.session.height);
    this.camera.centerOn(this.activeWorm);
    this.resetMobileTransientState();
    this.updateCursor();
  }

  private applySnapshot(snapshot: MatchInitSnapshot) {
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
    this.camera.setWorldSize(this.session.width, this.session.height);
    this.camera.centerOn(this.activeWorm);
    this.resetMobileTransientState();
    this.turnControllers.clear();
    const mode = this.network.getSnapshot().mode;
    if (mode === "local") {
      this.initializeTurnControllers();
    } else {
      this.network.swapToNetworkControllers();
    }
    this.updateCursor();
  }

  get activeTeam(): Team {
    return this.session.activeTeam;
  }

  get activeWorm(): Worm {
    return this.session.activeWorm;
  }

  setNetworkLogSetting(setting: NetworkLogSetting) {
    this.network.state.setNetworkLogSetting(setting);
  }

  getNetworkLogSetting(): NetworkLogSetting {
    return this.network.state.getNetworkLogSetting();
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
    return this.network.getSnapshot().mode === "local";
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
      this.network.state.toggleNetworkLog();
      const showLog = this.network.getSnapshot().debug.showLog;
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
        const snapshot = this.network.getSnapshot();
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
        this.sound.playWormDeath({
          worldX: event.position.x,
          turnIndex: event.turnIndex,
          wormIndex: event.wormIndex,
          cause: event.cause,
        });
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
        this.network.handleLocalTurnCommand(event.command, { turnIndex: event.turnIndex, teamId: event.teamId });
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
        this.network.handleLocalTurnEffects({
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
    this.camera.resetShake();
  }

  private triggerCameraShake(magnitude: number, duration = 0.4) {
    this.camera.triggerShake(magnitude, duration);
  }

  private updateCameraShake(dt: number) {
    this.camera.updateShake(dt);
  }

  private updateCamera(dt: number, allowEdgeScroll: boolean) {
    this.camera.update(dt, {
      enabled: allowEdgeScroll,
      mouseInside: this.input.mouseInside,
      mouseX: this.input.mouseX,
    });
  }

  private updatePassiveProjectileFocus(): boolean {
    const networkSnapshot = this.network.getSnapshot();
    if (networkSnapshot.mode === "local") return false;
    const localTeamId = networkSnapshot.player.localTeamId;
    if (!localTeamId) return false;
    if (this.activeTeam.id === localTeamId) return false;
    if (this.session.state.phase !== "projectile") return false;
    if (this.session.projectiles.length === 0) return false;

    const projectile = this.session.projectiles[this.session.projectiles.length - 1]!;
    this.camera.focusCenterOn(projectile);
    return true;
  }

  private focusCameraOnActiveWorm() {
    this.camera.focusOnPoint(this.activeWorm);
  }

  private updateTurnFocus() {
    const turnStartMs = this.session.state.turnStartMs;
    if (turnStartMs === this.lastTurnStartMs) return;
    this.lastTurnStartMs = turnStartMs;
    if (this.isMobileProfile()) {
      this.mobileGameplay.resetForTurn();
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
    const snapshot = this.network.getSnapshot();
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
    const mobile = this.mobileGameplay.getSnapshot();
    const ghostX = mobile.movementGhostX;
    if (ghostX === null) return;
    if (this.session.state.phase !== "aim") return;
    const worm = this.activeWorm;
    if (!worm.alive) return;
    const wormSurfaceY = this.getTerrainSurfaceY(worm.x, worm.radius);
    const verticalOffset = worm.y - wormSurfaceY;
    const ghostY = this.getTerrainSurfaceY(ghostX, worm.radius) + verticalOffset;
    const markerCol = mobile.movementAssistActive
      ? "rgba(150, 255, 200, 0.95)"
      : "rgba(255, 250, 170, 0.95)";

    const ghostSprite = mobile.movementGhostSprite;
    if (ghostSprite) {
      ctx.save();
      ctx.globalAlpha = mobile.movementAssistActive ? 0.58 : 0.5;
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
    const mobile = this.mobileGameplay.getSnapshot();
    if (mobile.aimMode !== "aim" && mobile.aimMode !== "charge") return;
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
    return this.mobileGameplay.getAimAnchorWorldPoint(this.activeWorm, aim);
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
    const networkSnapshot = this.network.getSnapshot();
    const aim = this.getAimInfo();
    const isMobileProfile = this.isMobileProfile();
    const topUiOffsetPx = this.getMobileTopUiOffsetPx();
    const displayTeamLabels = this.getDisplayedTeamLabels(networkSnapshot);
    renderGameScene({
      ctx: this.ctx,
      width: this.width,
      height: this.height,
      now,
      fps: this.fps,
      camera: this.camera,
      session: this.session,
      networkState: this.network.state,
      networkSnapshot,
      damageFloaters: this.damageFloaters,
      activeWormArrow: this.activeWormArrow,
      turnCountdown: this.turnCountdown,
      aim,
      predictedPath: this.predictPath(),
      isMobileProfile,
      topUiOffsetPx,
      displayTeamLabels,
      singlePlayerTeamOrder: this.getSinglePlayerTeamOrder(),
      getTeamHealth: (teamId) => this.getTeamHealth(teamId),
      renderMobileAimDragCrosshair: (ctx, renderAim) =>
        this.renderMobileAimDragCrosshair(ctx, renderAim),
      renderMobileMovementGhost: (ctx) => this.renderMobileMovementGhost(ctx),
      renderSettingsButton: (ctx) => this.renderSettingsButton(ctx),
      overlaysBlocking: this.hasBlockingOverlay(),
      showRadar: initialMenuDismissed,
    });
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
    const networkSnapshot = this.network.getSnapshot();
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
      centerX: this.camera.x + worldViewport.width / 2,
      viewportWidth: worldViewport.width,
    });
    this.sound.update();
    if (simulationPolicy.networkPaused) {
      this.session.pauseFor(dt * 1000);
    }
    this.network.deliverResolutionToController();
    this.session.updateActiveTurnDriver(dt, {
      allowInput: !overlaysBlocking && !simulationPolicy.waitingForSync,
      allowLocalInput: !this.isMobileProfile(),
      input: this.input,
      camera: this.camera.getDriverCamera(),
    });
    if (!simulationPolicy.networkPaused) {
      this.updateMobileMovementAssist(dt);
    } else {
      this.stopMobileMovementAssist(false);
    }
    if (!simulationPolicy.simulationPaused) {
      this.session.update(dt);
    }
    this.network.flushPendingTurnEffects(false);
    this.network.flushTurnResolution();
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
