import type { TeamId, PredictedPoint } from "../definitions";
import {
  WORLD,
  GAMEPLAY,
  WeaponType,
  clamp,
  distance,
  nowMs,
} from "../definitions";
import type { Input } from "../utils";
import { Terrain, Worm, Projectile, Particle } from "../entities";
import { GameState, type Phase } from "../game-state";
import { TeamManager, type Team } from "./team-manager";
import {
  computeAimInfo,
  fireWeapon,
  predictTrajectory,
  resolveCharge01,
  shouldPredictPath,
} from "./weapon-system";

/**
 * Hooks that allow the host environment (e.g. the DOM-oriented `Game` wrapper)
 * to react to important simulation events coming from the DOM-free session
 * core.
 */
export interface SessionCallbacks {
  onExplosion?: (info: {
    x: number;
    y: number;
    radius: number;
    damage: number;
    cause: WeaponType;
  }) => void;
  onRestart?: () => void;
}

export interface WormSnapshot {
  name: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
  health: number;
  alive: boolean;
  facing: number;
  onGround: boolean;
  age: number;
}

export interface TeamSnapshot {
  id: TeamId;
  worms: WormSnapshot[];
}

export interface TerrainSnapshot {
  width: number;
  height: number;
  horizontalPadding: number;
  solid: number[];
  heightMap: number[];
}

export interface GameStateSnapshot {
  phase: Phase;
  weapon: WeaponType;
  turnStartMs: number;
  charging: boolean;
  chargeStartMs: number;
}

export interface GameSnapshot {
  width: number;
  height: number;
  wind: number;
  message: string | null;
  terrain: TerrainSnapshot;
  teams: TeamSnapshot[];
  state: GameStateSnapshot;
  activeTeamIndex: number;
  activeWormIndex: number;
}

export class GameSession {
  readonly width: number;
  readonly height: number;
  readonly terrain: Terrain;
  readonly state: GameState;

  private readonly teamManager: TeamManager;
  private readonly callbacks: SessionCallbacks;
  private readonly horizontalPadding: number;
  private readonly random: () => number;
  private readonly now: () => number;

  projectiles: Projectile[] = [];
  particles: Particle[] = [];
  wind = 0;
  message: string | null = null;

  constructor(
    width: number,
    height: number,
    options?: {
      horizontalPadding?: number;
      callbacks?: SessionCallbacks;
      random?: () => number;
      now?: () => number;
    }
  ) {
    this.width = width;
    this.height = height;
    this.horizontalPadding = Math.max(0, options?.horizontalPadding ?? 0);
    this.callbacks = options?.callbacks ?? {};
    this.random = options?.random ?? Math.random;
    this.now = options?.now ?? nowMs;

    this.terrain = new Terrain(width, height, {
      horizontalPadding: this.horizontalPadding,
      random: this.random,
    });
    this.terrain.generate();

    this.teamManager = new TeamManager(width, height, this.random);
    this.teamManager.initialize(this.terrain);

    this.state = new GameState();
    this.nextTurn(true);
  }

  get activeTeam(): Team {
    return this.teamManager.activeTeam;
  }

  get activeWorm(): Worm {
    return this.teamManager.activeWorm;
  }

  get teams(): Team[] {
    return this.teamManager.teams;
  }

  get activeWormIndex(): number {
    return this.teamManager.activeWormIndex;
  }

  nextTurn(initial = false) {
    this.wind = this.randomRange(-WORLD.windMax, WORLD.windMax);
    this.state.startTurn(this.now(), WeaponType.Bazooka);
    this.message = initial ? "Welcome! Eliminate the other team!" : null;

    if (initial) this.teamManager.resetActiveWormIndex();
    else this.teamManager.advanceToNextTeam();
  }

  handleInput(
    input: Input,
    dt: number,
    camera: { offsetX: number; offsetY: number }
  ) {
    const active = this.activeWorm;
    const timeLeftMs = this.state.timeLeftMs(this.now(), GAMEPLAY.turnTimeMs);
    if (timeLeftMs <= 0 && this.state.phase === "aim") {
      this.endAimPhaseWithoutShot();
      return;
    }

    if (input.pressed("Digit1")) this.state.setWeapon(WeaponType.Bazooka);
    if (input.pressed("Digit2")) this.state.setWeapon(WeaponType.HandGrenade);
    if (input.pressed("Digit3")) this.state.setWeapon(WeaponType.Rifle);

    if (input.pressed("KeyR")) {
      this.restart();
      return;
    }

    if (this.state.phase === "aim") {
      let move = 0;
      if (input.isDown("ArrowLeft") || input.isDown("KeyA")) move -= 1;
      if (input.isDown("ArrowRight") || input.isDown("KeyD")) move += 1;
      const jump = input.pressed("Space");
      active.update(dt, this.terrain, move, jump);

      const aim = this.getAimInfo(input, camera);
      active.facing = aim.targetX < active.x ? -1 : 1;

      if (input.mouseJustPressed) {
        this.state.beginCharge(this.now());
      }
      if (this.state.charging && input.mouseJustReleased) {
        const power01 = this.state.endCharge(this.now());
        this.fireChargedWeapon(power01, input, camera);
        this.endAimPhaseAfterShot();
      }
    }
  }

