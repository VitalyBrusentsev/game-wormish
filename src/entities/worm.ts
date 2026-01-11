import { WORLD, COLORS } from "../definitions";
import type { TeamId } from "../definitions";
import { drawHealthBar } from "../utils";
import type { Terrain } from "./terrain";

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
  age: number;

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
    this.age = 0;
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
    const alive = this.alive;
    if (alive) {
      this.age += dt;
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
    } else {
      const drag = 7.5;
      const damping = Math.exp(-drag * dt);
      this.vx *= damping;
      if (Math.abs(this.vx) < 0.25) this.vx = 0;
      jump = false;
      moveX = 0;
    }

    // Snapshot previous on-ground state for this frame and use a sticky latch
    const prevOnGround = this.onGround;
    let grounded = prevOnGround;      // working flag used for support + gravity gating this frame
    let latchPrev = prevOnGround;     // preserved previous-frame support unless an explicit jump occurs

    // Jump
    if (alive && prevOnGround && jump) {
      this.vy = -WORLD.jumpSpeed;
      grounded = false;
      latchPrev = false; // jumping clears the previous support latch for this frame
    }

    // Gravity is applied after horizontal resolution to avoid ground jitter.

    // Integrate with simple terrain collisions
    // Horizontal
    let nx = this.x + this.vx * dt;
    let ny = this.y;

        // Try step-up when hitting wall (only when actually moving horizontally)
        if (nx !== this.x && terrain.circleCollides(nx, ny, this.radius)) {
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

        // Ground support check and gravity after horizontal step to prevent jitter
        if (grounded) {
          // Tolerant support check to reduce aliasing near jagged surfaces
          let supported = false;
          for (let off = 1; off <= 6; off++) {
            if (terrain.circleCollides(nx, ny + off, this.radius)) {
              supported = true;
              break;
            }
          }
          if (!supported) grounded = false;
        }
        if (!grounded) {
          this.vy += WORLD.gravity * dt;
        } else {
          this.vy = 0;
        }

    // Vertical
    const wasSupported = latchPrev;
    ny = ny + this.vy * dt;
    let onGround = false;
    if (terrain.circleCollides(nx, ny, this.radius)) {
      if (this.vy > 0) {
        // Falling: push up
        {
          const maxStep = Math.max(20, this.radius + 32);
          for (let step = 0; step <= maxStep; step++) {
            if (!terrain.circleCollides(nx, ny - step, this.radius)) {
              ny -= step;
              onGround = true;
              this.vy = 0;
              break;
            }
          }
        }
      } else if (this.vy < 0) {
        // ascending: push down
        {
          const maxStep = Math.max(20, this.radius + 32);
          for (let step = 0; step <= maxStep; step++) {
            if (!terrain.circleCollides(nx, ny + step, this.radius)) {
              ny += step;
              this.vy = 0;
              break;
            }
          }
        }
      }
      // If still colliding after the step adjustment, try a full resolve
      if (terrain.circleCollides(nx, ny, this.radius)) {
        const res = terrain.resolveCircle(nx, ny, this.radius, Math.max(32, this.radius + 32));
        nx = res.x;
        ny = res.y;
        onGround = onGround || res.onGround;
 
        // Escalate if still colliding (rare steep steps due to height jitter)
        if (terrain.circleCollides(nx, ny, this.radius)) {
          const res2 = terrain.resolveCircle(nx, ny, this.radius, Math.max(64, this.radius + 48));
          nx = res2.x;
          ny = res2.y;
          onGround = onGround || res2.onGround;
 
          // Give up this frame to avoid sinking deeper
          if (terrain.circleCollides(nx, ny, this.radius)) {
            nx = this.x;
            ny = this.y;
            this.vy = 0;
          }
        }
      }
    } else if (this.vy > 0) {
      // Proximity catch: if we're descending and narrowly missing the ground this frame,
      // snap to the nearest support within a small band below to avoid initial tunneling.
      const catchRange = Math.max(8, Math.ceil(this.vy * dt) + 6);
      for (let s = 1; s <= catchRange; s++) {
        if (terrain.circleCollides(nx, ny + s, this.radius)) {
          const res = terrain.resolveCircle(nx, ny + s, this.radius, Math.max(32, this.radius + 32));
          nx = res.x;
          ny = res.y;
          onGround = onGround || res.onGround || true;
          this.vy = 0;
          break;
        }
      }
    }

    this.x = nx;
    this.y = ny;
    this.onGround = wasSupported || onGround;
  }

  render(ctx: CanvasRenderingContext2D, highlight = false) {
    ctx.save();
    ctx.translate(this.x, this.y);

    if (!this.alive) {
      const baseY = this.radius + 1;

      // Shadow
      ctx.globalAlpha = 0.22;
      ctx.fillStyle = "#000";
      ctx.beginPath();
      ctx.ellipse(2.5, baseY + 1, 15, 5.5, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1;

      const w = 22;
      const h = 28;
      const shoulderY = baseY - h + 8;
      const topY = baseY - h - 4;
      const depthX = 4;
      const depthY = -3;

      // Side face (depth)
      ctx.fillStyle = "#a39d97";
      ctx.lineWidth = 2;
      ctx.lineJoin = "round";
      ctx.lineCap = "round";
      ctx.beginPath();
      ctx.moveTo(w / 2, baseY);
      ctx.lineTo(w / 2 + depthX, baseY + depthY);
      ctx.lineTo(w / 2 + depthX, shoulderY + depthY);
      ctx.lineTo(w / 2, shoulderY);
      ctx.closePath();
      ctx.fill();

      // Top face (hint of bevel)
      ctx.fillStyle = "#d7d2cd";
      ctx.beginPath();
      ctx.moveTo(-w / 2, shoulderY);
      ctx.lineTo(-w / 2 + depthX, shoulderY + depthY);
      ctx.quadraticCurveTo(depthX, topY + depthY, w / 2 + depthX, shoulderY + depthY);
      ctx.lineTo(w / 2, shoulderY);
      ctx.quadraticCurveTo(0, topY, -w / 2, shoulderY);
      ctx.closePath();
      ctx.fill();

      // Front face
      ctx.fillStyle = "#c9c4bf";
      ctx.strokeStyle = "rgba(0,0,0,0.22)";
      ctx.beginPath();
      ctx.moveTo(-w / 2, baseY);
      ctx.lineTo(-w / 2, shoulderY);
      ctx.quadraticCurveTo(0, topY, w / 2, shoulderY);
      ctx.lineTo(w / 2, baseY);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();

      // Depth edges
      ctx.strokeStyle = "rgba(0,0,0,0.16)";
      ctx.beginPath();
      ctx.moveTo(w / 2, baseY);
      ctx.lineTo(w / 2 + depthX, baseY + depthY);
      ctx.lineTo(w / 2 + depthX, shoulderY + depthY);
      ctx.stroke();

      // Front bevel highlight
      ctx.strokeStyle = "rgba(255,255,255,0.35)";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(-w / 2 + 2, baseY - 1);
      ctx.lineTo(-w / 2 + 2, shoulderY + 2);
      ctx.stroke();

      // Base slab
      ctx.fillStyle = "#b6b0aa";
      ctx.strokeStyle = "rgba(0,0,0,0.22)";
      ctx.lineWidth = 2;
      const slabX = -w / 2 - 3;
      const slabY = baseY - 4;
      const slabW = w + 10;
      const slabH = 8;
      const slabR = 3;
      ctx.beginPath();
      ctx.moveTo(slabX + slabR, slabY);
      ctx.lineTo(slabX + slabW - slabR, slabY);
      ctx.quadraticCurveTo(slabX + slabW, slabY, slabX + slabW, slabY + slabR);
      ctx.lineTo(slabX + slabW, slabY + slabH - slabR);
      ctx.quadraticCurveTo(
        slabX + slabW,
        slabY + slabH,
        slabX + slabW - slabR,
        slabY + slabH
      );
      ctx.lineTo(slabX + slabR, slabY + slabH);
      ctx.quadraticCurveTo(slabX, slabY + slabH, slabX, slabY + slabH - slabR);
      ctx.lineTo(slabX, slabY + slabR);
      ctx.quadraticCurveTo(slabX, slabY, slabX + slabR, slabY);
      ctx.fill();
      ctx.stroke();

      // Engraving (cross + a little crack)
      ctx.strokeStyle = "#7a7570";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(-4, baseY - 15);
      ctx.lineTo(4, baseY - 15);
      ctx.moveTo(0, baseY - 20);
      ctx.lineTo(0, baseY - 10);
      ctx.stroke();

      ctx.restore();
      return;
    }

    // Shadow
    ctx.globalAlpha = 0.25;
    ctx.fillStyle = "#000";
    ctx.beginPath();
    ctx.ellipse(0, this.radius - 4, this.radius * 0.9, this.radius * 0.4, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;

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
