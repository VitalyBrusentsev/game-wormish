import { describe, expect, it } from "vitest";
import { applyMoveThrottle, flushMoveThrottle, type MoveThrottleState } from "../game/network/move-throttle";

describe("move throttle", () => {
  const config = { minIntervalMs: 60, suppressIdle: true };
  const base = { turnIndex: 8, teamId: "Blue" as const };

  it("suppresses idle movement spam", () => {
    let state: MoveThrottleState | null = null;
    const first = applyMoveThrottle({
      state,
      config,
      nowMs: 1000,
      ...base,
      movement: { type: "move", move: 0, jump: false, dtMs: 8, atMs: 10 },
    });
    state = first.nextState;
    expect(first.toSend).toHaveLength(0);

    const second = applyMoveThrottle({
      state,
      config,
      nowMs: 1010,
      ...base,
      movement: { type: "move", move: 0, jump: false, dtMs: 8, atMs: 18 },
    });
    expect(second.toSend).toHaveLength(0);
  });

  it("sends immediately on move change and coalesces while held", () => {
    let state: MoveThrottleState | null = null;
    const start = applyMoveThrottle({
      state,
      config,
      nowMs: 1000,
      ...base,
      movement: { type: "move", move: 1, jump: false, dtMs: 8, atMs: 10 },
    });
    state = start.nextState;
    expect(start.toSend).toHaveLength(1);

    const tooSoon = applyMoveThrottle({
      state,
      config,
      nowMs: 1030,
      ...base,
      movement: { type: "move", move: 1, jump: false, dtMs: 8, atMs: 40 },
    });
    state = tooSoon.nextState;
    expect(tooSoon.toSend).toHaveLength(0);

    const sendLater = applyMoveThrottle({
      state,
      config,
      nowMs: 1070,
      ...base,
      movement: { type: "move", move: 1, jump: false, dtMs: 8, atMs: 70 },
    });
    state = sendLater.nextState;
    expect(sendLater.toSend).toHaveLength(1);
    expect(sendLater.toSend[0]!.dtMs).toBeGreaterThan(8);
  });

  it("flushes pending movement when requested", () => {
    const state: MoveThrottleState = {
      turnIndex: base.turnIndex,
      teamId: base.teamId,
      move: 1,
      lastSentAtMs: 1000,
      pendingDtMs: 32,
      pendingAtMs: 50,
    };
    const flush = flushMoveThrottle({ state, nowMs: 1100 });
    expect(flush.toSend).toHaveLength(1);
    expect(flush.toSend[0]).toEqual({ type: "move", move: 1, jump: false, dtMs: 32, atMs: 50 });
    expect(flush.nextState?.pendingDtMs).toBe(0);
  });
});

