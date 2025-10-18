import { WORLD, COLORS, clamp } from "../definitions";
import { groundTiles } from "../assets";

export class Terrain {
  width: number;
  height: number;
  solid: Uint8Array; // 1 = solid, 0 = air
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  heightMap: number[];
  private tilePattern: CanvasPattern | null = null;
  private readonly horizontalPadding: number;
  private readonly totalWidth: number;
  private readonly random: () => number;

  constructor(
    width: number,
    height: number,
    options?: { horizontalPadding?: number; random?: () => number }
  ) {
    this.width = width | 0;
    this.height = height | 0;
    this.horizontalPadding = Math.max(0, Math.floor(options?.horizontalPadding ?? 0));
    this.totalWidth = this.width + this.horizontalPadding * 2;
    this.solid = new Uint8Array(this.totalWidth * this.height);
    this.canvas = document.createElement("canvas");
    this.canvas.width = this.totalWidth;
    this.canvas.height = this.height;
    const ctx = this.canvas.getContext("2d");
    if (!ctx) throw new Error("Terrain 2D context missing");
    this.ctx = ctx;
    this.heightMap = new Array(this.totalWidth).fill(this.height * 0.7);
    this.random = options?.random ?? Math.random;
  }

  get worldLeft() {
    return -this.horizontalPadding;
  }

  get worldRight() {
    return this.width + this.horizontalPadding;
  }

  generate(seed = this.random()) {
    // Select and start loading a seamless ground tile (bundled by Vite)
    const idx = Math.floor(this.random() * groundTiles.length);
    const tileUrl = groundTiles[idx] ?? groundTiles[0]!;
    this.loadTile(tileUrl);

    // Generate height map using layered sines + jitter
    const base = this.height * this.randomRange(WORLD.minGround, WORLD.maxGround);
    const amp1 = this.height * 0.08;
    const amp2 = this.height * 0.04;
    const amp3 = this.height * 0.02;
    const k1 = this.randomRange(0.005, 0.01);
    const k2 = this.randomRange(0.01, 0.02);
    const k3 = this.randomRange(0.02, 0.04);

    for (let x = 0; x < this.totalWidth; x++) {
      const worldX = x - this.horizontalPadding;
      const h =
        base +
        Math.sin(worldX * k1 + seed * 10) * amp1 +
        Math.sin(worldX * k2 + seed * 20) * amp2 +
        Math.sin(worldX * k3 + seed * 30) * amp3 +
        this.randomRange(-10, 10);
      this.heightMap[x] = clamp(h, this.height * 0.35, this.height * 0.9);
    }

    // Build solid mask
    for (let x = 0; x < this.totalWidth; x++) {
      const groundY = Math.floor(this.heightMap[x]!);
      for (let y = 0; y < this.height; y++) {
        this.setSolidInternal(x, y, y >= groundY ? 1 : 0);
      }
    }

    // Draw terrain visuals
    this.repaint();
  }

  repaint() {
    this.redrawVisual();
    if (this.tilePattern) this.applyTilePattern();
    else this.drawGrass();
  }

  syncHeightMapFromSolid() {
    this.updateHeightMapRange(0, this.totalWidth - 1, true);
  }

  private redrawVisual() {
    const ctx = this.ctx;
    ctx.clearRect(0, 0, this.totalWidth, this.height);
    // Dirt gradient
    const grad = ctx.createLinearGradient(0, this.height * 0.5, 0, this.height);
    grad.addColorStop(0, COLORS.dirt);
    grad.addColorStop(1, COLORS.dirtDark);

    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.moveTo(0, this.height);
    for (let x = 0; x < this.totalWidth; x++) {
      ctx.lineTo(x, this.heightMap[x]!);
    }
    ctx.lineTo(this.totalWidth, this.height);
    ctx.closePath();
    ctx.fill();

    // Tiled pattern overlay will be applied asynchronously once the tile image loads.
  }

  private drawGrass() {
    const ctx = this.ctx;
    ctx.save();
    ctx.lineWidth = 3;
    ctx.strokeStyle = COLORS.grassHighlight;
    ctx.beginPath();
    for (let x = 0; x < this.totalWidth; x += 1) {
      const y = Math.floor(this.heightMap[x]!) - 1;
      ctx.moveTo(x, y - 1);
      ctx.lineTo(x + 2, y - 1 - this.random() * 2);
    }
    ctx.stroke();
    ctx.restore();

    // Top grass fill
    ctx.save();
    ctx.fillStyle = COLORS.grass;
    ctx.beginPath();
    for (let x = 0; x < this.totalWidth; x++) {
      const y = Math.floor(this.heightMap[x]!);
      ctx.rect(x, y - 5, 2, 6);
    }
    ctx.globalAlpha = 0.3;
    ctx.fill();
    ctx.restore();
  }

