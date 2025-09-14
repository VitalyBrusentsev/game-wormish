import {
  WORLD,
  COLORS,
  TeamId,
  clamp,
  randRange,
  distance,
  WeaponType,
} from "./definitions";
import { drawHealthBar } from "./utils";

type ExplosionHandler = (
  x: number,
  y: number,
  radius: number,
  damage: number,
  cause: WeaponType
) => void;

export class Terrain {
  width: number;
  height: number;
  solid: Uint8Array; // 1 = solid, 0 = air
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  heightMap: number[];

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
      const groundY = Math.floor(this.heightMap[x]);
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
      ctx.lineTo(x, this.heightMap[x]);
    }
    ctx.lineTo(this.width, this.height);
    ctx.closePath();
    ctx.fill();

    // Sand at bottom
    ctx.fillStyle = COLORS.sand;
    ctx.fillRect(0, this.height - 20, this.width, 20);
  }

  private drawGrass() {
    const ctx = this.ctx;
    ctx.save();
    ctx.lineWidth = 3;
    ctx.strokeStyle = COLORS.grassHighlight;
    ctx.beginPath();
    for (let x = 0; x < this.width; x += 1) {
      const y = Math.floor(this.heightMap[x]) - 1;
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
      const y = Math.floor(this.heightMap[x]);
      ctx.rect(x, y - 5, 2, 6);
    }
    ctx.globalAlpha = 0.3;
    ctx.fill();
    ctx.restore();
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

export class Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  maxLife: number;
  r: number;
  color: string;
  gravity: number;
  constructor(
    x: number,
    y: number,
    vx: number,
    vy: number,
    life: number,
    r: number,
    color: string,
    gravity = WORLD.gravity * 0.2
  ) {
    this.x = x;
    this.y = y;
    this.vx = vx;
    this.vy = vy;
    this.life = life;
    this.maxLife = life;
    this.r = r;
    this.color = color;
    this.gravity = gravity;
  }
  update(dt: number, terrain: Terrain) {
    this.life -= dt;
    this.vy += this.gravity * dt;
    this.x += this.vx * dt;
    this.y += this.vy * dt;
    // Collide with ground lightly
    if (terrain.isSolid(Math.round(this.x), Math.round(this.y))) {
      this.vx *= 0.4;
      this.vy *= -0.3;
      this.y -= 2;
    }
  }
  render(ctx: CanvasRenderingContext2D) {
    const t = Math.max(0, Math.min(1, this.life / this.maxLife));
    ctx.globalAlpha = t * 0.8;
    ctx.beginPath();
    ctx.arc(this.x, this.y, Math.max(0, this.r * t), 0, Math.PI * 2);
    ctx.fillStyle = this.color;
    ctx.fill();
    ctx.globalAlpha = 1;
  }
}

export class Worm {
  x: number;
  y: number;
  vx: number;
  vy: number;
  radius: number;
  team: TeamId;
  health: number;
  alive: boolean;
  facing: number; // -1 left, 1 right
  onGround: boolean;
  name: string;

  constructor(x: number, y: number, team: TeamId, name: string) {
    this.x = x;
    this.y = y;
    this.vx = 0;
    this.vy = 0;
    this.radius = WORLD.wormRadius;
    this.team = team;
    this.health = 100;
    this.alive = true;
    this.facing = 1;
    this.onGround = false;
    this.name = name;
  }

  applyImpulse(ix: number, iy: number) {
    this.vx += ix;
    this.vy += iy;
  }

  takeDamage(amount: number) {
    this.health = Math.max(0, this.health - Math.floor(amount));
    if (this.health <= 0) this.alive = false;
  }

