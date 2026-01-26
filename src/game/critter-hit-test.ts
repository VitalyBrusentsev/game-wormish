import { clamp } from "../definitions";
import { computeCritterRig } from "../critter/critter-geometry";
import { resolveCritterSpriteOffsets } from "../critter/critter-sprites";
import type { Worm } from "../entities";

type CircleShape = { kind: "circle"; x: number; y: number; r: number };
type AabbShape = { kind: "aabb"; x: number; y: number; hw: number; hh: number };
type HitShape = CircleShape | AabbShape;

const CRITTER_COLLISION = {
  headRScale: 1.2,
  torsoWScale: 1.2,
  torsoHScale: 1.4,
  torsoCenterUpFactor: 0.2,
} as const;

function circleIntersectsShape(cx: number, cy: number, cr: number, shape: HitShape): boolean {
  if (shape.kind === "circle") {
    const dx = cx - shape.x;
    const dy = cy - shape.y;
    const rr = cr + shape.r;
    return dx * dx + dy * dy <= rr * rr;
  }

  const closestX = clamp(cx, shape.x - shape.hw, shape.x + shape.hw);
  const closestY = clamp(cy, shape.y - shape.hh, shape.y + shape.hh);
  const dx = cx - closestX;
  const dy = cy - closestY;
  return dx * dx + dy * dy <= cr * cr;
}

export function critterHitTestCircle(worm: Worm, x: number, y: number, r: number): boolean {
  if (!worm.alive) return false;
  const facing = (worm.facing < 0 ? -1 : 1) as -1 | 1;
  const rig = computeCritterRig({ x: worm.x, y: worm.y, r: worm.radius, facing, pose: { kind: "idle" } });
  const offsets = resolveCritterSpriteOffsets();
  const applyOffset = (p: { x: number; y: number }, key: "head" | "torso" | "tail1" | "tail2") => {
    const o = offsets[key];
    return { x: p.x + facing * o.x, y: p.y + o.y };
  };

  const headCenter = applyOffset(rig.head.center, "head");
  const torsoCenter = applyOffset(rig.body.center, "torso");
  const tail = rig.tail.map((seg, i) => ({
    center: applyOffset(seg.center, i === 0 ? "tail1" : "tail2"),
    r: seg.r,
  }));

  const torsoCenterY = torsoCenter.y - rig.body.h * CRITTER_COLLISION.torsoCenterUpFactor;
  const torsoHw = (rig.body.w / 2) * CRITTER_COLLISION.torsoWScale;
  const torsoHh = (rig.body.h / 2) * CRITTER_COLLISION.torsoHScale;

  const shapes: HitShape[] = [
    { kind: "circle", x: headCenter.x, y: headCenter.y, r: rig.head.r * CRITTER_COLLISION.headRScale },
    { kind: "aabb", x: torsoCenter.x, y: torsoCenterY, hw: torsoHw, hh: torsoHh },
    ...tail.map((seg) => ({ kind: "circle" as const, x: seg.center.x, y: seg.center.y, r: seg.r })),
  ];

  for (const shape of shapes) {
    if (circleIntersectsShape(x, y, r, shape)) return true;
  }
  return false;
}