  // Load tile image and overlay pattern once ready
  private loadTile(url: string) {
    const img = new Image();
    img.onload = () => {
      const pat = this.ctx.createPattern(img, "repeat");
      if (pat) {
        this.tilePattern = pat;
        // Overlay pattern over existing ground while preserving carved holes
        this.applyTilePattern();
      }
    };
    img.src = url;
  }

  private randomRange(min: number, max: number) {
    return this.random() * (max - min) + min;
  }

  private applyTilePattern() {
    if (!this.tilePattern) return;
    const ctx = this.ctx;
    ctx.save();
    ctx.globalCompositeOperation = "source-in";
    ctx.fillStyle = this.tilePattern;
    ctx.fillRect(0, 0, this.totalWidth, this.height);
    ctx.restore();

    // Re-add grass overlay above the tiled fill
    this.drawGrass();
  }

  private toInternalX(x: number) {
    return Math.round(x + this.horizontalPadding);
  }

  private setSolidInternal(ix: number, y: number, value: 0 | 1) {
    if (ix < 0 || y < 0 || ix >= this.totalWidth || y >= this.height) return;
    this.solid[y * this.totalWidth + ix] = value;
  }

  setSolid(x: number, y: number, value: 0 | 1) {
    if (y < 0 || y >= this.height) return;
    const ix = this.toInternalX(x);
    if (ix < 0 || ix >= this.totalWidth) return;
    this.solid[y * this.totalWidth + ix] = value;
  }

  isSolid(x: number, y: number) {
    if (y < 0 || y >= this.height) return false;
    const ix = this.toInternalX(x);
    if (ix < 0 || ix >= this.totalWidth) return false;
    return this.solid[y * this.totalWidth + ix] === 1;
  }

  carveCircle(cx: number, cy: number, r: number) {
    const minX = Math.floor(this.worldLeft);
    const maxX = Math.ceil(this.worldRight);
    const x0 = Math.max(minX, Math.floor(cx - r));
    const y0 = Math.max(0, Math.floor(cy - r));
    const x1 = Math.min(maxX, Math.ceil(cx + r));
    const y1 = Math.min(this.height - 1, Math.ceil(cy + r));
    const rr = r * r;
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const dx = x + 0.5 - cx;
        const dy = y + 0.5 - cy;
        if (dx * dx + dy * dy <= rr) {
          this.setSolid(x, y, 0);
        }
      }
    }
    this.updateHeightMapRange(
      Math.max(0, Math.floor(x0 + this.horizontalPadding)),
      Math.min(this.totalWidth - 1, Math.ceil(x1 + this.horizontalPadding))
    );
    // Visual erase
    this.ctx.save();
    this.ctx.globalCompositeOperation = "destination-out";
    this.ctx.beginPath();
    this.ctx.arc(cx + this.horizontalPadding, cy, r, 0, Math.PI * 2);
    this.ctx.fill();
    this.ctx.restore();
  }

  private updateHeightMapRange(ixStart: number, ixEnd: number, preserveExisting = false) {
    const start = Math.max(0, Math.min(ixStart, ixEnd));
    const end = Math.min(this.totalWidth - 1, Math.max(ixStart, ixEnd));
    for (let ix = start; ix <= end; ix++) {
      const topRow = this.findTopSolidRow(ix);
      if (preserveExisting) {
        const current = this.heightMap[ix];
        if (current !== undefined && Math.floor(current) === topRow) {
          continue;
        }
      }
      this.heightMap[ix] = topRow;
    }
  }

  private findTopSolidRow(ix: number) {
    for (let y = 0; y < this.height; y++) {
      if (this.solid[y * this.totalWidth + ix] === 1) {
        return y;
      }
    }
    return this.height;
  }

  // Simple raycast against solid cells; returns hit point or null
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
    // Robust method: grid-overlap scan in the circle AABB
    return this.circleOverlapsSolidGrid(cx, cy, r);
  }

  // Robust circle-vs-grid overlap: scans solid pixels within the circle's bounding box.
  // Uses cell-center distance check, consistent with carveCircle.
  private circleOverlapsSolidGrid(cx: number, cy: number, r: number): boolean {
    // Robust rectangle-distance check: for each solid cell intersecting the circle's AABB,
    // compute the closest point on the cell rectangle to the circle center and compare distance.
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
        // Cell rectangle [x, x+1] x [y, y+1]
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
    // If colliding, try push upwards up to climbStep
    let x = cx;
    let y = cy;
    let onGround = false;
    if (this.circleCollides(x, y, r)) {
      for (let i = 1; i <= climbStep; i++) {
        if (!this.circleCollides(x, y - i, r)) {
          y -= i;
          onGround = true;
          return { x, y, collided: true, onGround };
        }
      }
      // Can't resolve by climbing — push outward by scanning radial
      // small brute force search
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

  render(ctx: CanvasRenderingContext2D) {
    ctx.drawImage(this.canvas, -this.horizontalPadding, 0);
  }
}
