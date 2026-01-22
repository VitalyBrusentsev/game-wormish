import { WeaponType } from "../definitions";
import { applyLinearEnv, createSoftClipper, hash01, weaponSeedId } from "./audio-utils";
import type { VoiceBlueprint } from "./sfx-types";

type ProjectileLaunchVoiceConfig = {
  ctx: AudioContext;
  noise: AudioBuffer;
  weapon: WeaponType;
  worldX: number;
  velocity: { x: number; y: number };
  turnIndex: number;
  projectileId: number;
};

type VoiceBuildLists = {
  nodeList: AudioNode[];
  sourceList: AudioScheduledSourceNode[];
};

const buildUziLaunch = (
  config: Pick<ProjectileLaunchVoiceConfig, "ctx" | "noise"> & { t0: number },
  input: GainNode,
  lists: VoiceBuildLists
) => {
  const { ctx, noise, t0 } = config;
  const { nodeList, sourceList } = lists;
  const duration = 0.09;

  const clip = createSoftClipper(ctx, 0.55);

  const body = ctx.createOscillator();
  body.type = "triangle";
  const bodyGain = ctx.createGain();
  const baseHz = 260;
  body.frequency.setValueAtTime(baseHz, t0);
  applyLinearEnv(bodyGain.gain, t0, [
    [0, 0],
    [0.0012, 0.6],
    [0.028, 0.12],
    [0.03, 0],
  ]);
  body.connect(bodyGain);
  bodyGain.connect(clip);

  const crack = ctx.createBufferSource();
  crack.buffer = noise;
  const hp = ctx.createBiquadFilter();
  hp.type = "highpass";
  hp.frequency.setValueAtTime(800, t0);
  const bp = ctx.createBiquadFilter();
  bp.type = "bandpass";
  bp.frequency.setValueAtTime(2600, t0);
  bp.Q.setValueAtTime(1.25, t0);
  const crackGain = ctx.createGain();
  applyLinearEnv(crackGain.gain, t0, [
    [0, 0],
    [0.0007, 0.7],
    [0.012, 0.22],
    [0.03, 0],
  ]);
  crack.connect(hp);
  hp.connect(bp);
  bp.connect(crackGain);
  crackGain.connect(clip);

  const thump = ctx.createOscillator();
  thump.type = "sine";
  thump.frequency.setValueAtTime(140, t0);
  thump.frequency.exponentialRampToValueAtTime(85, t0 + 0.07);
  const thumpGain = ctx.createGain();
  applyLinearEnv(thumpGain.gain, t0, [
    [0, 0],
    [0.0025, 0.25],
    [0.05, 0.06],
    [0.03, 0],
  ]);
  thump.connect(thumpGain);
  thumpGain.connect(clip);

  const lp = ctx.createBiquadFilter();
  lp.type = "lowpass";
  lp.frequency.setValueAtTime(5200, t0);
  clip.connect(lp);
  lp.connect(input);

  body.start(t0);
  body.stop(t0 + duration);
  crack.start(t0);
  crack.stop(t0 + duration);
  thump.start(t0);
  thump.stop(t0 + duration);

  nodeList.push(clip, bodyGain, hp, bp, crackGain, thumpGain, lp);
  sourceList.push(body, crack, thump);
};

