import type { TeamId, PredictedPoint } from "./definitions";
import {
  WORLD,
  COLORS,
  GAMEPLAY,
  WeaponType,
  clamp,
  randRange,
  distance,
  nowMs,
} from "./definitions";
import {
  Input,
  drawArrow,
  drawRoundedRect,
  drawAimDots,
  drawHealthBar,
  drawText,
  drawCrosshair,
  drawWrappedText,
} from "./utils";
import { Terrain, Worm, Projectile, Particle } from "./entities";
import { GameState } from "./game-state";
import { ElmRuntime } from "./elm/runtime";
import { initialAppState } from "./elm/init";

 // phase type managed by GameState

type Team = {
  id: TeamId;
  worms: Worm[];
};

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

  terrain: Terrain;
  input: Input;
  state: GameState;

  teams: Team[];
  currentTeamIndex: number;
  activeWormIndex: number;

  projectiles: Projectile[] = [];
  particles: Particle[] = [];

  elm: ElmRuntime;

  wind: number = 0;

  lastTimeMs: number = 0;
  message: string | null = null;

  private helpVisible = false;
  private helpOpenedAtMs: number | null = null;
  private helpCloseRect: Rect | null = null;

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

    // Create teams
    this.teams = [
      { id: "Red", worms: [] },
      { id: "Blue", worms: [] },
    ];
    this.currentTeamIndex = 0;
    this.activeWormIndex = 0;

    this.spawnTeams();
    
    this.state = new GameState();
    this.nextTurn(true);
    
    // Canvas hover style
    this.updateCursor();

    // Initialize Elm runtime (immutable model) without affecting current game logic
    this.elm = new ElmRuntime(
      initialAppState({
        width,
        height,
        nowMs: nowMs(),
        seed: 1,
        windStrength: 0,
        turnDurationMs: GAMEPLAY.turnTimeMs,
      })
    );
  }

  mount(parent: HTMLElement) {
    parent.appendChild(this.canvas);
    // Make canvas focusable and focused so keyboard works reliably across browsers/embeds
    this.canvas.tabIndex = 0;
    this.canvas.focus();
    // Keep focus on interaction
    this.canvas.addEventListener("pointerdown", () => this.canvas.focus());
    this.canvas.addEventListener("mousedown", () => this.canvas.focus());
    this.canvas.addEventListener("touchstart", () => this.canvas.focus());
  }


  private findGroundY(x: number) {
    // Scan down from top margin to find first solid
    for (let y = 0; y < this.height; y++) {
      if (this.terrain.isSolid(x, y)) {
        return y - WORLD.wormRadius - 2;
      }
    }
    return this.height * 0.5;
  }

  private spawnTeams() {
    const positions: number[] = [];
    const lanes = GAMEPLAY.teamSize * 2 + 2;
    for (let i = 1; i <= lanes; i++) {
      positions.push(Math.floor((i / (lanes + 1)) * this.width));
    }
    // Distribute alternating
    let posIndex = 0;
    for (let teamIndex = 0; teamIndex < this.teams.length; teamIndex++) {
      const team = this.teams[teamIndex]!;
      for (let i = 0; i < GAMEPLAY.teamSize; i++) {
        const x = (positions[posIndex++ % positions.length]!) + randRange(-30, 30);
        const y = this.findGroundY(Math.floor(x));
        const worm = new Worm(x, y, team.id, `${team.id[0]}${i + 1}`);

        // Spawn snap: ensure worms start settled on the terrain even if first dt spikes.
        // Nudge slightly downward to guarantee overlap, then resolve upward with a slightly higher climb step.
        {
          const nudge = 3;
          const settled = this.terrain.resolveCircle(worm.x, worm.y + nudge, worm.radius, 12);
          worm.x = settled.x;
          worm.y = settled.y;
          worm.vy = 0;
          worm.onGround = settled.onGround;
        }

        team.worms.push(worm);
      }
    }
  }

  get activeTeam(): Team {
    return this.teams[this.currentTeamIndex]!;
  }

  get activeWorm(): Worm {
    const team = this.activeTeam;
    // Ensure index points to live worm
    let idx = this.activeWormIndex % team.worms.length;
    for (let i = 0; i < team.worms.length; i++) {
      const w = team.worms[(idx + i) % team.worms.length]!;
      if (w.alive) {
        this.activeWormIndex = (idx + i) % team.worms.length;
        return w;
      }
    }
    // Fallback (shouldn't happen if team has living worms)
    return team.worms[0]!;
  }

  nextTurn(initial = false) {
    // Set wind each turn
    this.wind = randRange(-WORLD.windMax, WORLD.windMax);
    this.state.startTurn(nowMs(), WeaponType.Bazooka);
    this.message = initial ? "Welcome! Eliminate the other team!" : null;
    // Ensure cursor matches the newly selected weapon
    this.updateCursor();

    // Move to next team's living worm
    if (!initial) {
      this.currentTeamIndex = (this.currentTeamIndex + 1) % this.teams.length;
      // Select next living worm index for that team
      const team = this.activeTeam;
      let idx = (this.activeWormIndex + 1) % team.worms.length;
      for (let i = 0; i < team.worms.length; i++) {
        const w = team.worms[(idx + i) % team.worms.length]!;
        if (w.alive) {
          this.activeWormIndex = (idx + i) % team.worms.length;
          break;
        }
      }
    }
  }

  private showHelp() {
    if (this.helpVisible) return;
    this.helpVisible = true;
    this.helpOpenedAtMs = nowMs();
    if (this.state.charging) {
      this.state.charging = false;
    }
  }

  private hideHelp() {
    if (!this.helpVisible) return;
    const openedAt = this.helpOpenedAtMs;
    if (openedAt != null) {
      const pausedFor = nowMs() - openedAt;
      this.state.turnStartMs += pausedFor;
      if (this.state.chargeStartMs) {
        this.state.chargeStartMs += pausedFor;
      }
    }
    this.helpVisible = false;
    this.helpOpenedAtMs = null;
  }

  private pointInRect(x: number, y: number, rect: Rect | null) {
    if (!rect) return false;
    return (
      x >= rect.x &&
      x <= rect.x + rect.width &&
      y >= rect.y &&
      y <= rect.y + rect.height
    );
  }

  handleInput(dt: number) {
    if (this.input.pressed("F1")) {
      if (this.helpVisible) this.hideHelp();
      else this.showHelp();
    }

    if (this.helpVisible) {
      if (this.input.pressed("Escape")) {
        this.hideHelp();
      } else if (
        this.input.mouseJustPressed &&
        this.pointInRect(this.input.mouseX, this.input.mouseY, this.helpCloseRect)
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
  getAimInfo() {
    const a = this.activeWorm;
    let dx = this.input.mouseX - a.x;
    let dy = this.input.mouseY - a.y;
    if (this.state.weapon === WeaponType.Rifle) {
      const len = Math.hypot(dx, dy) || 1;
      const r = GAMEPLAY.rifle.aimRadius;
      if (len > r) {
        dx = (dx / len) * r;
        dy = (dy / len) * r;
      }
    }
    const targetX = a.x + dx;
    const targetY = a.y + dy;
    const angle = Math.atan2(targetY - a.y, targetX - a.x);
    return { targetX, targetY, angle };
  }

  fireChargedWeapon(power01: number) {
    const a = this.activeWorm;
    const { angle } = this.getAimInfo();
    const muzzleOffset = WORLD.wormRadius + 10;
    const sx = a.x + Math.cos(angle) * muzzleOffset;
    const sy = a.y + Math.sin(angle) * muzzleOffset;

    if (this.state.weapon === WeaponType.Bazooka) {
      const speed =
        GAMEPLAY.bazooka.minPower +
        (GAMEPLAY.bazooka.maxPower - GAMEPLAY.bazooka.minPower) * power01;
      const vx = Math.cos(angle) * speed;
      const vy = Math.sin(angle) * speed;
      this.projectiles.push(
        new Projectile(
          sx,
          sy,
          vx,
          vy,
          WORLD.projectileRadius,
          WeaponType.Bazooka,
          this.wind,
          (x, y, r, dmg) => this.onExplosion(x, y, r, dmg, WeaponType.Bazooka)
        )
      );
    } else if (this.state.weapon === WeaponType.HandGrenade) {
      const speed =
        GAMEPLAY.handGrenade.minPower +
        (GAMEPLAY.handGrenade.maxPower - GAMEPLAY.handGrenade.minPower) * power01;
      const vx = Math.cos(angle) * speed;
      const vy = Math.sin(angle) * speed;
      this.projectiles.push(
        new Projectile(
          sx,
          sy,
          vx,
          vy,
          WORLD.projectileRadius,
          WeaponType.HandGrenade,
          this.wind,
          (x, y, r, dmg) => this.onExplosion(x, y, r, dmg, WeaponType.HandGrenade),
          { fuse: GAMEPLAY.handGrenade.fuseMs, restitution: GAMEPLAY.handGrenade.restitution }
        )
      );
    } else if (this.state.weapon === WeaponType.Rifle) {
      // Straight shot, speed is fixed; no gravity/wind effects
      const speed = GAMEPLAY.rifle.speed;
      const vx = Math.cos(angle) * speed;
      const vy = Math.sin(angle) * speed;
      this.projectiles.push(
        new Projectile(
          sx,
          sy,
          vx,
          vy,
          GAMEPLAY.rifle.projectileRadius,
          WeaponType.Rifle,
          0, // ignore wind
          (x, y, r, dmg) => this.onExplosion(x, y, r, dmg, WeaponType.Rifle)
        )
      );
    }
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

    if (this.helpVisible) {
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
    const redAlive = this.teams[0]!.worms.some((w) => w.alive);
    const blueAlive = this.teams[1]!.worms.some((w) => w.alive);
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
    this.teams = [
      { id: "Red", worms: [] },
      { id: "Blue", worms: [] },
    ];
    this.spawnTeams();
    this.projectiles = [];
    this.particles = [];
    this.currentTeamIndex = Math.random() < 0.5 ? 0 : 1;
    this.activeWormIndex = 0;
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
    const team = this.teams.find((t) => t.id === id)!;
    return team.worms.reduce((sum, w) => sum + (w.alive ? w.health : 0), 0);
  }

  predictPath(): PredictedPoint[] {
    if (this.state.phase !== "aim") return [];
    if (!this.state.charging) return [];
    const a = this.activeWorm;
    const { angle } = this.getAimInfo();

    // Start at muzzle
    const muzzleOffset = WORLD.wormRadius + 10;
    const sx = a.x + Math.cos(angle) * muzzleOffset;
    const sy = a.y + Math.sin(angle) * muzzleOffset;

    // Rifle: straight ray until terrain hit or lifetime distance
    if (this.state.weapon === WeaponType.Rifle) {
      const pts: PredictedPoint[] = [];
      const dirx = Math.cos(angle);
      const diry = Math.sin(angle);
      // Raycast to terrain
      const hit = this.terrain.raycast(sx, sy, dirx, diry, 2000, 3);
      const maxDist = hit ? hit.dist : 800;
      const step = 16;
      for (let d = 0; d <= maxDist; d += step) {
        const x = sx + dirx * d;
        const y = sy + diry * d;
        const alpha = clamp(1 - d / maxDist, 0.1, 1);
        pts.push({ x, y, alpha });
      }
      return pts;
    }

    // Bazooka / Hand Grenade: simulate arc with gravity and wind
    const power01 = this.state.getCharge01(nowMs());
    const speed =
      this.state.weapon === WeaponType.Bazooka
        ? GAMEPLAY.bazooka.minPower +
          (GAMEPLAY.bazooka.maxPower - GAMEPLAY.bazooka.minPower) * power01
        : GAMEPLAY.handGrenade.minPower +
          (GAMEPLAY.handGrenade.maxPower - GAMEPLAY.handGrenade.minPower) * power01;
    let vx = Math.cos(angle) * speed;
    let vy = Math.sin(angle) * speed;
    const ax = this.wind; // wind accel (px/s^2)
    const ay = WORLD.gravity;

    const pts: PredictedPoint[] = [];
    let x = sx;
    let y = sy;
    const dt = 1 / 60;
    const maxT = 3.0; // seconds
    const steps = Math.floor(maxT / dt);
    for (let i = 0; i < steps; i++) {
      // advance
      vy += ay * dt;
      vx += ax * dt;
      x += vx * dt;
      y += vy * dt;

      // record every few steps
      if (i % 2 === 0) {
        const t = i * dt;
        const alpha = clamp(1 - t / maxT, 0.15, 1);
        pts.push({ x, y, alpha });
      }

      // stop on terrain hit or offscreen
      if (this.terrain.circleCollides(x, y, WORLD.projectileRadius)) break;
      if (x < -50 || x > this.width + 50 || y > this.height + 50) break;
    }
    return pts;
  }

  // Rendering --------------------------------------------------------

  private renderBackground() {
    const ctx = this.ctx;
    const g = ctx.createLinearGradient(0, 0, 0, this.height);
    g.addColorStop(0, COLORS.bgSkyTop);
    g.addColorStop(1, COLORS.bgSkyBottom);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, this.width, this.height);

    // Water at bottom
    ctx.fillStyle = COLORS.water;
    const waterH = 30;
    ctx.fillRect(0, this.height - waterH, this.width, waterH);
  }

  private renderHUD() {
    const ctx = this.ctx;
    const padding = 10;

    // Top HUD bar
    const barH = 44;
    ctx.save();
    drawRoundedRect(ctx, padding, padding, this.width - padding * 2, barH, 10);
    ctx.fillStyle = COLORS.hudBg;
    ctx.fill();
    ctx.strokeStyle = COLORS.hudPanelBorder;
    ctx.lineWidth = 1;
    ctx.stroke();

    // Team health
    const redHealth = this.getTeamHealth("Red");
    const blueHealth = this.getTeamHealth("Blue");
    const maxTeamHealth = GAMEPLAY.teamSize * 100;
    const hbW = 140;
    const hbH = 10;
    const leftX = padding + 12 + hbW / 2;
    const rightX = this.width - padding - 12 - hbW / 2;
    const topY = padding + 10;

    drawText(ctx, "RED", padding + 12, topY, COLORS.white, 14);
    drawHealthBar(ctx, leftX, topY + 16, hbW, hbH, redHealth / maxTeamHealth, COLORS.healthGreen, COLORS.healthRed);

    drawText(ctx, "BLUE", this.width - padding - 12, topY, COLORS.white, 14, "right");
    drawHealthBar(ctx, rightX, topY + 16, hbW, hbH, blueHealth / maxTeamHealth, COLORS.healthGreen, COLORS.healthRed);

    drawText(ctx, "F1: Help", padding + 12, topY + 30, COLORS.white, 12);

    // Center: current team, weapon, timer
    const timeLeftMs = this.state.timeLeftMs(nowMs(), GAMEPLAY.turnTimeMs);
    const timeLeft = Math.max(0, Math.ceil(timeLeftMs / 1000));
    const centerX = this.width / 2;

    const teamStr = `${this.activeTeam.id} Team`;
    const weaponStr = `Weapon: ${this.state.weapon}`;
    const clockStr = `Time: ${timeLeft}s`;

    drawText(ctx, teamStr, centerX, topY, COLORS.white, 14, "center");
    drawText(ctx, weaponStr, centerX, topY + 16, COLORS.white, 14, "center");
    drawText(ctx, clockStr, centerX, topY + 30, COLORS.white, 12, "center");

    // Wind indicator below center
    const windY = padding + barH + 14;
    const dir = Math.sign(this.wind);
    const mag = Math.abs(this.wind) / WORLD.windMax;
    const length = 80 * mag;
    drawArrow(ctx, centerX - length / 2 * dir, windY, 0, length * dir || 0.0001, COLORS.power, 4);
    drawText(ctx, "Wind", centerX, windY + 6, COLORS.white, 12, "center", "top", false);

    ctx.restore();

    // Power bar while charging
    if (this.state.phase === "aim" && this.state.charging) {
      const charge = this.state.getCharge01(nowMs());
      const w = 260;
      const h = 16;
      const x = (this.width - w) / 2;
      const y = this.height - h - 18;
      drawRoundedRect(ctx, x, y, w, h, 8);
      ctx.fillStyle = COLORS.hudBg;
      ctx.fill();
      drawRoundedRect(ctx, x + 2, y + 2, (w - 4) * charge, h - 4, (h - 4) / 2);
      ctx.fillStyle = COLORS.power;
      ctx.fill();
      drawText(ctx, "Hold and release to fire", this.width / 2, y - 18, COLORS.white, 14, "center");
    }

    // Message (non-gameover)
    if (this.message && this.state.phase !== "gameover") {
      drawText(ctx, this.message, this.width / 2, padding + barH + 32, COLORS.white, 16, "center");
    }
  }

  private renderHelpOverlay() {
    if (!this.helpVisible) {
      this.helpCloseRect = null;
      return;
    }

    const ctx = this.ctx;
    ctx.save();
    ctx.fillStyle = "rgba(4, 8, 18, 0.6)";
    ctx.fillRect(0, 0, this.width, this.height);

    let panelW = Math.min(620, Math.max(360, this.width - 120));
    let panelH = Math.min(420, Math.max(300, this.height - 200));
    panelW = Math.min(panelW, this.width - 40);
    panelH = Math.min(panelH, this.height - 40);
    const x = (this.width - panelW) / 2;
    const y = (this.height - panelH) / 2;

    drawRoundedRect(ctx, x, y, panelW, panelH, 20);
    ctx.fillStyle = "rgba(18, 26, 46, 0.94)";
    ctx.fill();
    ctx.strokeStyle = "rgba(255, 255, 255, 0.2)";
    ctx.lineWidth = 2;
    ctx.stroke();

    const titleY = y + 44;
    drawText(
      ctx,
      "Worm Commander's Handy Guide",
      x + panelW / 2,
      titleY,
      COLORS.white,
      24,
      "center"
    );

    const subtitleY = titleY + 28;
    drawText(
      ctx,
      "(Pause, sip cocoa, then plan your next shenanigan)",
      x + panelW / 2,
      subtitleY,
      COLORS.white,
      14,
      "center"
    );

    const bulletPoints = [
      "Move: A / D or ← → for a wiggly parade march.",
      "Hop: W or Space to vault over suspicious craters.",
      "Aim: Wiggle the mouse, keep your eyes on the crosshair.",
      "Charge & Fire: Hold the mouse button, release to unleash mayhem.",
      "Swap Toys: 1 Bazooka, 2 Grenade, 3 Rifle — choose your chaos.",
      "Wind Watch: mind the gusts before you light the fuse!",
    ];

    const contentMargin = 44;
    const contentX = x + contentMargin;
    const contentWidth = panelW - contentMargin * 2;
    let lineY = subtitleY + 36;

    for (const point of bulletPoints) {
      const consumed = drawWrappedText(
        ctx,
        `• ${point}`,
        contentX,
        lineY,
        COLORS.white,
        contentWidth,
        16,
        26
      );
      lineY += consumed + 10;
    }

    const buttonSize = 32;
    const buttonPadding = 18;
    const buttonX = x + panelW - buttonPadding - buttonSize;
    const buttonY = y + buttonPadding;
    drawRoundedRect(ctx, buttonX, buttonY, buttonSize, buttonSize, 10);
    ctx.fillStyle = "rgba(255, 255, 255, 0.1)";
    ctx.fill();
    ctx.strokeStyle = "rgba(255, 255, 255, 0.3)";
    ctx.stroke();
    drawText(ctx, "✕", buttonX + buttonSize / 2, buttonY + buttonSize / 2, COLORS.white, 20, "center", "middle");

    this.helpCloseRect = { x: buttonX, y: buttonY, width: buttonSize, height: buttonSize };

    ctx.restore();
  }

  private renderGameOver() {
    // Show a large centered winning message when the game is over.
    if (this.state.phase !== "gameover" || !this.message) return;
    const ctx = this.ctx;
    const x = this.width / 2;
    const y = this.height / 2;
    // ~20mm on a typical 96 DPI screen ≈ 76px. Use a fixed pixel size for consistency.
    const sizePx = 76;
    ctx.save();
    ctx.font = `bold ${sizePx}px ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    const msg = this.message!;

    // Draw a shadow for the whole message to improve contrast
    ctx.fillStyle = "rgba(0,0,0,0.6)";
    ctx.fillText(msg, x + 4, y + 4);

    // Try to specifically highlight the "R" in the "Press R" portion.
    // The message format is: "<Winner> wins! Press R to restart."
    const search = "Press ";
    const idx = msg.indexOf(search);
    if (idx !== -1 && idx + search.length < msg.length) {
      const idxR = idx + search.length;
      const pre = msg.slice(0, idxR); // includes "Press "
      const rChar = msg[idxR] ?? "";
      const post = msg.slice(idxR + 1);

      // Measure total width and compute left-aligned start so we can draw segments precisely.
      const totalWidth = ctx.measureText(msg).width;
      let startX = x - totalWidth / 2;

      // Draw 'pre' (left segment)
      ctx.fillStyle = COLORS.white;
      // For centered drawing of a segment we need to convert the segment position to its center X.
      const preWidth = ctx.measureText(pre).width;
      ctx.fillText(pre, startX + preWidth / 2, y);

      // Draw the highlighted 'R'
      const rWidth = ctx.measureText(rChar).width;
      ctx.fillStyle = COLORS.red;
      ctx.fillText(rChar, startX + preWidth + rWidth / 2, y);

      // Draw the 'post' (right segment)
      const postWidth = ctx.measureText(post).width;
      ctx.fillStyle = COLORS.white;
      ctx.fillText(post, startX + preWidth + rWidth + postWidth / 2, y);
    } else {
      // Fallback: draw whole message in white centered
      ctx.fillStyle = COLORS.white;
      ctx.fillText(msg, x, y);
    }

    ctx.restore();
  }

  private renderAimHelpers() {
    if (this.state.phase !== "aim") return;

    const ctx = this.ctx;
    const a = this.activeWorm;
    const { targetX, targetY, angle } = this.getAimInfo();

    // Predicted path dots while charging
    const pts = this.predictPath();
    if (pts.length > 0) {
      ctx.save();
      ctx.globalAlpha = 0.9;
      drawAimDots(ctx, pts, COLORS.white);
      ctx.restore();
    }

    // Crosshair at target (rifle constrained inside a circle)
    const chSize = 8;
    const crossCol = this.state.weapon === WeaponType.Rifle ? "#ffd84d" : "#fff";
    drawCrosshair(ctx, targetX, targetY, chSize, crossCol, 2);

    // Visualize rifle aim radius
    if (this.state.weapon === WeaponType.Rifle) {
      ctx.save();
      ctx.globalAlpha = 0.15;
      ctx.beginPath();
      ctx.arc(a.x, a.y, GAMEPLAY.rifle.aimRadius, 0, Math.PI * 2);
      ctx.fillStyle = "#ffd84d";
      ctx.fill();
      ctx.restore();
    }

    // Small muzzle direction indicator
    const muzzleOffset = WORLD.wormRadius + 10;
    const mx = a.x + Math.cos(angle) * muzzleOffset;
    const my = a.y + Math.sin(angle) * muzzleOffset;
    ctx.save();
    ctx.strokeStyle = "rgba(255,255,255,0.6)";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(mx, my);
    ctx.stroke();
    ctx.restore();
  }

  render() {
    const ctx = this.ctx;
    // Background and terrain
    this.renderBackground();
    this.terrain.render(ctx);

    // Particles below worms if desired
    for (const p of this.particles) p.render(ctx);

    // Worms
    for (let t = 0; t < this.teams.length; t++) {
      const team = this.teams[t]!;
      for (let i = 0; i < team.worms.length; i++) {
        const w = team.worms[i]!;
        const isActive = team.id === this.activeTeam.id && i === this.activeWormIndex && this.state.phase !== "gameover";
        w.render(ctx, isActive);
      }
    }

    // Projectiles
    for (const pr of this.projectiles) pr.render(ctx);

    // Aim helpers
    this.renderAimHelpers();

    // HUD
    this.renderHUD();

    // Large centered game-over message (drawn on top of everything)
    this.renderGameOver();

    // Help overlay (pauses gameplay and sits atop everything)
    this.renderHelpOverlay();
  }

  // Game loop --------------------------------------------------------

  frame(timeMs: number) {
    if (!this.lastTimeMs) this.lastTimeMs = timeMs;
    let dt = (timeMs - this.lastTimeMs) / 1000;
    // Clamp dt to avoid big jumps when tabbed out
    dt = Math.min(dt, 1 / 20);
    // Drive the Elm-style model tick (no behavior changes yet)
    if (this.elm) {
      this.elm.dispatch({ type: "TickAdvanced", nowMs: nowMs(), dtMs: dt * 1000 });
    }
    this.update(dt);
    this.render();
    this.input.update();
    this.lastTimeMs = timeMs;
    requestAnimationFrame((t) => this.frame(t));
  }
}
