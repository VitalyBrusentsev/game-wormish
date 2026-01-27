import type { Game } from "../game";
import type { TeamId } from "../definitions";
import { WeaponType, clamp } from "../definitions";
import type { Worm } from "../entities";

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
  getTeam: (teamId: string | TeamId) => DebugWorm[];
  getTeams: () => Record<TeamId, DebugWorm[]>;
  getActiveWorm: () => DebugWorm | null;
  selectWorm: (teamId: string | TeamId, index: number) => DebugWorm | null;
};

const createDebugWorms = (game: Game, teamId: TeamId, worms: Worm[]) =>
  worms.map((worm, index) => new DebugWorm(game, worm, teamId, index));

export const createGameDebugApi = (game: Game): GameDebugApi => ({
  getTeam: (teamId) => {
    const normalized = normalizeTeamId(teamId);
    if (!normalized) return [];
    const team = game.session.teams.find((entry) => entry.id === normalized);
    if (!team) return [];
    return createDebugWorms(game, team.id, team.worms);
  },
  getTeams: () => ({
    Red: createDebugWorms(
      game,
      "Red",
      game.session.teams.find((entry) => entry.id === "Red")?.worms ?? []
    ),
    Blue: createDebugWorms(
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
  selectWorm: (teamId, index) => {
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
});