const buildRifleLaunch = (
  config: Pick<ProjectileLaunchVoiceConfig, "ctx" | "noise"> & { t0: number; r0: number; r1: number; r2: number },
  input: GainNode,
  lists: VoiceBuildLists
) => {
  const { ctx, noise, t0, r0, r1, r2 } = config;
  const { nodeList, sourceList } = lists;
  const duration = 0.18;

  const clip = createSoftClipper(ctx, 0.8);
  const lp = ctx.createBiquadFilter();
  lp.type = "lowpass";
  lp.frequency.setValueAtTime(4800, t0);
  clip.connect(lp);
  lp.connect(input);

  const clickOsc = ctx.createOscillator();
  clickOsc.type = "square";
  clickOsc.frequency.setValueAtTime(1700, t0);
  const clickGain = ctx.createGain();
  applyLinearEnv(clickGain.gain, t0, [
    [0, 0],
    [0.0005, 0.85],
    [0.009, 0],
  ]);
  clickOsc.connect(clickGain);
  clickGain.connect(clip);

  const crack = ctx.createBufferSource();
  crack.buffer = noise;
  const crackHp = ctx.createBiquadFilter();
  crackHp.type = "highpass";
  crackHp.frequency.setValueAtTime(2200 + r0 * 700, t0);
  const crackBp = ctx.createBiquadFilter();
  crackBp.type = "bandpass";
  crackBp.frequency.setValueAtTime(3600 + r1 * 1200, t0);
  crackBp.Q.setValueAtTime(1.3, t0);
  const crackGain = ctx.createGain();
  applyLinearEnv(crackGain.gain, t0, [
    [0, 0],
    [0.0004, 1.0],
    [0.015, 0.32],
    [0.05, 0],
  ]);
  crack.connect(crackHp);
  crackHp.connect(crackBp);
  crackBp.connect(crackGain);
  crackGain.connect(clip);

  const air = ctx.createBufferSource();
  air.buffer = noise;
  const airHp = ctx.createBiquadFilter();
  airHp.type = "highpass";
  airHp.frequency.setValueAtTime(900, t0);
  const airBp = ctx.createBiquadFilter();
  airBp.type = "bandpass";
  airBp.frequency.setValueAtTime(2400 + r2 * 700, t0);
  airBp.Q.setValueAtTime(0.85, t0);
  const airGain = ctx.createGain();
  applyLinearEnv(airGain.gain, t0, [
    [0, 0],
    [0.002, 0.28],
    [0.06, 0.14],
    [0.14, 0],
  ]);
  air.connect(airHp);
  airHp.connect(airBp);
  airBp.connect(airGain);
  airGain.connect(clip);

  const thump = ctx.createOscillator();
  thump.type = "sine";
  thump.frequency.setValueAtTime(160, t0);
  thump.frequency.exponentialRampToValueAtTime(80, t0 + 0.09);
  const thumpGain = ctx.createGain();
  applyLinearEnv(thumpGain.gain, t0, [
    [0, 0],
    [0.004, 0.26],
    [0.08, 0.05],
    [0.04, 0],
  ]);
  thump.connect(thumpGain);
  thumpGain.connect(clip);

  const blast = ctx.createBufferSource();
  blast.buffer = noise;
  const hp = ctx.createBiquadFilter();
  hp.type = "highpass";
  hp.frequency.setValueAtTime(620, t0);
  const bp = ctx.createBiquadFilter();
  bp.type = "bandpass";
  bp.frequency.setValueAtTime(1500 + r2 * 220, t0);
  bp.Q.setValueAtTime(0.85, t0);
  const blastGain = ctx.createGain();
  applyLinearEnv(blastGain.gain, t0, [
    [0, 0],
    [0.0008, 0.9],
    [0.06, 0.22],
    [0.12, 0.09],
    [0.12, 0],
  ]);
  blast.connect(hp);
  hp.connect(bp);
  bp.connect(blastGain);
  blastGain.connect(clip);

  clickOsc.start(t0);
  clickOsc.stop(t0 + 0.04);
  crack.start(t0);
  crack.stop(t0 + duration);
  air.start(t0);
  air.stop(t0 + duration);
  thump.start(t0);
  thump.stop(t0 + duration);
  blast.start(t0);
  blast.stop(t0 + duration);

  nodeList.push(
    clip,
    lp,
    clickGain,
    crackHp,
    crackBp,
    crackGain,
    airHp,
    airBp,
    airGain,
    thumpGain,
    hp,
    bp,
    blastGain
  );
  sourceList.push(clickOsc, crack, air, thump, blast);
};

const buildBazookaLaunch = (
  config: Pick<ProjectileLaunchVoiceConfig, "ctx" | "noise"> & { t0: number; r0: number; r1: number },
  input: GainNode,
  lists: VoiceBuildLists
) => {
  const { ctx, noise, t0, r0, r1 } = config;
  const { nodeList, sourceList } = lists;
  const duration = 0.22;

  const whoosh = ctx.createBufferSource();
  whoosh.buffer = noise;
  const bp = ctx.createBiquadFilter();
  bp.type = "bandpass";
  bp.frequency.setValueAtTime(420 + r0 * 180, t0);
  bp.Q.setValueAtTime(0.6, t0);
  const whooshGain = ctx.createGain();
  applyLinearEnv(whooshGain.gain, t0, [
    [0, 0],
    [0.01, 0.9],
    [0.09, 0.25],
    [0.12, 0],
  ]);
  whoosh.connect(bp);
  bp.connect(whooshGain);
  whooshGain.connect(input);

  const thump = ctx.createOscillator();
  thump.type = "sine";
  thump.frequency.setValueAtTime(110 + r1 * 20, t0);
  thump.frequency.exponentialRampToValueAtTime(65, t0 + 0.12);
  const thumpGain = ctx.createGain();
  applyLinearEnv(thumpGain.gain, t0, [
    [0, 0],
    [0.004, 0.55],
    [0.1, 0.02],
    [0.05, 0],
  ]);
  thump.connect(thumpGain);
  thumpGain.connect(input);

  whoosh.start(t0);
  whoosh.stop(t0 + duration);
  thump.start(t0);
  thump.stop(t0 + duration);

  nodeList.push(bp, whooshGain, thumpGain);
  sourceList.push(whoosh, thump);
};

