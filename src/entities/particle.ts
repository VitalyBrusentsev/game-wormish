import { WORLD } from "../definitions";
import { Terrain } from "./terrain";

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
  collideTerrain: boolean;
  constructor(
    x: number,
    y: number,
    vx: number,
    vy: number,
    life: number,
    r: number,
    color: string,
    gravity = WORLD.gravity * 0.2,
    collideTerrain = true
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
    this.collideTerrain = collideTerrain;
  }
  update(dt: number, terrain: Terrain) {
    this.life -= dt;
    this.vy += this.gravity * dt;
    this.x += this.vx * dt;
    this.y += this.vy * dt;
    if (this.collideTerrain && terrain.isSolid(Math.round(this.x), Math.round(this.y))) {
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
