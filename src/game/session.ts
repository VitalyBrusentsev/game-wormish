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
import type { AimInfo } from "../rendering/game-rendering";
import {
  computeAimInfo,
  computeAimAngleFromTarget,
  fireWeapon,
  predictTrajectory,
  shouldPredictPath,
} from "./weapon-system";
import { gameEvents, type GameEventSource } from "../events/game-events";
import { computeWeaponRig } from "../critter/critter-geometry";
import type {
  TerrainOperation,
  TurnCommand,
  TurnEvent,
  TurnResolution,
  WormHealthChange,
} from "./network/turn-payload";
import type {
  TurnDriver,
  TurnDriverUpdateOptions,
  TurnContext,
} from "./turn-driver";
import { critterHitTestCircle } from "./critter-hit-test";

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
  tileIndex: number;
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
  turnIndex: number;
  wind: number;
  message: string | null;
  terrain: TerrainSnapshot;
  teams: TeamSnapshot[];
  state: GameStateSnapshot;
  activeTeamIndex: number;
  activeWormIndex: number;
}

export interface NetworkTurnSnapshot {
  turnIndex: number;
  wind: number;
  message: string | null;
  teams: TeamSnapshot[];
  state: GameStateSnapshot;
  activeTeamIndex: number;
  activeWormIndex: number;
}

export interface MatchInitSnapshot {
  width: number;
  height: number;
  turnIndex: number;
  wind: number;
  message: string | null;
  terrain: Omit<TerrainSnapshot, "solid">;
  teams: TeamSnapshot[];
  state: GameStateSnapshot;
  activeTeamIndex: number;
  activeWormIndex: number;
}

type TurnLog = {
  startedAtMs: number;
  turnIndex: number;
  actingTeamId: TeamId | null;
  actingTeamIndex: number | null;
  actingWormIndex: number | null;
  windAtStart: number | null;
  commands: TurnCommand[];
  projectileEvents: TurnEvent[];
  terrainOperations: TerrainOperation[];
  wormHealth: WormHealthChange[];
};

type UziBurst = {
  origin: { x: number; y: number };
  facing: -1 | 1;
  aimAngle: number;
  seedBase: number;
  startAtMs: number;
  nextShotIndex: number;
  projectileIds: number[];
};

export type UziBurstSnapshot = {
  origin: { x: number; y: number };
  facing: -1 | 1;
  aimAngle: number;
  seedBase: number;
  startAtMs: number;
  nextShotIndex: number;
  shotCount: number;
};

type AiPreShotVisual = {
  turnIndex: number;
  teamId: TeamId;
  wormIndex: number;
  weapon: WeaponType;
  power01: number;
  startMs: number;
  endMs: number;
  startAngle: number;
  targetAngle: number;
  overshootAngle: number;
  undershootAngle: number;
};

export class GameSession {
  readonly width: number;
  readonly height: number;
  readonly terrain: Terrain;
  readonly state: GameState;
  private aim: AimInfo;

  private readonly teamManager: TeamManager;
  private readonly horizontalPadding: number;
  private readonly defaultTeamOrder: readonly TeamId[] | undefined;
  private readonly random: () => number;
  private readonly now: () => number;

  projectiles: Projectile[] = [];
  particles: Particle[] = [];
  wind = 0;
  message: string | null = null;

  private turnLog: TurnLog;
  private pendingTurnResolution: TurnResolution | null = null;
  private turnIndex = 0;
  private projectileIds = new Map<Projectile, number>();
  private terminatedProjectiles = new Set<number>();
  private nextProjectileId = 1;
  private appliedRemoteTerrainOperationKeys = new Set<string>();
  private appliedRemoteWormHealthKeys = new Set<string>();
  private turnControllers = new Map<TeamId, TurnDriver>();
  private currentTurnDriver: TurnDriver | null = null;
  private currentTurnContext: TurnContext | null = null;
  private waitingForRemoteResolution = false;
  private currentTurnInitial = true;
  private uziBurst: UziBurst | null = null;
  private aiPreShotVisual: AiPreShotVisual | null = null;
  private grenadeSmokeCarry = new WeakMap<Projectile, number>();

  constructor(
    width: number,
    height: number,
    options?: {
      horizontalPadding?: number;
      teamOrder?: readonly TeamId[];
      random?: () => number;
      now?: () => number;
    }
  ) {
    this.width = width;
    this.height = height;
    this.horizontalPadding = Math.max(0, options?.horizontalPadding ?? 0);
    this.defaultTeamOrder = options?.teamOrder;
    this.random = options?.random ?? Math.random;
    this.now = options?.now ?? nowMs;

    this.turnLog = this.createEmptyTurnLog();

    this.terrain = new Terrain(width, height, {
      horizontalPadding: this.horizontalPadding,
      random: this.random,
    });
    this.terrain.generate();

    this.teamManager = new TeamManager(width, height, this.random);
    this.teamManager.initialize(
      this.terrain,
      this.defaultTeamOrder ? { teamOrder: this.defaultTeamOrder } : undefined
    );

    this.state = new GameState();
    this.aim = this.createDefaultAim();
    this.nextTurn(true);
  }

  getTurnIndex(): number {
    return this.turnIndex;
  }

  applyRemoteTurnEffects(effects: {
    turnIndex: number;
    actingTeamId: TeamId;
    terrainOperations: TerrainOperation[];
    wormHealth: WormHealthChange[];
  }) {
    if (effects.turnIndex !== this.turnIndex) return;
    if (effects.actingTeamId !== this.activeTeam.id) return;
    const source: GameEventSource = "remote-effects";

    for (const operation of effects.terrainOperations) {
      if (operation.type !== "carve-circle") continue;
      const key = this.terrainOperationKey(operation);
      if (this.appliedRemoteTerrainOperationKeys.has(key)) continue;
      this.appliedRemoteTerrainOperationKeys.add(key);
      this.terrain.carveCircle(operation.x, operation.y, operation.radius);
      this.dislodgeTombstonesFromCarve(operation.x, operation.y, operation.radius);
      gameEvents.emit("world.terrain.carved", {
        source,
        turnIndex: this.turnIndex,
        teamId: effects.actingTeamId,
        position: { x: operation.x, y: operation.y },
        radius: operation.radius,
        atMs: operation.atMs,
      });
    }

    for (const change of effects.wormHealth) {
      const key = this.wormHealthKey(change);
      if (this.appliedRemoteWormHealthKeys.has(key)) continue;
      this.appliedRemoteWormHealthKeys.add(key);
      const team = this.teams.find((t) => t.id === change.teamId);
      if (!team) continue;
      const worm = team.worms[change.wormIndex];
      if (!worm) continue;
      const beforeHealth = worm.health;
      const wasAlive = worm.alive;
      worm.health = change.after;
      worm.alive = change.alive;
      this.emitWormHealthEvents({
        source,
        turnIndex: this.turnIndex,
        teamId: change.teamId,
        wormIndex: change.wormIndex,
        position: { x: worm.x, y: worm.y },
        before: beforeHealth,
        after: worm.health,
        delta: worm.health - beforeHealth,
        cause: change.cause,
        atMs: change.atMs,
        wasAlive,
        alive: worm.alive,
      });
    }
  }

  hasPendingTurnResolution(): boolean {
    return this.pendingTurnResolution !== null;
  }

  setTurnControllers(controllers: Map<TeamId, TurnDriver>) {
    this.turnControllers = new Map(controllers);
    this.configureTurnDriver(this.currentTurnInitial);
  }

  updateActiveTurnDriver(
    dt: number,
    options: TurnDriverUpdateOptions
  ) {
    if (!this.currentTurnDriver || !this.currentTurnContext) return;
    this.currentTurnDriver.update(this.currentTurnContext, dt, options);
  }

  isLocalTurnActive() {
    return !this.waitingForRemoteResolution;
  }

