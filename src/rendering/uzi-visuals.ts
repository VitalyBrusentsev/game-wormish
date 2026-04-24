import { GAMEPLAY, clamp } from "../definitions";
import type { UziBurstSnapshot } from "../game/session";

const uziHash01 = (v: number) => {
  const x = Math.sin(v) * 10000;
  return x - Math.floor(x);
};

const uziHashSigned = (v: number) => uziHash01(v) * 2 - 1;

export const computeUziVisuals = (params: {
  burst: UziBurstSnapshot;
  turnAtMs: number;
  baseAimAngle: number;
}): { angle: number; recoilKick01: number } => {
  const intervalMs = 1000 / Math.max(1, GAMEPLAY.uzi.shotsPerSecond);
  const elapsedMs = Math.max(0, params.turnAtMs - params.burst.startAtMs);
  const shotIndexFloat = intervalMs > 0 ? elapsedMs / intervalMs : 0;
  const lastShotIndex = Math.max(0, params.burst.shotCount - 1);
  const shotIndex = clamp(Math.floor(shotIndexFloat), 0, lastShotIndex);
  const shotPhase01 = clamp(shotIndexFloat - shotIndex, 0, 1);
  const progress01 = lastShotIndex > 0 ? shotIndex / lastShotIndex : 1;

  const ampRad = 0.045 + 0.095 * progress01;
  const seedBase = params.burst.seedBase;
  const stepNoise =
    uziHashSigned(seedBase + shotIndex * 17.13) * 0.85 +
    uziHashSigned(seedBase + shotIndex * 71.77) * 0.55;
  const microNoise =
    Math.sin((elapsedMs + seedBase * 3.1) * 0.06) * 0.65 +
    Math.sin((elapsedMs + seedBase * 1.7) * 0.13) * 0.35;
  const shakeRad = clamp((stepNoise + microNoise * 0.35) * ampRad, -0.22, 0.22);

  const recoilKick01 = Math.exp(-shotPhase01 * 7.5);
  return { angle: params.baseAimAngle + shakeRad, recoilKick01 };
};
