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
  fireWeapon,
  predictTrajectory,
  shouldPredictPath,
} from "./weapon-system";
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
  wind: number;
  message: string | null;
  terrain: TerrainSnapshot;
  teams: TeamSnapshot[];
  state: GameStateSnapshot;
  activeTeamIndex: number;
  activeWormIndex: number;
}

export interface MatchInitSnapshot {
  width: number;
  height: number;
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
  actingTeamId: TeamId | null;
  actingTeamIndex: number | null;
  actingWormIndex: number | null;
  windAtStart: number | null;
  commands: TurnCommand[];
  projectileEvents: TurnEvent[];
  terrainOperations: TerrainOperation[];
  wormHealth: WormHealthChange[];
};

export class GameSession {
  readonly width: number;
  readonly height: number;
  readonly terrain: Terrain;
  readonly state: GameState;
  private aim: AimInfo;

  private readonly teamManager: TeamManager;
  private readonly callbacks: SessionCallbacks;
  private readonly horizontalPadding: number;
  private readonly random: () => number;
  private readonly now: () => number;

  projectiles: Projectile[] = [];
  particles: Particle[] = [];
  wind = 0;
  message: string | null = null;

  private turnLog: TurnLog;
  private pendingTurnResolution: TurnResolution | null = null;
  private projectileIds = new Map<Projectile, number>();
  private terminatedProjectiles = new Set<number>();
  private nextProjectileId = 1;
  private turnControllers = new Map<TeamId, TurnDriver>();
  private currentTurnDriver: TurnDriver | null = null;
  private currentTurnContext: TurnContext | null = null;
  private waitingForRemoteResolution = false;
  private currentTurnInitial = true;

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

    this.turnLog = this.createEmptyTurnLog();

    this.terrain = new Terrain(width, height, {
      horizontalPadding: this.horizontalPadding,
      random: this.random,
    });
    this.terrain.generate();

    this.teamManager = new TeamManager(width, height, this.random);
    this.teamManager.initialize(this.terrain);

    this.state = new GameState();
    this.aim = this.createDefaultAim();
    this.nextTurn(true);
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

