import { WeaponType } from "../definitions";
import { Terrain } from "./terrain";

export type ExplosionHandler = (
  x: number,
  y: number,
  radius: number,
  damage: number,
  cause: WeaponType
) => void;

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