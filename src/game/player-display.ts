import type { TeamId } from "../definitions";
import { COLORS } from "../definitions";
import type { NetworkSessionStateSnapshot } from "../network/session-state";

export type NetworkMicroStatus = {
  text: string;
  color: string;
  opponentSide: "left" | "right";
};

export const cleanPlayerName = (name: string | null) => {
  const cleaned = name?.trim();
  return cleaned ? cleaned : null;
};

export const getNetworkTeamNames = (snapshot: NetworkSessionStateSnapshot) => {
  if (snapshot.mode === "local") return null;

  const localTeamId = snapshot.player.localTeamId;
  const remoteTeamId = snapshot.player.remoteTeamId;
  const localName = cleanPlayerName(snapshot.player.localName);
  const remoteName = cleanPlayerName(snapshot.player.remoteName);

  const names: Partial<Record<TeamId, string>> = {};
  if (localTeamId && localName) names[localTeamId] = localName;
  if (remoteTeamId && remoteName) names[remoteTeamId] = remoteName;
  return names;
};

export const getNetworkMicroStatus = (
  snapshot: NetworkSessionStateSnapshot
): NetworkMicroStatus | null => {
  if (snapshot.mode === "local") return null;

  const remoteTeamId = snapshot.player.remoteTeamId;
  const localTeamId = snapshot.player.localTeamId;
  const opponentSide: "left" | "right" =
    remoteTeamId === "Red"
      ? "left"
      : remoteTeamId === "Blue"
        ? "right"
        : localTeamId === "Blue"
          ? "left"
          : "right";

  if (snapshot.bridge.networkReady && snapshot.bridge.waitingForRemoteSnapshot) {
    return {
      text: snapshot.mode === "network-guest" ? "Waiting for host sync..." : "Waiting for sync...",
      color: "#FFFF00",
      opponentSide,
    };
  }

  switch (snapshot.connection.lifecycle) {
    case "idle":
      return { text: "Idle", color: "#888888", opponentSide };
    case "creating":
    case "joining":
      return { text: "Setting up...", color: "#FFA500", opponentSide };
    case "created":
    case "joined":
      return { text: "Waiting...", color: "#FFFF00", opponentSide };
    case "connecting":
      return { text: "Connecting...", color: "#FFA500", opponentSide };
    case "connected":
      return { text: "Connected", color: "#00FF00", opponentSide };
    case "disconnected":
      return { text: "Disconnected", color: "#FF6600", opponentSide };
    case "error": {
      const details = snapshot.connection.lastError?.trim();
      return { text: details ? `Error: ${details}` : "Error", color: "#FF0000", opponentSide };
    }
  }

  return { text: "Unknown", color: COLORS.white, opponentSide };
};

export const replaceWinnerInMessage = (
  message: string | null,
  teamLabels?: Partial<Record<TeamId, string>>
) => {
  if (!message) return null;

  const match = /^(Red|Blue) wins!/.exec(message);
  if (!match) return message;

  const teamId = match[1] as TeamId;
  const teamName = cleanPlayerName(teamLabels?.[teamId] ?? null);
  if (!teamName) return message;

  const winnerToken = match[1];
  if (!winnerToken) return message;
  return message.replace(winnerToken, teamName);
};
