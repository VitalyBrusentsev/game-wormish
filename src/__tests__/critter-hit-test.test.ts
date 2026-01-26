import { describe, expect, it } from "vitest";
import { WeaponType } from "../definitions";
import { Worm } from "../entities";
import { computeCritterRig } from "../critter/critter-geometry";
import { critterHitTestCircle } from "../game/critter-hit-test";
import { resolveCritterSpriteOffsets } from "../critter/critter-sprites";

function createWorm(config: { x: number; y: number; facing: -1 | 1 }) {
  const worm = new Worm(config.x, config.y, "Red", "Test");
  worm.facing = config.facing;
  return worm;
}

describe("critterHitTestCircle", () => {
  it("hits head, torso, and tail segments", () => {
    const worm = createWorm({ x: 100, y: 120, facing: 1 });
    const rig = computeCritterRig({
      x: worm.x,
      y: worm.y,
      r: worm.radius,
      facing: 1,
      pose: { kind: "idle" },
    });

    const offsets = resolveCritterSpriteOffsets();
    const applyOffset = (p: { x: number; y: number }, key: "head" | "torso" | "tail1" | "tail2") => {
      const o = offsets[key];
      return { x: p.x + worm.facing * o.x, y: p.y + o.y };
    };

    const headCenter = applyOffset(rig.head.center, "head");
    const torsoCenter = applyOffset(rig.body.center, "torso");
    const torsoCenterY = torsoCenter.y - rig.body.h * 0.2;
    expect(critterHitTestCircle(worm, headCenter.x, headCenter.y, 1)).toBe(true);
    expect(critterHitTestCircle(worm, torsoCenter.x, torsoCenterY, 1)).toBe(true);

    rig.tail.forEach((seg, i) => {
      const center = applyOffset(seg.center, i === 0 ? "tail1" : "tail2");
      expect(critterHitTestCircle(worm, center.x, center.y, 1)).toBe(true);
    });
  });

  it("misses far away points", () => {
    const worm = createWorm({ x: 20, y: 20, facing: 1 });
    expect(critterHitTestCircle(worm, worm.x + 1000, worm.y + 1000, 2)).toBe(false);
  });

  it("does not hit dead worms", () => {
    const worm = createWorm({ x: 50, y: 80, facing: 1 });
    worm.alive = false;
    expect(critterHitTestCircle(worm, worm.x, worm.y, 50)).toBe(false);
  });

  it("respects facing for tail placement", () => {
    const worm = createWorm({ x: 200, y: 200, facing: 1 });
    const rigRight = computeCritterRig({
      x: worm.x,
      y: worm.y,
      r: worm.radius,
      facing: 1,
      pose: { kind: "idle" },
    });

    worm.facing = -1;
    const rigLeft = computeCritterRig({
      x: worm.x,
      y: worm.y,
      r: worm.radius,
      facing: -1,
      pose: { kind: "idle" },
    });

    const offsets = resolveCritterSpriteOffsets();
    const applyOffset = (p: { x: number; y: number }, facing: -1 | 1, key: "tail2") => {
      const o = offsets[key];
      return { x: p.x + facing * o.x, y: p.y + o.y };
    };

    const farTailRight = rigRight.tail[rigRight.tail.length - 1]!;
    const farTailLeft = rigLeft.tail[rigLeft.tail.length - 1]!;

    const farTailLeftCenter = applyOffset(farTailLeft.center, -1, "tail2");
    const farTailRightCenter = applyOffset(farTailRight.center, 1, "tail2");

    expect(critterHitTestCircle(worm, farTailLeftCenter.x, farTailLeftCenter.y, 1)).toBe(true);
    expect(critterHitTestCircle(worm, farTailRightCenter.x, farTailRightCenter.y, 1)).toBe(false);
  });

  it("does not consider arms for collision", () => {
    const worm = createWorm({ x: 300, y: 160, facing: 1 });
    const rigAim = computeCritterRig({
      x: worm.x,
      y: worm.y,
      r: worm.radius,
      facing: 1,
      pose: { kind: "aim", weapon: WeaponType.Rifle, aimAngle: 0 },
    });

    const hand = rigAim.arms.right.lower.b;
    expect(critterHitTestCircle(worm, hand.x, hand.y, 1)).toBe(false);
  });
});
