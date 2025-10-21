import type { TeamId, PredictedPoint } from "./definitions";
import { GAMEPLAY, WeaponType, nowMs, COLORS } from "./definitions";
import { Input, drawText } from "./utils";
import type { Worm } from "./entities";
import { HelpOverlay } from "./ui/help-overlay";
import { StartMenuOverlay } from "./ui/start-menu-overlay";
import {
  renderAimHelpers,
  renderBackground,
  renderGameOver,
  renderHUD,
  type AimInfo,
} from "./rendering/game-rendering";
import type { Team } from "./game/team-manager";
import {
  GameSession,
  type SessionCallbacks,
} from "./game/session";
import {
  LocalTurnController,
  type TurnDriver,
} from "./game/turn-driver";

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
  private helpOpenedFromMenu = false;

  private readonly cameraPadding = 48;
  private cameraOffsetX = 0;
  private cameraOffsetY = 0;
  private cameraShakeTime = 0;
  private cameraShakeDuration = 0;
  private cameraShakeMagnitude = 0;

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
  };

  private readonly turnControllers = new Map<TeamId, TurnDriver>();

  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
    this.canvas = document.createElement("canvas");
    this.canvas.width = width;
    this.canvas.height = height;
    const ctx = this.canvas.getContext("2d");
    if (!ctx) throw new Error("2D context not available");
    this.ctx = ctx;

    this.input = new Input();
    this.input.attach(this.canvas);

    this.session = new GameSession(width, height, {
      horizontalPadding: this.cameraPadding,
      callbacks: this.sessionCallbacks,
    });

    this.initializeTurnControllers();

    this.helpOverlay = new HelpOverlay();
    this.startMenu = new StartMenuOverlay();
    if (!initialMenuDismissed) {
      this.startMenu.show("start");
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
    this.input.detach();
    this.canvas.removeEventListener("pointerdown", this.pointerDownFocusHandler);
    this.canvas.removeEventListener("mousedown", this.mouseDownFocusHandler);
    this.canvas.removeEventListener("touchstart", this.touchStartFocusHandler);
    if (this.canvas.parentElement) {
      this.canvas.parentElement.removeChild(this.canvas);
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
      this.session.state.cancelCharge();
    }
  }

  private hideHelp() {
    const pausedFor = this.helpOverlay.hide(nowMs());
    if (this.helpOpenedFromMenu) {
      this.helpOpenedFromMenu = false;
      this.startMenu.show();
      return;
    }
    if (pausedFor > 0) {
      this.session.state.pauseFor(pausedFor);
    }
  }

  private processInput() {
    if (this.input.pressed("F1")) {
      if (this.helpOverlay.isVisible()) {
        this.hideHelp();
      } else {
        this.helpOpenedFromMenu = this.startMenu.isVisible();
        this.showHelp();
      }
      this.updateCursor();
    }

    if (this.helpOverlay.isVisible()) {
      if (this.input.pressed("Escape")) {
        this.hideHelp();
        this.updateCursor();
      } else if (
        this.input.mouseJustPressed &&
        this.helpOverlay.isCloseButtonHit(
          this.input.mouseX - this.cameraOffsetX,
          this.input.mouseY - this.cameraOffsetY
        )
      ) {
        this.hideHelp();
        this.updateCursor();
        this.input.consumeMousePress();
      }
      return;
    }

    const escapePressed = this.input.pressed("Escape");
    if (escapePressed) {
      if (this.startMenu.isVisible()) {
        if (initialMenuDismissed) {
          this.startMenu.hide();
          this.updateCursor();
          return;
        }
      } else {
        this.startMenu.show(initialMenuDismissed ? "pause" : "start");
        this.updateCursor();
        return;
      }
    }

    if (this.startMenu.isVisible()) {
      const pointerX = this.input.mouseX - this.cameraOffsetX;
      const pointerY = this.input.mouseY - this.cameraOffsetY;
      this.startMenu.updateLayout(this.width, this.height);
      this.startMenu.updatePointer(pointerX, pointerY, this.input.mouseDown);

      if (this.input.mouseJustPressed) {
        this.startMenu.handlePress();
      }

      if (this.input.mouseJustReleased) {
        this.startMenu.updatePointer(pointerX, pointerY, this.input.mouseDown);
        const action = this.startMenu.handleRelease(pointerX, pointerY);
        if (action === "help") {
          this.helpOpenedFromMenu = true;
          this.showHelp();
        } else if (action === "start") {
          this.startMenu.hide();
          initialMenuDismissed = true;
        } else if (action === "restart") {
          this.startMenu.hide();
          initialMenuDismissed = true;
          this.session.restart();
        }
      }

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

  private updateCursor() {
    if (this.helpOverlay.isVisible()) {
      this.canvas.style.cursor = "default";
      return;
    }
    if (this.startMenu.isVisible()) {
      this.canvas.style.cursor = this.startMenu.getCursor();
      return;
    }
    if (this.session.state.weapon === WeaponType.Rifle && !this.session.state.charging) {
      this.canvas.style.cursor = "none";
      return;
    }
    if (this.session.state.charging) {
      this.canvas.style.cursor = "crosshair";
      return;
    }
    this.canvas.style.cursor = this.session.state.weapon === WeaponType.Rifle ? "none" : "crosshair";
  }

  getTeamHealth(id: TeamId) {
    return this.session.getTeamHealth(id);
  }

  predictPath(): PredictedPoint[] {
    return this.session.predictPath(this.input, {
      offsetX: this.cameraOffsetX,
      offsetY: this.cameraOffsetY,
    });
  }

  private getAimInfo(): AimInfo {
    return this.session.getAimInfo(this.input, {
      offsetX: this.cameraOffsetX,
      offsetY: this.cameraOffsetY,
    });
  }

  render() {
    const ctx = this.ctx;
    ctx.save();
    ctx.translate(this.cameraOffsetX, this.cameraOffsetY);
    renderBackground(ctx, this.width, this.height, this.cameraPadding);
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

    renderHUD({
      ctx,
      width: this.width,
      height: this.height,
      state: this.session.state,
      now: nowMs(),
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

    this.startMenu.render(ctx, this.width, this.height);
    this.helpOverlay.render(ctx, this.width, this.height);

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
      this.helpOverlay.isVisible() || this.startMenu.isVisible();
    this.session.updateActiveTurnDriver(dt, {
      allowInput: !overlaysBlocking,
      input: this.input,
      camera: { offsetX: this.cameraOffsetX, offsetY: this.cameraOffsetY },
    });
    if (!overlaysBlocking) {
      this.session.update(dt);
    }
    this.updateCameraShake(dt);
    this.render();
    this.input.update();
    this.lastTimeMs = timeMs;
    if (this.running) {
      this.frameHandle = requestAnimationFrame(this.frameCallback);
    }
  }
}
