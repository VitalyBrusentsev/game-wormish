import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { GAMEPLAY, WeaponType } from "../definitions";
import type { AiTurnPlan } from "../ai/game-ai";
import { executeAiTurnPlan } from "../ai/game-ai";
import { GameSession } from "../game/session";
import type { TurnContext, TurnDriver, TurnDriverUpdateOptions } from "../game/turn-driver";

class StubTurnDriver implements TurnDriver {
  constructor(readonly type: "local" | "ai") {}

  beginTurn(_context: TurnContext): void {}

  update(_context: TurnContext, _dt: number, _options: TurnDriverUpdateOptions): void {}
}

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

  it("captures carved terrain changes in snapshots", () => {
    const rng = createRng(7);
    const session = new GameSession(320, 240, { random: rng, now: createNow(0, 1000) });

    const beforeHeightMap = [...session.terrain.heightMap];
    session.terrain.carveCircle(160, 120, 25);

    expect(session.terrain.heightMap).not.toEqual(beforeHeightMap);

    const damagedSnapshot = session.toSnapshot();

    expect(damagedSnapshot.terrain.heightMap).toEqual(session.terrain.heightMap);

    const restored = new GameSession(320, 240, { random: createRng(13), now: createNow(0, 1000) });
    restored.loadSnapshot(damagedSnapshot);

    expect(restored.toSnapshot()).toEqual(damagedSnapshot);
  });
});

describe("GameSession team setup", () => {
  it("applies and preserves configured team order across restarts", () => {
    const session = new GameSession(320, 240, {
      random: createRng(17),
      now: createNow(0, 1000),
      teamOrder: ["Blue", "Red"],
    });

    expect(session.teams.map((team) => team.id)).toEqual(["Blue", "Red"]);

    session.restart();
    expect(session.teams.map((team) => team.id)).toEqual(["Blue", "Red"]);

    session.restart({ teamOrder: ["Red", "Blue"] });
    expect(session.teams.map((team) => team.id)).toEqual(["Red", "Blue"]);
  });

  it("restores each local worm's selected weapon when its turn returns", () => {
    const session = new GameSession(320, 240, { random: createRng(23), now: createNow(0, 1000) });

    expect(session.state.weapon).toBe(WeaponType.Bazooka);

    session.setWeaponCommand(WeaponType.HandGrenade);
    session.nextTurn();
    expect(session.state.weapon).toBe(WeaponType.Bazooka);

    session.debugSelectWorm("Blue", GAMEPLAY.teamSize - 1);
    session.nextTurn();
    expect(session.state.weapon).toBe(WeaponType.HandGrenade);
  });

  it("keeps AI turns starting on bazooka while local worms retain their own weapon", () => {
    const session = new GameSession(320, 240, { random: createRng(24), now: createNow(0, 1000) });

    session.setTurnControllers(
      new Map([
        ["Red", new StubTurnDriver("local")],
        ["Blue", new StubTurnDriver("ai")],
      ])
    );

    session.setWeaponCommand(WeaponType.Rifle);
    session.nextTurn();
    expect(session.activeTeam.id).toBe("Blue");
    expect(session.state.weapon).toBe(WeaponType.Bazooka);

    session.debugSelectWorm("Blue", GAMEPLAY.teamSize - 1);
    session.nextTurn();
    expect(session.activeTeam.id).toBe("Red");
    expect(session.state.weapon).toBe(WeaponType.Rifle);
  });
});

