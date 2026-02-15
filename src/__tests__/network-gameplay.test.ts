import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { GAMEPLAY, WeaponType } from "../definitions";
import { GameSession } from "../game/session";
import { LocalTurnController, RemoteTurnController, type TurnDriver } from "../game/turn-driver";
import type { TurnCommand } from "../game/network/turn-payload";

const originalDocument = (globalThis as { document?: Document }).document;
const originalHTMLCanvasElement = (globalThis as { HTMLCanvasElement?: typeof HTMLCanvasElement })
  .HTMLCanvasElement;

class MockCanvasElement {
  width = 0;
  height = 0;

  getContext(type: string): CanvasRenderingContext2D | null {
    if (type !== "2d") return null;
    return {
      canvas: this as unknown as HTMLCanvasElement,
      clearRect: vi.fn(),
      fillRect: vi.fn(),
      beginPath: vi.fn(),
      moveTo: vi.fn(),
      lineTo: vi.fn(),
      closePath: vi.fn(),
      fill: vi.fn(),
      stroke: vi.fn(),
      save: vi.fn(),
      restore: vi.fn(),
      rect: vi.fn(),
      arc: vi.fn(),
      createLinearGradient: vi.fn(() => ({ addColorStop: vi.fn() })),
      createRadialGradient: vi.fn(() => ({ addColorStop: vi.fn() })),
      createPattern: vi.fn(() => ({})),
      translate: vi.fn(),
      rotate: vi.fn(),
      globalAlpha: 1,
      globalCompositeOperation: "source-over",
      fillStyle: "#000",
      strokeStyle: "#000",
      lineWidth: 1,
    } as unknown as CanvasRenderingContext2D;
  }

  toDataURL() {
    return "";
  }

  addEventListener() {}
  removeEventListener() {}
}

class MockImage {
  onload: (() => void) | null = null;
  private _src = "";

  set src(value: string) {
    this._src = value;
    this.onload?.();
  }

  get src() {
    return this._src;
  }
}

function createRng(seed: number) {
  let state = seed % 2147483647;
  if (state <= 0) state += 2147483646;
  return () => {
    state = (state * 16807) % 2147483647;
    return (state - 1) / 2147483646;
  };
}

beforeAll(() => {
  vi.stubGlobal("Image", MockImage as unknown as typeof Image);
  (globalThis as { HTMLCanvasElement?: typeof HTMLCanvasElement }).HTMLCanvasElement =
    MockCanvasElement as unknown as typeof HTMLCanvasElement;
  (globalThis as { document?: Document }).document = {
    createElement(tag: string) {
      if (tag === "canvas") {
        return new MockCanvasElement() as unknown as HTMLCanvasElement;
      }
      return { tagName: tag } as unknown as HTMLElement;
    },
  } as Document;
});

