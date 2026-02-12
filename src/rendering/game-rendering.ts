import type { PredictedPoint, TeamId } from "../definitions";
import { COLORS, GAMEPLAY, WORLD, WeaponType } from "../definitions";
import { computeCritterRig, computeWeaponRig } from "../critter/critter-geometry";
import type { GameState } from "../game-state";
import type { Worm } from "../entities";
import {
  drawAimDots,
  drawCrosshair,
  drawHealthBar,
  drawRoundedRect,
  drawText,
  drawWindsock,
} from "../utils";

export type AimInfo = {
  targetX: number;
  targetY: number;
  angle: number;
};

export function renderBackground(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  padding = 0,
  drawWater = true
) {
  const left = -padding;
  const top = -padding;
  const drawWidth = width + padding * 2;
  const drawHeight = height + padding * 2;
  const g = ctx.createLinearGradient(0, top, 0, top + drawHeight);
  g.addColorStop(0, COLORS.bgSkyTop);
  g.addColorStop(1, COLORS.bgSkyBottom);
  ctx.fillStyle = g;
  ctx.fillRect(left, top, drawWidth, drawHeight);

  if (drawWater) {
    ctx.fillStyle = COLORS.water;
    const waterH = 30;
    ctx.fillRect(left, height - waterH, drawWidth, waterH + padding);
  }
}

export type RenderHudOptions = {
  ctx: CanvasRenderingContext2D;
  width: number;
  height: number;
  state: GameState;
  now: number;
  activeTeamId: TeamId;
  teamDisplayOrder?: readonly [TeamId, TeamId];
  activeTeamLabel?: string;
  teamLabels?: Partial<Record<TeamId, string>>;
  networkMicroStatus?: { text: string; color: string; opponentSide: "left" | "right" };
  getTeamHealth: (id: TeamId) => number;
  wind: number;
  message: string | null;
  turnDurationMs: number;
};

const HUD_FONT_STACK =
  "ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial";
const HUD_WINDSOCK_ORANGE = "#d54f45";

function truncateHudText(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxWidth: number,
  sizePx: number
) {
  if (maxWidth <= 0) return "";
  ctx.font = `bold ${sizePx}px ${HUD_FONT_STACK}`;
  if (ctx.measureText(text).width <= maxWidth) return text;

  const ellipsis = "…";
  if (ctx.measureText(ellipsis).width > maxWidth) return "";

  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    const candidate = `${text.slice(0, mid)}${ellipsis}`;
    if (ctx.measureText(candidate).width <= maxWidth) lo = mid + 1;
    else hi = mid;
  }
  const keep = Math.max(0, lo - 1);
  return `${text.slice(0, keep)}${ellipsis}`;
}

