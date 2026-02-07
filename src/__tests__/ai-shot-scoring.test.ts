import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { GAMEPLAY, WeaponType } from "../definitions";
import { GameSession } from "../game/session";
import { buildAimFromAngle, scoreCandidate } from "../ai/shot-scoring";
import {
  computeMovementBudgetMs,
  planMovement,
  planPanicShot,
  planShot,
  shouldAcceptMovementShot,
  type ResolvedAiSettings,
} from "../ai/turn-planning";
import { Worm } from "../entities";

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

const buildSettings = (personality: ResolvedAiSettings["personality"] = "Generalist"): ResolvedAiSettings => ({
  personality,
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

  it("uses a steeper, high-power bazooka arc for crater escape panic shots", () => {
    const session = new GameSession(1400, 900, { random: createRng(17), now: () => 0 });
    session.wind = 0;
    session.terrain.applyHeightMap(session.terrain.heightMap.map(() => 760));

    const shooter = session.activeTeam.worms[0]!;
    const targetTeam = session.teams.find((team) => team.id !== session.activeTeam.id)!;
    const target = targetTeam.worms[0]!;

    for (const team of session.teams) {
      for (const worm of team.worms) {
        worm.alive = false;
      }
    }
    shooter.alive = true;
    target.alive = true;

    shooter.x = 240;
    shooter.y = 700;
    shooter.facing = 1;
    target.x = 980;
    target.y = 700;

    const standard = planPanicShot({
      session,
      shooter,
      target,
      cinematic: false,
      settings: buildSettings(),
    });
    const escape = planPanicShot({
      session,
      shooter,
      target,
      cinematic: false,
      settings: buildSettings(),
      strategy: "escape-arc",
    });

    expect(Math.sin(escape.candidate.angle)).toBeLessThanOrEqual(Math.sin(standard.candidate.angle));
    expect(Math.sin(escape.candidate.angle)).toBeLessThanOrEqual(-0.55);
    expect(escape.candidate.power).toBeGreaterThanOrEqual(0.82);
    expect(Math.cos(escape.candidate.angle)).toBeGreaterThan(0);
    expect(escape.candidate.debug.distToSelf).toBeGreaterThan(GAMEPLAY.bazooka.explosionRadius * 1.5);
  });

  it("makes commando prefer uzi when uzi lane is available", () => {
    const session = new GameSession(1400, 900, { random: createRng(19), now: () => 0 });
    session.wind = 0;
    session.terrain.applyHeightMap(session.terrain.heightMap.map(() => 760));

    const shooter = session.activeTeam.worms[0]!;
    const targetTeam = session.teams.find((team) => team.id !== session.activeTeam.id)!;
    const target = targetTeam.worms[0]!;

    for (const team of session.teams) {
      for (const worm of team.worms) {
        worm.alive = false;
      }
    }
    shooter.alive = true;
    target.alive = true;

    shooter.x = 280;
    shooter.y = 700;
    shooter.facing = 1;
    target.x = 470;
    target.y = 700;

    const planned = planShot({
      session,
      shooter,
      target,
      cinematic: false,
      settings: buildSettings("Commando"),
    });

    expect(planned).not.toBeNull();
    expect(planned!.chosen.weapon).toBe(WeaponType.Uzi);
  });

  it("penalizes uzi scoring when terrain blocks the direct lane", () => {
    const session = new GameSession(1400, 900, { random: createRng(26), now: () => 0 });
    session.wind = 0;
    const heightMap = session.terrain.heightMap.map(() => 760);
    for (let x = 360; x <= 410; x++) {
      heightMap[x] = 620;
    }
    session.terrain.applyHeightMap(heightMap);

    const shooter = session.activeTeam.worms[0]!;
    const targetTeam = session.teams.find((team) => team.id !== session.activeTeam.id)!;
    const target = targetTeam.worms[0]!;

    for (const team of session.teams) {
      for (const worm of team.worms) {
        worm.alive = false;
      }
    }
    shooter.alive = true;
    target.alive = true;

    shooter.x = 280;
    shooter.y = 700;
    shooter.facing = 1;
    target.x = 470;
    target.y = 700;

    const angle = 0;
    const aim = buildAimFromAngle(shooter, angle);
    const blocked = scoreCandidate({
      session,
      shooter,
      target,
      weapon: WeaponType.Uzi,
      aim,
      angle,
      power: 1,
      cinematic: false,
      personality: "Commando",
      baseAngle: angle,
      angleOffset: 0,
    });

    expect(blocked.debug.hitFactor).toBe(0);
    expect(blocked.debug.rangeFactor).toBe(0);
    expect(blocked.score).toBeLessThanOrEqual(0);

    const planned = planShot({
      session,
      shooter,
      target,
      cinematic: false,
      settings: buildSettings("Commando"),
    });
    if (planned) {
      expect(planned.chosen.weapon).not.toBe(WeaponType.Uzi);
    }
  });

  it("keeps commando moving when only long-range non-uzi shots are viable", () => {
    const session = new GameSession(1400, 900, { random: createRng(20), now: () => 0 });
    session.wind = 0;
    session.terrain.applyHeightMap(session.terrain.heightMap.map(() => 760));

    const shooter = session.activeTeam.worms[0]!;
    const targetTeam = session.teams.find((team) => team.id !== session.activeTeam.id)!;
    const target = targetTeam.worms[0]!;

    for (const team of session.teams) {
      for (const worm of team.worms) {
        worm.alive = false;
      }
    }
    shooter.alive = true;
    target.alive = true;

    shooter.x = 220;
    shooter.y = 700;
    shooter.facing = 1;
    target.x = 980;
    target.y = 700;

    const movement = planMovement({
      session,
      shooter,
      target,
      cinematic: false,
      settings: buildSettings("Commando"),
      timeLeftMs: 6500,
    });

    expect(movement.steps.length).toBeGreaterThan(0);
    const firstShot = planShot({
      session,
      shooter,
      target,
      cinematic: false,
      settings: buildSettings("Commando"),
    });
    expect(firstShot).not.toBeNull();
    expect(firstShot!.chosen.weapon).not.toBe(WeaponType.Uzi);
  });

  it("does not accept hitscan shot as resolved when repeatedly stuck", () => {
    const session = new GameSession(1400, 900, { random: createRng(21), now: () => 0 });
    session.wind = 0;
    session.terrain.applyHeightMap(session.terrain.heightMap.map(() => 760));

    const shooter = session.activeTeam.worms[0]!;
    const targetTeam = session.teams.find((team) => team.id !== session.activeTeam.id)!;
    const target = targetTeam.worms[0]!;

    for (const team of session.teams) {
      for (const worm of team.worms) {
        worm.alive = false;
      }
    }
    shooter.alive = true;
    target.alive = true;

    shooter.x = 280;
    shooter.y = 700;
    target.x = 470;
    target.y = 700;

    const shot = planShot({
      session,
      shooter,
      target,
      cinematic: false,
      settings: buildSettings("Commando"),
    });

    expect(shot).not.toBeNull();
    expect(shot!.fired.weapon).toBe(WeaponType.Uzi);
    const accepted = shouldAcceptMovementShot({
      shot: shot!,
      sawRepeatedStuck: true,
      shooter,
      target,
      usedMs: 2000,
      budgetMs: 12000,
      settings: buildSettings("Commando"),
    });
    expect(accepted).toBe(false);
  });

  it("extends move budget well beyond the old 9-second cap", () => {
    const budget = computeMovementBudgetMs({
      settings: buildSettings("Commando"),
      timeLeftMs: 28000,
    });

    expect(budget).toBeGreaterThan(9000);
    expect(budget).toBe(22000);
  });

  it("includes a retreat step before crater panic when movement exits early", () => {
    const session = new GameSession(1400, 900, { random: createRng(18), now: () => 0 });
    session.wind = 0;
    session.terrain.applyHeightMap(session.terrain.heightMap.map(() => 760));

    const shooter = session.activeTeam.worms[0]!;
    const targetTeam = session.teams.find((team) => team.id !== session.activeTeam.id)!;
    const target = targetTeam.worms[0]!;

    for (const team of session.teams) {
      for (const worm of team.worms) {
        worm.alive = false;
      }
    }
    shooter.alive = true;
    target.alive = true;

    shooter.x = 240;
    shooter.y = session.height - 12;
    shooter.facing = 1;
    target.x = 5000;
    target.y = 700;

    const updateSpy = vi
      .spyOn(Worm.prototype, "update")
      .mockImplementation(function (this: Worm) {
        this.x = 240;
        this.y += 0.03;
      });

    try {
      const movement = planMovement({
        session,
        shooter,
        target,
        cinematic: false,
        settings: buildSettings(),
        timeLeftMs: 4200,
      });

      expect(movement.craterStuck).toBe(true);
      expect(movement.steps.length).toBeGreaterThan(3);
      expect(movement.steps[movement.steps.length - 1]!.move).toBe(-1);
    } finally {
      updateSpy.mockRestore();
    }
  });

  it("treats repeated low forward progress as stuck and exits movement early", () => {
    const session = new GameSession(1400, 900, { random: createRng(28), now: () => 0 });
    session.wind = 0;
    session.terrain.applyHeightMap(session.terrain.heightMap.map(() => 760));

    const shooter = session.activeTeam.worms[0]!;
    const targetTeam = session.teams.find((team) => team.id !== session.activeTeam.id)!;
    const target = targetTeam.worms[0]!;

    for (const team of session.teams) {
      for (const worm of team.worms) {
        worm.alive = false;
      }
    }
    shooter.alive = true;
    target.alive = true;

    shooter.x = 240;
    shooter.y = 700;
    shooter.facing = 1;
    target.x = 5000;
    target.y = 700;

    const updateSpy = vi
      .spyOn(Worm.prototype, "update")
      .mockImplementation(function (this: Worm, _dt, _terrain, move) {
        this.x += move * 0.1;
        this.y += 0.02;
      });

    try {
      const movement = planMovement({
        session,
        shooter,
        target,
        cinematic: false,
        settings: buildSettings(),
        timeLeftMs: 18000,
      });

      expect(movement.craterStuck).toBe(true);
      expect(movement.steps.length).toBeLessThanOrEqual(4);
      expect(movement.steps[movement.steps.length - 1]!.move).toBe(-1);
    } finally {
      updateSpy.mockRestore();
    }
  });

  it("penalizes explosive shots that land too close to the shooter", () => {
    const session = new GameSession(1400, 900, { random: createRng(13), now: () => 0 });
    session.wind = 0;
    const heightMap = session.terrain.heightMap.map(() => 820);
    for (let x = 320; x <= 360; x++) {
      heightMap[x] = 730;
    }
    session.terrain.applyHeightMap(heightMap);

    const shooter = session.activeTeam.worms[0]!;
    const targetTeam = session.teams.find((team) => team.id !== session.activeTeam.id)!;
    const target = targetTeam.worms[0]!;

    for (const team of session.teams) {
      for (const worm of team.worms) {
        worm.alive = false;
      }
    }
    shooter.alive = true;
    target.alive = true;

    shooter.x = 260;
    shooter.y = 780;
    shooter.facing = 1;
    target.x = 1100;
    target.y = 700;

    const closeAim = buildAimFromAngle(shooter, -0.03);
    const close = scoreCandidate({
      session,
      shooter,
      target,
      weapon: WeaponType.Bazooka,
      aim: closeAim,
      angle: -0.03,
      power: 0.55,
      cinematic: false,
      personality: "Generalist",
      baseAngle: -0.03,
      angleOffset: 0,
    });

    const safeAim = buildAimFromAngle(shooter, -0.9);
    const safe = scoreCandidate({
      session,
      shooter,
      target,
      weapon: WeaponType.Bazooka,
      aim: safeAim,
      angle: -0.9,
      power: 0.95,
      cinematic: false,
      personality: "Generalist",
      baseAngle: -0.9,
      angleOffset: 0,
    });

    expect(close.debug.distToSelf).toBeLessThan(safe.debug.distToSelf);
    expect(close.debug.selfBufferPenalty).toBeGreaterThan(0);
    expect(safe.debug.selfBufferPenalty).toBe(0);
    expect(close.score).toBeLessThan(safe.score);
  });
});