  update(dt: number) {
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
        damage: 0,
        maxLifetime: GAMEPLAY.rifle.maxLifetime,
      };

      for (const projectile of this.projectiles) {
        if (projectile.type === WeaponType.HandGrenade)
          projectile.update(dt, this.terrain, specHG);
        else if (projectile.type === WeaponType.Bazooka)
          projectile.update(dt, this.terrain, specBaz);
        else projectile.update(dt, this.terrain, specRifle);

        if (projectile.type === WeaponType.Rifle && !projectile.exploded) {
          for (const team of this.teams) {
            for (const worm of team.worms) {
              if (!worm.alive) continue;
              const d = distance(projectile.x, projectile.y, worm.x, worm.y);
              if (d <= worm.radius) {
                worm.takeDamage(GAMEPLAY.rifle.directDamage);
                const dirx = (worm.x - projectile.x) / (d || 1);
                const diry = (worm.y - projectile.y) / (d || 1);
                worm.applyImpulse(dirx * 120, diry * 120);
                this.onExplosion(
                  projectile.x,
                  projectile.y,
                  GAMEPLAY.rifle.explosionRadius,
                  0,
                  WeaponType.Rifle
                );
                projectile.exploded = true;
                break;
              }
            }
            if (projectile.exploded) break;
          }
        }
      }

      this.projectiles = this.projectiles.filter((p) => !p.exploded);

