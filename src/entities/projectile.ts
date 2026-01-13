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
  distanceTraveled: number;
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
    this.distanceTraveled = 0;
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
      maxDistance?: number;
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
    if (this.type !== WeaponType.Rifle && this.type !== WeaponType.Uzi) {
      this.vy += specs.gravity * dt;
      // Wind affects horizontally except for rifle
      this.vx += this.wind * dt;
    }

    const steps = 3; // substeps reduce tunneling
    for (let i = 0; i < steps; i++) {
      const nx = this.x + (this.vx * dt) / steps;
      const ny = this.y + (this.vy * dt) / steps;
      this.distanceTraveled += Math.hypot(nx - this.x, ny - this.y);
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
    if (specs.maxDistance && this.distanceTraveled >= specs.maxDistance) {
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
      const radius = this.r;
      // Hand Grenade body with subtle highlight
      const bodyGradient = ctx.createRadialGradient(
        -radius * 0.35,
        -radius * 0.35,
        radius * 0.15,
        0,
        0,
        radius
      );
      bodyGradient.addColorStop(0, "#5a5a5a");
      bodyGradient.addColorStop(0.4, "#2b2b2b");
      bodyGradient.addColorStop(1, "#050505");
      ctx.fillStyle = bodyGradient;
      ctx.strokeStyle = "#0a0a0a";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(0, 0, radius, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();

      // Glint highlight to emphasize the spherical surface
      ctx.save();
      ctx.rotate(-Math.PI / 8);
      ctx.beginPath();
      ctx.ellipse(-radius * 0.35, -radius * 0.4, radius * 0.45, radius * 0.2, 0, 0, Math.PI * 2);
      const glintGradient = ctx.createRadialGradient(
        -radius * 0.4,
        -radius * 0.4,
        0,
        -radius * 0.35,
        -radius * 0.35,
        radius * 0.45
      );
      glintGradient.addColorStop(0, "rgba(255, 255, 255, 0.35)");
      glintGradient.addColorStop(1, "rgba(255, 255, 255, 0)");
      ctx.fillStyle = glintGradient;
      ctx.fill();
      ctx.restore();

      // Fuse with glowing particles
      const fuseStartX = 0;
      const fuseStartY = -radius;
      const fuseEndX = 4;
      const fuseEndY = -radius - 6;
      ctx.strokeStyle = "#3c3c3c";
      ctx.lineWidth = 3;
      ctx.lineCap = "round";
      ctx.beginPath();
      ctx.moveTo(fuseStartX, fuseStartY);
      ctx.lineTo(fuseEndX, fuseEndY);
      ctx.stroke();

      const flicker = (Math.sin(this.age * 40) + 1) / 2;
      const emberRadius = 2.4 + flicker * 0.8;
      const emberGradient = ctx.createRadialGradient(
        fuseEndX,
        fuseEndY,
        0,
        fuseEndX,
        fuseEndY,
        emberRadius
      );
      emberGradient.addColorStop(0, "#fff9c4");
      emberGradient.addColorStop(0.5, "#ffb347");
      emberGradient.addColorStop(1, "rgba(255, 69, 0, 0)");
      ctx.fillStyle = emberGradient;
      ctx.beginPath();
      ctx.arc(fuseEndX, fuseEndY, emberRadius, 0, Math.PI * 2);
      ctx.fill();

      // Glowing particles flying off the fuse
      for (let i = 0; i < 4; i++) {
        const t = this.age * 60 + i * 1.7;
        const particleDist = 2.2 + i * 0.6 + flicker * 0.8;
        const particleSize = 0.9 + (3 - i) * 0.2;
        const px = fuseEndX + Math.cos(t) * particleDist;
        const py = fuseEndY + Math.sin(t) * particleDist * 0.6;
        ctx.globalAlpha = 0.8 - i * 0.15;
        ctx.fillStyle = i === 0 ? "#ffe082" : "#ff8a50";
        ctx.beginPath();
        ctx.arc(px, py, particleSize, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
    } else {
      // Rifle/Uzi bullet (small tracer)
      const isUzi = this.type === WeaponType.Uzi;
      const headX = isUzi ? 4 : 6;
      const trailLength = 40;
      const trailStartX = headX - trailLength;

      ctx.lineCap = "round";

      ctx.shadowColor = "rgba(0, 0, 0, 0.35)";
      ctx.shadowBlur = isUzi ? 4 : 5;
      ctx.shadowOffsetY = 1;
      const outerTrail = ctx.createLinearGradient(trailStartX, 0, headX, 0);
      outerTrail.addColorStop(0, "rgba(255, 216, 77, 0)");
      outerTrail.addColorStop(0.5, isUzi ? "rgba(255, 216, 77, 0.12)" : "rgba(255, 216, 77, 0.18)");
      outerTrail.addColorStop(1, isUzi ? "rgba(255, 232, 140, 0.45)" : "rgba(255, 232, 140, 0.65)");
      ctx.strokeStyle = outerTrail;
      ctx.lineWidth = isUzi ? 3 : 4;
      ctx.beginPath();
      ctx.moveTo(trailStartX, 0);
      ctx.lineTo(headX, 0);
      ctx.stroke();

      ctx.shadowBlur = 0;
      ctx.shadowOffsetY = 0;
      const innerTrail = ctx.createLinearGradient(trailStartX, 0, headX, 0);
      innerTrail.addColorStop(0, "rgba(255, 255, 255, 0)");
      innerTrail.addColorStop(0.6, isUzi ? "rgba(255, 255, 255, 0.22)" : "rgba(255, 255, 255, 0.28)");
      innerTrail.addColorStop(1, isUzi ? "rgba(255, 255, 255, 0.75)" : "rgba(255, 255, 255, 0.9)");
      ctx.strokeStyle = innerTrail;
      ctx.lineWidth = isUzi ? 1.4 : 1.8;
      ctx.beginPath();
      ctx.moveTo(trailStartX, 0);
      ctx.lineTo(headX, 0);
      ctx.stroke();

      const headGradient = ctx.createRadialGradient(headX, 0, 0, headX, 0, isUzi ? 2.2 : 2.8);
      headGradient.addColorStop(0, "rgba(255, 255, 255, 1)");
      headGradient.addColorStop(0.6, isUzi ? "rgba(255, 255, 255, 0.85)" : "rgba(255, 255, 255, 0.95)");
      headGradient.addColorStop(1, "rgba(255, 216, 77, 0)");
      ctx.fillStyle = headGradient;
      ctx.beginPath();
      ctx.arc(headX, 0, isUzi ? 2.2 : 2.8, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }
}
