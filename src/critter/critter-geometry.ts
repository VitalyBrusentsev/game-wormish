import { CRITTER, WeaponType, clamp } from "../definitions";

export type Vec2 = { x: number; y: number };

export type CritterPose =
  | { kind: "idle" }
  | { kind: "aim"; weapon: WeaponType; aimAngle: number };

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

export function resolveWeaponVisualSpec(weapon: WeaponType, r: number): WeaponVisualSpec {
  switch (weapon) {
    case WeaponType.Uzi: {
      const length = r * 1.35;
      return { length, grip1: length * 0.55, grip2: null };
    }
    case WeaponType.Bazooka: {
      const length = r * 1.7;
      return { length, grip1: length * 0.28, grip2: length * 0.83 };
    }
    case WeaponType.HandGrenade: {
      const length = r * 1.1;
      return { length, grip1: length * 0.55, grip2: null };
    }
    case WeaponType.Rifle:
    default: {
      const length = r * 2.0;
      return { length, grip1: length * 0.24, grip2: length * 0.87 };
    }
  }
}

export function computeWeaponRig(config: {
  center: Vec2;
  r: number;
  weapon: WeaponType;
  aimAngle: number;
}): WeaponRig {
  const { center, r, weapon, aimAngle } = config;
  const dirx = Math.cos(aimAngle);
  const diry = Math.sin(aimAngle);
  const bodyW = r * CRITTER.bodyWidthFactor;
  const rootOffset = bodyW * CRITTER.weaponRootOffsetFactor;
  const spec = resolveWeaponVisualSpec(weapon, r);
  const root = { x: center.x + dirx * rootOffset, y: center.y + diry * rootOffset };
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
  const center = { x: config.x, y: config.y };
  const bodyW = config.r * CRITTER.bodyWidthFactor;
  const bodyH = bodyW * CRITTER.bodyHeightFactor;
  const headR = config.r * CRITTER.headRadiusFactor;
  const cornerR = Math.max(2, bodyH * 0.25);

  const longWeaponPose =
    config.pose.kind === "aim" &&
    (config.pose.weapon === WeaponType.Rifle || config.pose.weapon === WeaponType.Bazooka);

  const body = { center, w: bodyW, h: bodyH, cornerR };
  const head = {
    center: { x: center.x, y: center.y - bodyH / 2 - headR * 0.6 },
    r: headR,
  };

  const tailR1 = config.r * 0.58;
  const tailR2 = config.r * 0.44;
  const tailR3 = config.r * 0.32;
  const baseY = center.y + bodyH / 2 + tailR1 * 0.1;
  const backX = -config.facing;
  const tail: Array<{ center: Vec2; r: number }> = [
    { center: { x: center.x + backX * (tailR1 * 0.15), y: baseY + tailR1 * 0.55 }, r: tailR1 },
    { center: { x: center.x + backX * (tailR1 * 0.85), y: baseY + tailR1 * 1.15 }, r: tailR2 },
    { center: { x: center.x + backX * (tailR1 * 1.55), y: baseY + tailR1 * 1.65 }, r: tailR3 },
  ];

  const shoulderY = center.y + bodyH * CRITTER.shoulderYOffsetFactor;
  const leftShoulder = { x: center.x - bodyW / 2, y: shoulderY };
  const rightShoulder = { x: center.x + bodyW / 2, y: shoulderY };

  const baseUpperLen = config.r * (longWeaponPose ? 0.95 : CRITTER.armUpperFactor);
  const baseLowerLen = config.r * (longWeaponPose ? 0.95 : CRITTER.armLowerFactor);

  let weapon: WeaponRig | null = null;
  let grenade: { center: Vec2; r: number } | null = null;
  let leftTarget: Vec2;
  let rightTarget: Vec2;
  let supportSide: "left" | "right" | null = null;

  if (config.pose.kind === "aim") {
    const nearIsRight = config.facing > 0;
    if (config.pose.weapon === WeaponType.HandGrenade) {
      const up01 = clamp(-Math.sin(config.pose.aimAngle), 0, 1);
      const throwX = center.x - config.facing * (bodyW * (0.9 + 0.12 * up01));
      const throwY = shoulderY - config.r * (0.25 + 0.28 * up01);
      const supportX = center.x + config.facing * (bodyW * 0.38);
      const supportY = shoulderY + config.r * 0.1;

      if (nearIsRight) {
        rightTarget = { x: throwX, y: throwY };
        leftTarget = { x: supportX, y: supportY };
      } else {
        leftTarget = { x: throwX, y: throwY };
        rightTarget = { x: supportX, y: supportY };
      }
    } else {
      weapon = computeWeaponRig({
        center,
        r: config.r,
        weapon: config.pose.weapon,
        aimAngle: config.pose.aimAngle,
      });
      if (config.pose.weapon === WeaponType.Uzi) {
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

  const allowStretch =
    config.pose.kind === "aim" &&
    (config.pose.weapon === WeaponType.Rifle || config.pose.weapon === WeaponType.Bazooka);
  const maxReach = baseUpperLen + baseLowerLen;
  const resolveArmLengths = (shoulder: Vec2, target: Vec2, stretchMax: number) => {
    if (!allowStretch) return { upperLen: baseUpperLen, lowerLen: baseLowerLen };
    const dist = Math.hypot(target.x - shoulder.x, target.y - shoulder.y);
    const scale = clamp(dist / (maxReach || 1), 1, stretchMax);
    return { upperLen: baseUpperLen * scale, lowerLen: baseLowerLen * scale };
  };

  const leftLengths = resolveArmLengths(leftShoulder, leftTarget, supportSide === "left" ? 1.55 : 1.25);
  const rightLengths = resolveArmLengths(rightShoulder, rightTarget, supportSide === "right" ? 1.55 : 1.25);

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

  if (config.pose.kind === "aim" && config.pose.weapon === WeaponType.HandGrenade) {
    const throwHand = config.facing > 0 ? rightSolve.hand : leftSolve.hand;
    grenade = { center: throwHand, r: Math.max(2, config.r * 0.3) };
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
