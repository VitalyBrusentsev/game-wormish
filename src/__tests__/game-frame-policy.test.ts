import { describe, expect, it } from "vitest";
import { computeFrameSimulationPolicy, rebaseOverlayOpenedAtMs } from "../game";
import { NetworkSessionState } from "../network/session-state";
import { ConnectionState } from "../webrtc/types";

const createSnapshot = (configure?: (state: NetworkSessionState) => void) => {
  const state = new NetworkSessionState();
  configure?.(state);
  return state.getSnapshot();
};

describe("frame simulation policy", () => {
  it("pauses local simulation when overlays are open", () => {
    const snapshot = createSnapshot();
    const policy = computeFrameSimulationPolicy(snapshot, true);

    expect(policy.waitingForSync).toBe(false);
    expect(policy.networkPaused).toBe(false);
    expect(policy.simulationPaused).toBe(true);
  });

  it("keeps simulation running for connected network sessions while overlays are open", () => {
    const snapshot = createSnapshot((state) => {
      state.setMode("network-host");
      state.updateConnectionLifecycle(ConnectionState.CONNECTED, 1000);
      state.setWaitingForSnapshot(false);
    });
    const policy = computeFrameSimulationPolicy(snapshot, true);

    expect(policy.waitingForSync).toBe(false);
    expect(policy.networkPaused).toBe(false);
    expect(policy.simulationPaused).toBe(false);
  });

  it("pauses network sessions that are still waiting for sync", () => {
    const snapshot = createSnapshot((state) => {
      state.setMode("network-guest");
      state.updateConnectionLifecycle(ConnectionState.CONNECTED, 1000);
      state.setWaitingForSnapshot(true);
    });
    const policy = computeFrameSimulationPolicy(snapshot, false);

    expect(policy.waitingForSync).toBe(true);
    expect(policy.networkPaused).toBe(true);
    expect(policy.simulationPaused).toBe(true);
  });

  it("rebases overlay open timestamp after background pause", () => {
    expect(rebaseOverlayOpenedAtMs(null, 5000)).toBeNull();
    expect(rebaseOverlayOpenedAtMs(1200, 0)).toBe(1200);
    expect(rebaseOverlayOpenedAtMs(1200, -10)).toBe(1200);
    expect(rebaseOverlayOpenedAtMs(1200, 5000)).toBe(6200);
  });

  it("prevents double-counting hidden time in overlay pause duration", () => {
    const openedAtMs = 1000;
    const hiddenForMs = 5000;
    const resumedAtMs = 7000;
    const closedAtMs = 9000;

    const rebasedOpenedAtMs = rebaseOverlayOpenedAtMs(openedAtMs, hiddenForMs);
    const overlayVisibleMs = closedAtMs - (rebasedOpenedAtMs ?? 0);
    const expectedVisibleMs = (2000 - openedAtMs) + (closedAtMs - resumedAtMs);

    expect(overlayVisibleMs).toBe(expectedVisibleMs);
  });
});
