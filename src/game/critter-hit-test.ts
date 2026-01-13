import { clamp } from "../definitions";
import { computeCritterRig } from "../critter/critter-geometry";
import type { Worm } from "../entities";

type CircleShape = { kind: "circle"; x: number; y: number; r: number };
type AabbShape = { kind: "aabb"; x: number; y: number; hw: number; hh: number };
type HitShape = CircleShape | AabbShape;

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

  const shapes: HitShape[] = [
    { kind: "circle", x: rig.head.center.x, y: rig.head.center.y, r: rig.head.r },
    { kind: "aabb", x: rig.body.center.x, y: rig.body.center.y, hw: rig.body.w / 2, hh: rig.body.h / 2 },
    ...rig.tail.map((seg) => ({ kind: "circle" as const, x: seg.center.x, y: seg.center.y, r: seg.r })),
  ];

  for (const shape of shapes) {
    if (circleIntersectsShape(x, y, r, shape)) return true;
  }
  return false;
}