export function renderHUD({
  ctx,
  width,
  height,
  state,
  now,
  activeTeamId,
  teamDisplayOrder,
  activeTeamLabel,
  teamLabels,
  networkMicroStatus,
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

  const [leftTeamId, rightTeamId] = teamDisplayOrder ?? ["Red", "Blue"];
  const leftHealth = getTeamHealth(leftTeamId);
  const rightHealth = getTeamHealth(rightTeamId);
  const maxTeamHealth = GAMEPLAY.teamSize * 100;
  const hbW = 140;
  const hbH = 10;
  const leftX = padding + 12 + hbW / 2;
  const rightX = width - padding - 12 - hbW / 2;
  const topY = padding + 10;

  const leftLabel = truncateHudText(
    ctx,
    teamLabels?.[leftTeamId] ?? leftTeamId.toUpperCase(),
    hbW,
    14
  );
  ctx.font = `bold 14px ${HUD_FONT_STACK}`;
  const leftLabelWidth = ctx.measureText(leftLabel).width;
  drawText(ctx, leftLabel, padding + 12, topY, COLORS.white, 14);
  drawHealthBar(
    ctx,
    leftX,
    topY + 16,
    hbW,
    hbH,
    leftHealth / maxTeamHealth,
    COLORS.healthGreen,
    COLORS.healthRed
  );

  const rightLabel = truncateHudText(
    ctx,
    teamLabels?.[rightTeamId] ?? rightTeamId.toUpperCase(),
    hbW,
    14
  );
  ctx.font = `bold 14px ${HUD_FONT_STACK}`;
  const rightLabelWidth = ctx.measureText(rightLabel).width;
  drawText(
    ctx,
    rightLabel,
    width - padding - 12,
    topY,
    COLORS.white,
    14,
    "right"
  );
  drawHealthBar(
    ctx,
    rightX,
    topY + 16,
    hbW,
    hbH,
    rightHealth / maxTeamHealth,
    COLORS.healthGreen,
    COLORS.healthRed
  );

  const timeLeftMs = state.timeLeftMs(now, turnDurationMs);
  const timeLeft = Math.max(0, Math.ceil(timeLeftMs / 1000));
  const centerX = width / 2;

  const teamStr = activeTeamLabel ?? `${activeTeamId} Team`;
  const weaponLabel = state.weapon === WeaponType.HandGrenade ? "Grenade" : state.weapon;
  const weaponStr = weaponLabel;
  const clockStr = `Time: ${timeLeft}s`;

  drawText(ctx, teamStr, centerX, topY, COLORS.white, 14, "center");
  drawText(ctx, weaponStr, centerX, topY + 16, COLORS.white, 14, "center");
  drawText(ctx, clockStr, centerX, topY + 50, COLORS.white, 12, "center");

  const windDir = Math.sign(wind);
  const windMag01 = Math.min(1, Math.abs(wind) / WORLD.windMax);
  const desiredWindLen = 80 * windMag01;
  if (desiredWindLen > 0) {
    ctx.font = `bold 14px ${HUD_FONT_STACK}`;
    const teamStrWidth = ctx.measureText(teamStr).width;
    const gapFromTeam = 18;
    const arrowY = topY + 8;
    const labelY = topY + 18;

    if (windDir >= 0) {
      const startX = centerX + teamStrWidth / 2 + gapFromTeam;
      const maxLen = width - padding - 12 - startX;
      const windLen = Math.max(0, Math.min(desiredWindLen, maxLen));
      if (windLen > 0) {
        drawWindsock(ctx, startX, arrowY, 1, windLen, windMag01, HUD_WINDSOCK_ORANGE);
        drawText(ctx, "Wind", startX + windLen / 2, labelY, COLORS.white, 10, "center", "top", false);
      }
    } else {
      const startX = centerX - teamStrWidth / 2 - gapFromTeam;
      const maxLen = startX - (padding + 12);
      const windLen = Math.max(0, Math.min(desiredWindLen, maxLen));
      if (windLen > 0) {
        drawWindsock(ctx, startX, arrowY, -1, windLen, windMag01, HUD_WINDSOCK_ORANGE);
        drawText(ctx, "Wind", startX - windLen / 2, labelY, COLORS.white, 10, "center", "top", false);
      }
    }
  }

  if (networkMicroStatus) {
    const dotR = 4;
    const dotGap = 6;
    const gapFromLabel = 10;
    const minGapFromCenter = 16;
    const textSizePx = 12;
    const dotAndGap = dotR * 2 + dotGap;
    const dotY = topY + 8;
    const textY = topY + 1;

    if (networkMicroStatus.opponentSide === "left") {
      const startX = padding + 12 + leftLabelWidth + gapFromLabel;
      const maxX = centerX - minGapFromCenter;
      const availableWidth = maxX - startX;
      if (availableWidth > dotAndGap + 4) {
        const statusText = truncateHudText(
          ctx,
          networkMicroStatus.text,
          availableWidth - dotAndGap,
          textSizePx
        );
        ctx.fillStyle = networkMicroStatus.color;
        ctx.beginPath();
        ctx.arc(startX + dotR, dotY, dotR, 0, Math.PI * 2);
        ctx.fill();
        drawText(
          ctx,
          statusText,
          startX + dotAndGap,
          textY,
          COLORS.white,
          textSizePx,
          "left",
          "top",
          false
        );
      }
    } else {
      const endX = width - padding - 12 - rightLabelWidth - gapFromLabel;
      const minX = centerX + minGapFromCenter;
      const availableWidth = endX - minX;
      if (availableWidth > dotAndGap + 4) {
        const statusText = truncateHudText(
          ctx,
          networkMicroStatus.text,
          availableWidth - dotAndGap,
          textSizePx
        );
        ctx.font = `bold ${textSizePx}px ${HUD_FONT_STACK}`;
        const statusWidth = ctx.measureText(statusText).width;
        const totalWidth = dotAndGap + statusWidth;
        const startX = endX - totalWidth;
        ctx.fillStyle = networkMicroStatus.color;
        ctx.beginPath();
        ctx.arc(startX + dotR, dotY, dotR, 0, Math.PI * 2);
        ctx.fill();
        drawText(
          ctx,
          statusText,
          startX + dotAndGap,
          textY,
          COLORS.white,
          textSizePx,
          "left",
          "top",
          false
        );
      }
    }
  }

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
