import { describe, expect, it } from "vitest";
import { GameCamera } from "../game/game-camera";

describe("GameCamera", () => {
  it("computes viewport size and bounds from zoom", () => {
    const camera = new GameCamera({
      viewportWidth: 800,
      viewportHeight: 600,
      worldWidth: 2000,
      worldHeight: 700,
    });

    expect(camera.getWorldViewportSize()).toEqual({ width: 800, height: 600 });
    expect(camera.getBounds()).toEqual({ minX: 0, maxX: 1200, minY: 0, maxY: 100 });

    camera.setZoom(0.5);

    expect(camera.getWorldViewportSize()).toEqual({ width: 1600, height: 1200 });
    expect(camera.getBounds()).toEqual({ minX: 0, maxX: 400, minY: -500, maxY: 0 });
  });

  it("centers on points while clamping to the world", () => {
    const camera = new GameCamera({
      viewportWidth: 800,
      viewportHeight: 600,
      worldWidth: 2000,
      worldHeight: 900,
    });

    camera.centerOn({ x: 1000, y: 450 });
    expect(camera.x).toBe(600);
    expect(camera.y).toBe(150);

    camera.centerOn({ x: 50, y: 50 });
    expect(camera.x).toBe(0);
    expect(camera.y).toBe(0);

    camera.centerOn({ x: 1950, y: 850 });
    expect(camera.x).toBe(1200);
    expect(camera.y).toBe(300);
  });

  it("keeps world and screen coordinates round-trippable through zoom and shake offset", () => {
    const camera = new GameCamera({
      viewportWidth: 800,
      viewportHeight: 600,
      worldWidth: 2000,
      worldHeight: 900,
    });
    camera.centerOn({ x: 1000, y: 450 });
    camera.setZoom(1.25);
    camera.offsetX = 12;
    camera.offsetY = -7;

    const screen = camera.worldToScreen(900, 400);
    const world = camera.screenToWorld(screen.x, screen.y);

    expect(world.x).toBeCloseTo(900);
    expect(world.y).toBeCloseTo(400);
  });

  it("resizes around a supplied horizontal center and y focus", () => {
    const camera = new GameCamera({
      viewportWidth: 800,
      viewportHeight: 600,
      worldWidth: 2000,
      worldHeight: 900,
    });
    camera.centerOn({ x: 900, y: 300 });
    camera.setZoom(1.25);

    camera.resizeKeepingCenter(1000, 500, 700, 900);

    expect(camera.getWorldViewportSize()).toEqual({ width: 800, height: 400 });
    expect(camera.x).toBe(500);
    expect(camera.y).toBe(500);
    expect(camera.targetX).toBe(camera.x);
    expect(camera.targetY).toBe(camera.y);
  });

  it("focuses target only when a point leaves the camera margin", () => {
    const camera = new GameCamera({
      viewportWidth: 800,
      viewportHeight: 600,
      worldWidth: 2000,
      worldHeight: 900,
    });
    camera.centerOn({ x: 600, y: 300 });

    camera.focusOnPoint({ x: 500, y: 300 });
    expect(camera.targetX).toBe(camera.x);
    expect(camera.targetY).toBe(camera.y);

    camera.focusOnPoint({ x: 1190, y: 580 });
    expect(camera.targetX).toBeGreaterThan(camera.x);
    expect(camera.targetY).toBeGreaterThan(camera.y);
  });

  it("decays and resets camera shake deterministically", () => {
    const camera = new GameCamera({
      viewportWidth: 800,
      viewportHeight: 600,
      worldWidth: 2000,
      worldHeight: 900,
      random: () => 0,
    });

    camera.triggerShake(100, 1);
    camera.updateShake(0.5);
    expect(camera.offsetX).toBeCloseTo(10.8);
    expect(camera.offsetY).toBeCloseTo(0);

    camera.updateShake(0.5);
    expect(camera.offsetX).toBeCloseTo(0);
    expect(camera.offsetY).toBeCloseTo(0);

    camera.updateShake(0.1);
    expect(camera.offsetX).toBe(0);
    expect(camera.offsetY).toBe(0);
  });

  it("moves the target with edge scrolling and smooths toward it", () => {
    const camera = new GameCamera({
      viewportWidth: 800,
      viewportHeight: 600,
      worldWidth: 2000,
      worldHeight: 900,
    });
    camera.centerOn({ x: 1000, y: 450 });

    camera.update(0.1, { enabled: true, mouseInside: true, mouseX: 790 });

    expect(camera.targetX).toBeGreaterThan(600);
    expect(camera.x).toBeGreaterThan(600);
  });
});
