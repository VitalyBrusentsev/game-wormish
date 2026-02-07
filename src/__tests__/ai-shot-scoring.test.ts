import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { WeaponType } from "../definitions";
import { GameSession } from "../game/session";
import { buildAimFromAngle, scoreCandidate } from "../ai/shot-scoring";
import { planPanicShot, type ResolvedAiSettings } from "../ai/turn-planning";

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

const buildSettings = (): ResolvedAiSettings => ({
  personality: "Generalist",
  minThinkTimeMs: 1000,
  cinematicChance: 0,
  precisionMode: "perfect",
  precisionTopK: 3,
  noiseAngleRad: 0.05,
  noisePower: 0.06,
  debugEnabled: false,
  debugTopN: 6,
  movementEnabled: true,
});

describe("AI shot scoring", () => {
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

  it("detects first bazooka worm hit and applies friendly-fire penalty", () => {
    const session = new GameSession(1400, 900, { random: createRng(11), now: () => 0 });
    session.wind = 0;
    session.terrain.applyHeightMap(session.terrain.heightMap.map(() => 760));

    const shooter = session.activeTeam.worms[0]!;
    const ally = session.activeTeam.worms[1]!;
    const targetTeam = session.teams.find((team) => team.id !== session.activeTeam.id)!;
    const target = targetTeam.worms[0]!;

    for (const team of session.teams) {
      for (const worm of team.worms) {
        worm.alive = false;
      }
    }
    shooter.alive = true;
    ally.alive = true;
    target.alive = true;

    shooter.x = 220;
    shooter.y = 700;
    shooter.facing = 1;
    ally.x = 340;
    ally.y = 700;
    target.x = 760;
    target.y = 700;

    const angle = 0;
    const aim = buildAimFromAngle(shooter, angle);
    const candidate = scoreCandidate({
      session,
      shooter,
      target,
      weapon: WeaponType.Bazooka,
      aim,
      angle,
      power: 0.35,
      cinematic: false,
      personality: "Generalist",
      baseAngle: angle,
      angleOffset: 0,
    });

    expect(candidate.debug.hitWormTeam).toBe(shooter.team);
    expect(candidate.debug.hitWormName).toBe(ally.name);
    expect(candidate.debug.friendlyDamage).toBeGreaterThan(0);
    expect(candidate.debug.friendlyPenalty).toBeGreaterThan(0);
    expect(candidate.impact.x).toBeLessThan(target.x);
  });

  it("chooses safer panic bazooka options when allies are in front", () => {
    const session = new GameSession(1400, 900, { random: createRng(12), now: () => 0 });
    session.wind = 0;
    session.terrain.applyHeightMap(session.terrain.heightMap.map(() => 760));

    const shooter = session.activeTeam.worms[0]!;
    const ally = session.activeTeam.worms[1]!;
    const targetTeam = session.teams.find((team) => team.id !== session.activeTeam.id)!;
    const target = targetTeam.worms[0]!;

    for (const team of session.teams) {
      for (const worm of team.worms) {
        worm.alive = false;
      }
    }
    shooter.alive = true;
    ally.alive = true;
    target.alive = true;

    shooter.x = 220;
    shooter.y = 700;
    shooter.facing = 1;
    ally.x = 330;
    ally.y = 700;
    target.x = 980;
    target.y = 700;

    const panic = planPanicShot({
      session,
      shooter,
      target,
      cinematic: false,
      settings: buildSettings(),
    });

    expect(panic.candidate.debug.friendlyDamage).toBe(0);
    expect(panic.candidate.debug.hitWormTeam).not.toBe(shooter.team);
  });
});
