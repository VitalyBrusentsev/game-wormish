import type { TeamId } from "../definitions";
import { COLORS, WORLD, clamp } from "../definitions";
import { computeCritterRig, type CritterRig } from "../critter/critter-geometry";
import { renderCritterFace } from "../critter/critter-face";
import { renderCritterSprites } from "../critter/critter-sprites";
import { drawRoundedRect, drawWindsock } from "../utils";

type PanelSide = "left" | "right";

export type TeamPanelLayout = {
  x: number;
  y: number;
  w: number;
  h: number;
  avatar: number;
  compact: boolean;
  scale: number;
};

const HUD_FONT_STACK =
  "\"Fredoka\", ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial";
const HUD_DARK = "rgba(8,28,51,0.88)";
const HUD_DARKER = "rgba(6,16,30,0.94)";
const HUD_BORDER = "rgba(95,160,225,0.72)";
const HUD_CENTER_INNER_BORDER = "rgba(194,228,255,0.22)";

export function drawHudText(config: {
  ctx: CanvasRenderingContext2D;
  text: string;
  x: number;
  y: number;
  size: number;
  align?: CanvasTextAlign;
  baseline?: CanvasTextBaseline;
  weight?: number;
  color?: string;
  shadow?: boolean;
}) {
  const {
    ctx,
    text,
    x,
    y,
    size,
    align = "left",
    baseline = "top",
    weight = 800,
    color = COLORS.white,
    shadow = true,
  } = config;
  ctx.font = `${weight} ${size}px ${HUD_FONT_STACK}`;
  ctx.textAlign = align;
  ctx.textBaseline = baseline;
  if (shadow) {
    ctx.fillStyle = "rgba(0,0,0,0.55)";
    ctx.fillText(text, x + 2, y + 2);
  }
  ctx.fillStyle = color;
  ctx.fillText(text, x, y);
}

export function truncateHudText(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxWidth: number,
  sizePx: number,
  weight = 800
) {
  if (maxWidth <= 0) return "";
  ctx.font = `${weight} ${sizePx}px ${HUD_FONT_STACK}`;
  if (ctx.measureText(text).width <= maxWidth) return text;

  const ellipsis = "...";
  if (ctx.measureText(ellipsis).width > maxWidth) return "";

  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    const candidate = `${text.slice(0, mid)}${ellipsis}`;
    if (ctx.measureText(candidate).width <= maxWidth) lo = mid + 1;
    else hi = mid;
  }
  return `${text.slice(0, Math.max(0, lo - 1))}${ellipsis}`;
}
function drawPanelPath(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  side: PanelSide,
  radius: number
) {
  const bevel = Math.min(38, w * 0.12);
  const r = Math.min(radius, h * 0.5, w * 0.18);

  ctx.beginPath();
  if (side === "left") {
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - bevel, y);
    ctx.quadraticCurveTo(x + w - bevel * 0.35, y, x + w - bevel * 0.15, y + r);
    ctx.lineTo(x + w - bevel * 0.55, y + h - r);
    ctx.quadraticCurveTo(x + w - bevel * 0.75, y + h, x + w - bevel - r, y + h);
    ctx.lineTo(x + r, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - r);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
  } else {
    ctx.moveTo(x + bevel + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h - r);
    ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    ctx.lineTo(x + bevel, y + h);
    ctx.quadraticCurveTo(x + bevel * 0.35, y + h, x + bevel * 0.15, y + h - r);
    ctx.lineTo(x + bevel * 0.55, y + r);
    ctx.quadraticCurveTo(x + bevel * 0.75, y, x + bevel + r, y);
  }
  ctx.closePath();
}
function fillFramedPanel(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  side: PanelSide,
  radius: number,
  active: boolean
) {
  ctx.save();
  drawPanelPath(ctx, x, y, w, h, side, radius);
  const fill = ctx.createLinearGradient(x, y, x + w, y + h);
  fill.addColorStop(0, active ? "rgba(21,74,120,0.96)" : HUD_DARK);
  fill.addColorStop(0.55, HUD_DARKER);
  fill.addColorStop(1, active ? "rgba(18,63,104,0.95)" : "rgba(13,34,57,0.92)");
  ctx.fillStyle = fill;
  ctx.shadowColor = "rgba(0,0,0,0.38)";
  ctx.shadowBlur = 18;
  ctx.shadowOffsetY = 6;
  ctx.fill();

  ctx.shadowColor = "transparent";
  ctx.lineWidth = 4;
  ctx.strokeStyle = active ? "rgba(116,211,255,0.86)" : HUD_BORDER;
  ctx.stroke();
  ctx.restore();
}
function teamAccent(teamId: TeamId) {
  return teamId === "Red" ? COLORS.red : COLORS.blue;
}

