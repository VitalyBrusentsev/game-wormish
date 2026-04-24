import type { NetworkSessionStateSnapshot } from "../network/session-state";

export type FrameSimulationPolicy = {
  waitingForSync: boolean;
  networkPaused: boolean;
  simulationPaused: boolean;
};

export const computeFrameSimulationPolicy = (
  snapshot: NetworkSessionStateSnapshot,
  overlaysBlocking: boolean
): FrameSimulationPolicy => {
  const waitingForSync =
    snapshot.mode !== "local" &&
    snapshot.bridge.waitingForRemoteSnapshot;
  const networkPaused =
    snapshot.mode !== "local" &&
    (snapshot.connection.lifecycle !== "connected" || waitingForSync);
  const overlayPausesSimulation = overlaysBlocking && snapshot.mode === "local";

  return {
    waitingForSync,
    networkPaused,
    simulationPaused: overlayPausesSimulation || networkPaused,
  };
};

export const rebaseOverlayOpenedAtMs = (
  openedAtMs: number | null,
  pausedForMs: number
): number | null => {
  if (openedAtMs === null) return null;
  if (pausedForMs <= 0) return openedAtMs;
  return openedAtMs + pausedForMs;
};
