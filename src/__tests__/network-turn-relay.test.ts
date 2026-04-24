import { describe, expect, it, vi } from "vitest";
import { WeaponType } from "../definitions";
import { NetworkTurnRelay } from "../game/network/turn-relay";
import type { TurnCommand, TurnResolution } from "../game/network/turn-payload";
import type { TurnEffectsMessage } from "../game/network/messages";

const meta = { turnIndex: 3, teamId: "Blue" as const };
const worm = { x: 100, y: 200 };

const createClock = (startAtMs = 1000) => {
  let now = startAtMs;
  return {
    now: () => now,
    advance: (ms: number) => {
      now += ms;
    },
  };
};

const createUziEffects = (
  count: number,
  overrides: Partial<TurnEffectsMessage["payload"]> = {}
): TurnEffectsMessage["payload"] => ({
  turnIndex: 1,
  actingTeamId: "Blue",
  terrainOperations: Array.from({ length: count }, (_, index) => ({
    type: "carve-circle",
    x: index,
    y: index,
    radius: 7,
    atMs: index,
  })),
  wormHealth: [],
  ...overrides,
});

describe("NetworkTurnRelay", () => {
  it("throttles tiny aim updates but sends later significant ones", () => {
    const clock = createClock();
    const relay = new NetworkTurnRelay(clock.now);
    const send = vi.fn();
    const aim = (angle: number, targetX: number): TurnCommand => ({
      type: "aim",
      aim: { angle, targetX, targetY: 200 },
      atMs: clock.now(),
    });

    relay.handleLocalTurnCommand(aim(0, 180), meta, worm, send);
    relay.handleLocalTurnCommand(aim(0.01, 181), meta, worm, send);
    clock.advance(300);
    relay.handleLocalTurnCommand(aim(0.4, 230), meta, worm, send);

    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[0]?.[0].payload.command.type).toBe("aim");
    expect(send.mock.calls[1]?.[0].payload.command.type).toBe("aim");
  });

  it("batches movement and flushes it before non-movement commands", () => {
    const clock = createClock();
    const relay = new NetworkTurnRelay(clock.now);
    const send = vi.fn();

    relay.handleLocalTurnCommand(
      { type: "move", move: 1, jump: false, dtMs: 16, atMs: 10 },
      meta,
      worm,
      send
    );
    relay.handleLocalTurnCommand(
      { type: "move", move: 1, jump: false, dtMs: 20, atMs: 30 },
      meta,
      worm,
      send
    );
    relay.handleLocalTurnCommand(
      { type: "set-weapon", weapon: WeaponType.Rifle, atMs: 40 },
      meta,
      worm,
      send
    );

    expect(send).toHaveBeenCalledTimes(3);
    expect(send.mock.calls[0]?.[0].payload.command).toMatchObject({ type: "move", dtMs: 16 });
    expect(send.mock.calls[1]?.[0].payload.command).toMatchObject({ type: "move", dtMs: 20 });
    expect(send.mock.calls[2]?.[0].payload.command.type).toBe("set-weapon");
  });

  it("batches small Uzi effects until the flush interval", () => {
    const clock = createClock();
    const relay = new NetworkTurnRelay(clock.now);
    const send = vi.fn();

    relay.handleLocalTurnEffects(createUziEffects(1), send);
    relay.handleLocalTurnEffects(createUziEffects(1), send);
    expect(send).not.toHaveBeenCalled();

    clock.advance(999);
    relay.flushPendingTurnEffects(false, send);
    expect(send).not.toHaveBeenCalled();

    clock.advance(1);
    relay.flushPendingTurnEffects(false, send);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]?.[0]).toMatchObject({
      type: "turn_effects",
      payload: { terrainOperations: [{}, {}] },
    });
  });

  it("sends large effects immediately after flushing pending batched effects", () => {
    const relay = new NetworkTurnRelay(() => 1000);
    const send = vi.fn();
    const largeEffects = createUziEffects(1, {
      terrainOperations: [{ type: "carve-circle", x: 0, y: 0, radius: 42, atMs: 1 }],
      wormHealth: [],
    });

    relay.handleLocalTurnEffects(createUziEffects(1), send);
    relay.handleLocalTurnEffects(largeEffects, send);

    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[0]?.[0].payload.terrainOperations).toHaveLength(1);
    expect(send.mock.calls[1]?.[0].payload.terrainOperations[0]?.radius).toBe(42);
  });

  it("flushes pending effects before turn resolution", () => {
    const relay = new NetworkTurnRelay(() => 1000);
    const send = vi.fn();
    const resolution = {
      turnIndex: 1,
      actingTeamId: "Blue" as const,
      actingTeamIndex: 0,
      actingWormIndex: 0,
      windAtStart: 0,
      windAfter: 0,
      startedAtMs: 0,
      completedAtMs: 10,
      commandCount: 1,
      projectileEventCount: 0,
      terrainOperations: [],
      wormHealth: [],
      result: {
        turnIndex: 2,
        activeTeamIndex: 1,
        activeWormIndices: { Red: 0, Blue: 0 },
        wind: 0,
      },
    } as unknown as TurnResolution;

    relay.handleLocalTurnEffects(createUziEffects(1), send);
    relay.flushTurnResolution(resolution, send);

    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[0]?.[0].type).toBe("turn_effects");
    expect(send.mock.calls[1]?.[0].type).toBe("turn_resolution");
  });
});