afterAll(() => {
  if (originalHTMLCanvasElement) {
    (globalThis as { HTMLCanvasElement?: typeof HTMLCanvasElement }).HTMLCanvasElement =
      originalHTMLCanvasElement;
  } else {
    delete (globalThis as { HTMLCanvasElement?: unknown }).HTMLCanvasElement;
  }
  if (originalDocument) {
    (globalThis as { document?: Document }).document = originalDocument;
  } else {
    delete (globalThis as { document?: unknown }).document;
  }
  vi.unstubAllGlobals();
});

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("Network gameplay turn sync", () => {
  it("propagates active-worm drowning as a normal turn resolution", () => {
    const host = new GameSession(320, 240, { random: createRng(15), now: () => 1000 });
    const guest = new GameSession(320, 240, { random: createRng(16), now: () => 9000 });

    guest.loadMatchInitSnapshot(host.toMatchInitSnapshot());

    const hostControllers = new Map<"Red" | "Blue", TurnDriver>();
    hostControllers.set("Red", new LocalTurnController());
    hostControllers.set("Blue", new RemoteTurnController());
    host.setTurnControllers(hostControllers);

    const guestControllers = new Map<"Red" | "Blue", TurnDriver>();
    guestControllers.set("Red", new RemoteTurnController());
    guestControllers.set("Blue", new LocalTurnController());
    guest.setTurnControllers(guestControllers);

    expect(host.activeTeam.id).toBe("Red");
    expect(guest.activeTeam.id).toBe("Red");
    expect(host.state.phase).toBe("aim");
    expect(guest.state.phase).toBe("aim");

    const drowned = host.activeWorm;
    drowned.y = host.height + 20;
    host.update(1 / 60);
    guest.update(1 / 60);

    expect(drowned.alive).toBe(false);
    expect(host.state.phase).toBe("post");
    expect(host.getTurnIndex()).toBe(0);
    expect(guest.getTurnIndex()).toBe(0);

    vi.advanceTimersByTime(410);

    expect(host.getTurnIndex()).toBe(1);
    expect(host.activeTeam.id).toBe("Blue");
    expect(host.hasPendingTurnResolution()).toBe(true);

    const resolution = host.consumeTurnResolution();
    expect(resolution).not.toBeNull();
    expect(resolution?.turnIndex).toBe(0);
    expect(resolution?.result.turnIndex).toBe(1);

    guest.applyTurnResolution(resolution!, { localizeTime: true });
    expect(guest.getTurnIndex()).toBe(1);
    expect(guest.activeTeam.id).toBe("Blue");
    expect(guest.state.phase).toBe("aim");
    expect(guest.isWaitingForRemoteResolution()).toBe(false);
  });

  it("keeps passive peer from auto-advancing and resyncs on turn resolution", () => {
    const host = new GameSession(320, 240, { random: createRng(5), now: () => 1000 });
    const guest = new GameSession(320, 240, { random: createRng(9), now: () => 9000 });

    guest.loadMatchInitSnapshot(host.toMatchInitSnapshot());

    const hostControllers = new Map<"Red" | "Blue", TurnDriver>();
    hostControllers.set("Red", new LocalTurnController());
    hostControllers.set("Blue", new RemoteTurnController());
    host.setTurnControllers(hostControllers);

    const guestControllers = new Map<"Red" | "Blue", TurnDriver>();
    guestControllers.set("Red", new RemoteTurnController());
    guestControllers.set("Blue", new LocalTurnController());
    guest.setTurnControllers(guestControllers);

    expect(host.getTurnIndex()).toBe(0);
    expect(guest.getTurnIndex()).toBe(0);
    expect(host.isWaitingForRemoteResolution()).toBe(false);
    expect(guest.isWaitingForRemoteResolution()).toBe(true);

    const worm = host.activeWorm;
    const aim = { angle: -0.6, targetX: worm.x + 180, targetY: worm.y - 140 };

    const hostAny = host as unknown as {
      recordCommand: (command: unknown) => void;
    };

    hostAny.recordCommand({
      type: "set-weapon",
      weapon: WeaponType.Rifle,
      atMs: 10,
    });
    guest.applyRemoteTurnCommand({
      type: "set-weapon",
      weapon: WeaponType.Rifle,
      atMs: 10,
    });

    const fireCommand: TurnCommand = {
      type: "fire-charged-weapon",
      weapon: WeaponType.Rifle,
      power: 1,
      aim,
      atMs: 120,
      projectileIds: [] as number[],
    };

    hostAny.recordCommand(fireCommand);
    guest.applyRemoteTurnCommand(fireCommand);

    for (let i = 0; i < 240; i++) {
      host.update(1 / 60);
      guest.update(1 / 60);
    }

    expect(host.state.phase).toBe("post");
    expect(guest.state.phase).toBe("post");
    expect(guest.hasPendingTurnResolution()).toBe(false);

    vi.advanceTimersByTime(GAMEPLAY.postShotDelayMs + 10);
    expect(host.getTurnIndex()).toBe(1);
    expect(host.hasPendingTurnResolution()).toBe(true);

    const resolution = host.consumeTurnResolution();
    expect(resolution).not.toBeNull();
    expect(resolution?.turnIndex).toBe(0);
    expect(resolution?.result.turnIndex).toBe(1);

    expect(guest.getTurnIndex()).toBe(0);
    guest.applyTurnResolution(resolution!, { localizeTime: true });

    expect(guest.getTurnIndex()).toBe(1);
    expect(guest.activeTeam.id).toBe("Blue");
    expect(guest.isWaitingForRemoteResolution()).toBe(false);
  });

  it("replays throttled movement batches without drifting", () => {
    const fine = new GameSession(320, 240, { random: createRng(123), now: () => 1000 });
    const coarse = new GameSession(320, 240, { random: createRng(123), now: () => 1000 });

    expect(coarse.activeWorm.x).toBeCloseTo(fine.activeWorm.x, 6);
    expect(coarse.activeWorm.y).toBeCloseTo(fine.activeWorm.y, 6);

    for (let i = 0; i < 8; i++) {
      fine.applyRemoteTurnCommand({ type: "move", move: 1, jump: false, dtMs: 8, atMs: (i + 1) * 8 });
    }
    coarse.applyRemoteTurnCommand({ type: "move", move: 1, jump: false, dtMs: 64, atMs: 64 });

    expect(coarse.activeWorm.x).toBeCloseTo(fine.activeWorm.x, 6);
    expect(coarse.activeWorm.y).toBeCloseTo(fine.activeWorm.y, 6);
    expect(coarse.activeWorm.vx).toBeCloseTo(fine.activeWorm.vx, 6);
    expect(coarse.activeWorm.vy).toBeCloseTo(fine.activeWorm.vy, 6);
    expect(coarse.activeWorm.onGround).toBe(fine.activeWorm.onGround);
  });
});