function extendPortraitTail(rig: CritterRig) {
  const tail1 = rig.tail[0];
  const tail2 = rig.tail[1];
  if (!tail1 || !tail2) return;
  const dx = tail2.center.x - tail1.center.x;
  const dy = tail2.center.y - tail1.center.y;
  rig.tail.push({
    center: { x: tail2.center.x + dx * 0.9, y: tail2.center.y + dy * 0.9 },
    r: tail2.r * 0.72,
  });
}

function drawRigFallback(ctx: CanvasRenderingContext2D, rig: CritterRig, teamId: TeamId) {
  const bodyColor = teamId === "Red" ? "#ff8f8f" : "#83c9ff";
  const tail = [...rig.tail].sort((a, b) => a.r - b.r);

  ctx.save();
  ctx.fillStyle = bodyColor;
  ctx.strokeStyle = "rgba(0,0,0,0.28)";
  ctx.lineWidth = 2;
  for (const seg of tail) {
    ctx.beginPath();
    ctx.arc(seg.center.x, seg.center.y, seg.r, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  }
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
  ctx.beginPath();
  ctx.arc(rig.head.center.x, rig.head.center.y, rig.head.r, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  renderCritterFace({
    ctx,
    center: rig.head.center,
    headRadius: rig.head.r,
    lookAngle: 0,
    highlight: false,
    activePulse01: 0,
    activeLineScale: 1,
    age: 0,
  });
  ctx.restore();
}

function portraitPulse(nowMs: number) {
  const breath = Math.sin(nowMs * 0.0048);
  return {
    activePulse01: 0.5 + 0.5 * breath,
    age: nowMs / 1000,
  };
}

function applyPortraitBreath(rig: CritterRig, nowMs: number) {
  const breathDy = Math.sin(nowMs * 0.0042) * 2;
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

function drawPortraitCritter(
  ctx: CanvasRenderingContext2D,
  centerX: number,
  centerY: number,
  size: number,
  teamId: TeamId,
  active: boolean,
  nowMs: number,
  lookAngle: number
) {
  const facing = teamId === "Red" ? -1 : 1;
  const rig = computeCritterRig({
    x: 0,
    y: 10,
    r: 14,
    facing,
    pose: { kind: "idle" },
  });
  extendPortraitTail(rig);

  const pulse = active ? portraitPulse(nowMs) : portraitPulse(0);
  if (active) applyPortraitBreath(rig, nowMs);

  ctx.save();
  ctx.translate(centerX, centerY + size * 0.22);
  const baseScale = size / 62;
  ctx.scale(baseScale, baseScale);
  const renderedSprites = renderCritterSprites({
    ctx,
    rig,
    team: teamId,
    facing,
    afterHead: (headCenter) => {
      renderCritterFace({
        ctx,
        center: headCenter,
        headRadius: rig.head.r,
        lookAngle,
        highlight: active,
        activePulse01: pulse.activePulse01,
        activeLineScale: 1,
        age: pulse.age,
      });
    },
  });
  if (!renderedSprites) drawRigFallback(ctx, rig, teamId);
  ctx.restore();
}

function drawPortrait(config: {
  ctx: CanvasRenderingContext2D;
  x: number;
  y: number;
  size: number;
  radius: number;
  teamId: TeamId;
  active: boolean;
  nowMs: number;
  activeWormFacing: -1 | 1;
}) {
  const { ctx, x, y, size, radius, teamId, active, nowMs, activeWormFacing } = config;
  const accent = teamAccent(teamId);
  const cx = x + size / 2;
  const cy = y + size / 2;
  const lookAngle = activeWormFacing < 0 ? Math.PI : 0;

  ctx.save();
  drawRoundedRect(ctx, x, y, size, size, radius);
  const bg = ctx.createLinearGradient(x, y, x, y + size);
  bg.addColorStop(0, "rgba(73,141,200,0.7)");
  bg.addColorStop(1, "rgba(8,20,38,0.86)");
  ctx.fillStyle = bg;
  ctx.fill();

  ctx.save();
  drawRoundedRect(ctx, x, y, size, size, radius);
  ctx.clip();
  drawPortraitCritter(ctx, cx, cy, size, teamId, active, nowMs, lookAngle);
  ctx.restore();

  ctx.strokeStyle = active ? "rgba(206,242,255,0.88)" : accent;
  ctx.lineWidth = active ? 3 : 2.5;
  drawRoundedRect(ctx, x, y, size, size, radius);
  ctx.stroke();
  ctx.restore();
}
function drawHealthMeter(config: {
  ctx: CanvasRenderingContext2D;
  x: number;
  y: number;
  w: number;
  h: number;
  value: number;
  maxValue: number;
  side: PanelSide;
  compact: boolean;
}) {
  const { ctx, x, y, w, h, value, maxValue, side, compact } = config;
  const t = clamp(value / Math.max(1, maxValue), 0, 1);
  const label = String(Math.max(0, Math.round(value)));
  const labelSize = compact ? 13 : 16;
  const labelGap = compact ? 5 : 9;
  ctx.font = `900 ${labelSize}px ${HUD_FONT_STACK}`;
  const labelWidth = Math.max(26, ctx.measureText(label).width + 4);
  const barX = side === "left" ? x : x + labelWidth + labelGap;
  const textX = side === "left" ? x + w + labelGap : x + labelWidth;

  ctx.save();
  drawRoundedRect(ctx, barX, y, w, h, h / 2);
  ctx.fillStyle = "rgba(14,24,32,0.82)";
  ctx.fill();

  drawRoundedRect(ctx, barX + 2, y + 2, Math.max(0, (w - 4) * t), h - 4, (h - 4) / 2);
  const fill = ctx.createLinearGradient(barX, y, barX, y + h);
  fill.addColorStop(0, "#9cff4d");
  fill.addColorStop(1, "#48d12f");
  ctx.fillStyle = fill;
  ctx.fill();

  ctx.strokeStyle = "rgba(140,255,120,0.3)";
  ctx.lineWidth = 1;
  for (let i = 1; i < 8; i++) {
    const sx = barX + (w / 8) * i;
    ctx.beginPath();
    ctx.moveTo(sx, y + 2);
    ctx.lineTo(sx, y + h - 2);
    ctx.stroke();
  }

  ctx.strokeStyle = "rgba(210,255,210,0.42)";
  ctx.lineWidth = 1.5;
  drawRoundedRect(ctx, barX, y, w, h, h / 2);
  ctx.stroke();

  drawHudText({
    ctx,
    text: label,
    x: textX,
    y: y + h / 2,
    size: labelSize,
    align: side === "left" ? "left" : "right",
    baseline: "middle",
    weight: 900,
  });
  ctx.restore();
}
function drawNetworkStatus(
  ctx: CanvasRenderingContext2D,
  text: string,
  color: string,
  x: number,
  y: number,
  maxWidth: number,
  align: CanvasTextAlign
) {
  const dotX = align === "left" ? x + 4 : x - 4;
  const textX = align === "left" ? x + 16 : x - 16;
  const label = truncateHudText(ctx, text, Math.max(0, maxWidth - 20), 12, 800);

  ctx.save();
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(dotX, y + 6, 4, 0, Math.PI * 2);
  ctx.fill();
  drawHudText({
    ctx,
    text: label,
    x: textX,
    y,
    size: 12,
    align,
    weight: 800,
    shadow: false,
  });
  ctx.restore();
}
export function drawTeamPanel(config: {
  ctx: CanvasRenderingContext2D;
  layout: TeamPanelLayout;
  side: PanelSide;
  teamId: TeamId;
  label: string;
  health: number;
  maxHealth: number;
  active: boolean;
  nowMs: number;
  activeWormFacing: -1 | 1;
  networkStatus?: { text: string; color: string };
}) {
  const { ctx, layout, side, teamId, label, health, maxHealth, active, nowMs, activeWormFacing, networkStatus } = config;
  const { x, y, w, h, avatar, compact, scale } = layout;
  const panelRadius = compact ? 11 * scale : 16;
  fillFramedPanel(ctx, x, y, w, h, side, panelRadius, active);

  const avatarInset = (h - avatar) / 2;
  const avatarX = side === "left" ? x + avatarInset : x + w - avatar - avatarInset;
  const avatarY = y + avatarInset;
  const avatarRadius = Math.max(4, panelRadius - avatarInset);
  drawPortrait({
    ctx,
    x: avatarX,
    y: avatarY,
    size: avatar,
    radius: avatarRadius,
    teamId,
    active,
    nowMs,
    activeWormFacing,
  });

  const contentPad = compact ? 8 * scale : 18;
  const contentX = side === "left" ? avatarX + avatar + contentPad : x + contentPad;
  const contentW = Math.max(compact ? 44 : 58, w - avatar - contentPad * 2 - avatarInset * 2);
  const labelX = side === "left" ? contentX : contentX + contentW + (compact ? 4 : 0);
  const labelSize = compact ? 18 * scale : 30;
  const healthLabelReserve = compact ? 31 : 42;
  const healthGap = compact ? 5 : 0;
  const healthW = compact
    ? Math.max(18, Math.min(70 * scale, contentW - healthLabelReserve - healthGap))
    : Math.min(305, contentW - 42);
  const healthH = compact ? 12 * scale : 26;
  const healthX = compact
    ? contentX
    : side === "left"
      ? contentX
      : contentX + contentW - healthW - 44;
  const healthY = compact ? y + h - 21 * scale : y + h - 43;
  const truncated = truncateHudText(ctx, label, contentW, labelSize, 900);

  drawHudText({
    ctx,
    text: truncated,
    x: labelX,
    y: compact ? y + 8 * scale : y + 17,
    size: labelSize,
    align: side === "left" ? "left" : "right",
    weight: 900,
  });

  drawHealthMeter({
    ctx,
    x: healthX,
    y: healthY,
    w: Math.max(40, healthW),
    h: healthH,
    value: health,
    maxValue: maxHealth,
    side,
    compact,
  });

  if (networkStatus && !compact) {
    const statusX = side === "left" ? contentX : contentX + contentW;
    drawNetworkStatus(ctx, networkStatus.text, networkStatus.color, statusX, y + 52, contentW, side === "left" ? "left" : "right");
  }
}
function drawCenterPanelPath(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number) {
  const bevel = Math.min(38, w * 0.12);
  ctx.beginPath();
  ctx.moveTo(x + bevel, y);
  ctx.lineTo(x + w - bevel, y);
  ctx.lineTo(x + w, y + h * 0.5);
  ctx.lineTo(x + w - bevel, y + h);
  ctx.lineTo(x + bevel, y + h);
  ctx.lineTo(x, y + h * 0.5);
  ctx.closePath();
}

export function drawCenterWeaponPanel(config: {
  ctx: CanvasRenderingContext2D;
  x: number;
  y: number;
  w: number;
  h: number;
  teamLabel: string;
  weaponLabel: string;
  wind: number;
  compact: boolean;
  scale: number;
}) {
  const { ctx, x, y, w, h, teamLabel, weaponLabel, wind, compact, scale } = config;

  ctx.save();
  drawCenterPanelPath(ctx, x, y, w, h);
  const bg = ctx.createLinearGradient(x, y, x, y + h);
  bg.addColorStop(0, "rgba(18,45,76,0.94)");
  bg.addColorStop(1, "rgba(7,19,35,0.96)");
  ctx.fillStyle = bg;
  ctx.shadowColor = "rgba(0,0,0,0.36)";
  ctx.shadowBlur = 18;
  ctx.shadowOffsetY = 7;
  ctx.fill();
  ctx.shadowColor = "transparent";
  ctx.lineWidth = 4;
  ctx.strokeStyle = HUD_BORDER;
  ctx.stroke();
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = HUD_CENTER_INNER_BORDER;
  drawCenterPanelPath(ctx, x + 7, y + 7, w - 14, h - 14);
  ctx.stroke();

  const windDir = Math.sign(wind) >= 0 ? 1 : -1;
  const windMag01 = Math.min(1, Math.abs(wind) / WORLD.windMax);
  const centerX = x + w / 2;
  const sockOffsetX = compact ? 38 * scale : 76;
  const sockX = centerX + windDir * sockOffsetX;
  const sockY = y + h * 0.5;
  drawWindsock(
    ctx,
    sockX,
    sockY,
    windDir as -1 | 1,
    (compact ? 40 * scale : 62) * Math.max(0.28, windMag01),
    Math.max(0.18, windMag01),
    "#d54f45"
  );

  const textX = centerX;
  if (compact) {
    const textW = w - 100 * scale;
    const teamSize = 15 * scale;
    const weaponSize = 12 * scale;
    drawHudText({
      ctx,
      text: truncateHudText(ctx, teamLabel, textW, teamSize, 900),
      x: textX,
      y: y + h * 0.34,
      size: teamSize,
      align: "center",
      baseline: "middle",
      weight: 900,
    });
    drawHudText({
      ctx,
      text: truncateHudText(ctx, weaponLabel, textW, weaponSize, 900),
      x: textX,
      y: y + h * 0.65,
      size: weaponSize,
      align: "center",
      baseline: "middle",
      weight: 900,
    });
  } else {
    const textW = w - 176;
    drawHudText({
      ctx,
      text: truncateHudText(ctx, teamLabel, textW, 30, 900),
      x: textX,
      y: y + 15,
      size: 30,
      align: "center",
      weight: 900,
    });
    drawHudText({
      ctx,
      text: truncateHudText(ctx, weaponLabel, textW, 22, 900),
      x: textX,
      y: y + 54,
      size: 22,
      align: "center",
      weight: 900,
    });
  }
  ctx.restore();
}

export function drawTimerPill(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  timeLeft: number,
  compact: boolean
) {
  const text = compact ? `${timeLeft}s` : `Time: ${timeLeft}s`;
  const textSize = compact ? 16 : 22;
  ctx.save();
  ctx.font = `900 ${textSize}px ${HUD_FONT_STACK}`;
  const iconLeftPad = compact ? 17 : 26;
  const iconR = compact ? 8 : 11;
  const iconToTextGap = compact ? 12 : 14;
  const textRightPad = compact ? 15 : 20;
  const textWidth = ctx.measureText(text).width;
  const w = Math.ceil(iconLeftPad + iconR * 2 + iconToTextGap + textWidth + textRightPad);
  const h = compact ? 30 : 42;
  const px = x - w / 2;

  drawRoundedRect(ctx, px, y, w, h, Math.min(14, h / 2));
  ctx.fillStyle = "rgba(9,32,58,0.9)";
  ctx.fill();
  ctx.strokeStyle = "rgba(118,178,230,0.46)";
  ctx.lineWidth = 1.5;
  ctx.stroke();

  const iconX = px + iconLeftPad + iconR;
  const iconY = y + h / 2;
  ctx.strokeStyle = COLORS.white;
  ctx.lineWidth = compact ? 2 : 2.5;
  ctx.beginPath();
  ctx.arc(iconX, iconY, compact ? 8 : 11, 0, Math.PI * 2);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(iconX, iconY);
  ctx.lineTo(iconX, iconY - (compact ? 5 : 7));
  ctx.moveTo(iconX, iconY);
  ctx.lineTo(iconX + (compact ? 5 : 7), iconY + 2);
  ctx.stroke();

  drawHudText({
    ctx,
    text,
    x: px + w - textRightPad,
    y: iconY,
    size: textSize,
    align: "right",
    baseline: "middle",
    weight: 900,
  });
  ctx.restore();
}
