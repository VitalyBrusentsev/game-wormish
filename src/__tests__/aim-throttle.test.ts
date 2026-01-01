import { describe, expect, it } from "vitest";
import { applyAimThrottle, type AimThrottleState } from "../game/network/aim-throttle";

describe("applyAimThrottle", () => {
  const config = {
    minIntervalMs: 60,
    maxIntervalMs: 250,
    diffThreshold: 0.2,
    angleThresholdRad: 0.2,
  };

  const base = {
    turnIndex: 7,
    teamId: "Blue" as const,
    wormX: 100,
    wormY: 100,
    aim: { angle: 0, targetX: 200, targetY: 100 },
  };

  it("sends the first aim update", () => {
    const result = applyAimThrottle({
      state: null,
      config,
      nowMs: 1000,
      ...base,
    });
    expect(result.shouldSend).toBe(true);
    expect(result.nextState).not.toBeNull();
  });

  it("blocks updates within min interval", () => {
    const state: AimThrottleState = {
      ...base,
      sentAtMs: 1000,
    };
    const result = applyAimThrottle({
      state,
      config,
      nowMs: 1050,
      ...base,
      aim: { angle: 0.5, targetX: 220, targetY: 80 },
    });
    expect(result.shouldSend).toBe(false);
    expect(result.nextState).toBe(state);
  });

  it("sends significant change after min interval", () => {
    const state: AimThrottleState = {
      ...base,
      sentAtMs: 1000,
    };
    const result = applyAimThrottle({
      state,
      config,
      nowMs: 1100,
      ...base,
      aim: { angle: 0.6, targetX: 220, targetY: 80 },
    });
    expect(result.shouldSend).toBe(true);
    expect(result.nextState?.sentAtMs).toBe(1100);
  });

  it("sends periodic refresh after max interval even if similar", () => {
    const state: AimThrottleState = {
      ...base,
      sentAtMs: 1000,
    };
    const result = applyAimThrottle({
      state,
      config,
      nowMs: 1300,
      ...base,
      aim: { angle: 0.01, targetX: 201, targetY: 100 },
    });
    expect(result.shouldSend).toBe(true);
    expect(result.nextState?.sentAtMs).toBe(1300);
  });

  it("resets when turn index changes", () => {
    const state: AimThrottleState = {
      ...base,
      sentAtMs: 1000,
    };
    const result = applyAimThrottle({
      state,
      config,
      nowMs: 1010,
      turnIndex: 8,
      teamId: base.teamId,
      wormX: base.wormX,
      wormY: base.wormY,
      aim: base.aim,
    });
    expect(result.shouldSend).toBe(true);
  });
});

