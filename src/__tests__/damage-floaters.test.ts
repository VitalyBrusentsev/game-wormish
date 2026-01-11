import { describe, expect, it } from "vitest";
import { DamageFloaters } from "../ui/damage-floaters";
import { WeaponType } from "../definitions";
import type { GameEventMap } from "../events/game-events";

function createHealthChangedEvent(
  partial: Partial<GameEventMap["worm.health.changed"]> & Pick<GameEventMap["worm.health.changed"], "teamId" | "wormIndex" | "delta">
): GameEventMap["worm.health.changed"] {
  return {
    source: "local-sim",
    turnIndex: 0,
    teamId: partial.teamId,
    wormIndex: partial.wormIndex,
    position: partial.position ?? { x: 100, y: 200 },
    before: partial.before ?? 100,
    after: partial.after ?? 100 + partial.delta,
    delta: partial.delta,
    cause: partial.cause ?? WeaponType.Uzi,
    atMs: partial.atMs ?? 0,
    wasAlive: partial.wasAlive ?? true,
    alive: partial.alive ?? true,
  };
}

describe("DamageFloaters", () => {
  it("aggregates damage for the same worm into one active floater", () => {
    const floaters = new DamageFloaters();

    floaters.onWormHealthChanged(createHealthChangedEvent({ teamId: "Red", wormIndex: 0, delta: -5 }), 1000);
    floaters.onWormHealthChanged(createHealthChangedEvent({ teamId: "Red", wormIndex: 0, delta: -3 }), 1100);

    const snapshot = floaters.getDebugSnapshot(1100);
    expect(snapshot).toHaveLength(1);
    const floater = snapshot[0]!;
    expect(floater.amount).toBe(8);
    expect(floater.createdAtMs).toBe(1100);
  });

  it("creates separate floaters for different worms", () => {
    const floaters = new DamageFloaters();

    floaters.onWormHealthChanged(createHealthChangedEvent({ teamId: "Red", wormIndex: 0, delta: -2 }), 1000);
    floaters.onWormHealthChanged(createHealthChangedEvent({ teamId: "Red", wormIndex: 1, delta: -2 }), 1100);
    floaters.onWormHealthChanged(createHealthChangedEvent({ teamId: "Blue", wormIndex: 0, delta: -2 }), 1200);

    expect(floaters.getDebugSnapshot(1200)).toHaveLength(3);
  });

  it("does not aggregate into expired floaters", () => {
    const floaters = new DamageFloaters();
    const ttlMs = 3000;

    floaters.onWormHealthChanged(createHealthChangedEvent({ teamId: "Red", wormIndex: 0, delta: -5 }), 1000);
    floaters.onWormHealthChanged(createHealthChangedEvent({ teamId: "Red", wormIndex: 0, delta: -3 }), 1000 + ttlMs + 1);

    const snapshot = floaters.getDebugSnapshot(1000 + ttlMs + 1);
    expect(snapshot).toHaveLength(1);
    const floater = snapshot[0]!;
    expect(floater.amount).toBe(3);
    expect(floater.createdAtMs).toBe(1000 + ttlMs + 1);
  });
});
