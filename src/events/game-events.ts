import type { TeamId } from "../definitions";
import { WeaponType } from "../definitions";
import type { TurnCommand, TerrainOperation, WormHealthChange } from "../game/network/turn-payload";
import { EventBus } from "./event-bus";

export type GameEventSource = "local-sim" | "remote-sim" | "remote-effects" | "remote-resolution" | "system";

export type AimSnapshot = { angle: number; targetX: number; targetY: number };

export type GameEventMap = {
  "turn.started": {
    source: GameEventSource;
    turnIndex: number;
    teamId: TeamId;
    wormIndex: number;
    wind: number;
    weapon: WeaponType;
    initial: boolean;
  };
  "turn.command.recorded": {
    source: GameEventSource;
    turnIndex: number;
    teamId: TeamId;
    command: TurnCommand;
  };
  "turn.effects.emitted": {
    source: GameEventSource;
    turnIndex: number;
    actingTeamId: TeamId;
    terrainOperations: TerrainOperation[];
    wormHealth: WormHealthChange[];
  };
  "combat.shot.fired": {
    source: GameEventSource;
    turnIndex: number;
    teamId: TeamId;
    wormIndex: number;
    weapon: WeaponType;
    power01: number;
    aim: AimSnapshot;
    wormPosition: { x: number; y: number };
    wind: number;
    atMs: number;
    projectiles: Array<{
      projectileId: number;
      weapon: WeaponType;
      position: { x: number; y: number };
      velocity: { x: number; y: number };
      wind: number;
    }>;
  };
  "combat.projectile.spawned": {
    source: GameEventSource;
    turnIndex: number;
    teamId: TeamId;
    wormIndex: number;
    projectileId: number;
    weapon: WeaponType;
    position: { x: number; y: number };
    velocity: { x: number; y: number };
    wind: number;
    atMs: number;
  };
  "combat.projectile.exploded": {
    source: GameEventSource;
    turnIndex: number;
    teamId: TeamId;
    projectileId: number;
    weapon: WeaponType;
    position: { x: number; y: number };
    radius: number;
    damage: number;
    cause: WeaponType;
    atMs: number;
  };
  "combat.projectile.expired": {
    source: GameEventSource;
    turnIndex: number;
    teamId: TeamId;
    projectileId: number;
    weapon: WeaponType;
    position: { x: number; y: number };
    reason: "lifetime" | "out-of-bounds";
    atMs: number;
  };
  "combat.explosion": {
    source: GameEventSource;
    turnIndex: number;
    teamId: TeamId;
    position: { x: number; y: number };
    radius: number;
    damage: number;
    cause: WeaponType;
    atMs: number;
  };
  "world.terrain.carved": {
    source: GameEventSource;
    turnIndex: number;
    teamId: TeamId;
    position: { x: number; y: number };
    radius: number;
    atMs: number;
  };
  "worm.health.changed": {
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
  };
  "worm.hit": {
    source: GameEventSource;
    turnIndex: number;
    teamId: TeamId;
    wormIndex: number;
    position: { x: number; y: number };
    damage: number;
    cause: WeaponType;
    atMs: number;
    healthAfter: number;
  };
  "worm.killed": {
    source: GameEventSource;
    turnIndex: number;
    teamId: TeamId;
    wormIndex: number;
    position: { x: number; y: number };
    cause: WeaponType;
    atMs: number;
  };
  "match.restarted": {
    source: GameEventSource;
  };
  "match.gameover": {
    source: GameEventSource;
    winner: TeamId | "Nobody";
    turnIndex: number;
  };
};

export const gameEvents = new EventBus<GameEventMap>();

