import type { TeamId, PredictedPoint } from "./definitions";
import {
  WORLD,
  GAMEPLAY,
  WeaponType,
  clamp,
  randRange,
  distance,
  nowMs,
  COLORS,
} from "./definitions";
import { Input, drawText } from "./utils";
import { Terrain, Worm, Projectile, Particle } from "./entities";
import { GameState } from "./game-state";
import { HelpOverlay } from "./ui/help-overlay";
import {
  renderAimHelpers,
  renderBackground,
  renderGameOver,
  renderHUD,
  type AimInfo,
} from "./rendering/game-rendering";
import { TeamManager, type Team } from "./game/team-manager";
import {
  computeAimInfo,
  fireWeapon,
  predictTrajectory,
  resolveCharge01,
  shouldPredictPath,
} from "./game/weapon-system";

 // phase type managed by GameState

let initialHelpShown = false;

export class Game {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  width: number;
  height: number;

  terrain: Terrain;
  input: Input;
  state: GameState;

  private teamManager: TeamManager;

  projectiles: Projectile[] = [];
  particles: Particle[] = [];

  wind: number = 0;

  lastTimeMs: number = 0;
  message: string | null = null;

  private helpOverlay: HelpOverlay;

  private readonly frameTimes: number[] = [];
  private frameTimeSum = 0;
  private fps = 0;
  private readonly frameSampleSize = 60;

  private running = false;
  private frameHandle: number | null = null;
  private readonly frameCallback: FrameRequestCallback;

  private readonly pointerDownFocusHandler = () => this.canvas.focus();
  private readonly mouseDownFocusHandler = () => this.canvas.focus();
  private readonly touchStartFocusHandler = () => this.canvas.focus();

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

    // Create terrain
    this.terrain = new Terrain(width, height);
    this.terrain.generate();

    this.teamManager = new TeamManager(width, height);
    this.teamManager.initialize(this.terrain);

    this.state = new GameState();
    this.nextTurn(true);
    
    // Canvas hover style
    this.updateCursor();

    this.helpOverlay = new HelpOverlay();

    if (!initialHelpShown) {
      this.showHelp();
      initialHelpShown = true;
    }