const buildThrowLaunch = (
  config: Pick<ProjectileLaunchVoiceConfig, "ctx" | "noise"> & { t0: number; r0: number; r1: number },
  input: GainNode,
  lists: VoiceBuildLists
) => {
  const { ctx, noise, t0, r0, r1 } = config;
  const { nodeList, sourceList } = lists;
  const duration = 0.16;

  const throwNoise = ctx.createBufferSource();
  throwNoise.buffer = noise;
  const hp = ctx.createBiquadFilter();
  hp.type = "highpass";
  hp.frequency.setValueAtTime(900 + r0 * 400, t0);
  const throwGain = ctx.createGain();
  applyLinearEnv(throwGain.gain, t0, [
    [0, 0],
    [0.008, 0.5],
    [0.04, 0.2],
    [0.09, 0],
  ]);
  throwNoise.connect(hp);
  hp.connect(throwGain);
  throwGain.connect(input);

  const ping = ctx.createOscillator();
  ping.type = "triangle";
  ping.frequency.setValueAtTime(520 + r1 * 180, t0 + 0.01);
  const pingGain = ctx.createGain();
  applyLinearEnv(pingGain.gain, t0, [
    [0, 0],
    [0.01, 0.18],
    [0.06, 0],
  ]);
  ping.connect(pingGain);
  pingGain.connect(input);

  throwNoise.start(t0);
  throwNoise.stop(t0 + duration);
  ping.start(t0);
  ping.stop(t0 + duration);

  nodeList.push(hp, throwGain, pingGain);
  sourceList.push(throwNoise, ping);
};

export const createProjectileLaunchVoice = (config: ProjectileLaunchVoiceConfig): VoiceBlueprint => {
  const seed =
    (config.turnIndex * 1_000_003 + config.projectileId * 97 + weaponSeedId(config.weapon) * 911) | 0;
  const r0 = hash01(seed);
  const r1 = hash01(seed + 1);
  const r2 = hash01(seed + 2);

  const t0 = config.ctx.currentTime + 0.004;
  const tag = `launch:${config.weapon}`;
  const polyLimit = config.weapon === WeaponType.Uzi ? 10 : 4;

  if (config.weapon === WeaponType.Uzi) {
    const duration = 0.09;
    const baseGain = 0.28;
    return {
      tag,
      polyLimit,
      worldX: config.worldX,
      baseGain,
      stopAt: t0 + duration + 0.05,
      build: (input, nodeList, sourceList) =>
        buildUziLaunch({ ctx: config.ctx, noise: config.noise, t0 }, input, { nodeList, sourceList }),
    };
  }

  if (config.weapon === WeaponType.Rifle) {
    const duration = 0.18;
    const baseGain = 0.54;
    return {
      tag,
      polyLimit,
      worldX: config.worldX,
      baseGain,
      stopAt: t0 + duration + 0.12,
      build: (input, nodeList, sourceList) =>
        buildRifleLaunch(
          { ctx: config.ctx, noise: config.noise, t0, r0, r1, r2 },
          input,
          { nodeList, sourceList }
        ),
    };
  }

  if (config.weapon === WeaponType.Bazooka) {
    const duration = 0.22;
    const baseGain = 0.58;
    return {
      tag,
      polyLimit,
      worldX: config.worldX,
      baseGain,
      stopAt: t0 + duration + 0.08,
      build: (input, nodeList, sourceList) =>
        buildBazookaLaunch(
          { ctx: config.ctx, noise: config.noise, t0, r0, r1 },
          input,
          { nodeList, sourceList }
        ),
    };
  }

  const duration = 0.16;
  const baseGain = 0.42;
  return {
    tag,
    polyLimit,
    worldX: config.worldX,
    baseGain,
    stopAt: t0 + duration + 0.06,
    build: (input, nodeList, sourceList) =>
      buildThrowLaunch(
        { ctx: config.ctx, noise: config.noise, t0, r0, r1 },
        input,
        { nodeList, sourceList }
      ),
  };
};
