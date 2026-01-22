import { WeaponType } from "../definitions";
import { applyLinearEnv, clamp01, createSoftClipper, hash01, lerp, weaponSeedId } from "./audio-utils";
import type { VoiceBlueprint } from "./sfx-types";

type ProjectileExplodedVoiceConfig = {
  ctx: AudioContext;
  noise: AudioBuffer;
  weapon: WeaponType;
  cause: WeaponType;
  worldX: number;
  radius: number;
  impact: "terrain" | "worm" | "unknown";
  turnIndex: number;
  projectileId: number;
};

type VoiceBuildLists = {
  nodeList: AudioNode[];
  sourceList: AudioScheduledSourceNode[];
};

const buildBulletImpactWorm = (
  config: Pick<ProjectileExplodedVoiceConfig, "ctx" | "noise"> & { t0: number; r0: number; r1: number; r2: number },
  input: GainNode,
  lists: VoiceBuildLists
) => {
  const { ctx, noise, t0, r0, r1, r2 } = config;
  const { nodeList, sourceList } = lists;
  const duration = 0.12;

  const lp = ctx.createBiquadFilter();
  lp.type = "lowpass";
  lp.frequency.setValueAtTime(1900, t0);
  lp.Q.setValueAtTime(0.6, t0);
  lp.connect(input);

  const drop = ctx.createOscillator();
  drop.type = "sine";
  const startHz = lerp(760, 560, r2);
  const endHz = lerp(260, 190, r1);
  drop.frequency.setValueAtTime(startHz, t0);
  drop.frequency.exponentialRampToValueAtTime(endHz, t0 + 0.08);
  const dropGain = ctx.createGain();
  applyLinearEnv(dropGain.gain, t0, [
    [0, 0],
    [0.0018, 0.34],
    [0.05, 0.12],
    [0.07, 0],
  ]);
  drop.connect(dropGain);
  dropGain.connect(lp);

  const splash = ctx.createBufferSource();
  splash.buffer = noise;
  const bp = ctx.createBiquadFilter();
  bp.type = "bandpass";
  bp.frequency.setValueAtTime(lerp(700, 1050, r0), t0);
  bp.Q.setValueAtTime(7.5, t0);
  const splashGain = ctx.createGain();
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
};

const buildBulletImpactTerrain = (
  config: Pick<ProjectileExplodedVoiceConfig, "ctx" | "noise"> & { t0: number; r0: number; r1: number; r2: number },
  input: GainNode,
  lists: VoiceBuildLists
) => {
  const { ctx, noise, t0, r0, r1, r2 } = config;
  const { nodeList, sourceList } = lists;
  const duration = 0.12;

  const transient = ctx.createBufferSource();
  transient.buffer = noise;
  const hp = ctx.createBiquadFilter();
  hp.type = "highpass";
  hp.frequency.setValueAtTime(1600 + r0 * 1400, t0);
  const bp = ctx.createBiquadFilter();
  bp.type = "bandpass";
  bp.frequency.setValueAtTime(2800 + r1 * 1400, t0);
  bp.Q.setValueAtTime(1.1, t0);
  const transientGain = ctx.createGain();
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

  const ping = ctx.createOscillator();
  ping.type = "triangle";
  ping.frequency.setValueAtTime(lerp(520, 980, r2) * 0.7, t0);
  const pingGain = ctx.createGain();
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
};

const buildExplosion = (
  config: Pick<ProjectileExplodedVoiceConfig, "ctx" | "noise"> & { t0: number; r0: number; r1: number; size01: number },
  input: GainNode,
  lists: VoiceBuildLists
) => {
  const { ctx, noise, t0, r0, r1, size01 } = config;
  const { nodeList, sourceList } = lists;

  const duration = lerp(0.55, 0.95, size01);

  const clip = createSoftClipper(ctx, 0.35 + size01 * 0.25);
  const boom = ctx.createOscillator();
  boom.type = "sine";
  const boomHz = lerp(115, 75, size01) * lerp(0.9, 1.12, r0);
  boom.frequency.setValueAtTime(boomHz, t0);
  boom.frequency.exponentialRampToValueAtTime(lerp(55, 32, size01), t0 + 0.2);
  const boomGain = ctx.createGain();
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

  const crack = ctx.createBufferSource();
  crack.buffer = noise;
  const crackHp = ctx.createBiquadFilter();
  crackHp.type = "highpass";
  crackHp.frequency.setValueAtTime(1500 + r1 * 800, t0);
  const crackGain = ctx.createGain();
  applyLinearEnv(crackGain.gain, t0, [
    [0, 0],
    [0.002, 0.55],
    [0.05, 0.05],
    [0.08, 0],
  ]);
  crack.connect(crackHp);
  crackHp.connect(crackGain);
  crackGain.connect(clip);

  const rumble = ctx.createBufferSource();
  rumble.buffer = noise;
  const rumbleHp = ctx.createBiquadFilter();
  rumbleHp.type = "highpass";
  rumbleHp.frequency.setValueAtTime(55, t0);
  const rumbleLp = ctx.createBiquadFilter();
  rumbleLp.type = "lowpass";
  rumbleLp.frequency.setValueAtTime(420 + size01 * 140, t0);
  const rumbleGain = ctx.createGain();
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
};

export const createProjectileExplodedVoice = (config: ProjectileExplodedVoiceConfig): VoiceBlueprint => {
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
    const impact = config.impact;
    return {
      tag,
      polyLimit,
      worldX: config.worldX,
      baseGain,
      stopAt: t0 + duration + 0.08,
      build: (input, nodeList, sourceList) => {
        const shared = { ctx: config.ctx, noise: config.noise, t0, r0, r1, r2 };
        if (impact === "worm") {
          buildBulletImpactWorm(shared, input, { nodeList, sourceList });
          return;
        }
        buildBulletImpactTerrain(shared, input, { nodeList, sourceList });
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
    build: (input, nodeList, sourceList) =>
      buildExplosion(
        { ctx: config.ctx, noise: config.noise, t0, r0, r1, size01 },
        input,
        { nodeList, sourceList }
      ),
  };
};
