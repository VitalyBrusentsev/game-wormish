import { COLORS, CRITTER, WORLD, WeaponType, nowMs, clamp } from "../definitions";
import type { TeamId } from "../definitions";
import { computeCritterRig, type BaseCritterPose } from "../critter/critter-geometry";
import { renderCritterFace } from "../critter/critter-face";
import { renderCritterSprites, resolveCritterSpriteOffsets } from "../critter/critter-sprites";
import { drawWeaponSprite } from "../weapons/weapon-sprites";
import { drawHealthBar, drawRoundedRect } from "../utils";
import type { Terrain } from "./terrain";
import { WormVisualAnimator, type MotionSample } from "./worm-visual-animator";
import type { WormMovementSmoothingMode } from "../rendering/worm-animation-setting";

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
  preferredWeapon: WeaponType;
  private saluteStartMs: number | null = null;
  private saluteUntilMs = 0;
  private static readonly saluteTimeScale = 1;
  private readonly visualAnimator: WormVisualAnimator;

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
    this.preferredWeapon = WeaponType.Bazooka;
    this.visualAnimator = new WormVisualAnimator(this.x, this.y);
  }

  getMotionSample(): MotionSample {
    return { x: this.x, y: this.y, vx: this.vx, vy: this.vy };
  }

  queueMovementSmoothing(
    mode: WormMovementSmoothingMode,
    from: MotionSample,
    dtMs: number
  ) {
    this.visualAnimator.scheduleMovementBlend({
      mode,
      nowMs: nowMs(),
      from,
      to: this.getMotionSample(),
      dtMs,
    });
  }

  snapMovementSmoothing() {
    this.visualAnimator.snapToPhysics(this.getMotionSample());
  }

  applyImpulse(ix: number, iy: number) {
    this.vx += ix;
    this.vy += iy;
  }

  takeDamage(amount: number) {
    this.health = Math.max(0, this.health - Math.floor(amount));
    if (this.health <= 0) this.alive = false;
  }

  startSalute(startedAtMs: number) {
    if (!this.alive) return;
    const durationMs = 1100 * Worm.saluteTimeScale;
    const untilMs = startedAtMs + durationMs;
    if (this.saluteStartMs === null || startedAtMs >= this.saluteUntilMs) {
      this.saluteStartMs = startedAtMs;
      this.saluteUntilMs = untilMs;
    } else {
      this.saluteUntilMs = Math.max(this.saluteUntilMs, untilMs);
    }
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

  render(
    ctx: CanvasRenderingContext2D,
    highlight = false,
    aimPose?: { weapon: WeaponType; angle: number; recoil?: { kick01: number } } | null
  ) {
    const now = nowMs();
    const motion = this.visualAnimator.sampleMotion(now, this.getMotionSample());
    ctx.save();
    ctx.translate(motion.x, motion.y);

    if (!this.alive) {
      const baseY = this.radius + 1;

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

    const facing = (this.facing < 0 ? -1 : 1) as -1 | 1;
    const elasticOffsets = this.visualAnimator.computeElasticOffsets({
      nowMs: now,
      motion,
      facing,
      hasWeapon: Boolean(aimPose),
      onGround: this.onGround,
    });
    const renderedAimAngle = aimPose ? aimPose.angle + elasticOffsets.weapon.rockRad : 0;
    const basePose: BaseCritterPose = aimPose
      ? { kind: "aim", weapon: aimPose.weapon, aimAngle: renderedAimAngle }
      : { kind: "idle" };
    const activeLineScale = highlight ? 1.5 : 1;
    const activePulse01 = highlight ? 0.5 + 0.5 * Math.sin(now * 0.008) : 0;
    const saluteActive = this.saluteStartMs !== null && now < this.saluteUntilMs;
    if (this.saluteStartMs !== null && now >= this.saluteUntilMs) {
      this.saluteStartMs = null;
    }

    const computeSaluteAmount01 = () => {
      if (!saluteActive || this.saluteStartMs === null) return 0;
      const elapsed = now - this.saluteStartMs;
      const raiseMs = 220 * Worm.saluteTimeScale;
      const holdMs = 620 * Worm.saluteTimeScale;
      const lowerMs = 260 * Worm.saluteTimeScale;
      const total = raiseMs + holdMs + lowerMs;
      if (elapsed <= 0) return 0;
      if (elapsed >= total) return 0;

      const easeOutCubic = (t: number) => 1 - Math.pow(1 - t, 3);
      const easeInCubic = (t: number) => t * t * t;
      if (elapsed < raiseMs) return easeOutCubic(clamp(elapsed / raiseMs, 0, 1));
      if (elapsed < raiseMs + holdMs) return 1;
      const t = clamp((elapsed - raiseMs - holdMs) / lowerMs, 0, 1);
      return 1 - easeInCubic(t);
    };

    const pickSaluteArm = (pose: BaseCritterPose): "left" | "right" => {
      if (pose.kind !== "aim") return facing > 0 ? "right" : "left";
      if (pose.weapon === WeaponType.Uzi) return facing > 0 ? "left" : "right";
      if (pose.weapon === WeaponType.Rifle || pose.weapon === WeaponType.Bazooka) {
        return facing > 0 ? "right" : "left";
      }
      if (pose.weapon === WeaponType.HandGrenade) return facing > 0 ? "left" : "right";
      return facing > 0 ? "left" : "right";
    };

    const saluteAmount01 = computeSaluteAmount01();
    const saluting = saluteAmount01 > 0;
    const saluteArm = saluting ? pickSaluteArm(basePose) : null;
    const pose = saluting
      ? {
          kind: "salute" as const,
          base: basePose,
          arm: saluteArm!,
          amount01: saluteAmount01,
        }
      : basePose;
    const rig = computeCritterRig({ x: 0, y: 0, r: this.radius, facing, pose });
    if (rig.tail.length >= 2) {
      const tail1 = rig.tail[0]!;
      const tail2 = rig.tail[1]!;
      const dx = tail2.center.x - tail1.center.x;
      const dy = tail2.center.y - tail1.center.y;
      rig.tail.push({
        center: { x: tail2.center.x + dx * 0.9, y: tail2.center.y + dy * 0.9 },
        r: tail2.r * 0.72,
      });
    }

    const bodyColor = this.team === "Red" ? "#ff9aa9" : "#9ad0ff";
    const teamColor = this.team === "Red" ? COLORS.red : COLORS.blue;
    const outlineAlpha = highlight ? 0.26 + 0.16 * activePulse01 : 0.25;
    const outline = `rgba(0,0,0,${outlineAlpha.toFixed(3)})`;
    const armColor = this.team === "Red" ? "#ff8b9c" : "#84c6ff";

    const shift = (p: { x: number; y: number }, dx: number, dy: number) => {
      p.x += dx;
      p.y += dy;
    };
    shift(rig.head.center, elasticOffsets.head.x, elasticOffsets.head.y);
    for (let i = 0; i < rig.tail.length; i++) {
      const seg = rig.tail[i];
      const part = elasticOffsets.tail[i];
      if (!seg || !part) continue;
      shift(seg.center, part.x, part.y);
    }

    const weaponBobY = elasticOffsets.weapon.bobY;
    if (rig.weapon && aimPose && Math.abs(weaponBobY) > 0.001) {
      shift(rig.weapon.root, 0, weaponBobY);
      shift(rig.weapon.muzzle, 0, weaponBobY);
      shift(rig.weapon.grip1, 0, weaponBobY);
      if (rig.weapon.grip2) shift(rig.weapon.grip2, 0, weaponBobY);
      for (const side of ["left", "right"] as const) {
        shift(rig.arms[side].upper.a, 0, weaponBobY * 0.35);
        shift(rig.arms[side].upper.b, 0, weaponBobY * 0.8);
        shift(rig.arms[side].lower.a, 0, weaponBobY * 0.8);
        shift(rig.arms[side].lower.b, 0, weaponBobY);
      }
    }

    const baseArmThickness = Math.max(2, this.radius * CRITTER.armThicknessFactor) * 2;
    const armStrokeWidth = baseArmThickness * activeLineScale;
    const strokeArm = (arm: (typeof rig.arms)["left"], alpha: number) => {
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.strokeStyle = armColor;
      ctx.lineWidth = armStrokeWidth;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.beginPath();
      ctx.moveTo(arm.upper.a.x, arm.upper.a.y);
      ctx.lineTo(arm.upper.b.x, arm.upper.b.y);
      ctx.moveTo(arm.lower.a.x, arm.lower.a.y);
      ctx.lineTo(arm.lower.b.x, arm.lower.b.y);
      ctx.stroke();
      ctx.strokeStyle = `rgba(0,0,0,${(highlight ? 0.22 + 0.14 * activePulse01 : 0.22).toFixed(3)})`;
      ctx.lineWidth = Math.max(1, armStrokeWidth * 0.28);
      ctx.stroke();
      ctx.restore();
    };

    const recoilKick01 = clamp(aimPose?.recoil?.kick01 ?? 0, 0, 1);
    if (recoilKick01 > 0) {
      const kickPx = this.radius * 0.22 * recoilKick01;
      const kickDx = -facing * kickPx;
      const kickDy = -kickPx * 0.25;

      for (const seg of rig.tail) shift(seg.center, kickDx, kickDy);
      shift(rig.body.center, kickDx, kickDy);
      shift(rig.head.center, kickDx * 1.35, kickDy * 1.35);

      if (rig.weapon) {
        shift(rig.weapon.root, kickDx, kickDy);
        shift(rig.weapon.muzzle, kickDx, kickDy);
        shift(rig.weapon.grip1, kickDx, kickDy);
        if (rig.weapon.grip2) shift(rig.weapon.grip2, kickDx, kickDy);
      }
      if (rig.grenade) shift(rig.grenade.center, kickDx, kickDy);
      for (const side of ["left", "right"] as const) {
        shift(rig.arms[side].upper.a, kickDx, kickDy);
        shift(rig.arms[side].upper.b, kickDx, kickDy);
        shift(rig.arms[side].lower.a, kickDx, kickDy);
        shift(rig.arms[side].lower.b, kickDx, kickDy);
      }
    }

    if (highlight) {
      const breathDy = Math.sin(now * 0.0042) * 2;
      const visited = new WeakSet<object>();
      const shiftY = (p: { x: number; y: number }) => {
        if (visited.has(p)) return;
        visited.add(p);
        p.y += breathDy;
      };
      shiftY(rig.body.center);
      shiftY(rig.head.center);
      if (rig.weapon) {
        shiftY(rig.weapon.root);
        shiftY(rig.weapon.muzzle);
      }
      if (rig.grenade) shiftY(rig.grenade.center);
      for (const side of ["left", "right"] as const) {
        shiftY(rig.arms[side].upper.a);
        shiftY(rig.arms[side].upper.b);
        shiftY(rig.arms[side].lower.a);
        shiftY(rig.arms[side].lower.b);
      }
    }

    const lookAngle = aimPose ? renderedAimAngle : facing > 0 ? 0 : Math.PI;
    const farArmKey = (facing > 0 ? "right" : "left") as "left" | "right";
    const nearArmKey = (facing > 0 ? "left" : "right") as "left" | "right";
    const farArmAlpha = saluteArm === farArmKey ? 0.95 : 0.6;
    const nearArmAlpha = 1;

    const handR = Math.max(2, baseArmThickness * 0.55);
    const handLineWidth = 4 * activeLineScale;
    const renderWeapon = () => {
      ctx.save();
      if (rig.grenade) {
        ctx.fillStyle = "#2b2b2b";
        ctx.strokeStyle = "#0a0a0a";
        ctx.lineWidth = 2 * activeLineScale;
        ctx.beginPath();
        ctx.arc(rig.grenade.center.x, rig.grenade.center.y, rig.grenade.r, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();

        ctx.globalAlpha = 0.35;
        ctx.fillStyle = "#fff";
        ctx.beginPath();
        ctx.arc(
          rig.grenade.center.x - rig.grenade.r * 0.28,
          rig.grenade.center.y - rig.grenade.r * 0.28,
          rig.grenade.r * 0.32,
          0,
          Math.PI * 2
        );
        ctx.fill();
        ctx.restore();
        return;
      }

      if (rig.weapon && aimPose) {
        drawWeaponSprite({
          ctx,
          weapon: aimPose.weapon,
          rotationPoint: rig.weapon.root,
          aimAngle: rig.weapon.angle,
        });
      }
      ctx.restore();
    };

    const renderHandOverlays = () => {
      if (aimPose?.weapon === WeaponType.HandGrenade) {
        const hands = [rig.arms.left.lower.b, rig.arms.right.lower.b];
        ctx.save();
        ctx.fillStyle = bodyColor;
        ctx.strokeStyle = "rgba(0,0,0,0.25)";
        ctx.lineWidth = handLineWidth;
        for (const h of hands) {
          ctx.beginPath();
          ctx.arc(h.x, h.y, handR, 0, Math.PI * 2);
          ctx.fill();
          ctx.stroke();
        }
        ctx.restore();
      }
      if (
        rig.weapon &&
        (aimPose?.weapon === WeaponType.Rifle || aimPose?.weapon === WeaponType.Bazooka)
      ) {
        const nearHand = rig.arms[nearArmKey].lower.b;
        const farHand = rig.arms[farArmKey].lower.b;
        ctx.save();
        ctx.strokeStyle = "rgba(0,0,0,0.25)";
        ctx.lineWidth = handLineWidth;

        ctx.globalAlpha = 0.7;
        ctx.fillStyle = bodyColor;
        ctx.beginPath();
        ctx.arc(farHand.x, farHand.y, handR, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();

        ctx.globalAlpha = 1;
        ctx.beginPath();
        ctx.arc(nearHand.x, nearHand.y, handR, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
        ctx.restore();
      }
    };

    const renderFarArm = () => strokeArm(rig.arms[farArmKey], farArmAlpha);
    const renderNearArm = () => strokeArm(rig.arms[nearArmKey], nearArmAlpha);
    const renderNearArmAndHands = () => {
      renderNearArm();
      renderHandOverlays();
    };

    const renderedSprites = renderCritterSprites({
      ctx,
      rig,
      team: this.team,
      facing,
      partOffsets: {
        collar: elasticOffsets.collar,
        helmet: elasticOffsets.helmet,
      },
      beforeAll: renderFarArm,
      afterTorso: renderNearArmAndHands,
      afterHead: (headCenter) => {
        renderCritterFace({
          ctx,
          center: headCenter,
          headRadius: rig.head.r,
          lookAngle,
          highlight,
          activePulse01,
          activeLineScale,
          age: this.age,
        });
      },
      afterAll: renderWeapon,
    });

    if (!renderedSprites) {
      renderFarArm();

      // Tail segments (worm-ish "j" curve), small -> large
      ctx.fillStyle = bodyColor;
      ctx.strokeStyle = outline;
      ctx.lineWidth = 2 * activeLineScale;
      const tail = [...rig.tail].sort((a, b) => a.r - b.r);
      for (const seg of tail) {
        ctx.beginPath();
        ctx.arc(seg.center.x, seg.center.y, seg.r, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
      }

      // Body
      ctx.fillStyle = bodyColor;
      ctx.strokeStyle = outline;
      ctx.lineWidth = 2 * activeLineScale;
      drawRoundedRect(
        ctx,
        rig.body.center.x - rig.body.w / 2,
        rig.body.center.y - rig.body.h / 2,
        rig.body.w,
        rig.body.h,
        rig.body.cornerR
      );
      ctx.fill();
      ctx.stroke();

      renderNearArmAndHands();

      // Head
      ctx.fillStyle = bodyColor;
      ctx.strokeStyle = outline;
      ctx.lineWidth = 2 * activeLineScale;
      ctx.beginPath();
      ctx.arc(rig.head.center.x, rig.head.center.y, rig.head.r, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();

      renderWeapon();
    }

    if (!renderedSprites) {
      // Eyes + mouth
      ctx.save();
      ctx.translate(
        rig.head.center.x + facing * (rig.head.r * 0.18),
        rig.head.center.y - rig.head.r * 0.12
      );
      const eyeR = Math.max(2.2, rig.head.r * 0.26);
      const eyeDx = rig.head.r * 0.42;
      ctx.fillStyle = "#fff";
      ctx.beginPath();
      ctx.arc(-eyeDx, 0, eyeR, 0, Math.PI * 2);
      ctx.arc(eyeDx, 0, eyeR, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "#000";
      ctx.beginPath();
      ctx.arc(-eyeDx + facing * (eyeR * 0.35), eyeR * 0.1, eyeR * 0.5, 0, Math.PI * 2);
      ctx.arc(eyeDx + facing * (eyeR * 0.35), eyeR * 0.1, eyeR * 0.5, 0, Math.PI * 2);
      ctx.fill();

      const mouthY = rig.head.r * 0.55;
      const mouthW = rig.head.r * 0.55;
      const mouthSmile = 0.35 + 0.25 * Math.sin(this.age * 2.0);
      ctx.strokeStyle = `rgba(0,0,0,${(highlight ? 0.42 + 0.14 * activePulse01 : 0.45).toFixed(3)})`;
      ctx.lineWidth = 2 * activeLineScale;
      ctx.lineCap = "round";
      ctx.beginPath();
      ctx.moveTo(-mouthW, mouthY);
      ctx.quadraticCurveTo(0, mouthY + rig.head.r * mouthSmile, mouthW, mouthY);
      ctx.stroke();
      ctx.restore();

      // Team band
      ctx.strokeStyle = teamColor;
      ctx.lineWidth = 3 * activeLineScale;
      ctx.beginPath();
      ctx.arc(
        rig.head.center.x,
        rig.head.center.y,
        rig.head.r - 1.5,
        Math.PI * 0.2,
        Math.PI * 0.8
      );
      ctx.stroke();
    }

    // Highlight ring for active
    if (highlight) {
      const ringPulse01 = 0.5 + 0.5 * Math.sin(now * 0.006);
      const ringR = (this.radius + 4) * 1.5;

      ctx.save();
      ctx.strokeStyle = "rgba(255,255,255,0.125)";
      ctx.lineWidth = 7 * activeLineScale;
      ctx.shadowColor = "rgba(255,255,255,0.175)";
      ctx.shadowBlur = 10;
      ctx.beginPath();
      ctx.arc(0, 0, ringR, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();

      ctx.globalAlpha = 0.36 + 0.09 * ringPulse01;
      ctx.strokeStyle = "#fff";
      ctx.lineWidth = 2.5 * activeLineScale;
      ctx.beginPath();
      ctx.arc(0, 0, ringR, 0, Math.PI * 2);
      ctx.stroke();
      ctx.globalAlpha = 1;
    }

    // Individual health bar above the worm
    const hbW = 34;
    const hbH = 6;
    drawHealthBar(
      ctx,
      0,
      rig.head.center.y - rig.head.r - 33,
      hbW,
      hbH,
      this.health / 100,
      COLORS.healthGreen,
      "rgba(0,0,0,0.35)"
    );

    const debugCollision =
      typeof window !== "undefined" && (window as Window).debugCritterCollision === true;
    if (debugCollision) {
      const offsets = resolveCritterSpriteOffsets();
      const applyOffset = (p: { x: number; y: number }, key: "head" | "torso" | "tail1" | "tail2") => {
        const o = offsets[key];
        return { x: p.x + facing * o.x, y: p.y + o.y };
      };

      const headCenter = applyOffset(rig.head.center, "head");
      const torsoCenter = applyOffset(rig.body.center, "torso");
      const torsoCenterY = torsoCenter.y - rig.body.h * 0.2;
      const torsoW = rig.body.w * 1.2;
      const torsoH = rig.body.h * 1.4;
      const tail = rig.tail.map((seg, i) => ({
        center: applyOffset(seg.center, i === 0 ? "tail1" : "tail2"),
        r: seg.r,
      }));

      ctx.save();
      ctx.globalAlpha = 0.95;
      ctx.strokeStyle = "rgba(0,255,170,0.9)";
      ctx.lineWidth = 2 * activeLineScale;

      ctx.beginPath();
      ctx.arc(headCenter.x, headCenter.y, rig.head.r * 1.2, 0, Math.PI * 2);
      ctx.stroke();

      ctx.strokeRect(
        torsoCenter.x - torsoW / 2,
        torsoCenterY - torsoH / 2,
        torsoW,
        torsoH
      );

      for (const seg of tail) {
        ctx.beginPath();
        ctx.arc(seg.center.x, seg.center.y, seg.r, 0, Math.PI * 2);
        ctx.stroke();
      }

      ctx.restore();
    }

    ctx.restore();
  }
}
