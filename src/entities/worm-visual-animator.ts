import { WORLD, clamp } from "../definitions";
import {
  resolveMovementBlendSetting,
  resolveWormAnimationSetting,
  type WormMovementSmoothingMode,
} from "../rendering/worm-animation-setting";

export type MotionSample = {
  x: number;
  y: number;
  vx: number;
  vy: number;
};

type Point = { x: number; y: number };

type PointSpring = {
  x: number;
  y: number;
  vx: number;
  vy: number;
};

type MovementBlend = {
  startAtMs: number;
  durationMs: number;
  velocityInfluence: number;
  gravityCurve: number;
  from: MotionSample;
  to: MotionSample;
};

type ElasticOffsets = {
  head: Point;
  helmet: Point;
  collar: Point;
  tail: Point[];
  weapon: { bobY: number; rockRad: number };
};

const zeroPoint = (): Point => ({ x: 0, y: 0 });

const createSpring = (): PointSpring => ({ x: 0, y: 0, vx: 0, vy: 0 });

const clampAbs = (value: number, limit: number) => clamp(value, -limit, limit);

const solveHermite = (
  p0: number,
  p1: number,
  m0: number,
  m1: number,
  t: number
) => {
  const t2 = t * t;
  const t3 = t2 * t;
  const h00 = 2 * t3 - 3 * t2 + 1;
  const h10 = t3 - 2 * t2 + t;
  const h01 = -2 * t3 + 3 * t2;
  const h11 = t3 - t2;
  return h00 * p0 + h10 * m0 + h01 * p1 + h11 * m1;
};

export class WormVisualAnimator {
  private motion: MotionSample;
  private blend: MovementBlend | null = null;
  private lastMotionSampleAtMs = 0;
  private lastElasticAtMs = 0;
  private readonly springs = {
    head: createSpring(),
    helmet: createSpring(),
    collar: createSpring(),
    tail: [createSpring(), createSpring(), createSpring()],
  };

  constructor(initialX: number, initialY: number) {
    this.motion = { x: initialX, y: initialY, vx: 0, vy: 0 };
  }

  snapToPhysics(sample: MotionSample) {
    this.motion = { ...sample };
    this.blend = null;
    this.lastMotionSampleAtMs = 0;
  }

  scheduleMovementBlend(params: {
    nowMs: number;
    from: MotionSample;
    to: MotionSample;
    dtMs: number;
    mode: WormMovementSmoothingMode;
  }) {
    const setting = resolveMovementBlendSetting(params.mode);
    if (!setting.enabled || params.dtMs <= 0) {
      this.snapToPhysics(params.to);
      return;
    }

    const durationMs = clamp(
      params.dtMs * setting.durationScale,
      setting.minDurationMs,
      setting.maxDurationMs
    );
    if (durationMs <= 1) {
      this.snapToPhysics(params.to);
      return;
    }

    const current = this.sampleMotion(params.nowMs, params.from);
    this.blend = {
      startAtMs: params.nowMs,
      durationMs,
      velocityInfluence: setting.velocityInfluence,
      gravityCurve: setting.gravityCurve,
      from: current,
      to: { ...params.to },
    };
  }

