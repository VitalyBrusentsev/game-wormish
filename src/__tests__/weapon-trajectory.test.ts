import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { WeaponType, WORLD } from "../definitions";
import { Terrain, Worm } from "../entities";
import { predictTrajectory } from "../game/weapon-system";

const originalDocument = (globalThis as { document?: Document }).document;
const originalHTMLCanvasElement = (globalThis as { HTMLCanvasElement?: typeof HTMLCanvasElement })
  .HTMLCanvasElement;
const originalImage = (globalThis as { Image?: typeof Image }).Image;

class MockCanvasElement {
  width = 0;
  height = 0;
  private ctx: CanvasRenderingContext2D | null = null;

  getContext(type: string): CanvasRenderingContext2D | null {
    if (type !== "2d") return null;
    if (!this.ctx) this.ctx = createMockContext(this);
    return this.ctx;
  }
}

function createMockContext(canvas: MockCanvasElement): CanvasRenderingContext2D {
  const gradient = { addColorStop: vi.fn() };
  return {
    canvas,
    clearRect: vi.fn(),
    createLinearGradient: vi.fn(() => gradient),
    createPattern: vi.fn(() => ({})),
    fillRect: vi.fn(),
    drawImage: vi.fn(),
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
    globalAlpha: 1,
    globalCompositeOperation: "source-over",
    fillStyle: "#000",
    strokeStyle: "#000",
    lineWidth: 1,
  } as unknown as CanvasRenderingContext2D;
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

describe("weapon trajectory prediction", () => {
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
    if (originalImage) {
      (globalThis as { Image?: typeof Image }).Image = originalImage;
    } else {
      delete (globalThis as { Image?: unknown }).Image;
    }
  });

  it("simulates hand grenade bounce/roll beyond first ground contact", () => {
    const width = 2500;
    const height = 900;
    const groundY = 700;
    const terrain = new Terrain(width, height);
    terrain.applyHeightMap(new Array(width).fill(groundY));

    const shooter = new Worm(500, 650, "Red", "Shooter");
    shooter.facing = 1;

    const angle = 0.24;
    const points = predictTrajectory({
      weapon: WeaponType.HandGrenade,
      activeWorm: shooter,
      aim: {
        targetX: shooter.x + Math.cos(angle) * 120,
        targetY: shooter.y + Math.sin(angle) * 120,
        angle,
      },
      power01: 0.35,
      wind: 0,
      terrain,
      width,
      height,
    });

    expect(points.length).toBeGreaterThan(35);

    const bouncePeakIndex = points.findIndex(
      (point, i) =>
        i > 0 &&
        i < points.length - 1 &&
        points[i - 1]!.y <= point.y &&
        points[i + 1]!.y + 1 < point.y &&
        point.y >= groundY - WORLD.projectileRadius - 2
    );
    expect(bouncePeakIndex).toBeGreaterThan(0);
    expect(points.length - (bouncePeakIndex + 1)).toBeGreaterThan(8);
  });
});
