import type { MatchInitSnapshot } from "../session";
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

export interface TurnResolutionMessage {
  type: "turn_resolution";
  payload: TurnResolution;
}

export type NetworkMessage = MatchInitMessage | PlayerHelloMessage | TurnResolutionMessage;
