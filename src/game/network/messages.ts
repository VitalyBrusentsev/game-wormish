import type { MatchInitSnapshot } from "../session";
import type { TeamId } from "../../definitions";
import type { TurnCommand } from "./turn-payload";
import type { TurnResolution } from "./turn-payload";

export interface MatchInitMessage {
  type: "match_init";
  payload: {
    snapshot: MatchInitSnapshot;
  };
}

export interface PlayerHelloMessage {
  type: "player_hello";
  payload: {
    name: string | null;
    role: "host" | "guest";
  };
}

export interface MatchRestartRequestMessage {
  type: "match_restart_request";
  payload: Record<string, never>;
}

export interface TurnResolutionMessage {
  type: "turn_resolution";
  payload: TurnResolution;
}

export interface TurnCommandMessage {
  type: "turn_command";
  payload: {
    turnIndex: number;
    teamId: TeamId;
    command: TurnCommand;
  };
}

export type NetworkMessage =
  | MatchInitMessage
  | PlayerHelloMessage
  | MatchRestartRequestMessage
  | TurnCommandMessage
  | TurnResolutionMessage;
