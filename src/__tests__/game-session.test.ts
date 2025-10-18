import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { GameSession } from "../game/session";

interface CanvasContextMocks {
  clearRect: ReturnType<typeof vi.fn>;
}

const contextStats = new WeakMap<CanvasRenderingContext2D, CanvasContextMocks>();
const originalDocument = (globalThis as { document?: Document }).document;
const originalHTMLCanvasElement = (globalThis as { HTMLCanvasElement?: typeof HTMLCanvasElement })
  .HTMLCanvasElement;

class MockCanvasElement {
  width = 0;
  height = 0;
  private ctx: CanvasRenderingContext2D | null = null;

  getContext(type: string): CanvasRenderingContext2D | null {
    if (type !== "2d") return null;
    if (!this.ctx) this.ctx = createMockContext(this);
    return this.ctx;
  }

  toDataURL() {
    return "";
  }

  addEventListener() {}
  removeEventListener() {}

  getBoundingClientRect() {
    return { left: 0, top: 0, right: this.width, bottom: this.height, width: this.width, height: this.height };
  }
}

function createMockContext(canvas: MockCanvasElement): CanvasRenderingContext2D {
  const stats: CanvasContextMocks = {
    clearRect: vi.fn(),
  };
  const gradient = { addColorStop: vi.fn() };
  const ctx = {
    canvas,
    clearRect: stats.clearRect,
    createLinearGradient: vi.fn(() => gradient),
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
    createPattern: vi.fn(() => ({})),
    translate: vi.fn(),
    rotate: vi.fn(),
    globalAlpha: 1,
    globalCompositeOperation: "source-over",
    fillStyle: "#000",
    strokeStyle: "#000",
    lineWidth: 1,
  } as unknown as CanvasRenderingContext2D;
  contextStats.set(ctx, stats);
  return ctx;
}

function createRng(seed: number) {
  let state = seed % 2147483647;
  if (state <= 0) state += 2147483646;
  return () => {
    state = (state * 16807) % 2147483647;
    return (state - 1) / 2147483646;
  };
}

function createNow(start = 0, step = 1000) {
  let current = start - step;
  return () => {
    current += step;
    return current;
  };
}

class MockImage {
  onload: (() => void) | null = null;
  private _src = "";

  set src(value: string) {
    this._src = value;
    if (this.onload) this.onload();
  }

  get src() {
    return this._src;
  }
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
    (globalThis as { HTMLCanvasElement?: typeof HTMLCanvasElement }).HTMLCanvasElement = originalHTMLCanvasElement;
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
  vi.clearAllMocks();
});

describe("GameSession snapshots", () => {
  it("restores a snapshot and repaints the terrain", () => {
    const rng = createRng(42);
    const now = createNow(1000, 500);
    const session = new GameSession(320, 240, { random: rng, now });

    const ctxMock = contextStats.get(session.terrain.ctx);
    expect(ctxMock).toBeDefined();

    const snapshot = session.toSnapshot();

    session.terrain.carveCircle(160, 120, 30);
    session.wind = snapshot.wind + 5;
    session.message = "changed";
    session.projectiles.push({} as any);
    session.particles.push({} as any);
    session.nextTurn();

    ctxMock!.clearRect.mockClear();

    session.loadSnapshot(snapshot);

    expect(session.projectiles).toHaveLength(0);
    expect(session.particles).toHaveLength(0);
    expect(session.toSnapshot()).toEqual(snapshot);
    expect(Array.from(session.terrain.solid)).toEqual(snapshot.terrain.solid);
    expect(session.terrain.heightMap).toEqual(snapshot.terrain.heightMap);
    expect(ctxMock!.clearRect).toHaveBeenCalled();
  });

  it("produces deterministic snapshots with the same seed", () => {
    const rngA = createRng(99);
    const rngB = createRng(99);
    const sessionA = new GameSession(320, 240, { random: rngA, now: createNow(0, 1000) });
    const sessionB = new GameSession(320, 240, { random: rngB, now: createNow(0, 1000) });

    expect(sessionA.toSnapshot()).toEqual(sessionB.toSnapshot());
  });
});
