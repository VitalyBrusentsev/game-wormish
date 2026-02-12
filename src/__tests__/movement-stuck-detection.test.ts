import { describe, expect, it } from "vitest";
import {
  didMovementGetStuck,
  isForwardProgressBlocked,
  MOVEMENT_STUCK_DISTANCE_PX,
  MIN_FORWARD_PROGRESS_PX,
} from "../movement/stuck-detection";

describe("movement stuck detection", () => {
  it("flags movement below stuck threshold", () => {
    const from = { x: 100, y: 200 };
    const to = { x: 100 + MOVEMENT_STUCK_DISTANCE_PX * 0.4, y: 200 };
    expect(didMovementGetStuck(from, to)).toBe(true);
  });

  it("does not flag movement above stuck threshold", () => {
    const from = { x: 100, y: 200 };
    const to = { x: 100 + MOVEMENT_STUCK_DISTANCE_PX * 1.8, y: 200 };
    expect(didMovementGetStuck(from, to)).toBe(false);
  });

  it("detects blocked forward progress toward right and left", () => {
    expect(
      isForwardProgressBlocked(
        { x: 20, y: 0 },
        { x: 20 + MIN_FORWARD_PROGRESS_PX * 0.3, y: 0 },
        1
      )
    ).toBe(true);
    expect(
      isForwardProgressBlocked(
        { x: 80, y: 0 },
        { x: 80 - MIN_FORWARD_PROGRESS_PX * 0.4, y: 0 },
        -1
      )
    ).toBe(true);
  });
});
