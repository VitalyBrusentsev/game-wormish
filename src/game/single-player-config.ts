import type { TeamId } from "../definitions";

export type SinglePlayerTeamSide = "left" | "right";

export type SinglePlayerConfig = {
  playerTeamColor?: TeamId;
  playerStartSide?: SinglePlayerTeamSide;
};

export type GameOptions = {
  singlePlayer?: SinglePlayerConfig;
};

export type ResolvedSinglePlayerConfig = {
  playerTeamColor: TeamId;
  playerStartSide: SinglePlayerTeamSide;
};

export const resolveSinglePlayerConfig = (
  config?: SinglePlayerConfig
): ResolvedSinglePlayerConfig => ({
  playerTeamColor: config?.playerTeamColor ?? "Blue",
  playerStartSide: config?.playerStartSide ?? "left",
});

export const oppositeTeamId = (teamId: TeamId): TeamId =>
  teamId === "Red" ? "Blue" : "Red";
