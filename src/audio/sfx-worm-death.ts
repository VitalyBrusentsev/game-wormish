import { WeaponType } from "../definitions";
import { applyLinearEnv, createSoftClipper, hash01, weaponSeedId } from "./audio-utils";
import type { VoiceBlueprint } from "./sfx-types";

type WormDeathVoiceConfig = {
  ctx: AudioContext;
  noise: AudioBuffer;
  worldX: number;
  turnIndex: number;
  wormIndex: number;
  cause: WeaponType;
};

type VoiceBuildLists = {
  nodeList: AudioNode[];
  sourceList: AudioScheduledSourceNode[];
};

export const createWormDeathVoice = (config: WormDeathVoiceConfig): VoiceBlueprint => {
  const seed = (config.turnIndex * 1_000_003 + config.wormIndex * 313 + weaponSeedId(config.cause) * 751) | 0;
  const r0 = hash01(seed);
  const r1 = hash01(seed + 1);
  const r2 = hash01(seed + 2);

  const t0 = config.ctx.currentTime + 0.004;
  const duration = 0.42;

  return {
    tag: "worm-death",
    polyLimit: 6,
    worldX: config.worldX,
    baseGain: 0.34,
    stopAt: t0 + duration + 0.08,
    build: (input, nodeList, sourceList) =>
      buildWormDeathVoice(
        { ctx: config.ctx, noise: config.noise, t0, r0, r1, r2 },
        input,
        { nodeList, sourceList }
      ),
  };
};

const buildWormDeathVoice = (
  config: { ctx: AudioContext; noise: AudioBuffer; t0: number; r0: number; r1: number; r2: number },
  input: GainNode,
  lists: VoiceBuildLists
) => {
  const { ctx, noise, t0, r0, r1, r2 } = config;
  const { nodeList, sourceList } = lists;

  const clip = createSoftClipper(ctx, 0.22);
  clip.connect(input);

  const breath = ctx.createBufferSource();
  breath.buffer = noise;
  const breathHp = ctx.createBiquadFilter();
  breathHp.type = "highpass";
  breathHp.frequency.setValueAtTime(1400 + r0 * 300, t0);
  const breathBp = ctx.createBiquadFilter();
  breathBp.type = "bandpass";
  breathBp.frequency.setValueAtTime(2200 + r1 * 420, t0);
  breathBp.Q.setValueAtTime(1.1, t0);
  const breathGain = ctx.createGain();
  applyLinearEnv(breathGain.gain, t0, [
    [0, 0],
    [0.003, 0.22],
    [0.026, 0.06],
    [0.03, 0],
  ]);
  breath.connect(breathHp);
  breathHp.connect(breathBp);
  breathBp.connect(breathGain);
  breathGain.connect(clip);

  const uhStart = t0 + 0.008;
  const uhCore = ctx.createOscillator();
  uhCore.type = "triangle";
  uhCore.frequency.setValueAtTime(560 + r2 * 80, uhStart);
  uhCore.frequency.exponentialRampToValueAtTime(390 + r0 * 40, uhStart + 0.09);
  const uhAmp = ctx.createGain();
  applyLinearEnv(uhAmp.gain, uhStart, [
    [0, 0],
    [0.01, 0.45],
    [0.07, 0.16],
    [0.05, 0],
  ]);
  uhCore.connect(uhAmp);

  const uhF1 = ctx.createBiquadFilter();
  uhF1.type = "bandpass";
  uhF1.frequency.setValueAtTime(760 + r0 * 110, uhStart);
  uhF1.Q.setValueAtTime(3.2, uhStart);
  const uhF1Gain = ctx.createGain();
  uhF1Gain.gain.setValueAtTime(0.62, uhStart);

  const uhF2 = ctx.createBiquadFilter();
  uhF2.type = "bandpass";
  uhF2.frequency.setValueAtTime(1240 + r1 * 140, uhStart);
  uhF2.Q.setValueAtTime(4.3, uhStart);
  const uhF2Gain = ctx.createGain();
  uhF2Gain.gain.setValueAtTime(0.34, uhStart);

  uhAmp.connect(uhF1);
  uhAmp.connect(uhF2);
  uhF1.connect(uhF1Gain);
  uhF2.connect(uhF2Gain);
  uhF1Gain.connect(clip);
  uhF2Gain.connect(clip);

  const ohStart = t0 + 0.135;
  const ohCore = ctx.createOscillator();
  ohCore.type = "triangle";
  ohCore.frequency.setValueAtTime(430 + r2 * 70, ohStart);
  ohCore.frequency.linearRampToValueAtTime(390 + r1 * 55, ohStart + 0.03);
  ohCore.frequency.exponentialRampToValueAtTime(235 + r0 * 35, ohStart + 0.24);
  const ohAmp = ctx.createGain();
  applyLinearEnv(ohAmp.gain, ohStart, [
    [0, 0],
    [0.012, 0.52],
    [0.1, 0.24],
    [0.17, 0],
  ]);
  ohCore.connect(ohAmp);

  const ohF1 = ctx.createBiquadFilter();
  ohF1.type = "bandpass";
  ohF1.frequency.setValueAtTime(430 + r1 * 70, ohStart);
  ohF1.Q.setValueAtTime(3.8, ohStart);
  const ohF1Gain = ctx.createGain();
  ohF1Gain.gain.setValueAtTime(0.7, ohStart);

  const ohF2 = ctx.createBiquadFilter();
  ohF2.type = "bandpass";
  ohF2.frequency.setValueAtTime(740 + r2 * 110, ohStart);
  ohF2.Q.setValueAtTime(5.2, ohStart);
  const ohF2Gain = ctx.createGain();
  ohF2Gain.gain.setValueAtTime(0.46, ohStart);

  ohAmp.connect(ohF1);
  ohAmp.connect(ohF2);
  ohF1.connect(ohF1Gain);
  ohF2.connect(ohF2Gain);
  ohF1Gain.connect(clip);
  ohF2Gain.connect(clip);

  breath.start(t0);
  breath.stop(t0 + 0.08);
  uhCore.start(uhStart);
  uhCore.stop(uhStart + 0.16);
  ohCore.start(ohStart);
  ohCore.stop(ohStart + 0.28);

  nodeList.push(
    clip,
    breathHp,
    breathBp,
    breathGain,
    uhAmp,
    uhF1,
    uhF1Gain,
    uhF2,
    uhF2Gain,
    ohAmp,
    ohF1,
    ohF1Gain,
    ohF2,
    ohF2Gain
  );
  sourceList.push(breath, uhCore, ohCore);
};
