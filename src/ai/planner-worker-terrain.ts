import { clamp } from "../definitions";
import type { AiPlannerTerrainSnapshot } from "./planner-worker-types";

export class PlannerTerrain {
  readonly width: number;
  readonly height: number;
  readonly worldLeft: number;
  readonly worldRight: number;
  readonly solid: Uint8Array;
  readonly heightMap: number[];
  private readonly totalWidth: number;

  constructor(snapshot: AiPlannerTerrainSnapshot) {
    this.width = snapshot.width;
    this.height = snapshot.height;
    this.worldLeft = snapshot.worldLeft;
    this.totalWidth = snapshot.totalWidth;
    this.worldRight = this.worldLeft + this.totalWidth;
    this.solid = snapshot.solid;
    this.heightMap = [...snapshot.heightMap];
  }

  private toInternalX(x: number) {
    return Math.round(x - this.worldLeft);
  }

  isSolid(x: number, y: number) {
    if (y < 0 || y >= this.height) return false;
    const ix = this.toInternalX(x);
    if (ix < 0 || ix >= this.totalWidth) return false;
    return this.solid[y * this.totalWidth + ix] === 1;
  }

  raycast(
    ox: number,
    oy: number,
    dx: number,
    dy: number,
    maxDist: number,
    step = 3
  ): { x: number; y: number; dist: number } | null {
    const len = Math.hypot(dx, dy) || 1;
    const vx = (dx / len) * step;
    const vy = (dy / len) * step;
    let x = ox;
    let y = oy;
    let d = 0;
    while (d <= maxDist) {
      if (this.isSolid(Math.round(x), Math.round(y))) {
        return { x, y, dist: d };
      }
      x += vx;
      y += vy;
      d += step;
    }
    return null;
  }

  circleCollides(cx: number, cy: number, r: number): boolean {
    return this.circleOverlapsSolidGrid(cx, cy, r);
  }

  private circleOverlapsSolidGrid(cx: number, cy: number, r: number): boolean {
    const minX = Math.floor(this.worldLeft);
    const maxX = Math.ceil(this.worldRight);
    const x0 = Math.max(minX, Math.floor(cx - r - 1));
    const y0 = Math.max(0, Math.floor(cy - r - 1));
    const x1 = Math.min(maxX, Math.ceil(cx + r + 1));
    const y1 = Math.min(this.height - 1, Math.ceil(cy + r + 1));
    const rr = r * r;
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        if (!this.isSolid(x, y)) continue;
        const closestX = clamp(cx, x, x + 1);
        const closestY = clamp(cy, y, y + 1);
        const dx = cx - closestX;
        const dy = cy - closestY;
        if (dx * dx + dy * dy <= rr) {
          return true;
        }
      }
    }
    return false;
  }

  resolveCircle(
    cx: number,
    cy: number,
    r: number,
    climbStep = 6
  ): { x: number; y: number; collided: boolean; onGround: boolean } {
    let x = cx;
    let y = cy;
    if (this.circleCollides(x, y, r)) {
      for (let i = 1; i <= climbStep; i++) {
        if (!this.circleCollides(x, y - i, r)) {
          y -= i;
          return { x, y, collided: true, onGround: true };
        }
      }
      for (let radius = 1; radius <= r + 2; radius++) {
        const steps = 16;
        for (let k = 0; k < steps; k++) {
          const a = (k / steps) * Math.PI * 2;
          const nx = x + Math.cos(a) * radius;
          const ny = y + Math.sin(a) * radius;
          if (!this.circleCollides(nx, ny, r)) {
            return { x: nx, y: ny, collided: true, onGround: false };
          }
        }
      }
      return { x, y, collided: true, onGround: false };
    }
    return { x, y, collided: false, onGround: false };
  }
}
