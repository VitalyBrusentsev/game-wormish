import { WeaponType } from "../definitions";

export const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

export const normalizeLevel = (v: number) => clamp01(Number.isFinite(v) ? v : 0);

export const weaponSeedId = (weapon: WeaponType) => {
  switch (weapon) {
    case WeaponType.Bazooka:
      return 1;
    case WeaponType.HandGrenade:
      return 2;
    case WeaponType.Rifle:
      return 3;
    case WeaponType.Uzi:
      return 4;
  }
};

const xorshift32 = (x: number) => {
  let v = x | 0;
  v ^= v << 13;
  v ^= v >>> 17;
  v ^= v << 5;
  return v | 0;
};

export const hash01 = (seed: number) => {
  const v = xorshift32(seed);
  return ((v >>> 0) % 1_000_000) / 1_000_000;
};

export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

export const createNoiseBuffer = (ctx: AudioContext, durationSec: number) => {
  const length = Math.max(1, Math.floor(ctx.sampleRate * durationSec));
  const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < data.length; i++) {
    data[i] = Math.random() * 2 - 1;
  }
  return buffer;
};

export const applyLinearEnv = (
  param: AudioParam,
  t0: number,
  points: Array<[dt: number, value: number]>
) => {
  if (points.length === 0) return;
  param.cancelScheduledValues(t0);
  param.setValueAtTime(points[0]![1], t0);
  let t = t0;
  for (let i = 1; i < points.length; i++) {
    t += Math.max(0, points[i]![0]);
    param.linearRampToValueAtTime(points[i]![1], t);
  }
};

export const createSoftClipper = (ctx: AudioContext, drive: number) => {
  const shaper = ctx.createWaveShaper();
  const amount = Math.max(0, drive);
  const n = 1024;
  const curve = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    curve[i] = Math.tanh(x * (1 + amount * 6));
  }
  shaper.curve = curve;
  shaper.oversample = "2x";
  return shaper;
};

