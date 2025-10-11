import type { PredictedPoint, TeamId } from "../definitions";
import { COLORS, GAMEPLAY, WORLD, WeaponType } from "../definitions";
import type { GameState } from "../game-state";
import type { Worm } from "../entities";
import {
  drawAimDots,
  drawArrow,
  drawCrosshair,
  drawHealthBar,
  drawRoundedRect,
  drawText,
} from "../utils";

export type AimInfo = {
  targetX: number;
  targetY: number;
  angle: number;
};

export function renderBackground(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number
) {
  const g = ctx.createLinearGradient(0, 0, 0, height);
  g.addColorStop(0, COLORS.bgSkyTop);
  g.addColorStop(1, COLORS.bgSkyBottom);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, width, height);

  ctx.fillStyle = COLORS.water;
  const waterH = 30;
  ctx.fillRect(0, height - waterH, width, waterH);
}

export type RenderHudOptions = {
  ctx: CanvasRenderingContext2D;
  width: number;
  height: number;
  state: GameState;
  now: number;
  activeTeamId: TeamId;
  getTeamHealth: (id: TeamId) => number;
  wind: number;
  message: string | null;
  turnDurationMs: number;
};

export function renderHUD({
  ctx,
  width,
  height,
  state,
  now,
  activeTeamId,
  getTeamHealth,
  wind,
  message,
  turnDurationMs,
}: RenderHudOptions) {
  const padding = 10;

  const barH = 44;
  ctx.save();
  drawRoundedRect(ctx, padding, padding, width - padding * 2, barH, 10);
  ctx.fillStyle = COLORS.hudBg;
  ctx.fill();
  ctx.strokeStyle = COLORS.hudPanelBorder;
  ctx.lineWidth = 1;
  ctx.stroke();

  const redHealth = getTeamHealth("Red");
  const blueHealth = getTeamHealth("Blue");
  const maxTeamHealth = GAMEPLAY.teamSize * 100;
  const hbW = 140;
  const hbH = 10;
  const leftX = padding + 12 + hbW / 2;
  const rightX = width - padding - 12 - hbW / 2;
  const topY = padding + 10;

  drawText(ctx, "RED", padding + 12, topY, COLORS.white, 14);
  drawHealthBar(
    ctx,
    leftX,
    topY + 16,
    hbW,
    hbH,
    redHealth / maxTeamHealth,
    COLORS.healthGreen,
    COLORS.healthRed
  );

  drawText(ctx, "BLUE", width - padding - 12, topY, COLORS.white, 14, "right");
  drawHealthBar(
    ctx,
    rightX,
    topY + 16,
    hbW,
    hbH,
    blueHealth / maxTeamHealth,
    COLORS.healthGreen,
    COLORS.healthRed
  );

  drawText(ctx, "F1: Help", padding + 12, topY + 30, COLORS.white, 12);

  const timeLeftMs = state.timeLeftMs(now, turnDurationMs);
  const timeLeft = Math.max(0, Math.ceil(timeLeftMs / 1000));
  const centerX = width / 2;

  const teamStr = `${activeTeamId} Team`;
  const weaponStr = `Weapon: ${state.weapon}`;
  const clockStr = `Time: ${timeLeft}s`;

  drawText(ctx, teamStr, centerX, topY, COLORS.white, 14, "center");
  drawText(ctx, weaponStr, centerX, topY + 16, COLORS.white, 14, "center");
  drawText(ctx, clockStr, centerX, topY + 30, COLORS.white, 12, "center");

  const windY = padding + barH + 14;
  const dir = Math.sign(wind);
  const mag = Math.abs(wind) / WORLD.windMax;
  const length = 80 * mag;
  drawArrow(ctx, centerX - (length / 2) * dir, windY, 0, length * dir || 0.0001, COLORS.power, 4);
  drawText(ctx, "Wind", centerX, windY + 6, COLORS.white, 12, "center", "top", false);

  ctx.restore();

  if (state.phase === "aim" && state.charging) {
    const charge = state.getCharge01(now);
    const w = 260;
    const h = 16;
    const x = (width - w) / 2;
    const y = height - h - 18;
    drawRoundedRect(ctx, x, y, w, h, 8);
    ctx.fillStyle = COLORS.hudBg;
    ctx.fill();
    drawRoundedRect(ctx, x + 2, y + 2, (w - 4) * charge, h - 4, (h - 4) / 2);
    ctx.fillStyle = COLORS.power;
    ctx.fill();
    drawText(ctx, "Hold and release to fire", width / 2, y - 18, COLORS.white, 14, "center");
  }

  if (message && state.phase !== "gameover") {
    drawText(
      ctx,
      message,
      width / 2,
      padding + barH + 32,
      COLORS.white,
      16,
      "center"
    );
  }
}

export type RenderAimHelpersOptions = {
  ctx: CanvasRenderingContext2D;
  state: GameState;
  activeWorm: Worm;
  aim: AimInfo;
  predictedPath: PredictedPoint[];
};

export function renderAimHelpers({
  ctx,
  state,
  activeWorm,
  aim,
  predictedPath,
}: RenderAimHelpersOptions) {
  if (state.phase !== "aim") return;

  if (predictedPath.length > 0) {
    ctx.save();
    ctx.globalAlpha = 0.9;
    drawAimDots(ctx, predictedPath, COLORS.white);
    ctx.restore();
  }

  if (state.weapon === WeaponType.Rifle) {
    const chSize = 8;
    const crossCol = "#ffd84d";
    drawCrosshair(ctx, aim.targetX, aim.targetY, chSize, crossCol, 2);

    ctx.save();
    ctx.globalAlpha = 0.15;
    ctx.beginPath();
    ctx.arc(activeWorm.x, activeWorm.y, GAMEPLAY.rifle.aimRadius, 0, Math.PI * 2);
    ctx.fillStyle = "#ffd84d";
    ctx.fill();
    ctx.restore();
  }

  const muzzleOffset = WORLD.wormRadius + 10;
  const mx = activeWorm.x + Math.cos(aim.angle) * muzzleOffset;
  const my = activeWorm.y + Math.sin(aim.angle) * muzzleOffset;
  ctx.save();
  ctx.strokeStyle = "rgba(255,255,255,0.6)";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(activeWorm.x, activeWorm.y);
  ctx.lineTo(mx, my);
  ctx.stroke();
  ctx.restore();
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
