import { WeaponType } from "../definitions";
import { applyLinearEnv, clamp01, createSoftClipper, hash01, lerp, weaponSeedId } from "./audio-utils";

export type VoiceBlueprint = {
  tag: string;
  polyLimit: number;
  worldX: number;
  baseGain: number;
  stopAt: number;
  build: (input: GainNode, nodeList: AudioNode[], sourceList: AudioScheduledSourceNode[]) => void;
};

export const createProjectileLaunchVoice = (config: {
  ctx: AudioContext;
  noise: AudioBuffer;
  weapon: WeaponType;
  worldX: number;
  velocity: { x: number; y: number };
  turnIndex: number;
  projectileId: number;
}): VoiceBlueprint => {
  const speed = Math.hypot(config.velocity.x, config.velocity.y);
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
    const baseGain = 0.26;
    return {
      tag,
      polyLimit,
      worldX: config.worldX,
      baseGain,
      stopAt: t0 + duration + 0.05,
      build: (input, nodeList, sourceList) => {
        const body = config.ctx.createOscillator();
        body.type = "triangle";
        const bodyGain = config.ctx.createGain();
        const baseHz = lerp(360, 520, clamp01(speed / 2200));
        body.frequency.setValueAtTime(baseHz * lerp(0.92, 1.12, r0), t0);
        applyLinearEnv(bodyGain.gain, t0, [
          [0, 0],
          [0.002, 0.95],
          [0.06, 0.02],
          [0.02, 0],
        ]);
        body.connect(bodyGain);
        bodyGain.connect(input);

        const hiss = config.ctx.createBufferSource();
        hiss.buffer = config.noise;
        const hp = config.ctx.createBiquadFilter();
        hp.type = "highpass";
        hp.frequency.setValueAtTime(1900 + r1 * 900, t0);
        const hissGain = config.ctx.createGain();
        applyLinearEnv(hissGain.gain, t0, [
          [0, 0],
          [0.0015, 0.22],
          [0.03, 0.05],
          [0.025, 0],
        ]);
        hiss.connect(hp);
        hp.connect(hissGain);
        hissGain.connect(input);

        body.start(t0);
        body.stop(t0 + duration);
        hiss.start(t0);
        hiss.stop(t0 + duration);

        nodeList.push(bodyGain, hp, hissGain);
        sourceList.push(body, hiss);
      },
    };
  }

  if (config.weapon === WeaponType.Rifle) {
    const duration = 0.12;
    const baseGain = 0.55;
    return {
      tag,
      polyLimit,
      worldX: config.worldX,
      baseGain,
      stopAt: t0 + duration + 0.06,
      build: (input, nodeList, sourceList) => {
        const clip = createSoftClipper(config.ctx, 0.7);
        const clickOsc = config.ctx.createOscillator();
        clickOsc.type = "square";
        clickOsc.frequency.setValueAtTime(2200 + r0 * 800, t0);
        const clickGain = config.ctx.createGain();
        applyLinearEnv(clickGain.gain, t0, [
          [0, 0],
          [0.0006, 0.75],
          [0.008, 0],
        ]);
        clickOsc.connect(clickGain);
        clickGain.connect(clip);

        const blast = config.ctx.createBufferSource();
        blast.buffer = config.noise;
        const hp = config.ctx.createBiquadFilter();
        hp.type = "highpass";
        hp.frequency.setValueAtTime(700 + r1 * 250, t0);
        const bp = config.ctx.createBiquadFilter();
        bp.type = "bandpass";
        bp.frequency.setValueAtTime(1600 + r2 * 900, t0);
        bp.Q.setValueAtTime(0.8, t0);
        const blastGain = config.ctx.createGain();
        applyLinearEnv(blastGain.gain, t0, [
          [0, 0],
          [0.001, 0.95],
          [0.02, 0.22],
          [0.04, 0],
        ]);
        blast.connect(hp);
        hp.connect(bp);
        bp.connect(blastGain);
        blastGain.connect(clip);

        clip.connect(input);

        clickOsc.start(t0);
        clickOsc.stop(t0 + 0.03);
        blast.start(t0);
        blast.stop(t0 + duration);

        nodeList.push(clip, clickGain, hp, bp, blastGain);
        sourceList.push(clickOsc, blast);
      },
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
      build: (input, nodeList, sourceList) => {
        const whoosh = config.ctx.createBufferSource();
        whoosh.buffer = config.noise;
        const bp = config.ctx.createBiquadFilter();
        bp.type = "bandpass";
        bp.frequency.setValueAtTime(420 + r0 * 180, t0);
        bp.Q.setValueAtTime(0.6, t0);
        const whooshGain = config.ctx.createGain();
        applyLinearEnv(whooshGain.gain, t0, [
          [0, 0],
          [0.01, 0.9],
          [0.09, 0.25],
          [0.12, 0],
        ]);
        whoosh.connect(bp);
        bp.connect(whooshGain);
        whooshGain.connect(input);

        const thump = config.ctx.createOscillator();
        thump.type = "sine";
        thump.frequency.setValueAtTime(110 + r1 * 20, t0);
        thump.frequency.exponentialRampToValueAtTime(65, t0 + 0.12);
        const thumpGain = config.ctx.createGain();
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
      },
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
    build: (input, nodeList, sourceList) => {
      const throwNoise = config.ctx.createBufferSource();
      throwNoise.buffer = config.noise;
      const hp = config.ctx.createBiquadFilter();
      hp.type = "highpass";
      hp.frequency.setValueAtTime(900 + r0 * 400, t0);
      const throwGain = config.ctx.createGain();
      applyLinearEnv(throwGain.gain, t0, [
        [0, 0],
        [0.008, 0.5],
        [0.04, 0.2],
        [0.09, 0],
      ]);
      throwNoise.connect(hp);
      hp.connect(throwGain);
      throwGain.connect(input);

      const ping = config.ctx.createOscillator();
      ping.type = "triangle";
      ping.frequency.setValueAtTime(520 + r1 * 180, t0 + 0.01);
      const pingGain = config.ctx.createGain();
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
    },
  };
};

