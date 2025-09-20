import { WORLD, COLORS, clamp, randRange } from "../definitions";
import { groundTiles } from "../assets";
export class Terrain {
  width: number;
  height: number;
  solid: Uint8Array; // 1 = solid, 0 = air
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  heightMap: number[];
  private tilePattern: CanvasPattern | null = null;

  constructor(width: number, height: number) {
    this.width = width | 0;
    this.height = height | 0;
    this.solid = new Uint8Array(this.width * this.height);
    this.canvas = document.createElement("canvas");
    this.canvas.width = this.width;
    this.canvas.height = this.height;
    const ctx = this.canvas.getContext("2d");
    if (!ctx) throw new Error("Terrain 2D context missing");
    this.ctx = ctx;
    this.heightMap = new Array(this.width).fill(this.height * 0.7);
  }

  generate(seed = Math.random()) {
    // Select and start loading a seamless ground tile (bundled by Vite)
    const idx = Math.floor(Math.random() * groundTiles.length);
    const tileUrl = groundTiles[idx] ?? groundTiles[0]!;
    this.loadTile(tileUrl);

    // Generate height map using layered sines + jitter
    const base = this.height * randRange(WORLD.minGround, WORLD.maxGround);
    const amp1 = this.height * 0.08;
    const amp2 = this.height * 0.04;
    const amp3 = this.height * 0.02;
    const k1 = randRange(0.005, 0.01);
    const k2 = randRange(0.01, 0.02);
    const k3 = randRange(0.02, 0.04);

    for (let x = 0; x < this.width; x++) {
      const h =
        base +
        Math.sin(x * k1 + seed * 10) * amp1 +
        Math.sin(x * k2 + seed * 20) * amp2 +
        Math.sin(x * k3 + seed * 30) * amp3 +
        randRange(-10, 10);
      this.heightMap[x] = clamp(h, this.height * 0.35, this.height * 0.9);
    }

    // Build solid mask
    for (let x = 0; x < this.width; x++) {
      const groundY = Math.floor(this.heightMap[x]!);
      for (let y = 0; y < this.height; y++) {
        this.setSolid(x, y, y >= groundY ? 1 : 0);
      }
    }

    // Draw terrain visuals
    this.redrawVisual();
    // Add grass edge
    this.drawGrass();
  }

  private redrawVisual() {
    const ctx = this.ctx;
    ctx.clearRect(0, 0, this.width, this.height);
    // Dirt gradient
    const grad = ctx.createLinearGradient(0, this.height * 0.5, 0, this.height);
    grad.addColorStop(0, COLORS.dirt);
    grad.addColorStop(1, COLORS.dirtDark);

    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.moveTo(0, this.height);
    for (let x = 0; x < this.width; x++) {
      ctx.lineTo(x, this.heightMap[x]!);
    }
    ctx.lineTo(this.width, this.height);
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
    for (let x = 0; x < this.width; x += 1) {
      const y = Math.floor(this.heightMap[x]!) - 1;
      ctx.moveTo(x, y - 1);
      ctx.lineTo(x + 2, y - 1 - Math.random() * 2);
    }
    ctx.stroke();
    ctx.restore();

    // Top grass fill
    ctx.save();
    ctx.fillStyle = COLORS.grass;
    ctx.beginPath();
    for (let x = 0; x < this.width; x++) {
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

 private applyTilePattern() {
   if (!this.tilePattern) return;
   const ctx = this.ctx;
   ctx.save();
   ctx.globalCompositeOperation = "source-in";
   ctx.fillStyle = this.tilePattern;
   ctx.fillRect(0, 0, this.width, this.height);
   ctx.restore();

   // Re-add grass overlay above the tiled fill
   this.drawGrass();
 }

 setSolid(x: number, y: number, value: 0 | 1) {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return;
    this.solid[y * this.width + x] = value;
  }

  isSolid(x: number, y: number) {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return false;
    return this.solid[y * this.width + x] === 1;
  }

  carveCircle(cx: number, cy: number, r: number) {
    const x0 = Math.max(0, Math.floor(cx - r));
    const y0 = Math.max(0, Math.floor(cy - r));
    const x1 = Math.min(this.width - 1, Math.ceil(cx + r));
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
    // Visual erase
    this.ctx.save();
    this.ctx.globalCompositeOperation = "destination-out";
    this.ctx.beginPath();
    this.ctx.arc(cx, cy, r, 0, Math.PI * 2);
    this.ctx.fill();
    this.ctx.restore();
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
    // Sample around the circle perimeter and center
    const steps = 16;
    if (this.isSolid(Math.round(cx), Math.round(cy))) return true;
    for (let i = 0; i < steps; i++) {
      const a = (i / steps) * Math.PI * 2;
      const x = Math.round(cx + Math.cos(a) * r);
      const y = Math.round(cy + Math.sin(a) * r);
      if (this.isSolid(x, y)) return true;
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
    ctx.drawImage(this.canvas, 0, 0);
  }
}