  sampleMotion(nowMs: number, physicsFallback: MotionSample): MotionSample {
    const measureDt = () => {
      if (!this.lastMotionSampleAtMs) return 0;
      return clamp((nowMs - this.lastMotionSampleAtMs) / 1000, 1 / 240, 1 / 20);
    };

    if (!this.blend) {
      const dt = measureDt();
      const measuredVx = dt > 0 ? (physicsFallback.x - this.motion.x) / dt : 0;
      const measuredVy = dt > 0 ? (physicsFallback.y - this.motion.y) / dt : 0;
      this.motion = {
        x: physicsFallback.x,
        y: physicsFallback.y,
        vx: measuredVx,
        vy: measuredVy,
      };
      this.lastMotionSampleAtMs = nowMs;
      return this.motion;
    }

    const blend = this.blend;
    const elapsedMs = Math.max(0, nowMs - blend.startAtMs);
    const t = clamp(elapsedMs / Math.max(1, blend.durationMs), 0, 1);
    if (t >= 1) {
      const dt = measureDt();
      const measuredVx = dt > 0 ? (blend.to.x - this.motion.x) / dt : 0;
      const measuredVy = dt > 0 ? (blend.to.y - this.motion.y) / dt : 0;
      this.motion = { x: blend.to.x, y: blend.to.y, vx: measuredVx, vy: measuredVy };
      this.blend = null;
      this.lastMotionSampleAtMs = nowMs;
      return this.motion;
    }

    const durationSec = Math.max(0.001, blend.durationMs / 1000);
    const velocityScale = blend.velocityInfluence;
    const m0x = blend.from.vx * durationSec * velocityScale;
    const m1x = blend.to.vx * durationSec * velocityScale;
    const m0y = blend.from.vy * durationSec * velocityScale;
    const m1y = blend.to.vy * durationSec * velocityScale;

    const pointAt = (sampleT: number) => {
      const x = solveHermite(blend.from.x, blend.to.x, m0x, m1x, sampleT);
      const yBase = solveHermite(blend.from.y, blend.to.y, m0y, m1y, sampleT);
      const gravityArc =
        blend.gravityCurve *
        WORLD.gravity *
        durationSec *
        durationSec *
        0.5 *
        sampleT *
        (1 - sampleT);
      return { x, y: yBase + gravityArc };
    };

    const p = pointAt(t);
    const eps = 0.008;
    const nextT = Math.min(1, t + eps);
    const p2 = pointAt(nextT);
    const dtSec = Math.max(1e-3, (nextT - t) * durationSec);
    const vx = (p2.x - p.x) / dtSec;
    const vy = (p2.y - p.y) / dtSec;

    this.motion = { x: p.x, y: p.y, vx, vy };
    this.lastMotionSampleAtMs = nowMs;
    return this.motion;
  }

  computeElasticOffsets(params: {
    nowMs: number;
    motion: MotionSample;
    facing: -1 | 1;
    hasWeapon: boolean;
    onGround: boolean;
  }): ElasticOffsets {
    const settings = resolveWormAnimationSetting();
    const dt = this.computeElasticDt(params.nowMs);
    const move01 = clamp(Math.abs(params.motion.vx) / Math.max(1, WORLD.walkSpeed), 0, 1);
    const phase =
      params.nowMs *
      0.001 *
      Math.PI *
      2 *
      settings.elastic.strideHz *
      (0.35 + move01 * 0.65);

    if (!settings.elastic.enabled) {
      this.resetSprings();
      return {
        head: zeroPoint(),
        helmet: zeroPoint(),
        collar: zeroPoint(),
        tail: [zeroPoint(), zeroPoint(), zeroPoint()],
        weapon: this.resolveWeaponCarry(params.nowMs, move01, params.hasWeapon, params.onGround),
      };
    }

    const maxOffset = Math.max(0, settings.elastic.maxOffsetPx);
    const lagTime = settings.elastic.velocityLagSeconds;
    const lagX = clampAbs(-params.motion.vx * lagTime, maxOffset);
    const lagY = clampAbs(-params.motion.vy * lagTime * 0.45, maxOffset);

    const headTarget = {
      x:
        (lagX / Math.max(1, maxOffset)) * settings.elastic.headLagPx +
        Math.sin(phase) * settings.elastic.headBobPx * move01,
      y:
        lagY * 0.24 +
        Math.abs(Math.sin(phase + Math.PI * 0.45)) * settings.elastic.headBobPx * move01,
    };
    const helmetTarget = {
      x:
        (lagX / Math.max(1, maxOffset)) * settings.elastic.helmetLagPx +
        Math.sin(phase + 0.6) * settings.elastic.helmetBobPx * move01,
      y:
        lagY * 0.28 +
        Math.abs(Math.sin(phase + Math.PI * 0.2)) * settings.elastic.helmetBobPx * move01,
    };
    const collarTarget = {
      x:
        (lagX / Math.max(1, maxOffset)) * settings.elastic.collarLagPx +
        Math.sin(phase - 0.4) * settings.elastic.collarBobPx * move01,
      y:
        lagY * 0.18 +
        Math.abs(Math.sin(phase + Math.PI * 0.65)) * settings.elastic.collarBobPx * move01,
    };

    const springConfig = {
      stiffness: settings.elastic.springStiffness,
      damping: settings.elastic.springDamping,
      maxOffset: maxOffset,
    };

    const head = this.advanceSpring(this.springs.head, headTarget, dt, springConfig);
    const helmet = this.advanceSpring(this.springs.helmet, helmetTarget, dt, springConfig);
    const collar = this.advanceSpring(this.springs.collar, collarTarget, dt, springConfig);

    const tail: Point[] = this.springs.tail.map((spring, index) => {
      const wavePhase = phase - index * settings.elastic.tailPhaseStepRad;
      const waveX =
        Math.sin(wavePhase) *
        settings.elastic.tailSwingPx *
        move01 *
        (1 + index * 0.35);
      const waveY =
        Math.cos(wavePhase) *
        settings.elastic.tailLiftPx *
        move01 *
        (1 + index * 0.2);
      const target = {
        x:
          (lagX / Math.max(1, maxOffset)) * settings.elastic.tailLagPx * (0.65 + index * 0.35) -
          params.facing * waveX,
        y: lagY * 0.14 + waveY,
      };
      return this.advanceSpring(spring, target, dt, springConfig);
    });

    return {
      head,
      helmet,
      collar,
      tail,
      weapon: this.resolveWeaponCarry(params.nowMs, move01, params.hasWeapon, params.onGround),
    };
  }

