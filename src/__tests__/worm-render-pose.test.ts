import { describe, expect, it } from "vitest";
import { WeaponType } from "../definitions";
import type { UziBurstSnapshot } from "../game/session";
import { resolveWormRenderAimPose } from "../critter/worm-render-pose";

const aim = {
  targetX: 150,
  targetY: 95,
  angle: 0.35,
};

const uziBurst = (partial: Partial<UziBurstSnapshot> = {}): UziBurstSnapshot => ({
  facing: 1,
  aimAngle: 0.2,
  seedBase: 123.45,
  startAtMs: 100,
  nextShotIndex: 2,
  shotCount: 5,
  ...partial,
});

describe("resolveWormRenderAimPose", () => {
  it("does not pose inactive worms or gameover worms for aiming", () => {
    expect(
      resolveWormRenderAimPose({
        isActive: false,
        phase: "aim",
        weapon: WeaponType.Rifle,
        aim,
        nowMs: 1000,
        turnStartMs: 900,
        uziBurst: null,
      })
    ).toBeNull();

    expect(
      resolveWormRenderAimPose({
        isActive: true,
        phase: "gameover",
        weapon: WeaponType.Rifle,
        aim,
        nowMs: 1000,
        turnStartMs: 900,
        uziBurst: null,
      })
    ).toBeNull();
  });

  it("keeps non-grenade weapons posed through projectile and post phases", () => {
    expect(
      resolveWormRenderAimPose({
        isActive: true,
        phase: "projectile",
        weapon: WeaponType.Rifle,
        aim,
        nowMs: 1000,
        turnStartMs: 900,
        uziBurst: null,
      })
    ).toEqual({ weapon: WeaponType.Rifle, angle: aim.angle });

    expect(
      resolveWormRenderAimPose({
        isActive: true,
        phase: "projectile",
        weapon: WeaponType.HandGrenade,
        aim,
        nowMs: 1000,
        turnStartMs: 900,
        uziBurst: null,
      })
    ).toBeNull();
  });

  it("derives Uzi shake and recoil from the burst snapshot", () => {
    const pose = resolveWormRenderAimPose({
      isActive: true,
      phase: "projectile",
      weapon: WeaponType.Uzi,
      aim,
      nowMs: 260,
      turnStartMs: 100,
      uziBurst: uziBurst(),
    });

    expect(pose?.weapon).toBe(WeaponType.Uzi);
    expect(pose?.angle).not.toBe(aim.angle);
    expect(pose?.recoil?.kick01).toBeGreaterThan(0);
    expect(pose?.recoil?.kick01).toBeLessThanOrEqual(1);
  });
});
