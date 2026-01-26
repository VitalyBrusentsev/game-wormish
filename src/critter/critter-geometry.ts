import { CRITTER, WeaponType, clamp } from "../definitions";
import { resolveWeaponSpriteSpecs, weaponSpriteKeyForWeapon } from "../weapons/weapon-sprites";

export type Vec2 = { x: number; y: number };

export type BaseCritterPose =
  | { kind: "idle" }
  | { kind: "aim"; weapon: WeaponType; aimAngle: number };

export type CritterPose =
  | BaseCritterPose
  | {
      kind: "salute";
      base: BaseCritterPose;
      arm: "left" | "right";
      amount01: number;
      offset?: Vec2;
    };

export type WeaponRig = {
  angle: number;
  root: Vec2;
  muzzle: Vec2;
  length: number;
  grip1: Vec2;
  grip2: Vec2 | null;
};

export type SegmentRig = { a: Vec2; b: Vec2 };

export type CritterRig = {
  body: { center: Vec2; w: number; h: number; cornerR: number };
  head: { center: Vec2; r: number };
  tail: Array<{ center: Vec2; r: number }>;
  weapon: WeaponRig | null;
  grenade: { center: Vec2; r: number } | null;
  arms: { left: { upper: SegmentRig; lower: SegmentRig }; right: { upper: SegmentRig; lower: SegmentRig } };
};

export type WeaponVisualSpec = {
  length: number;
  grip1: number;
  grip2: number | null;
};

export function resolveWeaponVisualSpec(weapon: WeaponType, barrelLength: number): WeaponVisualSpec {
  switch (weapon) {
    case WeaponType.Uzi: {
      return { length: barrelLength, grip1: barrelLength * 0.55, grip2: null };
    }
    case WeaponType.Bazooka: {
      return { length: barrelLength, grip1: barrelLength * 0.28, grip2: barrelLength * 0.83 };
    }
    case WeaponType.HandGrenade: {
      return { length: barrelLength, grip1: barrelLength * 0.55, grip2: null };
    }
    case WeaponType.Rifle:
    default: {
      return { length: barrelLength, grip1: barrelLength * 0.24, grip2: barrelLength * 0.87 };
    }
  }
}

export function computeWeaponRig(config: {
  center: Vec2;
  weapon: WeaponType;
  aimAngle: number;
  facing: -1 | 1;
}): WeaponRig {
  const { center, weapon, aimAngle, facing } = config;
  const key = weaponSpriteKeyForWeapon(weapon);
  const spriteSpec = key ? resolveWeaponSpriteSpecs()[key] : null;

  const dirx = Math.cos(aimAngle);
  const diry = Math.sin(aimAngle);

  const barrelLength = spriteSpec?.barrelLength ?? 0;
  const root = spriteSpec
    ? { x: center.x + facing * spriteSpec.offset.x, y: center.y + spriteSpec.offset.y }
    : { x: center.x, y: center.y };

  const spec = resolveWeaponVisualSpec(weapon, barrelLength);
  const muzzle = { x: root.x + dirx * spec.length, y: root.y + diry * spec.length };
  const grip1 = { x: root.x + dirx * spec.grip1, y: root.y + diry * spec.grip1 };
  const grip2 =
    spec.grip2 === null ? null : { x: root.x + dirx * spec.grip2, y: root.y + diry * spec.grip2 };
  return { angle: aimAngle, root, muzzle, length: spec.length, grip1, grip2 };
}

function solveTwoBoneIk(config: {
  shoulder: Vec2;
  target: Vec2;
  upperLen: number;
  lowerLen: number;
  preferElbow: Vec2;
}): { elbow: Vec2; hand: Vec2 } {
  const { shoulder, target, upperLen, lowerLen, preferElbow } = config;

  const dx = target.x - shoulder.x;
  const dy = target.y - shoulder.y;
  const distRaw = Math.hypot(dx, dy) || 1;
  const minD = Math.max(1e-3, Math.abs(upperLen - lowerLen) + 1e-3);
  const maxD = upperLen + lowerLen - 1e-3;
  const dist = clamp(distRaw, minD, maxD);
  const tx = shoulder.x + (dx / distRaw) * dist;
  const ty = shoulder.y + (dy / distRaw) * dist;

  const baseAng = Math.atan2(ty - shoulder.y, tx - shoulder.x);
  const cosA = clamp((upperLen * upperLen + dist * dist - lowerLen * lowerLen) / (2 * upperLen * dist), -1, 1);
  const angA = Math.acos(cosA);

  const elbow1 = { x: shoulder.x + Math.cos(baseAng + angA) * upperLen, y: shoulder.y + Math.sin(baseAng + angA) * upperLen };
  const elbow2 = { x: shoulder.x + Math.cos(baseAng - angA) * upperLen, y: shoulder.y + Math.sin(baseAng - angA) * upperLen };

  const score1 = (elbow1.x - shoulder.x) * preferElbow.x + (elbow1.y - shoulder.y) * preferElbow.y;
  const score2 = (elbow2.x - shoulder.x) * preferElbow.x + (elbow2.y - shoulder.y) * preferElbow.y;
  const elbow = score1 >= score2 ? elbow1 : elbow2;

  return { elbow, hand: { x: tx, y: ty } };
}

