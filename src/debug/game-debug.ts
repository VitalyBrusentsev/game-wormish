import type { Game } from "../game";
import type { TeamId } from "../definitions";
import { WeaponType, clamp } from "../definitions";
import type { Worm } from "../entities";
import type { GameAiSettings } from "../ai/types";
import { playTurnWithGameAiForTeam, type AiTurnPlan } from "../ai/game-ai";
import type { NetworkLogSetting } from "../network/session-state";
import {
  getWormPersonality,
  normalizeAiPersonality,
  setWormPersonality,
} from "../ai/personality-store";

const normalizeTeamId = (value: string | TeamId): TeamId | null => {
  if (value === "Red" || value === "Blue") return value;
  const normalized = value.trim().toLowerCase();
  if (normalized === "red") return "Red";
  if (normalized === "blue") return "Blue";
  return null;
};

const normalizeWeapon = (value: string | WeaponType): WeaponType | null => {
  if (Object.values(WeaponType).includes(value as WeaponType)) {
    return value as WeaponType;
  }
  const normalized = value.trim().toLowerCase();
  switch (normalized) {
    case "bazooka":
      return WeaponType.Bazooka;
    case "handgrenade":
    case "hand_grenade":
    case "hand grenade":
    case "grenade":
      return WeaponType.HandGrenade;
    case "rifle":
      return WeaponType.Rifle;
    case "uzi":
      return WeaponType.Uzi;
    default:
      return null;
  }
};

const normalizeNetworkLogSetting = (value: unknown): NetworkLogSetting | null => {
  if (value === "all" || value === "turn-resolution") return value;
  return null;
};

export class DebugWorm {
  constructor(
    private readonly game: Game,
    private readonly worm: Worm,
    private readonly teamId: TeamId,
    private readonly index: number
  ) { }

  get name() {
    return this.worm.name;
  }

  get team() {
    return this.worm.team;
  }

  get x() {
    return this.worm.x;
  }

  get y() {
    return this.worm.y;
  }

  get vx() {
    return this.worm.vx;
  }

  get vy() {
    return this.worm.vy;
  }

  get health() {
    return this.worm.health;
  }

  get alive() {
    return this.worm.alive;
  }

  get facing() {
    return this.worm.facing;
  }

  get onGround() {
    return this.worm.onGround;
  }

  get age() {
    return this.worm.age;
  }

  get personality() {
    return getWormPersonality(this.worm);
  }

  setPersonality(value: string | ReturnType<typeof getWormPersonality> | null) {
    const normalized = normalizeAiPersonality(value);
    setWormPersonality(this.worm, normalized);
  }

  select() {
    this.game.session.debugSelectWorm(this.teamId, this.index);
    return this;
  }

  move(dx: number, dy = 0) {
    this.select();
    this.worm.x += dx;
    this.worm.y += dy;
    const resolved = this.game.session.terrain.resolveCircle(
      this.worm.x,
      this.worm.y,
      this.worm.radius,
      Math.max(32, this.worm.radius + 32)
    );
    this.worm.x = resolved.x;
    this.worm.y = resolved.y;
    if (resolved.collided) this.worm.onGround = resolved.onGround;
  }

  walk(direction: -1 | 0 | 1, durationMs: number, jump = false) {
    this.select();
    const move = Math.max(-1, Math.min(1, direction)) as -1 | 0 | 1;
    const duration = Math.max(0, Math.round(durationMs));
    this.game.session.debugMove(move, duration, jump);
  }

  kill() {
    this.select();
    this.worm.takeDamage(this.worm.health + 999);
  }

  useWeapon(value: string | WeaponType) {
    this.select();
    const weapon = normalizeWeapon(value);
    if (!weapon) return;
    this.game.session.debugSetWeapon(weapon);
  }

  shoot(angle: number, power = 1) {
    this.select();
    this.game.session.debugShoot(angle, clamp(power, 0, 1));
  }
}

export type GameDebugApi = {
  getTeam: (teamId: string | TeamId) => DebugTeam;
  getTeams: () => Record<TeamId, DebugTeam>;
  getActiveWorm: () => DebugWorm | null;
  selectWorm: (teamId: string | TeamId, index: number) => DebugWorm | null;
  networkLogSetting: NetworkLogSetting;
  networkLog: string;
};

export type DebugTeam = DebugWorm[] & {
  id: TeamId;
  playTurnWithGameAI: (settings?: GameAiSettings) => AiTurnPlan | null;
};

const createDebugWorms = (game: Game, teamId: TeamId, worms: Worm[]) =>
  worms.map((worm, index) => new DebugWorm(game, worm, teamId, index));

const createDebugTeam = (game: Game, teamId: TeamId, worms: Worm[]): DebugTeam => {
  const team = createDebugWorms(game, teamId, worms) as DebugTeam;
  team.id = teamId;
  team.playTurnWithGameAI = (settings) =>
    playTurnWithGameAiForTeam(game.session, teamId, settings);
  return team;
};

const createEmptyDebugTeam = (teamId: TeamId): DebugTeam => {
  return Object.assign([], {
    id: teamId,
    playTurnWithGameAI: () => null,
  });
};

export const createGameDebugApi = (game: Game): GameDebugApi => {
  const api = {
    getTeam: (teamId: string | TeamId) => {
      const normalized = normalizeTeamId(teamId);
      if (!normalized) return createEmptyDebugTeam(game.session.activeTeam.id);
      const team = game.session.teams.find((entry) => entry.id === normalized);
      if (!team) return createEmptyDebugTeam(normalized);
      return createDebugTeam(game, team.id, team.worms);
    },
    getTeams: () => ({
      Red: createDebugTeam(
        game,
        "Red",
        game.session.teams.find((entry) => entry.id === "Red")?.worms ?? []
      ),
      Blue: createDebugTeam(
        game,
        "Blue",
        game.session.teams.find((entry) => entry.id === "Blue")?.worms ?? []
      ),
    }),
    getActiveWorm: () => {
      const team = game.session.activeTeam;
      if (!team) return null;
      const worm = game.session.activeWorm;
      const index = game.session.activeWormIndex;
      return new DebugWorm(game, worm, team.id, index);
    },
    selectWorm: (teamId: string | TeamId, index: number) => {
      const normalized = normalizeTeamId(teamId);
      if (!normalized) return null;
      const team = game.session.teams.find((entry) => entry.id === normalized);
      if (!team) return null;
      const safeIndex = Math.max(0, Math.min(team.worms.length - 1, index));
      const worm = team.worms[safeIndex];
      if (!worm) return null;
      game.session.debugSelectWorm(normalized, safeIndex);
      return new DebugWorm(game, worm, normalized, safeIndex);
    },
    networkLogSetting: game.getNetworkLogSetting(),
    networkLog: game.getNetworkLogText(),
  } as GameDebugApi;

  Object.defineProperty(api, "networkLogSetting", {
    get: () => game.getNetworkLogSetting(),
    set: (value: unknown) => {
      const normalized = normalizeNetworkLogSetting(value);
      if (!normalized) return;
      game.setNetworkLogSetting(normalized);
    },
    enumerable: true,
    configurable: false,
  });

  Object.defineProperty(api, "networkLog", {
    get: () => game.getNetworkLogText(),
    enumerable: true,
    configurable: false,
  });

  return api;
};