  update(dt: number, terrain: Terrain, moveX: number, jump: boolean) {
    if (!this.alive) return;
    // Horizontal input
    const targetVx = moveX * WORLD.walkSpeed;
    const accel = 800;
    if (Math.abs(targetVx - this.vx) < 5) {
      this.vx = targetVx;
    } else {
      this.vx += Math.sign(targetVx - this.vx) * accel * dt;
      // Clamp
      if ((targetVx >= 0 && this.vx > targetVx) || (targetVx < 0 && this.vx < targetVx)) {
        this.vx = targetVx;
      }
    }
    if (moveX !== 0) this.facing = Math.sign(moveX);

    // Jump
    if (this.onGround && jump) {
      this.vy = -WORLD.jumpSpeed;
      this.onGround = false;
    }

    // Gravity
    this.vy += WORLD.gravity * dt;

    // Integrate with simple terrain collisions
    // Horizontal
    let nx = this.x + this.vx * dt;
    let ny = this.y;

    // Try step-up when hitting wall
    if (terrain.circleCollides(nx, ny, this.radius)) {
      let climbed = false;
      for (let step = 1; step <= 8; step++) {
        if (!terrain.circleCollides(nx, ny - step, this.radius)) {
          ny -= step;
          climbed = true;
          break;
        }
      }
      if (!climbed) {
        nx = this.x; // block horizontal
        this.vx = 0;
      }
    }

    // Vertical
    ny = ny + this.vy * dt;
    let onGround = false;
    if (terrain.circleCollides(nx, ny, this.radius)) {
      if (this.vy > 0) {
        // Falling: push up
        for (let step = 0; step <= 14; step++) {
          if (!terrain.circleCollides(nx, ny - step, this.radius)) {
            ny -= step;
            onGround = true;
            this.vy = 0;
            break;
          }
        }
      } else if (this.vy < 0) {
        // ascending: push down
        for (let step = 0; step <= 14; step++) {
          if (!terrain.circleCollides(nx, ny + step, this.radius)) {
            ny += step;
            this.vy = 0;
            break;
          }
        }
      }
      // If still colliding, try resolve
      const res = terrain.resolveCircle(nx, ny, this.radius);
      nx = res.x;
      ny = res.y;
      onGround = onGround || res.onGround;
    }

    this.x = nx;
    this.y = ny;
    this.onGround = onGround;
  }

