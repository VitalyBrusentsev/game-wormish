import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { GAMEPLAY, WeaponType } from "../definitions";
import { Projectile } from "../entities";
import { GameSession } from "../game/session";

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

  toDataURL() {
    return "";
  }

  addEventListener() {}
  removeEventListener() {}
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
    translate: vi.fn(),
    rotate: vi.fn(),
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

function createRng(seed: number) {
  let state = seed % 2147483647;
  if (state <= 0) state += 2147483646;
  return () => {
    state = (state * 16807) % 2147483647;
    return (state - 1) / 2147483646;
  };
}

describe("bazooka projectile collisions", () => {
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

  it("explodes on worm contact", () => {
    const session = new GameSession(320, 240, { random: createRng(7), now: () => 0 });
    const targetTeam = session.teams.find((t) => t.id !== session.activeTeam.id)!;
    const target = targetTeam.worms[0]!;
    target.x = 200;
    target.y = 70;
    target.vx = 0;
    target.vy = 0;
    target.onGround = false;

    const projectile = new Projectile(
      target.x,
      target.y,
      0,
      0,
      4,
      WeaponType.Bazooka,
      0,
      (x, y, radius, damage, cause) => (session as any).onExplosion(x, y, radius, damage, cause)
    );

    session.projectiles = [projectile];
    session.state.phase = "projectile";

    session.update(0);

    expect(session.projectiles).toHaveLength(0);
    expect(target.health).toBeLessThan(100);
    expect(target.health).toBe(100 - GAMEPLAY.bazooka.damage);
  });
});