  isWaitingForRemoteResolution() {
    return this.waitingForRemoteResolution;
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

  debugSelectWorm(teamId: TeamId, wormIndex: number) {
    const teamIndex = this.teamManager.teams.findIndex((team) => team.id === teamId);
    if (teamIndex < 0) return;
    this.teamManager.setCurrentTeamIndex(teamIndex);
    this.teamManager.setActiveWormIndex(wormIndex);
  }

  debugSetWeapon(weapon: WeaponType) {
    this.applyRemoteTurnCommand({
      type: "set-weapon",
      weapon,
      atMs: this.turnTimestampMs(),
    });
  }

  debugMove(move: -1 | 0 | 1, durationMs: number, jump = false) {
    const dtMs = Math.max(0, Math.round(durationMs));
    if (dtMs === 0 && move === 0 && !jump) return;
    this.applyRemoteTurnCommand({
      type: "move",
      move,
      jump,
      dtMs,
      atMs: this.turnTimestampMs(),
    });
  }

  debugShoot(angle: number, power: number) {
    this.clearAiPreShotVisual();
    const worm = this.activeWorm;
    const targetDistance = 100;
    const targetX = worm.x + Math.cos(angle) * targetDistance;
    const targetY = worm.y + Math.sin(angle) * targetDistance;
    this.applyRemoteTurnCommand({
      type: "fire-charged-weapon",
      weapon: this.state.weapon,
      power: clamp(power, 0, 1),
      aim: { angle, targetX, targetY },
      atMs: this.turnTimestampMs(),
      projectileIds: [],
    });
  }

  beginAiPreShotVisual(params: {
    weapon: WeaponType;
    targetAngle: number;
    power01: number;
    durationMs: number;
  }) {
    if (this.state.phase !== "aim") return;
    const now = this.now();
    const durationMs = Math.max(0, params.durationMs);
    const startAngle = this.aim.angle;
    const delta = this.normalizeAngleRad(params.targetAngle - startAngle);
    const direction = delta >= 0 ? 1 : -1;
    const overshootMagnitude = clamp(Math.abs(delta) * 0.3, 0.05, 0.18);
    this.aiPreShotVisual = {
      turnIndex: this.turnIndex,
      teamId: this.activeTeam.id,
      wormIndex: this.activeWormIndex,
      weapon: params.weapon,
      power01: clamp(params.power01, 0, 1),
      startMs: now,
      endMs: now + durationMs,
      startAngle,
      targetAngle: params.targetAngle,
      overshootAngle: params.targetAngle + direction * overshootMagnitude,
      undershootAngle: params.targetAngle - direction * overshootMagnitude * 0.55,
    };
  }

  clearAiPreShotVisual() {
    this.aiPreShotVisual = null;
  }

  nextTurn(initial = false) {
    const previousLog = this.turnLog;
    const previousTurnIndex = this.turnIndex;
    const completedAtMs = this.now();

    this.turnIndex = initial ? 0 : this.turnIndex + 1;
    this.wind = this.randomRange(-WORLD.windMax, WORLD.windMax);
    this.state.startTurn(this.now(), WeaponType.Bazooka);
    this.message = initial ? "Welcome! Eliminate the other team!" : null;
    this.uziBurst = null;

    if (initial) this.teamManager.resetActiveWormIndex();
    else this.teamManager.advanceToNextTeam();
    this.aim = this.createDefaultAim();
    this.clearAiPreShotVisual();

    const snapshot = this.toNetworkTurnSnapshot();

    if (!initial) {
      const resolution = this.buildTurnResolution(
        previousLog,
        snapshot,
        completedAtMs,
        previousTurnIndex
      );
      if (resolution) {
        this.pendingTurnResolution = resolution;
      }
    } else {
      this.pendingTurnResolution = null;
    }

    this.turnLog = this.createEmptyTurnLog();
    this.projectileIds.clear();
    this.terminatedProjectiles.clear();
    this.nextProjectileId = 1;
    this.appliedRemoteTerrainOperationKeys.clear();
    this.appliedRemoteWormHealthKeys.clear();
    this.beginTurnLog();
    this.configureTurnDriver(initial);
    this.emitTurnStarted({ initial, source: initial ? "system" : "local-sim" });
  }

  pauseFor(pausedMs: number) {
    if (pausedMs <= 0) return;
    this.state.pauseFor(pausedMs);
    if (this.turnLog.startedAtMs) {
      this.turnLog.startedAtMs += pausedMs;
    }
  }

  handleInput(
    input: Input,
    dt: number,
    camera: { offsetX: number; offsetY: number }
  ) {
    if (!this.isLocalTurnActive()) return;
    const timeLeftMs = this.state.timeLeftMs(this.now(), GAMEPLAY.turnTimeMs);
    if (timeLeftMs <= 0 && this.state.phase === "aim") {
      this.endAimPhaseWithoutShot();
      return;
    }

    const atMs = this.turnTimestampMs();

    if (input.pressed("Digit1")) this.recordWeaponChange(WeaponType.Bazooka, atMs);
    if (input.pressed("Digit2")) this.recordWeaponChange(WeaponType.HandGrenade, atMs);
    if (input.pressed("Digit3")) this.recordWeaponChange(WeaponType.Rifle, atMs);
    if (input.pressed("Digit4")) this.recordWeaponChange(WeaponType.Uzi, atMs);

    if (input.pressed("KeyR") && this.state.phase === "gameover") {
      this.restart();
      return;
    }

    if (this.state.phase === "aim") {
      const aim = this.computeAimFromInput(input, camera);
      this.recordAim(aim, atMs);

      let move = 0;
      if (input.isDown("ArrowLeft") || input.isDown("KeyA")) move -= 1;
      if (input.isDown("ArrowRight") || input.isDown("KeyD")) move += 1;
      const jump = input.pressed("Space");

      const movement = (Math.max(-1, Math.min(1, move)) || 0) as -1 | 0 | 1;
      this.recordMovement(movement, jump, dt, atMs);
      if (input.mouseJustPressed) this.recordStartCharge(atMs);
      if (this.state.charging && input.mouseJustReleased) {
        const power01 = this.state.getCharge01(this.state.turnStartMs + atMs);
        this.recordFireChargedWeapon(power01, aim, atMs);
      }
    }
  }

  applyRemoteTurnCommand(command: TurnCommand) {
    this.applyCommand(command);
    gameEvents.emit("turn.command.recorded", {
      source: "remote-sim",
      turnIndex: this.turnIndex,
      teamId: this.activeTeam.id,
      command: this.cloneTurnCommand(command),
    });
  }

  update(dt: number) {
    if (this.state.phase === "projectile") {
      this.updateUziBurst();
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
      const specUzi = {
        gravity: 0,
        explosionRadius: GAMEPLAY.uzi.explosionRadius,
        damage: 0,
        maxDistance: GAMEPLAY.uzi.maxDistance,
      };

      for (const projectile of this.projectiles) {
        if (projectile.type === WeaponType.HandGrenade)
          projectile.update(dt, this.terrain, specHG);
        else if (projectile.type === WeaponType.Bazooka)
          projectile.update(dt, this.terrain, specBaz);
        else if (projectile.type === WeaponType.Uzi)
          projectile.update(dt, this.terrain, specUzi);
        else projectile.update(dt, this.terrain, specRifle);

        if (projectile.type === WeaponType.HandGrenade && !projectile.exploded) {
          this.emitGrenadeFuseSmoke(projectile, dt);
        }

        if (
          (projectile.type === WeaponType.Rifle || projectile.type === WeaponType.Uzi) &&
          !projectile.exploded
        ) {
          for (const team of this.teams) {
            for (const worm of team.worms) {
              if (!worm.alive) continue;
              if (critterHitTestCircle(worm, projectile.x, projectile.y, projectile.r)) {
                if (this.isLocalTurnActive()) {
                  const wasAlive = worm.alive;
                  const beforeHealth = worm.health;
                  const dmg =
                    projectile.type === WeaponType.Rifle
                      ? GAMEPLAY.rifle.directDamage
                      : GAMEPLAY.uzi.directDamage;
                  worm.takeDamage(dmg);
                  this.recordWormHealthChange(
                    worm,
                    team,
                    beforeHealth,
                    wasAlive,
                    projectile.type
                  );
                  const d = distance(projectile.x, projectile.y, worm.x, worm.y);
                  const dirx = (worm.x - projectile.x) / (d || 1);
                  const diry = (worm.y - projectile.y) / (d || 1);
                  const impulse = projectile.type === WeaponType.Rifle ? 120 : 70;
                  worm.applyImpulse(dirx * impulse, diry * impulse);
                }
                projectile.explode(projectile.type === WeaponType.Rifle ? specRifle : specUzi, "worm");
                break;
              }
            }
            if (projectile.exploded) break;
          }
        }

        if (projectile.type === WeaponType.Bazooka && !projectile.exploded) {
          for (const team of this.teams) {
            for (const worm of team.worms) {
              if (!worm.alive) continue;
              if (critterHitTestCircle(worm, projectile.x, projectile.y, projectile.r)) {
                projectile.explode(specBaz, "worm");
                break;
              }
            }
            if (projectile.exploded) break;
          }
        }

        const projectileId = this.projectileIds.get(projectile);
        if (projectile.exploded && projectileId !== undefined) {
          this.recordProjectileExpiry(projectile, projectileId);
        }
      }

      this.projectiles = this.projectiles.filter((p) => !p.exploded);
      for (const [proj, id] of Array.from(this.projectileIds.entries())) {
        if (proj.exploded) {
          this.projectileIds.delete(proj);
          this.terminatedProjectiles.delete(id);
        }
      }

      if (this.projectiles.length === 0 && !this.uziBurst) {
        this.state.endProjectilePhase();
        if (this.isLocalTurnActive()) {
          setTimeout(() => {
            if (this.state.phase === "post" && this.isLocalTurnActive()) this.nextTurn();
          }, GAMEPLAY.postShotDelayMs);
        }
      }
    }

    for (const particle of this.particles) {
      particle.update(dt, this.terrain);
    }
    this.particles = this.particles.filter((p) => p.life > 0);

    for (const team of this.teams) {
      for (const worm of team.worms) {
        if (worm.alive && this.state.phase === "aim") continue;
        worm.update(dt, this.terrain, 0, false);
      }
    }

    if (this.isLocalTurnActive()) {
      this.teamManager.killWormsBelow(this.height - 8);
      this.checkVictory();
    }
  }

  getAimInfo(): AimInfo {
    return this.aim;
  }

  getRenderAimInfo(): AimInfo {
    const preview = this.resolveAiPreShotAim(this.now());
    if (!preview) return this.aim;
    const worm = this.activeWorm;
    worm.facing = preview.targetX < worm.x ? -1 : 1;
    return preview;
  }

  getUziBurstSnapshot(): UziBurstSnapshot | null {
    const burst = this.uziBurst;
    if (!burst) return null;
    return {
      origin: { ...burst.origin },
      facing: burst.facing,
      aimAngle: burst.aimAngle,
      seedBase: burst.seedBase,
      startAtMs: burst.startAtMs,
      nextShotIndex: burst.nextShotIndex,
      shotCount: burst.projectileIds.length,
    };
  }

  predictPath(): PredictedPoint[] {
    const preview = this.resolveAiPreShotPreview(this.now());
    if (
      preview &&
      (preview.visual.weapon === WeaponType.HandGrenade ||
        preview.visual.weapon === WeaponType.Bazooka)
    ) {
      return predictTrajectory({
        weapon: preview.visual.weapon,
        activeWorm: this.activeWorm,
        aim: preview.aim,
        power01: preview.visual.power01,
        wind: this.wind,
        terrain: this.terrain,
        width: this.width,
        height: this.height,
      });
    }

    if (!shouldPredictPath(this.state)) return [];
    const aim = this.aim;
    const power01 = this.state.getCharge01(this.state.turnStartMs + this.turnTimestampMs());
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

  private resolveAiPreShotPreview(now: number): { visual: AiPreShotVisual; aim: AimInfo } | null {
    const visual = this.getActiveAiPreShotVisual(now);
    if (!visual) return null;
    const durationMs = Math.max(1, visual.endMs - visual.startMs);
    const progress = clamp((now - visual.startMs) / durationMs, 0, 1);
    const overshootEnd = 0.4;
    const undershootEnd = 0.72;

    let angle = visual.targetAngle;
    if (progress <= overshootEnd) {
      angle = this.lerpAngle(
        visual.startAngle,
        visual.overshootAngle,
        progress / overshootEnd
      );
    } else if (progress <= undershootEnd) {
      angle = this.lerpAngle(
        visual.overshootAngle,
        visual.undershootAngle,
        (progress - overshootEnd) / (undershootEnd - overshootEnd)
      );
    } else {
      angle = this.lerpAngle(
        visual.undershootAngle,
        visual.targetAngle,
        (progress - undershootEnd) / (1 - undershootEnd)
      );
    }

    const worm = this.activeWorm;
    const targetDistance = 120;
    return {
      visual,
      aim: {
        angle,
        targetX: worm.x + Math.cos(angle) * targetDistance,
        targetY: worm.y + Math.sin(angle) * targetDistance,
      },
    };
  }

  private resolveAiPreShotAim(now: number): AimInfo | null {
    return this.resolveAiPreShotPreview(now)?.aim ?? null;
  }

  private getActiveAiPreShotVisual(now: number): AiPreShotVisual | null {
    const visual = this.aiPreShotVisual;
    if (!visual) return null;
    if (
      this.state.phase !== "aim" ||
      visual.turnIndex !== this.turnIndex ||
      visual.teamId !== this.activeTeam.id ||
      visual.wormIndex !== this.activeWormIndex
    ) {
      this.aiPreShotVisual = null;
      return null;
    }
    if (now > visual.endMs + 2000) {
      this.aiPreShotVisual = null;
      return null;
    }
    return visual;
  }

  private normalizeAngleRad(angle: number): number {
    let normalized = (angle + Math.PI) % (Math.PI * 2);
    if (normalized < 0) normalized += Math.PI * 2;
    return normalized - Math.PI;
  }

  private lerpAngle(from: number, to: number, t: number): number {
    return from + this.normalizeAngleRad(to - from) * clamp(t, 0, 1);
  }

  getTeamHealth(id: TeamId) {
    return this.teamManager.getTeamHealth(id);
  }

  restart(options?: { startingTeamIndex?: number; teamOrder?: readonly TeamId[] }) {
    this.terrain.generate();
    const teamOrder = options?.teamOrder ?? this.defaultTeamOrder;
    this.teamManager.initialize(
      this.terrain,
      teamOrder ? { teamOrder } : undefined
    );
    this.projectiles = [];
    this.particles = [];
    this.uziBurst = null;
    if (options?.startingTeamIndex !== undefined) {
      this.teamManager.setCurrentTeamIndex(options.startingTeamIndex);
    } else {
      this.teamManager.setCurrentTeamIndex(this.random() < 0.5 ? 0 : 1);
    }
    this.pendingTurnResolution = null;
    this.projectileIds.clear();
    this.terminatedProjectiles.clear();
    this.nextProjectileId = 1;
    this.clearAiPreShotVisual();
    this.nextTurn(true);
    gameEvents.emit("match.restarted", { source: "system" });
  }

  toSnapshot(): GameSnapshot {
    return {
      width: this.width,
      height: this.height,
      turnIndex: this.turnIndex,
      wind: this.wind,
      message: this.message,
      terrain: {
        width: this.terrain.width,
        height: this.terrain.height,
        horizontalPadding: this.horizontalPadding,
        tileIndex: this.terrain.tileIndex,
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

  toNetworkTurnSnapshot(): NetworkTurnSnapshot {
    return {
      turnIndex: this.turnIndex,
      wind: this.wind,
      message: this.message,
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

  toMatchInitSnapshot(): MatchInitSnapshot {
    return {
      width: this.width,
      height: this.height,
      turnIndex: this.turnIndex,
      wind: this.wind,
      message: this.message,
      terrain: {
        width: this.terrain.width,
        height: this.terrain.height,
        horizontalPadding: this.horizontalPadding,
        tileIndex: this.terrain.tileIndex,
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

    this.turnIndex = snapshot.turnIndex;
    this.wind = snapshot.wind;
    this.message = snapshot.message;

    if (
      snapshot.terrain.width !== this.terrain.width ||
      snapshot.terrain.height !== this.terrain.height
    ) {
      throw new Error("Snapshot terrain dimensions do not match");
    }

    const tileIndex = Number.isFinite(snapshot.terrain.tileIndex)
      ? snapshot.terrain.tileIndex
      : 0;
    this.terrain.setTileIndex(tileIndex);
    this.terrain.solid = new Uint8Array(snapshot.terrain.solid);
    this.terrain.heightMap = [...snapshot.terrain.heightMap];
    this.terrain.syncHeightMapFromSolid();
    this.terrain.repaint();

    this.teamManager.teams = this.restoreTeams(snapshot.teams);
    this.applySnapshotState(snapshot.state, snapshot.activeTeamIndex, snapshot.activeWormIndex);

    this.projectiles = [];
    this.particles = [];
    this.aim = this.createDefaultAim();
    this.uziBurst = null;
    this.clearAiPreShotVisual();
  }

  loadMatchInitSnapshot(snapshot: MatchInitSnapshot) {
    if (snapshot.width !== this.width || snapshot.height !== this.height) {
      throw new Error("Snapshot dimensions do not match session dimensions");
    }

    this.turnIndex = snapshot.turnIndex;
    this.wind = snapshot.wind;
    this.message = snapshot.message;

    if (
      snapshot.terrain.width !== this.terrain.width ||
      snapshot.terrain.height !== this.terrain.height
    ) {
      throw new Error("Snapshot terrain dimensions do not match");
    }

    const expectedTotalWidth =
      snapshot.terrain.width + snapshot.terrain.horizontalPadding * 2;
    if (snapshot.terrain.heightMap.length !== expectedTotalWidth) {
      throw new Error("Snapshot terrain height map size mismatch");
    }

    this.terrain.setTileIndex(snapshot.terrain.tileIndex);
    this.terrain.applyHeightMap(snapshot.terrain.heightMap);

    this.teamManager.teams = this.restoreTeams(snapshot.teams);
    this.applySnapshotState(snapshot.state, snapshot.activeTeamIndex, snapshot.activeWormIndex);

    this.projectiles = [];
    this.particles = [];
    this.aim = this.createDefaultAim();
    this.uziBurst = null;
    this.clearAiPreShotVisual();
  }

  loadNetworkTurnSnapshot(snapshot: NetworkTurnSnapshot) {
    this.turnIndex = snapshot.turnIndex;
    this.wind = snapshot.wind;
    this.message = snapshot.message;
    this.teamManager.teams = this.restoreTeams(snapshot.teams);
    this.applySnapshotState(snapshot.state, snapshot.activeTeamIndex, snapshot.activeWormIndex);
    this.projectiles = [];
    this.particles = [];
    this.aim = this.createDefaultAim();
    this.uziBurst = null;
    this.clearAiPreShotVisual();
  }

  private restoreTeams(teams: TeamSnapshot[]): Team[] {
    return teams.map((teamData) => {
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
  }

  private applySnapshotState(
    state: GameStateSnapshot,
    activeTeamIndex: number,
    activeWormIndex: number
  ) {
    this.teamManager.setCurrentTeamIndex(activeTeamIndex);
    this.teamManager.setActiveWormIndex(activeWormIndex);
    this.state.phase = state.phase;
    this.state.weapon = state.weapon;
    this.state.turnStartMs = state.turnStartMs;
    this.state.charging = state.charging;
    this.state.chargeStartMs = state.chargeStartMs;
  }

  finalizeTurn(): TurnResolution {
    if (!this.pendingTurnResolution) {
      throw new Error("No completed turn resolution is available");
    }
    const resolution = this.pendingTurnResolution;
    this.pendingTurnResolution = null;
    if (this.currentTurnDriver && this.currentTurnContext) {
      this.currentTurnDriver.endTurn?.(this.currentTurnContext, resolution);
    }
    return resolution;
  }

  consumeTurnResolution(): TurnResolution | null {
    if (!this.pendingTurnResolution) return null;
    return this.finalizeTurn();
  }

  applyTurnResolution(resolution: TurnResolution, options?: { localizeTime?: boolean }) {
    if (resolution.turnIndex !== this.turnIndex) {
      throw new Error("Incoming resolution turn index mismatch");
    }
    if (resolution.actingTeamId !== this.activeTeam.id) {
      throw new Error("Incoming resolution does not match active team");
    }
    if (resolution.actingTeamIndex !== this.teamManager.activeTeamIndex) {
      throw new Error("Incoming resolution team index mismatch");
    }
    if (resolution.actingWormIndex !== this.teamManager.activeWormIndex) {
      throw new Error("Incoming resolution worm index mismatch");
    }
    if (resolution.windAtStart !== this.wind) {
      throw new Error("Incoming resolution wind baseline mismatch");
    }
    const expectedNextTurnIndex = resolution.turnIndex + 1;
    if (
      resolution.result.turnIndex !== expectedNextTurnIndex &&
      !(resolution.result.turnIndex === resolution.turnIndex && resolution.result.state.phase === "gameover")
    ) {
      throw new Error("Incoming resolution snapshot turn index mismatch");
    }

    const phaseBefore = this.state.phase;
    const startedNewTurn =
      resolution.result.turnIndex === resolution.turnIndex + 1 &&
      resolution.result.state.phase === "aim";
    const previousDriver = this.currentTurnDriver;
    const previousContext = this.currentTurnContext;

    if (this.appliedRemoteWormHealthKeys.size === 0) {
      for (const change of resolution.wormHealth) {
        const team = this.teams.find((t) => t.id === change.teamId);
        if (!team) {
          throw new Error(`Unknown team referenced in resolution: ${change.teamId}`);
        }
        const worm = team.worms[change.wormIndex];
        if (!worm) {
          throw new Error("Unknown worm index referenced in resolution");
        }
        if (worm.health !== change.before) {
          throw new Error("Worm health mismatch before applying resolution change");
        }
        if (worm.alive !== change.wasAlive) {
          throw new Error("Worm alive state mismatch before applying resolution change");
        }
        if (Math.abs(change.before + change.delta - change.after) > 1e-3) {
          throw new Error("Worm health delta mismatch in resolution change");
        }
      }
    }

    const knownTeamIds = new Set(this.teams.map((t) => t.id));

    const worldLeft = this.terrain.worldLeft;
    const worldRight = this.terrain.worldRight;
    const minY = -this.height;
    const maxY = this.height * 2;

    for (const teamSnapshot of resolution.result.teams) {
      if (!knownTeamIds.has(teamSnapshot.id)) {
        throw new Error(`Unknown team found in resolution snapshot: ${teamSnapshot.id}`);
      }
      for (const worm of teamSnapshot.worms) {
        if (!Number.isFinite(worm.x) || !Number.isFinite(worm.y)) {
          throw new Error("Non-finite worm coordinates in resolution snapshot");
        }
        if (worm.x < worldLeft || worm.x > worldRight) {
          throw new Error("Worm position exceeds horizontal world bounds");
        }
        if (worm.y < minY || worm.y > maxY) {
          throw new Error("Worm position exceeds vertical world bounds");
        }
      }
    }

    const maxRadius = Math.max(this.width, this.height);
    for (const operation of resolution.terrainOperations) {
      if (operation.type !== "carve-circle") {
        throw new Error("Unknown terrain operation in resolution");
      }
      if (!Number.isFinite(operation.x) || !Number.isFinite(operation.y)) {
        throw new Error("Non-finite terrain operation coordinates");
      }
      if (!Number.isFinite(operation.radius)) {
        throw new Error("Non-finite terrain operation radius");
      }
      if (operation.radius < 0 || operation.radius > maxRadius) {
        throw new Error("Terrain operation radius out of range");
      }
      if (operation.x < worldLeft || operation.x > worldRight) {
        throw new Error("Terrain operation outside horizontal map limits");
      }
      if (operation.y < minY || operation.y > maxY) {
        throw new Error("Terrain operation outside vertical map limits");
      }
    }

    for (const operation of resolution.terrainOperations) {
      if (operation.type !== "carve-circle") continue;
      const key = this.terrainOperationKey(operation);
      if (this.appliedRemoteTerrainOperationKeys.has(key)) continue;
      this.appliedRemoteTerrainOperationKeys.add(key);
      this.terrain.carveCircle(operation.x, operation.y, operation.radius);
      gameEvents.emit("world.terrain.carved", {
        source: "remote-resolution",
        turnIndex: this.turnIndex,
        teamId: resolution.actingTeamId,
        position: { x: operation.x, y: operation.y },
        radius: operation.radius,
        atMs: operation.atMs,
      });
    }

    const healthEventsToEmit: WormHealthChange[] = [];
    for (const change of resolution.wormHealth) {
      const key = this.wormHealthKey(change);
      if (!this.appliedRemoteWormHealthKeys.has(key)) {
        healthEventsToEmit.push(change);
      }
      this.appliedRemoteWormHealthKeys.add(key);
    }

    this.loadNetworkTurnSnapshot(resolution.result);
    if (options?.localizeTime && this.state.phase === "aim") {
      const localStart = this.now();
      this.state.turnStartMs = localStart;
      if (this.state.charging) {
        this.state.chargeStartMs = localStart;
      }
    }

    for (const change of healthEventsToEmit) {
      const team = this.teams.find((t) => t.id === change.teamId);
      if (!team) continue;
      const worm = team.worms[change.wormIndex];
      if (!worm) continue;
      this.emitWormHealthEvents({
        source: "remote-resolution",
        turnIndex: resolution.turnIndex,
        teamId: change.teamId,
        wormIndex: change.wormIndex,
        position: { x: worm.x, y: worm.y },
        before: change.before,
        after: change.after,
        delta: change.delta,
        cause: change.cause,
        atMs: change.atMs,
        wasAlive: change.wasAlive,
        alive: change.alive,
      });
    }

    if (phaseBefore !== "gameover" && this.state.phase === "gameover") {
      const winner = this.message?.startsWith("Red wins!")
        ? ("Red" as const)
        : this.message?.startsWith("Blue wins!")
          ? ("Blue" as const)
          : ("Nobody" as const);
      gameEvents.emit("match.gameover", {
        source: "remote-resolution",
        winner,
        turnIndex: resolution.result.turnIndex,
      });
    }

    this.turnLog = this.createEmptyTurnLog();
    this.projectileIds.clear();
    this.terminatedProjectiles.clear();
    this.nextProjectileId = 1;
    this.appliedRemoteTerrainOperationKeys.clear();
    this.appliedRemoteWormHealthKeys.clear();
    this.beginTurnLog();
    this.pendingTurnResolution = null;
    this.waitingForRemoteResolution = false;
    if (previousDriver?.endTurn && previousContext) {
      previousDriver.endTurn(previousContext, resolution);
    }
    this.configureTurnDriver(false);
    if (startedNewTurn) {
      this.emitTurnStarted({ initial: false, source: "remote-resolution" });
    }
  }

  private createEmptyTurnLog(): TurnLog {
    return {
      startedAtMs: 0,
      turnIndex: 0,
      actingTeamId: null,
      actingTeamIndex: null,
      actingWormIndex: null,
      windAtStart: null,
      commands: [],
      projectileEvents: [],
      terrainOperations: [],
      wormHealth: [],
    };
  }

  private beginTurnLog() {
    this.turnLog.startedAtMs = this.state.turnStartMs;
    this.turnLog.turnIndex = this.turnIndex;
    this.turnLog.actingTeamId = this.activeTeam.id;
    this.turnLog.actingTeamIndex = this.teamManager.activeTeamIndex;
    this.turnLog.actingWormIndex = this.teamManager.activeWormIndex;
    this.turnLog.windAtStart = this.wind;
  }

  private configureTurnDriver(initial: boolean) {
    this.currentTurnInitial = initial;
    this.currentTurnContext = {
      session: this,
      team: this.activeTeam,
      teamIndex: this.teamManager.activeTeamIndex,
      initial,
    };
    const driver = this.turnControllers.get(this.activeTeam.id) ?? null;
    this.currentTurnDriver = driver;
    if (!driver) {
      this.waitingForRemoteResolution = false;
      return;
    }
    driver.beginTurn(this.currentTurnContext);
    this.waitingForRemoteResolution = driver.type === "remote";
  }

  private recordWeaponChange(weapon: WeaponType, atMs: number) {
    if (this.state.weapon === weapon) return;
    this.recordCommand({ type: "set-weapon", weapon, atMs });
  }

  private recordAim(aim: AimInfo, atMs: number) {
    if (this.sameAim(this.aim, aim)) return;
    this.recordCommand({ type: "aim", aim, atMs });
  }

  private recordMovement(move: -1 | 0 | 1, jump: boolean, dt: number, atMs: number) {
    const dtMs = Math.max(0, Math.round(dt * 1000));
    if (dtMs === 0 && move === 0 && !jump) return;
    this.recordCommand({ type: "move", move, jump, dtMs, atMs });
  }

  private applyActiveWormMovement(params: {
    move: -1 | 0 | 1;
    jump: boolean;
    dtMs: number;
  }) {
    const maxStepMs = 8;
    let remainingMs = Math.max(0, Math.floor(params.dtMs));
    let first = true;
    while (remainingMs > 0) {
      const stepMs = Math.min(maxStepMs, remainingMs);
      this.activeWorm.update(stepMs / 1000, this.terrain, params.move, params.jump && first);
      remainingMs -= stepMs;
      first = false;
    }
  }

  private recordStartCharge(atMs: number) {
    if (this.state.charging || this.state.phase !== "aim") return;
    this.recordCommand({ type: "start-charge", atMs });
  }

  private recordFireChargedWeapon(power: number, aim: AimInfo, atMs: number) {
    if (!this.state.charging || this.state.phase !== "aim") return;
    const power01 = clamp(power, 0, 1);
    this.recordCommand({
      type: "fire-charged-weapon",
      weapon: this.state.weapon,
      power: power01,
      aim,
      atMs,
      projectileIds: [],
    });
  }

  cancelChargeCommand() {
    if (!this.isLocalTurnActive()) return;
    if (!this.state.charging) return;
    this.recordCommand({ type: "cancel-charge", atMs: this.turnTimestampMs() });
  }

  private recordCommand(command: TurnCommand) {
    const finalized = this.applyCommand(command);
    if (!finalized) return;
    this.turnLog.commands.push(finalized);
    gameEvents.emit("turn.command.recorded", {
      source: "local-sim",
      turnIndex: this.turnIndex,
      teamId: this.activeTeam.id,
      command: this.cloneTurnCommand(finalized),
    });
  }

  private cloneTurnCommand(command: TurnCommand): TurnCommand {
    if (command.type === "fire-charged-weapon") {
      return {
        ...command,
        aim: { ...command.aim },
        projectileIds: [...command.projectileIds],
      };
    }
    if (command.type === "aim") {
      return {
        ...command,
        aim: { ...command.aim },
      };
    }
    return { ...command };
  }

  private applyCommand(command: TurnCommand): TurnCommand | null {
    switch (command.type) {
      case "set-weapon": {
        this.state.setWeapon(command.weapon);
        return command;
      }
      case "aim": {
        this.aim = command.aim;
        const worm = this.activeWorm;
        worm.facing = command.aim.targetX < worm.x ? -1 : 1;
        return command;
      }
      case "move": {
        if (this.state.phase !== "aim") return null;
        this.applyActiveWormMovement({
          move: command.move,
          jump: command.jump,
          dtMs: command.dtMs,
        });
        return command;
      }
      case "start-charge": {
        if (this.state.phase !== "aim") return null;
        this.state.beginCharge(this.state.turnStartMs + command.atMs);
        return command;
      }
      case "cancel-charge": {
        if (!this.state.charging) return null;
        this.state.cancelCharge();
        return command;
      }
      case "fire-charged-weapon": {
        return this.applyFireCommand(command);
      }
      default:
        return null;
    }
  }

  private applyFireCommand(
    command: Extract<TurnCommand, { type: "fire-charged-weapon" }>
  ): TurnCommand | null {
    if (this.state.phase !== "aim") return null;
    this.clearAiPreShotVisual();
    this.state.setWeapon(command.weapon);
    this.aim = command.aim;
    const worm = this.activeWorm;
    worm.facing = command.aim.targetX < worm.x ? -1 : 1;
    const finalized = this.fireChargedWeapon(
      command.power,
      command.aim,
      command.atMs,
      command.weapon,
      command.projectileIds
    );
    this.state.cancelCharge();
    this.endAimPhaseAfterShot();
    return finalized;
  }

  private turnTimestampMs(): number {
    if (!this.turnLog.startedAtMs) return 0;
    return Math.max(0, this.now() - this.turnLog.startedAtMs);
  }

  private createDefaultAim(): AimInfo {
    const worm = this.activeWorm;
    const dir = worm.facing >= 0 ? 1 : -1;
    const targetX = worm.x + dir * 40;
    const targetY = worm.y;
    return {
      targetX,
      targetY,
      angle: computeAimAngleFromTarget({ weapon: this.state.weapon, worm, targetX, targetY }),
    };
  }

  private computeAimFromInput(
    input: Input,
    camera: { offsetX: number; offsetY: number }
  ): AimInfo {
    return computeAimInfo({
      input,
      state: this.state,
      activeWorm: this.activeWorm,
      cameraOffsetX: camera.offsetX,
      cameraOffsetY: camera.offsetY,
    });
  }

  private sameAim(a: AimInfo, b: AimInfo) {
    const angleEps = 1e-3;
    const posEps = 0.25;
    return (
      Math.abs(a.angle - b.angle) < angleEps &&
      Math.abs(a.targetX - b.targetX) < posEps &&
      Math.abs(a.targetY - b.targetY) < posEps
    );
  }

  private allocateProjectileId(projectile: Projectile): number {
    const id = this.nextProjectileId++;
    this.projectileIds.set(projectile, id);
    return id;
  }

  private wrapProjectileExplosion(projectile: Projectile, id: number) {
    const originalHandler = projectile.explosionHandler;
    projectile.explosionHandler = (x, y, radius, damage, cause, impact) => {
      this.turnLog.projectileEvents.push({
        type: "projectile-exploded",
        id,
        weapon: projectile.type,
        position: { x, y },
        radius,
        damage,
        cause,
        impact,
        atMs: this.turnTimestampMs(),
      });
      gameEvents.emit("combat.projectile.exploded", {
        source: this.isLocalTurnActive() ? "local-sim" : "remote-sim",
        turnIndex: this.turnIndex,
        teamId: this.activeTeam.id,
        projectileId: id,
        weapon: projectile.type,
        position: { x, y },
        radius,
        damage,
        cause,
        impact,
        atMs: this.turnTimestampMs(),
      });
      this.terminatedProjectiles.add(id);
      originalHandler(x, y, radius, damage, cause, impact);
    };
  }

  private recordProjectileExpiry(projectile: Projectile, id: number) {
    if (this.terminatedProjectiles.has(id)) return;
    this.turnLog.projectileEvents.push({
      type: "projectile-expired",
      id,
      weapon: projectile.type,
      position: { x: projectile.x, y: projectile.y },
      reason: this.detectProjectileExpiryReason(projectile),
      atMs: this.turnTimestampMs(),
    });
    gameEvents.emit("combat.projectile.expired", {
      source: this.isLocalTurnActive() ? "local-sim" : "remote-sim",
      turnIndex: this.turnIndex,
      teamId: this.activeTeam.id,
      projectileId: id,
      weapon: projectile.type,
      position: { x: projectile.x, y: projectile.y },
      reason: this.detectProjectileExpiryReason(projectile),
      atMs: this.turnTimestampMs(),
    });
    this.terminatedProjectiles.add(id);
  }

  private detectProjectileExpiryReason(projectile: Projectile): "lifetime" | "out-of-bounds" {
    if (
      projectile.type === WeaponType.Rifle &&
      GAMEPLAY.rifle.maxLifetime &&
      projectile.age >= GAMEPLAY.rifle.maxLifetime - 1e-3
    ) {
      return "lifetime";
    }
    if (
      projectile.type === WeaponType.Uzi &&
      projectile.distanceTraveled >= GAMEPLAY.uzi.maxDistance - 1e-3
    ) {
      return "lifetime";
    }
    return "out-of-bounds";
  }

  private recordTerrainCarve(x: number, y: number, radius: number) {
    const operation: TerrainOperation = {
      type: "carve-circle",
      x,
      y,
      radius,
      atMs: this.turnTimestampMs(),
    };
    this.turnLog.terrainOperations.push(operation);
    gameEvents.emit("turn.effects.emitted", {
      source: "local-sim",
      turnIndex: this.turnIndex,
      actingTeamId: this.activeTeam.id,
      terrainOperations: [{ ...operation }],
      wormHealth: [],
    });
    gameEvents.emit("world.terrain.carved", {
      source: "local-sim",
      turnIndex: this.turnIndex,
      teamId: this.activeTeam.id,
      position: { x, y },
      radius,
      atMs: operation.atMs,
    });
  }

  private dislodgeTombstonesFromCarve(x: number, y: number, radius: number) {
    const pad = 10;
    const maxDistance = radius + WORLD.wormRadius + pad;
    for (const team of this.teams) {
      for (const worm of team.worms) {
        if (worm.alive) continue;
        const dx = worm.x - x;
        const dy = worm.y - y;
        const d = Math.hypot(dx, dy);
        if (d > maxDistance) continue;
        worm.onGround = false;
        if (worm.vy === 0) worm.vy = 30;
      }
    }
  }

  private recordWormHealthChange(
    worm: Worm,
    team: Team,
    beforeHealth: number,
    wasAlive: boolean,
    cause: WeaponType
  ) {
    if (beforeHealth === worm.health && wasAlive === worm.alive) return;
    const wormIndex = team.worms.indexOf(worm);
    if (wormIndex === -1) return;
    const change: WormHealthChange = {
      teamId: team.id,
      wormIndex,
      before: beforeHealth,
      after: worm.health,
      delta: worm.health - beforeHealth,
      cause,
      atMs: this.turnTimestampMs(),
      wasAlive,
      alive: worm.alive,
    };
    this.turnLog.wormHealth.push(change);
    gameEvents.emit("turn.effects.emitted", {
      source: "local-sim",
      turnIndex: this.turnIndex,
      actingTeamId: this.activeTeam.id,
      terrainOperations: [],
      wormHealth: [{ ...change }],
    });
    this.emitWormHealthEvents({
      source: "local-sim",
      turnIndex: this.turnIndex,
      teamId: change.teamId,
      wormIndex: change.wormIndex,
      position: { x: worm.x, y: worm.y },
      before: change.before,
      after: change.after,
      delta: change.delta,
      cause: change.cause,
      atMs: change.atMs,
      wasAlive: change.wasAlive,
      alive: change.alive,
    });
  }

  private terrainOperationKey(operation: TerrainOperation): string {
    if (operation.type !== "carve-circle") return "unknown";
    return `carve-circle|${operation.atMs}|${operation.x.toFixed(3)}|${operation.y.toFixed(
      3
    )}|${operation.radius.toFixed(3)}`;
  }

  private wormHealthKey(change: WormHealthChange): string {
    return `${change.teamId}|${change.wormIndex}|${change.atMs}|${change.after.toFixed(
      3
    )}|${change.alive ? 1 : 0}`;
  }

  private buildTurnResolution(
    log: TurnLog,
    snapshot: NetworkTurnSnapshot,
    completedAtMs: number,
    previousTurnIndex: number
  ): TurnResolution | null {
    if (
      !log.actingTeamId ||
      log.actingTeamIndex === null ||
      log.actingWormIndex === null ||
      log.startedAtMs === 0
    )
      return null;

    const terrainOperations = log.terrainOperations.map((operation) => ({
      ...operation,
    }));

    const wormHealth = log.wormHealth.map((change) => ({
      ...change,
    }));

    return {
      turnIndex: previousTurnIndex,
      actingTeamId: log.actingTeamId,
      actingTeamIndex: log.actingTeamIndex!,
      actingWormIndex: log.actingWormIndex,
      windAtStart: log.windAtStart ?? 0,
      windAfter: snapshot.wind,
      startedAtMs: log.startedAtMs,
      completedAtMs,
      commandCount: log.commands.length,
      projectileEventCount: log.projectileEvents.length,
      terrainOperations,
      wormHealth,
      result: snapshot,
    };
  }

  private randomRange(min: number, max: number) {
    return this.random() * (max - min) + min;
  }

  private reserveProjectileIds(desiredCount: number, forcedProjectileIds: number[]): number[] {
    const ids: number[] = [];
    const forced = forcedProjectileIds.length > 0 ? forcedProjectileIds.slice(0, desiredCount) : [];
    let maxForced = 0;
    for (const id of forced) {
      ids.push(id);
      if (id > maxForced) maxForced = id;
    }
    if (maxForced > 0) {
      this.nextProjectileId = Math.max(this.nextProjectileId, maxForced + 1);
    }
    while (ids.length < desiredCount) {
      ids.push(this.nextProjectileId++);
    }
    return ids;
  }

  private uziBloomOffsetRad(seedBase: number, shotIndex: number): number {
    const shotCount = Math.max(1, GAMEPLAY.uzi.burstCount - 1);
    const t = shotIndex / shotCount;
    const ramp = Math.pow(t, GAMEPLAY.uzi.bloom.exponent);
    const sigma =
      GAMEPLAY.uzi.bloom.startSigmaRad +
      (GAMEPLAY.uzi.bloom.endSigmaRad - GAMEPLAY.uzi.bloom.startSigmaRad) * ramp;

    const u1 = this.uziHash01(seedBase + shotIndex * 101.3);
    const u2 = this.uziHash01(seedBase + shotIndex * 191.7);
    const clampedU1 = Math.max(1e-6, Math.min(1 - 1e-6, u1));
    const r = Math.sqrt(-2 * Math.log(clampedU1));
    const theta = 2 * Math.PI * u2;
    return Math.cos(theta) * r * sigma;
  }

  private uziHash01(v: number): number {
    const x = Math.sin(v) * 10000;
    return x - Math.floor(x);
  }

  private updateUziBurst() {
    const burst = this.uziBurst;
    if (!burst) return;
    const intervalMs = 1000 / GAMEPLAY.uzi.shotsPerSecond;
    const currentAtMs = this.turnTimestampMs();

    while (burst.nextShotIndex < burst.projectileIds.length) {
      const shotAtMs = burst.startAtMs + burst.nextShotIndex * intervalMs;
      if (currentAtMs + 1e-3 < shotAtMs) break;
      this.spawnUziProjectile({
        burst,
        shotIndex: burst.nextShotIndex,
        projectileId: burst.projectileIds[burst.nextShotIndex]!,
        atMs: shotAtMs,
      });
      burst.nextShotIndex += 1;
    }

    if (burst.nextShotIndex >= burst.projectileIds.length) {
      this.uziBurst = null;
    }
  }

  private spawnUziProjectile(config: {
    burst: UziBurst;
    shotIndex: number;
    projectileId: number;
    atMs: number;
  }) {
    const angle = config.burst.aimAngle + this.uziBloomOffsetRad(config.burst.seedBase, config.shotIndex);
    const muzzle = computeWeaponRig({
      center: { x: config.burst.origin.x, y: config.burst.origin.y },
      weapon: WeaponType.Uzi,
      aimAngle: angle,
      facing: config.burst.facing,
    }).muzzle;
    const sx = muzzle.x;
    const sy = muzzle.y;
    const vx = Math.cos(angle) * GAMEPLAY.uzi.speed;
    const vy = Math.sin(angle) * GAMEPLAY.uzi.speed;

    const projectile = new Projectile(
      sx,
      sy,
      vx,
      vy,
      GAMEPLAY.uzi.projectileRadius,
      WeaponType.Uzi,
      0,
      (x, y, r, dmg, cause, _impact) => this.onExplosion(x, y, r, dmg, cause)
    );
    this.projectiles.push(projectile);

    const id = config.projectileId;
    this.projectileIds.set(projectile, id);
    this.wrapProjectileExplosion(projectile, id);

    const spawnEvent: Extract<TurnEvent, { type: "projectile-spawned" }> = {
      type: "projectile-spawned",
      id,
      weapon: projectile.type,
      position: { x: projectile.x, y: projectile.y },
      velocity: { x: projectile.vx, y: projectile.vy },
      wind: projectile.wind,
      atMs: config.atMs,
    };
    this.turnLog.projectileEvents.push(spawnEvent);

    const source: GameEventSource = this.isLocalTurnActive() ? "local-sim" : "remote-sim";
    const wormIndex = this.teamManager.activeWormIndex;
    gameEvents.emit("combat.projectile.spawned", {
      source,
      turnIndex: this.turnIndex,
      teamId: this.activeTeam.id,
      wormIndex,
      projectileId: spawnEvent.id,
      weapon: spawnEvent.weapon,
      position: { ...spawnEvent.position },
      velocity: { ...spawnEvent.velocity },
      wind: spawnEvent.wind,
      atMs: spawnEvent.atMs,
    });
  }

  private fireChargedWeapon(
    power01: number,
    aim: AimInfo,
    atMs: number,
    weapon: WeaponType,
    forcedProjectileIds: number[]
  ): Extract<TurnCommand, { type: "fire-charged-weapon" }> {
    if (weapon === WeaponType.Uzi) {
      const projectileIds = this.reserveProjectileIds(GAMEPLAY.uzi.burstCount, forcedProjectileIds);
      const currentAtMs = this.turnTimestampMs();
      const startAtMs = Math.max(atMs, currentAtMs);
      const seedBase = this.turnIndex * 100_000 + Math.round(atMs);
      const facing = (this.activeWorm.facing < 0 ? -1 : 1) as -1 | 1;
      this.uziBurst = {
        origin: { x: this.activeWorm.x, y: this.activeWorm.y },
        facing,
        aimAngle: aim.angle,
        seedBase,
        startAtMs,
        nextShotIndex: 0,
        projectileIds,
      };

      const command = {
        type: "fire-charged-weapon",
        weapon,
        power: power01,
        aim: { angle: aim.angle, targetX: aim.targetX, targetY: aim.targetY },
        atMs,
        projectileIds,
      } as const;

      const source: GameEventSource = this.isLocalTurnActive() ? "local-sim" : "remote-sim";
      const wormIndex = this.teamManager.activeWormIndex;
      gameEvents.emit("combat.shot.fired", {
        source,
        turnIndex: this.turnIndex,
        teamId: this.activeTeam.id,
        wormIndex,
        weapon,
        power01,
        aim: { angle: aim.angle, targetX: aim.targetX, targetY: aim.targetY },
        wormPosition: { x: this.activeWorm.x, y: this.activeWorm.y },
        wind: this.wind,
        atMs,
        projectiles: [],
      });

      this.updateUziBurst();
      return command;
    }

    const beforeCount = this.projectiles.length;
    fireWeapon({
      weapon,
      activeWorm: this.activeWorm,
      aim,
      power01,
      wind: this.wind,
      projectiles: this.projectiles,
      onExplosion: (x, y, r, dmg, cause) => this.onExplosion(x, y, r, dmg, cause),
    });

    const newProjectiles = this.projectiles.slice(beforeCount);
    const projectileIds: number[] = [];
    const spawnEvents: Array<Extract<TurnEvent, { type: "projectile-spawned" }>> = [];
    const forcedIds = forcedProjectileIds.length > 0 ? [...forcedProjectileIds] : null;
    for (const projectile of newProjectiles) {
      const forcedId = forcedIds?.shift();
      const id = forcedId ?? this.allocateProjectileId(projectile);
      if (forcedId !== undefined) {
        this.projectileIds.set(projectile, id);
        this.nextProjectileId = Math.max(this.nextProjectileId, id + 1);
      }
      projectileIds.push(id);
      this.wrapProjectileExplosion(projectile, id);
      spawnEvents.push({
        type: "projectile-spawned",
        id,
        weapon: projectile.type,
        position: { x: projectile.x, y: projectile.y },
        velocity: { x: projectile.vx, y: projectile.vy },
        wind: projectile.wind,
        atMs,
      });
    }

    const command = {
      type: "fire-charged-weapon",
      weapon,
      power: power01,
      aim: { angle: aim.angle, targetX: aim.targetX, targetY: aim.targetY },
      atMs,
      projectileIds,
    } as const;

    this.turnLog.projectileEvents.push(...spawnEvents);

    const source: GameEventSource = this.isLocalTurnActive() ? "local-sim" : "remote-sim";
    const wormIndex = this.teamManager.activeWormIndex;
    gameEvents.emit("combat.shot.fired", {
      source,
      turnIndex: this.turnIndex,
      teamId: this.activeTeam.id,
      wormIndex,
      weapon,
      power01,
      aim: { angle: aim.angle, targetX: aim.targetX, targetY: aim.targetY },
      wormPosition: { x: this.activeWorm.x, y: this.activeWorm.y },
      wind: this.wind,
      atMs,
      projectiles: spawnEvents.map((event) => ({
        projectileId: event.id,
        weapon: event.weapon,
        position: { ...event.position },
        velocity: { ...event.velocity },
        wind: event.wind,
      })),
    });

    for (const event of spawnEvents) {
      gameEvents.emit("combat.projectile.spawned", {
        source,
        turnIndex: this.turnIndex,
        teamId: this.activeTeam.id,
        wormIndex,
        projectileId: event.id,
        weapon: event.weapon,
        position: { ...event.position },
        velocity: { ...event.velocity },
        wind: event.wind,
        atMs: event.atMs,
      });
    }

    return command;
  }

  private onExplosion(
    x: number,
    y: number,
    radius: number,
    damage: number,
    cause: WeaponType
  ) {
    const source: GameEventSource = this.isLocalTurnActive() ? "local-sim" : "remote-sim";
    gameEvents.emit("combat.explosion", {
      source,
      turnIndex: this.turnIndex,
      teamId: this.activeTeam.id,
      position: { x, y },
      radius,
      damage,
      cause,
      atMs: this.turnTimestampMs(),
    });

    const particleCount =
      cause === WeaponType.Rifle ? 12 : cause === WeaponType.Uzi ? 8 : 50;
    for (let i = 0; i < particleCount; i++) {
      const ang = this.random() * Math.PI * 2;
      const spd =
        cause === WeaponType.Rifle
          ? this.randomRange(60, 180)
          : cause === WeaponType.Uzi
            ? this.randomRange(40, 140)
          : this.randomRange(100, 400);
      const vx = Math.cos(ang) * spd;
      const vy =
        Math.sin(ang) * spd - (cause === WeaponType.Rifle ? 30 : cause === WeaponType.Uzi ? 25 : 50);
      const life = this.randomRange(
        0.25,
        cause === WeaponType.Rifle ? 0.6 : cause === WeaponType.Uzi ? 0.45 : 0.9
      );
      const r = this.randomRange(1, cause === WeaponType.Rifle ? 3 : cause === WeaponType.Uzi ? 2 : 6);
      const col =
        i % 2 === 0 ? "rgba(120,120,120,0.8)" : "rgba(200,180,120,0.8)";
      this.particles.push(new Particle(x, y, vx, vy, life, r, col));
    }

    if (!this.isLocalTurnActive()) {
      return;
    }

    this.recordTerrainCarve(x, y, radius);
    this.terrain.carveCircle(x, y, radius);
    this.dislodgeTombstonesFromCarve(x, y, radius);

    if (cause !== WeaponType.Rifle && cause !== WeaponType.Uzi) {
      for (const team of this.teams) {
        for (const worm of team.worms) {
          if (!worm.alive) continue;
          const d = distance(x, y, worm.x, worm.y);
          if (d <= radius * 2) {
            const t = clamp(1 - d / radius, 0, 1);
            const dmg = damage * Math.pow(t, 0.6);
            if (dmg > 0) {
              const wasAlive = worm.alive;
              const beforeHealth = worm.health;
              worm.takeDamage(dmg);
              const dirx = (worm.x - x) / (d || 1);
              const diry = (worm.y - y) / (d || 1);
              const imp = 240 * t;
              worm.applyImpulse(dirx * imp, diry * imp);

              this.recordWormHealthChange(worm, team, beforeHealth, wasAlive, cause);

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

  }

  private emitGrenadeFuseSmoke(projectile: Projectile, dt: number) {
    const localFuseX = 4;
    const localFuseY = -projectile.r - 6;
    const angle = Math.atan2(projectile.vy, projectile.vx);
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    const fuseX = projectile.x + localFuseX * cos - localFuseY * sin;
    const fuseY = projectile.y + localFuseX * sin + localFuseY * cos;

    const radialX = fuseX - projectile.x;
    const radialY = fuseY - projectile.y;
    const radialLen = Math.hypot(radialX, radialY) || 1;
    const dirX = radialX / radialLen;
    const dirY = radialY / radialLen;
    const driftX = -dirY;
    const driftY = dirX;

    const emissionRate = 26;
    let carry = (this.grenadeSmokeCarry.get(projectile) ?? 0) + dt * emissionRate;
    const emitCount = Math.floor(carry);
    carry -= emitCount;
    this.grenadeSmokeCarry.set(projectile, carry);

    for (let i = 0; i < emitCount; i++) {
      const phase = projectile.age * 18 + i * 2.31;
      const jitter01 = (Math.sin(phase * 1.9) + 1) * 0.5;
      const dist = 1.4 + jitter01 * 1.2;
      const jitter = Math.sin(phase * 1.3) * (2 + jitter01 * 3.4);
      const speed = 20 + jitter01 * 16;
      const vx = dirX * speed + driftX * jitter + projectile.vx * 0.08;
      const vy = dirY * speed + driftY * jitter + projectile.vy * 0.08;
      const life = 0.44 + jitter01 * 0.34;
      const radius = 1.6 + jitter01 * 1.8;
      const color = `rgba(92, 100, 112, ${0.44 + jitter01 * 0.22})`;
      this.particles.push(
        new Particle(
          fuseX + dirX * dist + driftX * jitter * 0.2,
          fuseY + dirY * dist + driftY * jitter * 0.2,
          vx,
          vy,
          life,
          radius,
          color,
          -24,
          false
        )
      );
    }
  }

  private emitTurnStarted(config: { initial: boolean; source: GameEventSource }) {
    gameEvents.emit("turn.started", {
      source: config.source,
      turnIndex: this.turnIndex,
      teamId: this.activeTeam.id,
      wormIndex: this.teamManager.activeWormIndex,
      wind: this.wind,
      weapon: this.state.weapon,
      initial: config.initial,
    });
  }

  private emitWormHealthEvents(event: {
    source: GameEventSource;
    turnIndex: number;
    teamId: TeamId;
    wormIndex: number;
    position: { x: number; y: number };
    before: number;
    after: number;
    delta: number;
    cause: WeaponType;
    atMs: number;
    wasAlive: boolean;
    alive: boolean;
  }) {
    gameEvents.emit("worm.health.changed", event);
    const damage = Math.max(0, event.before - event.after);
    if (damage > 0) {
      gameEvents.emit("worm.hit", {
        source: event.source,
        turnIndex: event.turnIndex,
        teamId: event.teamId,
        wormIndex: event.wormIndex,
        position: event.position,
        damage,
        cause: event.cause,
        atMs: event.atMs,
        healthAfter: event.after,
      });
    }
    if (event.wasAlive && !event.alive) {
      gameEvents.emit("worm.killed", {
        source: event.source,
        turnIndex: event.turnIndex,
        teamId: event.teamId,
        wormIndex: event.wormIndex,
        position: event.position,
        cause: event.cause,
        atMs: event.atMs,
      });
    }
  }

  private endAimPhaseWithoutShot() {
    this.clearAiPreShotVisual();
    this.state.expireAimPhase();
    if (!this.isLocalTurnActive()) return;
    setTimeout(() => {
      if (this.isLocalTurnActive()) this.nextTurn();
    }, 400);
  }

  private endAimPhaseAfterShot() {
    this.clearAiPreShotVisual();
    this.state.shotFired();
    this.message = null;
  }

  private checkVictory() {
    if (this.state.phase === "gameover") return;
    const redAlive = this.teamManager.isTeamAlive("Red");
    const blueAlive = this.teamManager.isTeamAlive("Blue");
    if (!redAlive || !blueAlive) {
      this.state.phase = "gameover";
      const winner: TeamId | "Nobody" = redAlive ? "Red" : blueAlive ? "Blue" : "Nobody";
      this.message = `${winner} wins! Press R to restart.`;
      gameEvents.emit("match.gameover", {
        source: "local-sim",
        winner,
        turnIndex: this.turnIndex,
      });
      if (this.isLocalTurnActive() && !this.pendingTurnResolution) {
        const resolution = this.buildTurnResolution(
          this.turnLog,
          this.toNetworkTurnSnapshot(),
          this.now(),
          this.turnIndex
        );
        if (resolution) {
          this.pendingTurnResolution = resolution;
        }
      }
    }
  }
}