      if (this.projectiles.length === 0) {
        this.state.endProjectilePhase();
        setTimeout(() => {
          if (this.state.phase === "post") this.nextTurn();
        }, GAMEPLAY.postShotDelayMs);
      }
    }

    for (const particle of this.particles) {
      particle.update(dt, this.terrain);
    }
    this.particles = this.particles.filter((p) => p.life > 0);

    if (this.state.phase !== "aim") {
      for (const team of this.teams) {
        for (const worm of team.worms) {
          if (!worm.alive) continue;
          worm.update(dt, this.terrain, 0, false);
        }
      }
    }

    this.teamManager.killWormsBelow(this.height - 8);
    this.checkVictory();
  }

  getAimInfo(
    input: Input,
    camera: { offsetX: number; offsetY: number }
  ) {
    return computeAimInfo({
      input,
      state: this.state,
      activeWorm: this.activeWorm,
      cameraOffsetX: camera.offsetX,
      cameraOffsetY: camera.offsetY,
    });
  }

  predictPath(
    input: Input,
    camera: { offsetX: number; offsetY: number }
  ): PredictedPoint[] {
    if (!shouldPredictPath(this.state)) return [];
    const aim = this.getAimInfo(input, camera);
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

  getTeamHealth(id: TeamId) {
    return this.teamManager.getTeamHealth(id);
  }

  restart() {
    this.terrain.generate();
    this.teamManager.initialize(this.terrain);
    this.projectiles = [];
    this.particles = [];
    this.teamManager.setCurrentTeamIndex(this.random() < 0.5 ? 0 : 1);
    this.nextTurn(true);
    this.callbacks.onRestart?.();
  }

  toSnapshot(): GameSnapshot {
    return {
      width: this.width,
      height: this.height,
      wind: this.wind,
      message: this.message,
      terrain: {
        width: this.terrain.width,
        height: this.terrain.height,
        horizontalPadding: this.horizontalPadding,
        solid: Array.from(this.terrain.solid),
        heightMap: [...this.terrain.heightMap],
      },
      teams: this.teams.map((team) => ({
        id: team.id,
        worms: team.worms.map((worm) => ({
          name: worm.name,
          x: worm.x,
          y: worm.y,
          vx: worm.vx,
          vy: worm.vy,
          health: worm.health,
          alive: worm.alive,
          facing: worm.facing,
          onGround: worm.onGround,
          age: worm.age,
        })),
      })),
      state: {
        phase: this.state.phase,
        weapon: this.state.weapon,
        turnStartMs: this.state.turnStartMs,
        charging: this.state.charging,
        chargeStartMs: this.state.chargeStartMs,
      },
      activeTeamIndex: this.teamManager.activeTeamIndex,
      activeWormIndex: this.teamManager.activeWormIndex,
    };
  }

  loadSnapshot(snapshot: GameSnapshot) {
    if (snapshot.width !== this.width || snapshot.height !== this.height) {
      throw new Error("Snapshot dimensions do not match session dimensions");
    }

    this.wind = snapshot.wind;
    this.message = snapshot.message;

    if (
      snapshot.terrain.width !== this.terrain.width ||
      snapshot.terrain.height !== this.terrain.height
    ) {
      throw new Error("Snapshot terrain dimensions do not match");
    }

    this.terrain.solid = new Uint8Array(snapshot.terrain.solid);
    this.terrain.heightMap = [...snapshot.terrain.heightMap];
    this.terrain.syncHeightMapFromSolid();
    this.terrain.repaint();

    const restoredTeams: Team[] = snapshot.teams.map((teamData) => {
      const team: Team = { id: teamData.id, worms: [] };
      for (const wormData of teamData.worms) {
        const worm = new Worm(wormData.x, wormData.y, teamData.id, wormData.name);
        worm.vx = wormData.vx;
        worm.vy = wormData.vy;
        worm.health = wormData.health;
        worm.alive = wormData.alive;
        worm.facing = wormData.facing;
        worm.onGround = wormData.onGround;
        worm.age = wormData.age;
        team.worms.push(worm);
      }
      return team;
    });

    this.teamManager.teams = restoredTeams;
    this.teamManager.setCurrentTeamIndex(snapshot.activeTeamIndex);
    this.teamManager.setActiveWormIndex(snapshot.activeWormIndex);

    this.state.phase = snapshot.state.phase;
    this.state.weapon = snapshot.state.weapon;
    this.state.turnStartMs = snapshot.state.turnStartMs;
    this.state.charging = snapshot.state.charging;
    this.state.chargeStartMs = snapshot.state.chargeStartMs;

    this.projectiles = [];
    this.particles = [];
  }

  private randomRange(min: number, max: number) {
    return this.random() * (max - min) + min;
  }

  private fireChargedWeapon(
    power01: number,
    input: Input,
    camera: { offsetX: number; offsetY: number }
  ) {
    const aim = this.getAimInfo(input, camera);
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

  private onExplosion(
    x: number,
    y: number,
    radius: number,
    damage: number,
    cause: WeaponType
  ) {
    this.terrain.carveCircle(x, y, radius);

    const particleCount = cause === WeaponType.Rifle ? 12 : 50;
    for (let i = 0; i < particleCount; i++) {
      const ang = this.random() * Math.PI * 2;
      const spd =
        cause === WeaponType.Rifle
          ? this.randomRange(60, 180)
          : this.randomRange(100, 400);
      const vx = Math.cos(ang) * spd;
      const vy =
        Math.sin(ang) * spd - (cause === WeaponType.Rifle ? 30 : 50);
      const life = this.randomRange(0.3, cause === WeaponType.Rifle ? 0.6 : 0.9);
      const r = this.randomRange(1, cause === WeaponType.Rifle ? 3 : 6);
      const col =
        i % 2 === 0 ? "rgba(120,120,120,0.8)" : "rgba(200,180,120,0.8)";
      this.particles.push(new Particle(x, y, vx, vy, life, r, col));
    }

    if (cause !== WeaponType.Rifle) {
      for (const team of this.teams) {
        for (const worm of team.worms) {
          if (!worm.alive) continue;
          const d = distance(x, y, worm.x, worm.y);
          if (d <= radius * 2) {
            const t = clamp(1 - d / radius, 0, 1);
            const dmg = damage * Math.pow(t, 0.6);
            if (dmg > 0) {
              const wasAlive = worm.alive;
              worm.takeDamage(dmg);
              const dirx = (worm.x - x) / (d || 1);
              const diry = (worm.y - y) / (d || 1);
              const imp = 240 * t;
              worm.applyImpulse(dirx * imp, diry * imp);

              if (wasAlive && !worm.alive) {
                for (let i = 0; i < 12; i++) {
                  const ang = this.random() * Math.PI * 2;
                  const spd = this.randomRange(30, 120);
                  const vx = Math.cos(ang) * spd;
                  const vy = Math.sin(ang) * spd - 40;
                  this.particles.push(
                    new Particle(
                      worm.x,
                      worm.y,
                      vx,
                      vy,
                      this.randomRange(0.5, 0.8),
                      this.randomRange(2, 3),
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

    this.callbacks.onExplosion?.({ x, y, radius, damage, cause });
  }

  private endAimPhaseWithoutShot() {
    this.state.expireAimPhase();
    setTimeout(() => {
      this.nextTurn();
    }, 400);
  }

  private endAimPhaseAfterShot() {
    this.state.shotFired();
    this.message = null;
  }

  private checkVictory() {
    const redAlive = this.teamManager.isTeamAlive("Red");
    const blueAlive = this.teamManager.isTeamAlive("Blue");
    if (!redAlive || !blueAlive) {
      this.state.phase = "gameover";
      const winner = redAlive ? "Red" : blueAlive ? "Blue" : "Nobody";
      this.message = `${winner} wins! Press R to restart.`;
    }
  }
}