    this.frameCallback = (t) => this.frame(t);

  }

  mount(parent: HTMLElement) {
    parent.appendChild(this.canvas);
    // Make canvas focusable and focused so keyboard works reliably across browsers/embeds
    this.canvas.tabIndex = 0;
    this.canvas.focus();
    // Keep focus on interaction
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
    return this.teamManager.activeTeam;
  }

  get activeWorm(): Worm {
    return this.teamManager.activeWorm;
  }

  private get activeWormIndex() {
    return this.teamManager.activeWormIndex;
  }

  private get teams() {
    return this.teamManager.teams;
  }

  nextTurn(initial = false) {
    // Set wind each turn
    this.wind = randRange(-WORLD.windMax, WORLD.windMax);
    this.state.startTurn(nowMs(), WeaponType.Bazooka);
    this.message = initial ? "Welcome! Eliminate the other team!" : null;
    // Ensure cursor matches the newly selected weapon
    this.updateCursor();

    // Move to next team's living worm
    if (initial) this.teamManager.resetActiveWormIndex();
    else this.teamManager.advanceToNextTeam();
  }

  private showHelp() {
    const opened = this.helpOverlay.show(nowMs());
    if (opened && this.state.charging) {
      this.state.cancelCharge();
    }
  }

  private hideHelp() {
    const pausedFor = this.helpOverlay.hide(nowMs());
    if (pausedFor > 0) {
      this.state.pauseFor(pausedFor);
    }
  }

  handleInput(dt: number) {
    if (this.input.pressed("F1")) {
      if (this.helpOverlay.isVisible()) this.hideHelp();
      else this.showHelp();
    }

    if (this.helpOverlay.isVisible()) {
      if (this.input.pressed("Escape")) {
        this.hideHelp();
      } else if (
        this.input.mouseJustPressed &&
        this.helpOverlay.isCloseButtonHit(this.input.mouseX, this.input.mouseY)
      ) {
        this.hideHelp();
      }
      return;
    }

    const a = this.activeWorm;
    const timeLeftMs = this.state.timeLeftMs(nowMs(), GAMEPLAY.turnTimeMs);
    if (timeLeftMs <= 0 && this.state.phase === "aim") {
      // Auto end turn if no shot
      this.endAimPhaseWithoutShot();
      return;
    }

    // Weapon switching
    if (this.keyAny(["Digit1"])) this.state.setWeapon(WeaponType.Bazooka);
    if (this.keyAny(["Digit2"])) this.state.setWeapon(WeaponType.HandGrenade);
    if (this.keyAny(["Digit3"])) this.state.setWeapon(WeaponType.Rifle);
    // Update cursor visibility when weapon changes
    this.updateCursor();

    // Restart
    if (this.keyAny(["KeyR"])) {
      this.restart();
      return;
    }

    if (this.state.phase === "aim") {
      // Movement
      let move = 0;
      if (this.keyDownAny(["ArrowLeft", "KeyA"])) move -= 1;
      if (this.keyDownAny(["ArrowRight", "KeyD"])) move += 1;
      const jump = this.keyPressedAny(["Space"]);
      a.update(dt, this.terrain, move, jump);

      // Aim face direction based on target X
      const aim = this.getAimInfo();
      if (aim.targetX < a.x) a.facing = -1;
      else a.facing = 1;

      // Charge-based weapons (both)
      if (this.input.mouseJustPressed) {
        this.state.beginCharge(nowMs());
      }
      if (this.state.charging && this.input.mouseJustReleased) {
        const power01 = this.state.endCharge(nowMs());
        this.fireChargedWeapon(power01);
        this.endAimPhaseAfterShot();
        return;
      }
    }
  }

  // charge logic moved to GameState.getCharge01(nowMs)

  // Compute aiming target and angle; Rifle constrains the target to a 200px circle
  getAimInfo(): AimInfo {
    return computeAimInfo({
      input: this.input,
      state: this.state,
      activeWorm: this.activeWorm,
    });
  }

  private fireChargedWeapon(power01: number) {
    const aim = this.getAimInfo();
    fireWeapon({
      weapon: this.state.weapon,
      activeWorm: this.activeWorm,
      aim,
      power01,
      wind: this.wind,
      projectiles: this.projectiles,
      onExplosion: (x, y, r, dmg, cause) => this.onExplosion(x, y, r, dmg, cause),
    });
  }

  endAimPhaseWithoutShot() {
    // Time ran out, pass
    this.state.expireAimPhase();
    setTimeout(() => {
      this.nextTurn();
    }, 400);
  }

  endAimPhaseAfterShot() {
    this.state.shotFired();
    this.message = null;
  }

  onExplosion(x: number, y: number, radius: number, damage: number, cause: WeaponType) {
    // Terrain hole
    this.terrain.carveCircle(x, y, radius);

    // Particles/smoke
    const particleCount = cause === WeaponType.Rifle ? 12 : 50;
    for (let i = 0; i < particleCount; i++) {
      const ang = Math.random() * Math.PI * 2;
      const spd = cause === WeaponType.Rifle ? randRange(60, 180) : randRange(100, 400);
      const vx = Math.cos(ang) * spd;
      const vy = Math.sin(ang) * spd - (cause === WeaponType.Rifle ? 30 : 50);
      const life = randRange(0.3, cause === WeaponType.Rifle ? 0.6 : 0.9);
      const r = randRange(1, cause === WeaponType.Rifle ? 3 : 6);
      const col = i % 2 === 0 ? "rgba(120,120,120,0.8)" : "rgba(200,180,120,0.8)";
      this.particles.push(new Particle(x, y, vx, vy, life, r, col));
    }

    // Damage worms — Rifle does NOT apply radial damage; only crater.
    if (cause !== WeaponType.Rifle) {
      for (const team of this.teams) {
        for (const w of team.worms) {
          if (!w.alive) continue; // ignore dead worms entirely
          const d = distance(x, y, w.x, w.y);
          if (d <= radius * 2) {
            const t = clamp(1 - d / radius, 0, 1);
            const dmg = damage * Math.pow(t, 0.6);
            if (dmg > 0) {
              const wasAlive = w.alive;
              w.takeDamage(dmg);
              // Knockback impulse (even if killed, harmless)
              const dirx = (w.x - x) / (d || 1);
              const diry = (w.y - y) / (d || 1);
              const imp = 240 * t;
              w.applyImpulse(dirx * imp, diry * imp);

              // If this explosion killed the worm, emit a one-time small "poof"
              if (wasAlive && !w.alive) {
                for (let i = 0; i < 12; i++) {
                  const ang = Math.random() * Math.PI * 2;
                  const spd = randRange(30, 120);
                  const vx = Math.cos(ang) * spd;
                  const vy = Math.sin(ang) * spd - 40;
                  this.particles.push(
                    new Particle(
                      w.x,
                      w.y,
                      vx,
                      vy,
                      randRange(0.5, 0.8),
                      randRange(2, 3),
                      "rgba(200,80,80,0.8)"
                    )
                  );
                }
              }
            }
          }
        }
      }
    }
  }

  update(dt: number) {
    this.handleInput(dt);

    if (this.helpOverlay.isVisible()) {
      return;
    }

    // Update projectiles
    if (this.state.phase === "projectile") {
      const specBaz = {
        gravity: WORLD.gravity,
        explosionRadius: GAMEPLAY.bazooka.explosionRadius,
        damage: GAMEPLAY.bazooka.damage,
      };
      const specHG = {
        gravity: WORLD.gravity,
        explosionRadius: GAMEPLAY.handGrenade.explosionRadius,
        damage: GAMEPLAY.handGrenade.damage,
      };
      const specRifle = {
        gravity: 0,
        explosionRadius: GAMEPLAY.rifle.explosionRadius,
        damage: 0, // no radial damage
        maxLifetime: GAMEPLAY.rifle.maxLifetime,
      };

      for (const p of this.projectiles) {
        if (p.type === WeaponType.HandGrenade) p.update(dt, this.terrain, specHG);
        else if (p.type === WeaponType.Bazooka) p.update(dt, this.terrain, specBaz);
        else p.update(dt, this.terrain, specRifle);

        // Rifle: direct-hit check against worms
        if (p.type === WeaponType.Rifle && !p.exploded) {
          for (const team of this.teams) {
            for (const w of team.worms) {
              if (!w.alive) continue;
              const d = distance(p.x, p.y, w.x, w.y);
              if (d <= w.radius) {
                w.takeDamage(GAMEPLAY.rifle.directDamage);
                // Small knockback
                const dirx = (w.x - p.x) / (d || 1);
                const diry = (w.y - p.y) / (d || 1);
                w.applyImpulse(dirx * 120, diry * 120);
                // Small crater at hit
                this.onExplosion(p.x, p.y, GAMEPLAY.rifle.explosionRadius, 0, WeaponType.Rifle);
                p.exploded = true;
                break;
              }
            }
            if (p.exploded) break;
          }
        }
      }

      // Remove exploded/offscreen
      this.projectiles = this.projectiles.filter((p) => !p.exploded);

      // If none left, end after short delay or when particles settle
      if (this.projectiles.length === 0) {
        this.state.endProjectilePhase();
        setTimeout(() => {
          if (this.state.phase === "post") this.nextTurn();
        }, GAMEPLAY.postShotDelayMs);
      }
    }

    // Update particles
    for (const pt of this.particles) {
      pt.update(dt, this.terrain);
    }
    this.particles = this.particles.filter((p) => p.life > 0);

    // Apply physics to non-active worms during projectile phase
    if (this.state.phase !== "aim") {
      for (const team of this.teams) {
        for (const w of team.worms) {
          if (!w.alive) continue;
          const move = 0;
          const jump = false;
          w.update(dt, this.terrain, move, jump);
        }
      }
    }

    // Kill worms falling into water
    for (const team of this.teams) {
      for (const w of team.worms) {
        if (w.alive && w.y > this.height - 8) {
          // Water line
          w.alive = false;
        }
      }
    }

    // Victory check
    this.checkVictory();
  }

  checkVictory() {
    const redAlive = this.teamManager.isTeamAlive("Red");
    const blueAlive = this.teamManager.isTeamAlive("Blue");
    if (!redAlive || !blueAlive) {
      this.state.phase = "gameover";
      const winner = redAlive ? "Red" : blueAlive ? "Blue" : "Nobody";
      this.message = `${winner} wins! Press R to restart.`;
    }
  }

  restart() {
    // Reset everything
    this.terrain = new Terrain(this.width, this.height);
    this.terrain.generate();
    this.teamManager.initialize(this.terrain);
    this.projectiles = [];
    this.particles = [];
    this.teamManager.setCurrentTeamIndex(Math.random() < 0.5 ? 0 : 1);
    this.nextTurn(true);
  }

  // Update canvas cursor based on selected weapon (hide when Rifle)
  private updateCursor() {
    // Hide the OS crosshair cursor when Rifle is selected so only the in-game aiming
    // crosshair (clamped to a radius) is visible. Otherwise show crosshair.
    this.canvas.style.cursor = this.state.weapon === WeaponType.Rifle ? "none" : "crosshair";
  }

  keyAny(codes: string[]) {
    return codes.some((c) => this.input.pressed(c));
  }

  keyDownAny(codes: string[]) {
    return codes.some((c) => this.input.isDown(c));
  }

  keyPressedAny(codes: string[]) {
    return codes.some((c) => this.input.pressed(c));
  }

  getTeamHealth(id: TeamId) {
    return this.teamManager.getTeamHealth(id);
  }

  predictPath(): PredictedPoint[] {
    if (!shouldPredictPath(this.state)) return [];
    const aim = this.getAimInfo();
    const power01 = resolveCharge01(this.state);
    return predictTrajectory({
      weapon: this.state.weapon,
      activeWorm: this.activeWorm,
      aim,
      power01,
      wind: this.wind,
      terrain: this.terrain,
      width: this.width,
      height: this.height,
    });
  }

  // Rendering --------------------------------------------------------

  render() {
    const ctx = this.ctx;
    renderBackground(ctx, this.width, this.height);
    this.terrain.render(ctx);

    for (const p of this.particles) p.render(ctx);

    for (let t = 0; t < this.teams.length; t++) {
      const team = this.teams[t]!;
      for (let i = 0; i < team.worms.length; i++) {
        const w = team.worms[i]!;
        const isActive =
          team.id === this.activeTeam.id &&
          i === this.activeWormIndex &&
          this.state.phase !== "gameover";
        w.render(ctx, isActive);
      }
    }

    for (const pr of this.projectiles) pr.render(ctx);

    renderAimHelpers({
      ctx,
      state: this.state,
      activeWorm: this.activeWorm,
      aim: this.getAimInfo(),
      predictedPath: this.predictPath(),
    });

    renderHUD({
      ctx,
      width: this.width,
      height: this.height,
      state: this.state,
      now: nowMs(),
      activeTeamId: this.activeTeam.id,
      getTeamHealth: (teamId) => this.getTeamHealth(teamId),
      wind: this.wind,
      message: this.message,
      turnDurationMs: GAMEPLAY.turnTimeMs,
    });

    renderGameOver({
      ctx,
      width: this.width,
      height: this.height,
      message: this.message,
      isGameOver: this.state.phase === "gameover",
    });

    this.helpOverlay.render(ctx, this.width, this.height);

    const fpsText = `FPS: ${this.fps.toFixed(1)}`;
    drawText(ctx, fpsText, this.width - 12, 12, COLORS.white, 14, "right");
  }

  // Game loop --------------------------------------------------------

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
    // Clamp dt to avoid big jumps when tabbed out
    dt = Math.min(dt, 1 / 20);
    this.update(dt);
    this.render();
    this.input.update();
    this.lastTimeMs = timeMs;
    if (this.running) {
      this.frameHandle = requestAnimationFrame(this.frameCallback);
    }
  }
}
