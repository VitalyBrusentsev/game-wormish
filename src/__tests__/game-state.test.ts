import { describe, expect, it } from "vitest";
import { GameState } from "../game-state";
import { WeaponType } from "../definitions";

describe("GameState", () => {
  it("resets turn state when starting a new turn", () => {
    const state = new GameState();
    state.charging = true;
    state.chargeStartMs = 500;
    state.weapon = WeaponType.HandGrenade;

    state.startTurn(1000, WeaponType.Bazooka);

    expect(state.phase).toBe("aim");
    expect(state.weapon).toBe(WeaponType.Bazooka);
    expect(state.turnStartMs).toBe(1000);
    expect(state.charging).toBe(false);
    expect(state.chargeStartMs).toBe(0);
  });

  it("computes charge power ping-ponging between 0 and 1", () => {
    const state = new GameState();
    state.beginCharge(1000);

    expect(state.getCharge01(1600)).toBeCloseTo(0.428571, 5);
    expect(state.getCharge01(2400)).toBeCloseTo(1, 5);
    expect(state.getCharge01(3400)).toBeCloseTo(0.285714, 5);
    expect(state.getCharge01(3800)).toBeCloseTo(0, 5);
  });

  it("pauses timers by shifting tracked timestamps", () => {
    const state = new GameState();
    state.startTurn(2000);
    state.beginCharge(2400);

    state.pauseFor(500);

    expect(state.turnStartMs).toBe(2500);
    expect(state.chargeStartMs).toBe(2900);
  });
});