describe("GameSession turn logging", () => {
  it("builds a network-ready turn resolution from the command log", () => {
    const now = createNow(1000, 250);
    const session = new GameSession(200, 150, { random: createRng(5), now });
    const sessionAny = session as any;

    const worm = session.activeWorm;
    const aim = { angle: 0.2, targetX: worm.x + 30, targetY: worm.y - 10 };

    sessionAny.recordCommand({
      type: "set-weapon",
      weapon: WeaponType.HandGrenade,
      atMs: 50,
    });
    sessionAny.recordCommand({ type: "aim", aim, atMs: 100 });
    sessionAny.recordCommand({ type: "move", move: 1, jump: false, dtMs: 120, atMs: 150 });

    const previousLog = sessionAny.turnLog;
    expect(previousLog.commands).toHaveLength(3);

    session.nextTurn();

    const resolution = session.finalizeTurn();

    expect(resolution.startedAtMs).toBe(previousLog.startedAtMs);
    expect(resolution.windAtStart).toBe(previousLog.windAtStart);
    expect(resolution.commandCount).toBe(previousLog.commands.length);
    expect(resolution.projectileEventCount).toBe(previousLog.projectileEvents.length);

    expect((sessionAny.turnLog as { commands: unknown[] }).commands).toHaveLength(0);
  });

  it("captures projectile ids and spawn events when firing weapons", () => {
    const now = createNow(0, 100);
    const session = new GameSession(320, 240, { random: createRng(21), now });
    const sessionAny = session as any;
    const worm = session.activeWorm;
    const aim = { angle: 0, targetX: worm.x + 80, targetY: worm.y };

    sessionAny.recordCommand({
      type: "fire-charged-weapon",
      weapon: WeaponType.Bazooka,
      power: 0.5,
      aim,
      atMs: 200,
      projectileIds: [],
    });

    const log = sessionAny.turnLog as {
      commands: Array<{ projectileIds: number[] }>;
      projectileEvents: Array<{ type: string; id: number }>;
    };
    expect(log.commands).toHaveLength(1);

    expect(log.commands[0]).toBeDefined();
    const fireCommand = log.commands[0]!;
    expect(fireCommand.projectileIds.length).toBeGreaterThan(0);
    const spawnEvents = log.projectileEvents.filter((event) => event.type === "projectile-spawned");
    expect(spawnEvents).toHaveLength(fireCommand.projectileIds.length);
    expect(spawnEvents.map((event) => event.id)).toEqual(fireCommand.projectileIds);

    session.nextTurn();
    const resolution = session.finalizeTurn();

    expect(resolution.commandCount).toBe(log.commands.length);
    expect(resolution.projectileEventCount).toBe(log.projectileEvents.length);
  });

  it("spawns Uzi burst shots from the shooter's updated position", () => {
    let now = 1000;
    const session = new GameSession(320, 240, { random: createRng(29), now: () => now });
    const sessionAny = session as any;
    const worm = session.activeWorm;
    const aim = { angle: 0, targetX: worm.x + 120, targetY: worm.y };

    sessionAny.recordCommand({
      type: "fire-charged-weapon",
      weapon: WeaponType.Uzi,
      power: 1,
      aim,
      atMs: 0,
      projectileIds: [],
    });

    const log = sessionAny.turnLog as {
      projectileEvents: Array<{
        type: string;
        position: { x: number; y: number };
      }>;
    };
    const spawnEvents = () =>
      log.projectileEvents.filter(
        (event): event is { type: "projectile-spawned"; position: { x: number; y: number } } =>
          event.type === "projectile-spawned"
      );
    expect(spawnEvents().length).toBeGreaterThan(0);

    worm.x += 50;
    worm.y -= 30;

    now += 1000 / GAMEPLAY.uzi.shotsPerSecond + 1;
    session.update(0);

    const spawned = spawnEvents();
    expect(spawned.length).toBeGreaterThan(1);
    const first = spawned[0]!.position;
    const second = spawned[1]!.position;
    expect(second.x - first.x).toBeGreaterThan(40);
    expect(second.y - first.y).toBeLessThan(-20);
  });
});