  private resolveWeaponCarry(
    nowMs: number,
    move01: number,
    hasWeapon: boolean,
    onGround: boolean
  ) {
    const setting = resolveWormAnimationSetting().weaponCarry;
    if (!setting.enabled || !hasWeapon) return { bobY: 0, rockRad: 0 };
    const weaponMove01 = clamp(move01 * setting.moveScale, 0, 1);
    const groundMul = onGround ? 1 : 0.55;
    const nowSec = nowMs * 0.001;
    return {
      bobY:
        Math.sin(nowSec * Math.PI * 2 * setting.bobHz + 0.55) *
        setting.bobPx *
        weaponMove01 *
        groundMul,
      rockRad:
        Math.sin(nowSec * Math.PI * 2 * setting.rockHz) *
        setting.rockRad *
        weaponMove01 *
        groundMul,
    };
  }

  private computeElasticDt(nowMs: number): number {
    if (!this.lastElasticAtMs) {
      this.lastElasticAtMs = nowMs;
      return 1 / 60;
    }
    const dt = clamp((nowMs - this.lastElasticAtMs) / 1000, 1 / 240, 1 / 20);
    this.lastElasticAtMs = nowMs;
    return dt;
  }

  private resetSprings() {
    const reset = (spring: PointSpring) => {
      spring.x = 0;
      spring.y = 0;
      spring.vx = 0;
      spring.vy = 0;
    };
    reset(this.springs.head);
    reset(this.springs.helmet);
    reset(this.springs.collar);
    for (const spring of this.springs.tail) reset(spring);
  }

  private advanceSpring(
    spring: PointSpring,
    target: Point,
    dt: number,
    config: { stiffness: number; damping: number; maxOffset: number }
  ): Point {
    const ax = (target.x - spring.x) * config.stiffness - spring.vx * config.damping;
    const ay = (target.y - spring.y) * config.stiffness - spring.vy * config.damping;
    spring.vx += ax * dt;
    spring.vy += ay * dt;
    spring.x += spring.vx * dt;
    spring.y += spring.vy * dt;
    spring.x = clampAbs(spring.x, config.maxOffset);
    spring.y = clampAbs(spring.y, config.maxOffset);
    return { x: spring.x, y: spring.y };
  }
}