  nextTurn(initial = false) {
    const previousLog = this.turnLog;
    const completedAtMs = this.now();

    this.wind = this.randomRange(-WORLD.windMax, WORLD.windMax);
    this.state.startTurn(this.now(), WeaponType.Bazooka);
    this.message = initial ? "Welcome! Eliminate the other team!" : null;

    if (initial) this.teamManager.resetActiveWormIndex();
    else this.teamManager.advanceToNextTeam();
    this.aim = this.createDefaultAim();

    const snapshot = this.toSnapshot();

    if (!initial) {
      const resolution = this.buildTurnResolution(previousLog, snapshot, completedAtMs);
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
    this.beginTurnLog();
    this.configureTurnDriver(initial);
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

    if (input.pressed("KeyR") && this.state.phase === "gameover") {
      this.restart();
      return;
    }

    const aim = this.computeAimFromInput(input, camera);
    this.recordAim(aim, atMs);

    if (this.state.phase === "aim") {
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
                const wasAlive = worm.alive;
                const beforeHealth = worm.health;
                worm.takeDamage(GAMEPLAY.rifle.directDamage);
                this.recordWormHealthChange(
                  worm,
                  team,
                  beforeHealth,
                  wasAlive,
                  WeaponType.Rifle
                );
                const dirx = (worm.x - projectile.x) / (d || 1);
                const diry = (worm.y - projectile.y) / (d || 1);
                worm.applyImpulse(dirx * 120, diry * 120);
                projectile.explode(specRifle);
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

  getAimInfo(): AimInfo {
    return this.aim;
  }

  predictPath(): PredictedPoint[] {
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

  getTeamHealth(id: TeamId) {
    return this.teamManager.getTeamHealth(id);
  }

  restart() {
    this.terrain.generate();
    this.teamManager.initialize(this.terrain);
    this.projectiles = [];
    this.particles = [];
    this.teamManager.setCurrentTeamIndex(this.random() < 0.5 ? 0 : 1);
    this.pendingTurnResolution = null;
    this.projectileIds.clear();
    this.terminatedProjectiles.clear();
    this.nextProjectileId = 1;
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

  toMatchInitSnapshot(): MatchInitSnapshot {
    return {
      width: this.width,
      height: this.height,
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
  }

  loadMatchInitSnapshot(snapshot: MatchInitSnapshot) {
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

  applyTurnResolution(resolution: TurnResolution) {
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
    if (resolution.startedAtMs !== this.state.turnStartMs) {
      throw new Error("Incoming resolution turn start mismatch");
    }

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

    const knownTeamIds = new Set(this.teams.map((t) => t.id));
    const snapshotTerrain = resolution.snapshot.terrain;
    if (snapshotTerrain.horizontalPadding !== this.horizontalPadding) {
      throw new Error("Resolution terrain padding mismatch");
    }
    const expectedTotalWidth =
      snapshotTerrain.width + snapshotTerrain.horizontalPadding * 2;
    if (snapshotTerrain.solid.length !== expectedTotalWidth * snapshotTerrain.height) {
      throw new Error("Resolution terrain mask size mismatch");
    }
    if (snapshotTerrain.heightMap.length !== expectedTotalWidth) {
      throw new Error("Resolution terrain height map size mismatch");
    }

    const worldLeft = this.terrain.worldLeft;
    const worldRight = this.terrain.worldRight;
    const minY = -this.height;
    const maxY = this.height * 2;

    for (const teamSnapshot of resolution.snapshot.teams) {
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

    this.loadSnapshot(resolution.snapshot);

    this.turnLog = this.createEmptyTurnLog();
    this.projectileIds.clear();
    this.terminatedProjectiles.clear();
    this.nextProjectileId = 1;
    this.beginTurnLog();
    this.pendingTurnResolution = null;
    this.waitingForRemoteResolution = false;
    if (this.currentTurnDriver && this.currentTurnContext) {
      this.currentTurnDriver.endTurn?.(this.currentTurnContext, resolution);
    }
  }

  private createEmptyTurnLog(): TurnLog {
    return {
      startedAtMs: 0,
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
    if (!this.state.charging) return;
    this.recordCommand({ type: "cancel-charge", atMs: this.turnTimestampMs() });
  }

  private recordCommand(command: TurnCommand) {
    const finalized = this.applyCommand(command);
    if (finalized) this.turnLog.commands.push(finalized);
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
        const dt = command.dtMs / 1000;
        this.activeWorm.update(dt, this.terrain, command.move, command.jump);
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

  private applyFireCommand(command: Extract<TurnCommand, { type: "fire-charged-weapon" }>): TurnCommand | null {
    if (this.state.phase !== "aim") return null;
    this.state.setWeapon(command.weapon);
    this.aim = command.aim;
    const worm = this.activeWorm;
    worm.facing = command.aim.targetX < worm.x ? -1 : 1;
    const finalized = this.fireChargedWeapon(command.power, command.aim, command.atMs, command.weapon);
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
    return { targetX, targetY, angle: Math.atan2(targetY - worm.y, targetX - worm.x) };
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
    projectile.explosionHandler = (x, y, radius, damage, cause) => {
      this.turnLog.projectileEvents.push({
        type: "projectile-exploded",
        id,
        weapon: projectile.type,
        position: { x, y },
        radius,
        damage,
        cause,
        atMs: this.turnTimestampMs(),
      });
      this.terminatedProjectiles.add(id);
      originalHandler(x, y, radius, damage, cause);
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
    return "out-of-bounds";
  }

  private recordTerrainCarve(x: number, y: number, radius: number) {
    this.turnLog.terrainOperations.push({
      type: "carve-circle",
      x,
      y,
      radius,
      atMs: this.turnTimestampMs(),
    });
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
    this.turnLog.wormHealth.push({
      teamId: team.id,
      wormIndex,
      before: beforeHealth,
      after: worm.health,
      delta: worm.health - beforeHealth,
      cause,
      atMs: this.turnTimestampMs(),
      wasAlive,
      alive: worm.alive,
    });
  }

  private cloneCommand(command: TurnCommand): TurnCommand {
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

  private buildTurnResolution(
    log: TurnLog,
    snapshot: GameSnapshot,
    completedAtMs: number
  ): TurnResolution | null {
    if (
      !log.actingTeamId ||
      log.actingTeamIndex === null ||
      log.actingWormIndex === null ||
      log.startedAtMs === 0
    )
      return null;

    const commands = log.commands.map((command) => this.cloneCommand(command));

    const projectileEvents = log.projectileEvents.map((event) => {
      if (event.type === "projectile-spawned") {
        return {
          ...event,
          position: { ...event.position },
          velocity: { ...event.velocity },
        };
      }
      return {
        ...event,
        position: { ...event.position },
      };
    });

    const terrainOperations = log.terrainOperations.map((operation) => ({
      ...operation,
    }));

    const wormHealth = log.wormHealth.map((change) => ({
      ...change,
    }));

    return {
      actingTeamId: log.actingTeamId,
      actingTeamIndex: log.actingTeamIndex!,
      actingWormIndex: log.actingWormIndex,
      windAtStart: log.windAtStart ?? 0,
      windAfter: snapshot.wind,
      startedAtMs: log.startedAtMs,
      completedAtMs,
      commands,
      projectileEvents,
      terrainOperations,
      wormHealth,
      snapshot,
    };
  }

  private randomRange(min: number, max: number) {
    return this.random() * (max - min) + min;
  }

  private fireChargedWeapon(
    power01: number,
    aim: AimInfo,
    atMs: number,
    weapon: WeaponType
  ): Extract<TurnCommand, { type: "fire-charged-weapon" }> {
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
    const spawnEvents: TurnEvent[] = [];
    for (const projectile of newProjectiles) {
      const id = this.allocateProjectileId(projectile);
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
    return command;
  }

  private onExplosion(
    x: number,
    y: number,
    radius: number,
    damage: number,
    cause: WeaponType
  ) {
    this.recordTerrainCarve(x, y, radius);
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