describe("GameSession mobile command facade", () => {
  it("fires rifle instantly without requiring charge", () => {
    const session = new GameSession(360, 260, { random: createRng(12), now: createNow(0, 40) });
    const shooter = session.activeWorm;
    session.terrain.applyHeightMap(session.terrain.heightMap.map(() => 190));
    shooter.x = 120;
    shooter.y = 170;

    const setWeaponOk = session.setWeaponCommand(WeaponType.Rifle);
    expect(setWeaponOk).toBe(true);
    const aimed = session.setAimTargetCommand(shooter.x + 80, shooter.y - 10);
    expect(aimed).toBe(true);

    const fired = session.fireCurrentWeaponCommand({ instantPower01: 1 });
    expect(fired).toBe(true);
    expect(session.state.phase).toBe("projectile");
    expect(session.projectiles.length).toBeGreaterThan(0);
  });

  it("requires charge for bazooka fire and then fires once charged", () => {
    const session = new GameSession(360, 260, { random: createRng(14), now: createNow(0, 35) });
    const shooter = session.activeWorm;
    session.terrain.applyHeightMap(session.terrain.heightMap.map(() => 190));
    shooter.x = 140;
    shooter.y = 170;

    expect(session.setWeaponCommand(WeaponType.Bazooka)).toBe(true);
    expect(session.fireCurrentWeaponCommand()).toBe(false);
    expect(session.startChargeCommand()).toBe(true);
    expect(session.state.charging).toBe(true);
    expect(session.fireCurrentWeaponCommand()).toBe(true);
    expect(session.state.phase).toBe("projectile");
    expect(session.state.charging).toBe(false);
  });

  it("records fixed movement steps while in aim phase", () => {
    const session = new GameSession(480, 280, { random: createRng(16), now: createNow(0, 30) });
    session.terrain.applyHeightMap(session.terrain.heightMap.map(() => 205));
    const worm = session.activeWorm;
    worm.x = 180;
    worm.y = 185;
    worm.onGround = true;
    worm.vx = 0;
    worm.vy = 0;

    const beforeX = worm.x;
    const moved = session.recordMovementStepCommand(1, 140, false);
    expect(moved).toBe(true);
    expect(worm.x).toBeGreaterThan(beforeX);
  });

  it("can apply AI movement smoothing for assisted fixed movement steps", () => {
    const session = new GameSession(480, 280, { random: createRng(18), now: createNow(0, 30) });
    session.terrain.applyHeightMap(session.terrain.heightMap.map(() => 205));
    const worm = session.activeWorm;
    worm.x = 180;
    worm.y = 185;
    worm.onGround = true;
    worm.vx = 0;
    worm.vy = 0;

    const smoothingSpy = vi.spyOn(worm, "queueMovementSmoothing");
    const moved = session.recordMovementStepCommand(1, 140, false, { movementSmoothingMode: "ai" });

    expect(moved).toBe(true);
    expect(smoothingSpy).toHaveBeenCalledTimes(1);
    expect(smoothingSpy).toHaveBeenCalledWith("ai", expect.any(Object), 140);
  });
});