  render(ctx: CanvasRenderingContext2D, highlight = false) {
    // Always render: alive worms or a tombstone for fallen ones
    ctx.save();
    ctx.translate(this.x, this.y);

    // Shadow
    ctx.globalAlpha = 0.25;
    ctx.fillStyle = "#000";
    ctx.beginPath();
    ctx.ellipse(0, this.radius - 4, this.radius * 0.9, this.radius * 0.4, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;

    if (!this.alive) {
      // Cute little tombstone
      ctx.fillStyle = "#c9c4bf";
      ctx.strokeStyle = "rgba(0,0,0,0.25)";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(-10, 0);
      ctx.lineTo(-10, -12);
      ctx.quadraticCurveTo(0, -20, 10, -12);
      ctx.lineTo(10, 0);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();

      // Engraving (simple cross)
      ctx.strokeStyle = "#7a7570";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(-3, -10);
      ctx.lineTo(3, -10);
      ctx.moveTo(0, -14);
      ctx.lineTo(0, -6);
      ctx.stroke();

      ctx.restore();
      return;
    }

    // Alive: draw worm body
    const bodyColor = this.team === "Red" ? "#ff9aa9" : "#9ad0ff";
    ctx.fillStyle = bodyColor;
    ctx.strokeStyle = "rgba(0,0,0,0.25)";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(0, 0, this.radius, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();

    // Eyes
    ctx.save();
    ctx.translate(this.facing * 3, -3);
    ctx.fillStyle = "#fff";
    ctx.beginPath();
    ctx.arc(-4, 0, 3, 0, Math.PI * 2);
    ctx.arc(4, 0, 3, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#000";
    ctx.beginPath();
    ctx.arc(-4 + this.facing * 1.2, 0.5, 1.5, 0, Math.PI * 2);
    ctx.arc(4 + this.facing * 1.2, 0.5, 1.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    // Team band
    ctx.strokeStyle = this.team === "Red" ? COLORS.red : COLORS.blue;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(0, 0, this.radius - 2, Math.PI * 0.25, Math.PI * 0.75);
    ctx.stroke();

    // Highlight ring for active
    if (highlight) {
      ctx.globalAlpha = 0.8;
      ctx.strokeStyle = "#fff";
      ctx.lineWidth = 2;
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.arc(0, 0, this.radius + 4, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.globalAlpha = 1;
    }

    // Individual health bar above the worm
    const hbW = 34;
    const hbH = 6;
    drawHealthBar(
      ctx,
      0, // centered at worm
      -this.radius - 18,
      hbW,
      hbH,
      this.health / 100,
      COLORS.healthGreen,
      "rgba(0,0,0,0.35)"
    );

    ctx.restore();
  }
}

export class Projectile {
  x: number;
  y: number;
  vx: number;
  vy: number;
  r: number;
  type: WeaponType;
  fuse: number; // for hand grenade
  restitution: number; // bounce for hand grenade
  wind: number;
  exploded: boolean;
  age: number;
  explosionHandler: ExplosionHandler;

  constructor(
    x: number,
    y: number,
    vx: number,
    vy: number,
    r: number,
    type: WeaponType,
    wind: number,
    explosionHandler: ExplosionHandler,
    options?: { fuse?: number; restitution?: number }
  ) {
    this.x = x;
    this.y = y;
    this.vx = vx;
    this.vy = vy;
    this.r = r;
    this.type = type;
    this.fuse = options?.fuse ?? 0;
    this.restitution = options?.restitution ?? 0;
    this.wind = wind;
    this.exploded = false;
    this.age = 0;
    this.explosionHandler = explosionHandler;
  }

  update(
    dt: number,
    terrain: Terrain,
    specs: {
      gravity: number;
      explosionRadius: number;
      damage: number;
      maxLifetime?: number;
    }
  ) {
    if (this.exploded) return;

    // Time
    this.age += dt;

    if (this.type === WeaponType.HandGrenade) {
      this.fuse -= dt * 1000;
      if (this.fuse <= 0) {
        this.explode(specs);
        return;
      }
    }

    // Physics
    if (this.type !== WeaponType.Rifle) {
      this.vy += specs.gravity * dt;
      // Wind affects horizontally except for rifle
      this.vx += this.wind * dt;
    }

    const steps = 3; // substeps reduce tunneling
    for (let i = 0; i < steps; i++) {
      const nx = this.x + (this.vx * dt) / steps;
      const ny = this.y + (this.vy * dt) / steps;
      // Collision with terrain
      if (terrain.circleCollides(nx, ny, this.r)) {
        if (this.type === WeaponType.HandGrenade) {
          // Bounce
          const prevX = this.x;
          const prevY = this.y;
          let nxv = nx - prevX;
          let nyv = ny - prevY;
          const len = Math.hypot(nxv, nyv) || 1;
          nxv /= len;
          nyv /= len;
          // invert velocity with restitution
          if (Math.abs(nyv) > Math.abs(nxv)) {
            // Vertical hit
            this.vy *= -this.restitution;
          } else {
            this.vx *= -this.restitution;
          }
          // Nudge out of terrain
          const res = terrain.resolveCircle(this.x, this.y, this.r, 6);
          this.x = res.x;
          this.y = res.y - 1;
        } else {
          // Impact explode (Bazooka, Rifle)
          this.explode(specs);
          return;
        }
      } else {
        this.x = nx;
        this.y = ny;
      }
    }

    // Off-screen or lifetime
    const out =
      this.y > terrain.height + 200 ||
      this.x < -200 ||
      this.x > terrain.width + 200;
    if (out) {
      this.exploded = true;
    }
    if (this.type === WeaponType.Rifle && specs.maxLifetime && this.age >= specs.maxLifetime) {
      this.exploded = true;
    }
  }

  explode(specs: { explosionRadius: number; damage: number }) {
    if (this.exploded) return;
    this.exploded = true;
    this.explosionHandler(this.x, this.y, specs.explosionRadius, specs.damage, this.type);
  }

  render(ctx: CanvasRenderingContext2D) {
    if (this.exploded) return;
    ctx.save();
    ctx.translate(this.x, this.y);
    const ang = Math.atan2(this.vy, this.vx);
    ctx.rotate(ang);
    // Body
    if (this.type === WeaponType.Bazooka) {
      ctx.fillStyle = "#666";
      ctx.strokeStyle = "#222";
      ctx.lineWidth = 2;
      ctx.beginPath();
      // @ts-ignore roundRect is widely supported on Canvas2D
      ctx.roundRect(-10, -4, 20, 8, 3);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = "#ff5533";
      ctx.beginPath();
      ctx.arc(10, 0, 3, 0, Math.PI * 2);
      ctx.fill();
    } else if (this.type === WeaponType.HandGrenade) {
      // Hand Grenade
      ctx.fillStyle = "#2e8b57";
      ctx.strokeStyle = "#1b4f32";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(0, 0, this.r, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      // Fuse
      ctx.strokeStyle = "#888";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(0, -this.r);
      ctx.lineTo(4, -this.r - 6);
      ctx.stroke();
    } else {
      // Rifle bullet (small tracer)
      ctx.strokeStyle = "#ffd84d";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(-6, 0);
      ctx.lineTo(6, 0);
      ctx.stroke();
      ctx.fillStyle = "#fff";
      ctx.beginPath();
      ctx.arc(6, 0, 1.5, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }
}

