import { describe, expect, it } from "vitest";
import { computeFrameSimulationPolicy } from "../game";
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
});
