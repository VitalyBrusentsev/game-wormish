import { WeaponType } from "../definitions";
import type { UziBurstSnapshot } from "../game/session";
import type { AimInfo } from "../rendering/game-rendering";
import { computeUziVisuals } from "../weapons/uzi-visuals";

export type WormRenderAimPose = {
  weapon: WeaponType;
  angle: number;
  recoil?: { kick01: number };
};

export type WormRenderPoseContext = {
  isActive: boolean;
  phase: "aim" | "projectile" | "post" | "gameover";
  weapon: WeaponType;
  aim: AimInfo;
  nowMs: number;
  turnStartMs: number;
  uziBurst: UziBurstSnapshot | null;
};

export function resolveWormRenderAimPose({
  isActive,
  phase,
  weapon,
  aim,
  nowMs,
  turnStartMs,
  uziBurst,
}: WormRenderPoseContext): WormRenderAimPose | null {
  if (!isActive) return null;
  if (phase === "gameover") return null;
  if (phase !== "aim" && !((phase === "projectile" || phase === "post") && weapon !== WeaponType.HandGrenade)) {
    return null;
  }

  if (phase === "projectile" && weapon === WeaponType.Uzi && uziBurst) {
    const turnAtMs = Math.max(0, nowMs - turnStartMs);
    const visuals = computeUziVisuals({
      burst: uziBurst,
      turnAtMs,
      baseAimAngle: uziBurst.aimAngle,
    });
    return {
      weapon,
      angle: visuals.angle,
      recoil: { kick01: visuals.recoilKick01 },
    };
  }

  return { weapon, angle: aim.angle };
}
