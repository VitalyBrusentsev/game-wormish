import type { PredictedPoint } from "../definitions";
import { COLORS, GAMEPLAY, WeaponType } from "../definitions";
import { computeCritterRig, computeWeaponRig } from "../critter/critter-geometry";
import type { GameState } from "../game-state";
import type { Worm } from "../entities";
import {
  drawAimDots,
  drawCrosshair,
} from "../utils";

export type AimInfo = {
  targetX: number;
  targetY: number;
  angle: number;
};

export type RenderAimHelpersOptions = {
  ctx: CanvasRenderingContext2D;
  state: GameState;
  activeWorm: Worm;
  aim: AimInfo;
  predictedPath: PredictedPoint[];
  showDesktopAssist?: boolean;
};

export function renderAimHelpers({
  ctx,
  state,
  activeWorm,
  aim,
  predictedPath,
  showDesktopAssist = true,
}: RenderAimHelpersOptions) {
  if (state.phase !== "aim") return;

  if (predictedPath.length > 0) {
    ctx.save();
    ctx.globalAlpha = 0.9;
    drawAimDots(ctx, predictedPath, COLORS.white);
    ctx.restore();
  }

  if (showDesktopAssist && (state.weapon === WeaponType.Rifle || state.weapon === WeaponType.Uzi)) {
    const chSize = 8;
    const crossCol = "#ffd84d";
    drawCrosshair(ctx, aim.targetX, aim.targetY, chSize, crossCol, 2);

    ctx.save();
    ctx.globalAlpha = 0.15;
    ctx.beginPath();
    const radius =
      state.weapon === WeaponType.Rifle ? GAMEPLAY.rifle.aimRadius : GAMEPLAY.uzi.aimRadius;
    ctx.arc(activeWorm.x, activeWorm.y, radius, 0, Math.PI * 2);
    ctx.fillStyle = "#ffd84d";
    ctx.fill();
    ctx.restore();
  }

  const muzzle =
    state.weapon === WeaponType.HandGrenade
      ? (() => {
          const facing = (activeWorm.facing < 0 ? -1 : 1) as -1 | 1;
          const rig = computeCritterRig({
            x: activeWorm.x,
            y: activeWorm.y,
            r: activeWorm.radius,
            facing,
            pose: { kind: "aim", weapon: state.weapon, aimAngle: aim.angle },
          });
          const hold = rig.grenade?.center ?? { x: activeWorm.x, y: activeWorm.y };
          return { x: hold.x, y: hold.y };
        })()
      : computeWeaponRig({
          center: { x: activeWorm.x, y: activeWorm.y },
          weapon: state.weapon,
          aimAngle: aim.angle,
          facing: (activeWorm.facing < 0 ? -1 : 1) as -1 | 1,
        }).muzzle;

  if (showDesktopAssist && state.weapon === WeaponType.Uzi) {
    const maxLen = 400;
    const ex = muzzle.x + Math.cos(aim.angle) * maxLen;
    const ey = muzzle.y + Math.sin(aim.angle) * maxLen;
    ctx.save();
    const grad = ctx.createLinearGradient(muzzle.x, muzzle.y, ex, ey);
    grad.addColorStop(0, "rgba(255,255,255,0.35)");
    grad.addColorStop(1, "rgba(255,255,255,0)");
    ctx.strokeStyle = grad;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(muzzle.x, muzzle.y);
    ctx.lineTo(ex, ey);
    ctx.stroke();
    ctx.restore();
  }
}

export type RenderGameOverOptions = {
  ctx: CanvasRenderingContext2D;
  width: number;
  height: number;
  message: string | null;
  isGameOver: boolean;
};

export function renderGameOver({
  ctx,
  width,
  height,
  message,
  isGameOver,
}: RenderGameOverOptions) {
  if (!isGameOver || !message) return;

  const x = width / 2;
  const y = height / 2;
  const sizePx = 76;
  ctx.save();
  ctx.font = `bold ${sizePx}px ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";

  ctx.fillStyle = "rgba(0,0,0,0.6)";
  ctx.fillText(message, x + 4, y + 4);

  const search = "Press ";
  const idx = message.indexOf(search);
  if (idx !== -1 && idx + search.length < message.length) {
    const idxR = idx + search.length;
    const pre = message.slice(0, idxR);
    const rChar = message[idxR] ?? "";
    const post = message.slice(idxR + 1);

    const totalWidth = ctx.measureText(message).width;
    let startX = x - totalWidth / 2;

    ctx.fillStyle = COLORS.white;
    const preWidth = ctx.measureText(pre).width;
    ctx.fillText(pre, startX + preWidth / 2, y);

    const rWidth = ctx.measureText(rChar).width;
    ctx.fillStyle = COLORS.red;
    ctx.fillText(rChar, startX + preWidth + rWidth / 2, y);

    const postWidth = ctx.measureText(post).width;
    ctx.fillStyle = COLORS.white;
    ctx.fillText(post, startX + preWidth + rWidth + postWidth / 2, y);
  } else {
    ctx.fillStyle = COLORS.white;
    ctx.fillText(message, x, y);
  }

  ctx.restore();
}