describe("GameSession AI pre-shot visuals", () => {
  const normalizeAngle = (angle: number): number => {
    let normalized = (angle + Math.PI) % (Math.PI * 2);
    if (normalized < 0) normalized += Math.PI * 2;
    return normalized - Math.PI;
  };

  it("applies overshoot and undershoot before settling on target aim", () => {
    let now = 1000;
    const session = new GameSession(320, 240, {
      random: createRng(77),
      now: () => now,
    });

    const targetAngle = -0.85;
    session.beginAiPreShotVisual({
      weapon: WeaponType.Bazooka,
      targetAngle,
      power01: 0.8,
      durationMs: 1000,
    });

    const startAngle = session.getRenderAimInfo().angle;
    const direction = normalizeAngle(targetAngle - startAngle) >= 0 ? 1 : -1;

    now = 1400;
    const overshootAngle = session.getRenderAimInfo().angle;
    now = 1720;
    const undershootAngle = session.getRenderAimInfo().angle;
    now = 2000;
    const settledAngle = session.getRenderAimInfo().angle;

    expect(Math.sign(normalizeAngle(overshootAngle - targetAngle))).toBe(direction);
    expect(Math.sign(normalizeAngle(undershootAngle - targetAngle))).toBe(-direction);
    expect(normalizeAngle(settledAngle - targetAngle)).toBeCloseTo(0, 4);
  });

  it("renders grenade trajectory preview during AI pre-shot visuals", () => {
    let now = 1000;
    const session = new GameSession(320, 240, {
      random: createRng(33),
      now: () => now,
    });

    session.debugSetWeapon(WeaponType.HandGrenade);
    session.beginAiPreShotVisual({
      weapon: WeaponType.HandGrenade,
      targetAngle: -0.7,
      power01: 0.75,
      durationMs: 800,
    });

    const previewPath = session.predictPath();
    expect(previewPath.length).toBeGreaterThan(0);

    session.clearAiPreShotVisual();
    const noPreviewPath = session.predictPath();
    expect(noPreviewPath).toHaveLength(0);
  });

  it("renders bazooka trajectory preview during AI pre-shot visuals", () => {
    let now = 1000;
    const session = new GameSession(320, 240, {
      random: createRng(34),
      now: () => now,
    });

    session.debugSetWeapon(WeaponType.Bazooka);
    session.beginAiPreShotVisual({
      weapon: WeaponType.Bazooka,
      targetAngle: -0.55,
      power01: 0.65,
      durationMs: 900,
    });

    const previewPath = session.predictPath();
    expect(previewPath.length).toBeGreaterThan(0);

    session.clearAiPreShotVisual();
    const noPreviewPath = session.predictPath();
    expect(noPreviewPath).toHaveLength(0);
  });

  it("pauses AI fire scheduling while simulation is paused", async () => {
    vi.useFakeTimers();
    try {
      let now = 1000;
      const session = new GameSession(320, 240, {
        random: createRng(88),
        now: () => now,
      });
      const targetTeam = session.teams.find((team) => team.id !== session.activeTeam.id);
      expect(targetTeam).toBeDefined();
      const target = targetTeam!.worms[0]!;
      const plan: AiTurnPlan = {
        weapon: WeaponType.Rifle,
        angle: 0,
        power: 1,
        delayMs: 220,
        target,
        score: 1,
        cinematic: false,
        personality: "Generalist",
      };

      session.setSimulationPaused(true);
      executeAiTurnPlan(session, plan);

      now += 1200;
      await vi.advanceTimersByTimeAsync(1200);
      expect(session.state.phase).toBe("aim");

      session.setSimulationPaused(false);

      now += 160;
      await vi.advanceTimersByTimeAsync(160);
      expect(session.state.phase).toBe("aim");

      now += 160;
      await vi.advanceTimersByTimeAsync(160);
      expect(session.state.phase).toBe("projectile");
    } finally {
      vi.useRealTimers();
    }
  });

  it("expires the local aim phase while input is blocked if simulation keeps running", () => {
    let now = 1000;
    const session = new GameSession(320, 240, {
      random: createRng(91),
      now: () => now,
    });
    const controllers = new Map(
      session.teams.map((team) => [
        team.id,
        new StubTurnDriver(team.id === session.activeTeam.id ? "local" : "ai"),
      ] as const)
    );
    session.setTurnControllers(controllers);

    now = session.state.turnStartMs + GAMEPLAY.turnTimeMs + 1;
    session.updateActiveTurnDriver(1 / 60, {
      allowInput: false,
      input: {} as TurnDriverUpdateOptions["input"],
      camera: { offsetX: 0, offsetY: 0, zoom: 1 },
    });

    expect(session.state.phase).toBe("post");
  });

  it("does not expire the local aim phase while simulation is paused", () => {
    let now = 1000;
    const session = new GameSession(320, 240, {
      random: createRng(92),
      now: () => now,
    });
    const controllers = new Map(
      session.teams.map((team) => [
        team.id,
        new StubTurnDriver(team.id === session.activeTeam.id ? "local" : "ai"),
      ] as const)
    );
    session.setTurnControllers(controllers);
    session.setSimulationPaused(true);

    now = session.state.turnStartMs + GAMEPLAY.turnTimeMs + 1;
    session.updateActiveTurnDriver(1 / 60, {
      allowInput: false,
      input: {} as TurnDriverUpdateOptions["input"],
      camera: { offsetX: 0, offsetY: 0, zoom: 1 },
    });

    expect(session.state.phase).toBe("aim");
  });

  it("ends the turn when the active worm drowns during aim phase", async () => {
    vi.useFakeTimers();
    try {
      let now = 1000;
      const session = new GameSession(320, 240, {
        random: createRng(93),
        now: () => now,
      });
      const startingTeamId = session.activeTeam.id;
      const nextTeamId = session.teams.find((team) => team.id !== startingTeamId)?.id;
      expect(nextTeamId).toBeDefined();

      const drowningWorm = session.activeWorm;
      drowningWorm.y = session.height + 20;

      session.update(1 / 60);

      expect(drowningWorm.alive).toBe(false);
      expect(session.state.phase).toBe("post");
      expect(session.activeTeam.id).toBe(startingTeamId);

      now += 400;
      await vi.advanceTimersByTimeAsync(400);

      expect(session.activeTeam.id).toBe(nextTeamId);
      expect(session.state.phase).toBe("aim");
    } finally {
      vi.useRealTimers();
    }
  });
});
