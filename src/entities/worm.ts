import { WORLD, TeamId, COLORS } from "../definitions";
import { drawHealthBar } from "../utils";
import { Terrain } from "./terrain";

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