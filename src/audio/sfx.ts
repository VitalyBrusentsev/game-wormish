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
      build: (input, nodeList, sourceList) => {
        const clip = createSoftClipper(config.ctx, 0.55);

        const body = config.ctx.createOscillator();
        body.type = "triangle";
        const bodyGain = config.ctx.createGain();
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

        const crack = config.ctx.createBufferSource();
        crack.buffer = config.noise;
        const hp = config.ctx.createBiquadFilter();
        hp.type = "highpass";
        hp.frequency.setValueAtTime(800, t0);
        const bp = config.ctx.createBiquadFilter();
        bp.type = "bandpass";
        bp.frequency.setValueAtTime(2600, t0);
        bp.Q.setValueAtTime(1.25, t0);
        const crackGain = config.ctx.createGain();
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

        const thump = config.ctx.createOscillator();
        thump.type = "sine";
        thump.frequency.setValueAtTime(140, t0);
        thump.frequency.exponentialRampToValueAtTime(85, t0 + 0.07);
        const thumpGain = config.ctx.createGain();
        applyLinearEnv(thumpGain.gain, t0, [
          [0, 0],
          [0.0025, 0.25],
          [0.05, 0.06],
          [0.03, 0],
        ]);
        thump.connect(thumpGain);
        thumpGain.connect(clip);

        const lp = config.ctx.createBiquadFilter();
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
      },
    };
  }

  if (config.weapon === WeaponType.Rifle) {
    const duration = 0.14;
    const baseGain = 0.55;
    return {
      tag,
      polyLimit,
      worldX: config.worldX,
      baseGain,
      stopAt: t0 + duration + 0.06,
      build: (input, nodeList, sourceList) => {
        const clip = createSoftClipper(config.ctx, 0.95);
        const lp = config.ctx.createBiquadFilter();
        lp.type = "lowpass";
        lp.frequency.setValueAtTime(3600, t0);
        clip.connect(lp);
        lp.connect(input);

        const clickOsc = config.ctx.createOscillator();
        clickOsc.type = "square";
        clickOsc.frequency.setValueAtTime(1300, t0);
        const clickGain = config.ctx.createGain();
        applyLinearEnv(clickGain.gain, t0, [
          [0, 0],
          [0.0007, 0.65],
          [0.012, 0],
        ]);
        clickOsc.connect(clickGain);
        clickGain.connect(clip);

        const thump = config.ctx.createOscillator();
        thump.type = "sine";
        thump.frequency.setValueAtTime(160, t0);
        thump.frequency.exponentialRampToValueAtTime(80, t0 + 0.09);
        const thumpGain = config.ctx.createGain();
        applyLinearEnv(thumpGain.gain, t0, [
          [0, 0],
          [0.004, 0.32],
          [0.08, 0.06],
          [0.04, 0],
        ]);
        thump.connect(thumpGain);
        thumpGain.connect(clip);

        const blast = config.ctx.createBufferSource();
        blast.buffer = config.noise;
        const hp = config.ctx.createBiquadFilter();
        hp.type = "highpass";
        hp.frequency.setValueAtTime(480, t0);
        const bp = config.ctx.createBiquadFilter();
        bp.type = "bandpass";
        bp.frequency.setValueAtTime(1200 + r2 * 140, t0);
        bp.Q.setValueAtTime(0.7, t0);
        const blastGain = config.ctx.createGain();
        applyLinearEnv(blastGain.gain, t0, [
          [0, 0],
          [0.001, 0.95],
          [0.028, 0.22],
          [0.055, 0],
        ]);
        blast.connect(hp);
        hp.connect(bp);
        bp.connect(blastGain);
        blastGain.connect(clip);

        clickOsc.start(t0);
        clickOsc.stop(t0 + 0.04);
        thump.start(t0);
        thump.stop(t0 + duration);
        blast.start(t0);
        blast.stop(t0 + duration);

        nodeList.push(clip, lp, clickGain, thumpGain, hp, bp, blastGain);
        sourceList.push(clickOsc, thump, blast);
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
  impact: "terrain" | "worm" | "unknown";
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
  const tag = isBullet ? `impact:${config.impact}` : "explosion";
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
        if (config.impact === "worm") {
          const lp = config.ctx.createBiquadFilter();
          lp.type = "lowpass";
          lp.frequency.setValueAtTime(1900, t0);
          lp.Q.setValueAtTime(0.6, t0);
          lp.connect(input);

          const drop = config.ctx.createOscillator();
          drop.type = "sine";
          const startHz = lerp(760, 560, r2);
          const endHz = lerp(260, 190, r1);
          drop.frequency.setValueAtTime(startHz, t0);
          drop.frequency.exponentialRampToValueAtTime(endHz, t0 + 0.08);
          const dropGain = config.ctx.createGain();
          applyLinearEnv(dropGain.gain, t0, [
            [0, 0],
            [0.0018, 0.34],
            [0.05, 0.12],
            [0.07, 0],
          ]);
          drop.connect(dropGain);
          dropGain.connect(lp);

          const splash = config.ctx.createBufferSource();
          splash.buffer = config.noise;
          const bp = config.ctx.createBiquadFilter();
          bp.type = "bandpass";
          bp.frequency.setValueAtTime(lerp(700, 1050, r0), t0);
          bp.Q.setValueAtTime(7.5, t0);
          const splashGain = config.ctx.createGain();
          applyLinearEnv(splashGain.gain, t0, [
            [0, 0],
            [0.0012, 0.3],
            [0.026, 0.09],
            [0.05, 0],
          ]);
          splash.connect(bp);
          bp.connect(splashGain);
          splashGain.connect(lp);

          drop.start(t0);
          drop.stop(t0 + duration);
          splash.start(t0);
          splash.stop(t0 + duration);

          nodeList.push(lp, dropGain, bp, splashGain);
          sourceList.push(drop, splash);
          return;
        }

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
        ping.frequency.setValueAtTime(lerp(520, 980, r2) * 0.7, t0);
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
  const duration = lerp(0.55, 0.95, size01);
  const baseGain = lerp(0.5, 0.72, size01);

  return {
    tag,
    polyLimit,
    worldX: config.worldX,
    baseGain,
    stopAt: t0 + duration + 0.12,
    build: (input, nodeList, sourceList) => {
      const clip = createSoftClipper(config.ctx, 0.35 + size01 * 0.25);
      const boom = config.ctx.createOscillator();
      boom.type = "sine";
      const boomHz = lerp(115, 75, size01) * lerp(0.9, 1.12, r0);
      boom.frequency.setValueAtTime(boomHz, t0);
      boom.frequency.exponentialRampToValueAtTime(lerp(55, 32, size01), t0 + 0.2);
      const boomGain = config.ctx.createGain();
      const boomAttack = 0.006;
      const boomMid = Math.max(0.18, duration * 0.35);
      const boomFade = Math.max(0.14, duration - boomAttack - boomMid);
      applyLinearEnv(boomGain.gain, t0, [
        [0, 0],
        [boomAttack, lerp(0.62, 0.72, size01)],
        [boomMid, lerp(0.14, 0.18, size01)],
        [boomFade, 0],
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
        [0.002, 0.55],
        [0.05, 0.05],
        [0.08, 0],
      ]);
      crack.connect(crackHp);
      crackHp.connect(crackGain);
      crackGain.connect(clip);

      const rumble = config.ctx.createBufferSource();
      rumble.buffer = config.noise;
      const rumbleHp = config.ctx.createBiquadFilter();
      rumbleHp.type = "highpass";
      rumbleHp.frequency.setValueAtTime(55, t0);
      const rumbleLp = config.ctx.createBiquadFilter();
      rumbleLp.type = "lowpass";
      rumbleLp.frequency.setValueAtTime(420 + size01 * 140, t0);
      const rumbleGain = config.ctx.createGain();
      const rumbleAttack = 0.02;
      const rumbleMid = Math.max(0.25, duration * 0.5);
      const rumbleFade = Math.max(0.18, duration - rumbleAttack - rumbleMid);
      applyLinearEnv(rumbleGain.gain, t0, [
        [0, 0],
        [rumbleAttack, lerp(0.3, 0.42, size01)],
        [rumbleMid, lerp(0.09, 0.14, size01)],
        [rumbleFade, 0],
      ]);
      rumble.connect(rumbleHp);
      rumbleHp.connect(rumbleLp);
      rumbleLp.connect(rumbleGain);
      rumbleGain.connect(clip);

      clip.connect(input);

      boom.start(t0);
      boom.stop(t0 + duration);
      crack.start(t0);
      crack.stop(t0 + Math.min(duration, 0.2));
      rumble.start(t0);
      rumble.stop(t0 + duration);

      nodeList.push(clip, boomGain, crackHp, crackGain, rumbleHp, rumbleLp, rumbleGain);
      sourceList.push(boom, crack, rumble);
    },
  };
};