export function computeCritterRig(config: {
  x: number;
  y: number;
  r: number;
  facing: -1 | 1;
  pose: CritterPose;
}): CritterRig {
  const basePose: BaseCritterPose = config.pose.kind === "salute" ? config.pose.base : config.pose;
  const salute = config.pose.kind === "salute" ? config.pose : null;

  const center = { x: config.x, y: config.y };
  const bodyW = config.r * CRITTER.bodyWidthFactor;
  const bodyH = bodyW * CRITTER.bodyHeightFactor;
  const headR = config.r * CRITTER.headRadiusFactor;
  const cornerR = Math.max(2, bodyH * 0.25);

  const longWeaponPose =
    basePose.kind === "aim" &&
    (basePose.weapon === WeaponType.Rifle || basePose.weapon === WeaponType.Bazooka);
  const grenadePose = basePose.kind === "aim" && basePose.weapon === WeaponType.HandGrenade;

  const body = { center, w: bodyW, h: bodyH, cornerR };
  const head = {
    center: { x: center.x, y: center.y - bodyH / 2 - headR * 0.6 },
    r: headR,
  };

  const tailR1 = config.r * 0.58;
  const tailR2 = config.r * 0.44;
  const baseY = center.y + bodyH / 2 + tailR1 * 0.1;
  const backX = -config.facing;
  const tail: Array<{ center: Vec2; r: number }> = [
    { center: { x: center.x + backX * (tailR1 * 0.15), y: baseY + tailR1 * 0.55 }, r: tailR1 },
    { center: { x: center.x + backX * (tailR1 * 0.85), y: baseY + tailR1 * 1.15 }, r: tailR2 },
  ];

  const shoulderY = center.y + bodyH * CRITTER.shoulderYOffsetFactor - 6;
  const leftShoulder = { x: center.x - bodyW / 2 - 2, y: shoulderY };
  const rightShoulder = { x: center.x + bodyW / 2 + 2, y: shoulderY };

  const baseUpperLen = config.r * (longWeaponPose ? 0.95 : CRITTER.armUpperFactor);
  const baseLowerLen = config.r * (longWeaponPose ? 0.95 : CRITTER.armLowerFactor);
  const armLenScale = 1.1;
  const upperLen = baseUpperLen * armLenScale;
  const lowerLen = baseLowerLen * armLenScale;

  let weapon: WeaponRig | null = null;
  let grenade: { center: Vec2; r: number } | null = null;
  let grenadeHold: Vec2 | null = null;
  let leftTarget: Vec2;
  let rightTarget: Vec2;
  let supportSide: "left" | "right" | null = null;

  if (basePose.kind === "aim") {
    const nearIsRight = config.facing > 0;
    if (basePose.weapon === WeaponType.HandGrenade) {
      const holdDist = config.r * 2;
      const invSqrt2 = 0.7071067811865476;
      const backX = -config.facing;
      const hold = {
        x: center.x + backX * holdDist * invSqrt2,
        y: center.y - holdDist * invSqrt2,
      };
      grenadeHold = hold;

      const throwArm: "left" | "right" = config.facing > 0 ? "left" : "right";
      const restTarget = (side: "left" | "right") => {
        const shoulder = side === "left" ? leftShoulder : rightShoulder;
        const forward = config.facing * upperLen * 0.25;
        return { x: shoulder.x + forward, y: shoulder.y + upperLen * 0.9 };
      };

      if (throwArm === "left") {
        leftTarget = hold;
        rightTarget = restTarget("right");
      } else {
        rightTarget = hold;
        leftTarget = restTarget("left");
      }
    } else {
      weapon = computeWeaponRig({
        center,
        weapon: basePose.weapon,
        aimAngle: basePose.aimAngle,
        facing: config.facing,
      });
      if (basePose.weapon === WeaponType.Uzi) {
        if (nearIsRight) {
          rightTarget = weapon.grip1;
          leftTarget = { x: leftShoulder.x - baseUpperLen * 0.1, y: leftShoulder.y + baseUpperLen * 0.9 };
        } else {
          leftTarget = weapon.grip1;
          rightTarget = { x: rightShoulder.x + baseUpperLen * 0.1, y: rightShoulder.y + baseUpperLen * 0.9 };
        }
      } else {
        const support = weapon.grip2 ?? weapon.grip1;
        if (nearIsRight) {
          if (longWeaponPose) {
            rightTarget = support;
            leftTarget = weapon.grip1;
            supportSide = "right";
          } else {
            rightTarget = weapon.grip1;
            leftTarget = support;
            supportSide = null;
          }
        } else {
          if (longWeaponPose) {
            leftTarget = support;
            rightTarget = weapon.grip1;
            supportSide = "left";
          } else {
            leftTarget = weapon.grip1;
            rightTarget = support;
            supportSide = null;
          }
        }
      }
    }
  } else {
    const forward = config.facing * baseUpperLen * 0.35;
    leftTarget = { x: leftShoulder.x - baseUpperLen * 0.15 + forward, y: leftShoulder.y + baseUpperLen * 0.95 };
    rightTarget = { x: rightShoulder.x + baseUpperLen * 0.15 + forward, y: rightShoulder.y + baseUpperLen * 0.95 };
  }

  if (salute) {
    const amount01 = clamp(salute.amount01, 0, 1);
    const armSign = salute.arm === "left" ? -1 : 1;
    const offset = salute.offset ?? { x: 0, y: 0 };
    const saluteTarget = {
      x: head.center.x + armSign * headR + offset.x,
      y: head.center.y + offset.y - 6,
    };
    const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
    const lerpVec = (a: Vec2, b: Vec2, t: number): Vec2 => ({
      x: lerp(a.x, b.x, t),
      y: lerp(a.y, b.y, t),
    });

    if (salute.arm === "left") leftTarget = lerpVec(leftTarget, saluteTarget, amount01);
    else rightTarget = lerpVec(rightTarget, saluteTarget, amount01);
  }

  const allowStretch =
    basePose.kind === "aim" &&
    (basePose.weapon === WeaponType.Rifle ||
      basePose.weapon === WeaponType.Bazooka ||
      basePose.weapon === WeaponType.HandGrenade);
  const maxReach = upperLen + lowerLen;
  const grenadeThrowArm: "left" | "right" | null = grenadePose ? (config.facing > 0 ? "left" : "right") : null;
  const resolveArmLengths = (shoulder: Vec2, target: Vec2, stretchMax: number) => {
    if (!allowStretch) return { upperLen, lowerLen };
    const dist = Math.hypot(target.x - shoulder.x, target.y - shoulder.y);
    const scale = clamp(dist / (maxReach || 1), 1, stretchMax);
    return { upperLen: upperLen * scale, lowerLen: lowerLen * scale };
  };

  const leftStretchMax =
    grenadeThrowArm === "left" ? 4.6 : supportSide === "left" ? 1.55 : 1.25;
  const rightStretchMax =
    grenadeThrowArm === "right" ? 4.6 : supportSide === "right" ? 1.55 : 1.25;
  const leftLengths = resolveArmLengths(leftShoulder, leftTarget, leftStretchMax);
  const rightLengths = resolveArmLengths(rightShoulder, rightTarget, rightStretchMax);

  const leftSolve = solveTwoBoneIk({
    shoulder: leftShoulder,
    target: leftTarget,
    upperLen: leftLengths.upperLen,
    lowerLen: leftLengths.lowerLen,
    preferElbow: { x: -1, y: 1.3 },
  });
  const rightSolve = solveTwoBoneIk({
    shoulder: rightShoulder,
    target: rightTarget,
    upperLen: rightLengths.upperLen,
    lowerLen: rightLengths.lowerLen,
    preferElbow: { x: 1, y: 1.3 },
  });

  if (basePose.kind === "aim" && basePose.weapon === WeaponType.HandGrenade) {
    const throwHand = config.facing > 0 ? leftSolve.hand : rightSolve.hand;
    grenade = { center: grenadeHold ?? throwHand, r: Math.max(2, config.r * 0.3) };
  }

  return {
    body,
    head,
    tail,
    weapon,
    grenade,
    arms: {
      left: {
        upper: { a: leftShoulder, b: leftSolve.elbow },
        lower: { a: leftSolve.elbow, b: leftSolve.hand },
      },
      right: {
        upper: { a: rightShoulder, b: rightSolve.elbow },
        lower: { a: rightSolve.elbow, b: rightSolve.hand },
      },
    },
  };
}
