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

function sweepCircleVsCircle(
  fromX: number,
  fromY: number,
  toX: number,
  toY: number,
  radius: number,
  shape: CircleShape
): number | null {
  const dx = toX - fromX;
  const dy = toY - fromY;
  const rr = radius + shape.r;
  const fx = fromX - shape.x;
  const fy = fromY - shape.y;
  const a = dx * dx + dy * dy;
  const c = fx * fx + fy * fy - rr * rr;
  if (c <= 0) return 0;
  if (a <= 1e-9) return null;
  const b = 2 * (fx * dx + fy * dy);
  const disc = b * b - 4 * a * c;
  if (disc < 0) return null;
  const sqrtDisc = Math.sqrt(disc);
  const t1 = (-b - sqrtDisc) / (2 * a);
  const t2 = (-b + sqrtDisc) / (2 * a);
  if (t1 >= 0 && t1 <= 1) return t1;
  if (t2 >= 0 && t2 <= 1) return t2;
  return null;
}

function sweepCircleVsAabb(
  fromX: number,
  fromY: number,
  toX: number,
  toY: number,
  radius: number,
  shape: AabbShape
): number | null {
  const minX = shape.x - shape.hw - radius;
  const maxX = shape.x + shape.hw + radius;
  const minY = shape.y - shape.hh - radius;
  const maxY = shape.y + shape.hh + radius;

  if (fromX >= minX && fromX <= maxX && fromY >= minY && fromY <= maxY) return 0;

  const dx = toX - fromX;
  const dy = toY - fromY;
  let tMin = 0;
  let tMax = 1;

  if (Math.abs(dx) <= 1e-9) {
    if (fromX < minX || fromX > maxX) return null;
  } else {
    const tx1 = (minX - fromX) / dx;
    const tx2 = (maxX - fromX) / dx;
    tMin = Math.max(tMin, Math.min(tx1, tx2));
    tMax = Math.min(tMax, Math.max(tx1, tx2));
    if (tMax < tMin) return null;
  }

  if (Math.abs(dy) <= 1e-9) {
    if (fromY < minY || fromY > maxY) return null;
  } else {
    const ty1 = (minY - fromY) / dy;
    const ty2 = (maxY - fromY) / dy;
    tMin = Math.max(tMin, Math.min(ty1, ty2));
    tMax = Math.min(tMax, Math.max(ty1, ty2));
    if (tMax < tMin) return null;
  }

  return tMin <= 1 ? tMin : null;
}

function sweepCircleIntersectsShape(
  fromX: number,
  fromY: number,
  toX: number,
  toY: number,
  radius: number,
  shape: HitShape
): number | null {
  if (shape.kind === "circle") {
    return sweepCircleVsCircle(fromX, fromY, toX, toY, radius, shape);
  }
  return sweepCircleVsAabb(fromX, fromY, toX, toY, radius, shape);
}

function buildCritterHitShapes(worm: Worm): HitShape[] {
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

  return [
    { kind: "circle", x: headCenter.x, y: headCenter.y, r: rig.head.r * CRITTER_COLLISION.headRScale },
    { kind: "aabb", x: torsoCenter.x, y: torsoCenterY, hw: torsoHw, hh: torsoHh },
    ...tail.map((seg) => ({ kind: "circle" as const, x: seg.center.x, y: seg.center.y, r: seg.r })),
  ];
}

export function critterHitTestCircle(worm: Worm, x: number, y: number, r: number): boolean {
  if (!worm.alive) return false;
  const shapes = buildCritterHitShapes(worm);

  for (const shape of shapes) {
    if (circleIntersectsShape(x, y, r, shape)) return true;
  }
  return false;
}

export function critterSweepHitTestCircle(
  worm: Worm,
  fromX: number,
  fromY: number,
  toX: number,
  toY: number,
  r: number
): number | null {
  if (!worm.alive) return null;
  const shapes = buildCritterHitShapes(worm);
  let firstHitT: number | null = null;
  for (const shape of shapes) {
    const t = sweepCircleIntersectsShape(fromX, fromY, toX, toY, r, shape);
    if (t === null) continue;
    if (firstHitT === null || t < firstHitT) {
      firstHitT = t;
    }
  }
  return firstHitT;
}