export const createProjectileExplodedVoice = (config: {
  ctx: AudioContext;
  noise: AudioBuffer;
  weapon: WeaponType;
  cause: WeaponType;
  worldX: number;
  radius: number;
  turnIndex: number;
  projectileId: number;
}): VoiceBlueprint => {
  const seed =
    (config.turnIndex * 1_000_003 + config.projectileId * 97 + weaponSeedId(config.cause) * 991) | 0;
  const r0 = hash01(seed);
  const r1 = hash01(seed + 1);
  const r2 = hash01(seed + 2);

  const t0 = config.ctx.currentTime + 0.004;
  const isBullet = config.cause === WeaponType.Rifle || config.cause === WeaponType.Uzi;
  const tag = isBullet ? "impact" : "explosion";
  const polyLimit = isBullet ? 12 : 3;

  if (isBullet) {
    const duration = 0.12;
    const baseGain = config.cause === WeaponType.Rifle ? 0.52 : 0.35;
    return {
      tag,
      polyLimit,
      worldX: config.worldX,
      baseGain,
      stopAt: t0 + duration + 0.08,
      build: (input, nodeList, sourceList) => {
        const transient = config.ctx.createBufferSource();
        transient.buffer = config.noise;
        const hp = config.ctx.createBiquadFilter();
        hp.type = "highpass";
        hp.frequency.setValueAtTime(1600 + r0 * 1400, t0);
        const bp = config.ctx.createBiquadFilter();
        bp.type = "bandpass";
        bp.frequency.setValueAtTime(2800 + r1 * 1400, t0);
        bp.Q.setValueAtTime(1.1, t0);
        const transientGain = config.ctx.createGain();
        applyLinearEnv(transientGain.gain, t0, [
          [0, 0],
          [0.001, 0.85],
          [0.018, 0.12],
          [0.03, 0],
        ]);
        transient.connect(hp);
        hp.connect(bp);
        bp.connect(transientGain);
        transientGain.connect(input);

        const ping = config.ctx.createOscillator();
        ping.type = "triangle";
        ping.frequency.setValueAtTime(lerp(520, 980, r2), t0);
        const pingGain = config.ctx.createGain();
        applyLinearEnv(pingGain.gain, t0, [
          [0, 0],
          [0.002, 0.22],
          [0.06, 0.04],
          [0.05, 0],
        ]);
        ping.connect(pingGain);
        pingGain.connect(input);

        transient.start(t0);
        transient.stop(t0 + duration);
        ping.start(t0);
        ping.stop(t0 + duration);

        nodeList.push(hp, bp, transientGain, pingGain);
        sourceList.push(transient, ping);
      },
    };
  }

  const size01 = clamp01((config.radius - 20) / 60);
  const duration = lerp(0.45, 0.75, size01);
  const baseGain = lerp(0.65, 0.9, size01);

  return {
    tag,
    polyLimit,
    worldX: config.worldX,
    baseGain,
    stopAt: t0 + duration + 0.12,
    build: (input, nodeList, sourceList) => {
      const clip = createSoftClipper(config.ctx, 0.55 + size01 * 0.35);
      const boom = config.ctx.createOscillator();
      boom.type = "sine";
      const boomHz = lerp(115, 75, size01) * lerp(0.9, 1.12, r0);
      boom.frequency.setValueAtTime(boomHz, t0);
      boom.frequency.exponentialRampToValueAtTime(lerp(55, 32, size01), t0 + 0.2);
      const boomGain = config.ctx.createGain();
      applyLinearEnv(boomGain.gain, t0, [
        [0, 0],
        [0.006, 0.85],
        [0.22, 0.18],
        [0.28, 0],
      ]);
      boom.connect(boomGain);
      boomGain.connect(clip);

      const crack = config.ctx.createBufferSource();
      crack.buffer = config.noise;
      const crackHp = config.ctx.createBiquadFilter();
      crackHp.type = "highpass";
      crackHp.frequency.setValueAtTime(1500 + r1 * 800, t0);
      const crackGain = config.ctx.createGain();
      applyLinearEnv(crackGain.gain, t0, [
        [0, 0],
        [0.002, 0.75],
        [0.05, 0.06],
        [0.06, 0],
      ]);
      crack.connect(crackHp);
      crackHp.connect(crackGain);
      crackGain.connect(clip);

      const rumble = config.ctx.createBufferSource();
      rumble.buffer = config.noise;
      const rumbleLp = config.ctx.createBiquadFilter();
      rumbleLp.type = "lowpass";
      rumbleLp.frequency.setValueAtTime(420 + size01 * 140, t0);
      const rumbleGain = config.ctx.createGain();
      applyLinearEnv(rumbleGain.gain, t0, [
        [0, 0],
        [0.02, 0.6],
        [0.32, 0.18],
        [0.25, 0],
      ]);
      rumble.connect(rumbleLp);
      rumbleLp.connect(rumbleGain);
      rumbleGain.connect(clip);

      clip.connect(input);

      boom.start(t0);
      boom.stop(t0 + duration);
      crack.start(t0);
      crack.stop(t0 + 0.16);
      rumble.start(t0);
      rumble.stop(t0 + duration);

      nodeList.push(clip, boomGain, crackHp, crackGain, rumbleLp, rumbleGain);
      sourceList.push(boom, crack, rumble);
    },
  };
};
