import type { TeamId } from "../definitions";
import { clamp, COLORS } from "../definitions";
import type { Projectile, Terrain } from "../entities";
import type { Team } from "../game/team-manager";
import { drawRoundedRect } from "../utils";

export const MAP_GADGET_WIDTH_PX = 240;

type MapGadgetOptions = {
  ctx: CanvasRenderingContext2D;
  viewportWidth: number;
  viewportHeight: number;
  now: number;
  terrain: Terrain;
  teams: readonly Team[];
  projectiles?: readonly Projectile[];
  showRadar?: boolean;
  maxWidthPx?: number;
  topOffsetPx?: number;
};

type MapGadgetLayoutOptions = Pick<
  MapGadgetOptions,
  "viewportWidth" | "terrain" | "maxWidthPx" | "topOffsetPx"
>;

type Layout = {
  x: number;
  y: number;
  outerWidth: number;
  outerHeight: number;
  innerX: number;
  innerY: number;
  mapWidth: number;
  mapHeight: number;
  scale: number;
};

const HUD_TOP_PADDING_PX = 10;
const HUD_BAR_HEIGHT_PX = 44;
const HUD_TO_GADGET_GAP_PX = 10;

const FRAME_PAD_PX = 10;
const FRAME_RADIUS_PX = 14;

const MAP_BG = "rgba(5,6,8,0.72)";
const MAP_GROUND = COLORS.dirtDark;

function mulberry32(seed: number) {
  let t = seed >>> 0;
  return () => {
    t += 0x6d2b79f5;
    let v = Math.imul(t ^ (t >>> 15), 1 | t);
    v ^= v + Math.imul(v ^ (v >>> 7), 61 | v);
    return ((v ^ (v >>> 14)) >>> 0) / 4294967296;
  };
}

function teamDotColor(teamId: TeamId): string {
  return teamId === "Red" ? COLORS.red : COLORS.blue;
}

function getLayout({
  viewportWidth,
  terrain,
  maxWidthPx,
  topOffsetPx = 0,
}: MapGadgetLayoutOptions): Layout {
  const worldWidth = Math.max(1, terrain.worldRight - terrain.worldLeft);
  const maxWidth = Math.max(80, Math.min(MAP_GADGET_WIDTH_PX, maxWidthPx ?? MAP_GADGET_WIDTH_PX));
  const scale = maxWidth / worldWidth;
  const mapWidth = maxWidth;
  const mapHeight = Math.max(1, Math.round(terrain.height * scale));
  const outerWidth = mapWidth + FRAME_PAD_PX * 2;
  const outerHeight = mapHeight + FRAME_PAD_PX * 2;

  const x = viewportWidth - HUD_TOP_PADDING_PX - outerWidth;
  const y = topOffsetPx + HUD_TOP_PADDING_PX + HUD_BAR_HEIGHT_PX + HUD_TO_GADGET_GAP_PX;
  const innerX = x + FRAME_PAD_PX;
  const innerY = y + FRAME_PAD_PX;

  return {
    x,
    y,
    outerWidth,
    outerHeight,
    innerX,
    innerY,
    mapWidth,
    mapHeight,
    scale,
  };
}

export function getMapGadgetBottomY(options: MapGadgetLayoutOptions): number {
  const layout = getLayout(options);
  return layout.y + layout.outerHeight;
}

function drawMetalFrame(ctx: CanvasRenderingContext2D, layout: Layout) {
  const { x, y, outerWidth: w, outerHeight: h } = layout;

  ctx.save();
  drawRoundedRect(ctx, x, y, w, h, FRAME_RADIUS_PX);
  const g = ctx.createLinearGradient(x, y, x + w, y + h);
  g.addColorStop(0, "#6e747c");
  g.addColorStop(0.25, "#2f343a");
  g.addColorStop(0.55, "#7b828a");
  g.addColorStop(0.85, "#22262b");
  g.addColorStop(1, "#5f656e");
  ctx.fillStyle = g;
  ctx.fill();

  ctx.save();
  ctx.globalAlpha = 0.9;
  ctx.strokeStyle = "rgba(255,255,255,0.22)";
  ctx.lineWidth = 2;
  drawRoundedRect(ctx, x + 1, y + 1, w - 2, h - 2, FRAME_RADIUS_PX - 1);
  ctx.stroke();
  ctx.restore();

  ctx.save();
  ctx.globalAlpha = 0.65;
  ctx.strokeStyle = "rgba(0,0,0,0.55)";
  ctx.lineWidth = 2;
  drawRoundedRect(ctx, x + 3, y + 3, w - 6, h - 6, FRAME_RADIUS_PX - 3);
  ctx.stroke();
  ctx.restore();

  const rand = mulberry32(0xdecafbad);
  ctx.save();
  ctx.globalAlpha = 0.22;
  ctx.strokeStyle = "rgba(255,255,255,0.55)";
  ctx.lineWidth = 1;
  for (let i = 0; i < 14; i++) {
    const sx = x + 6 + rand() * (w - 12);
    const sy = y + 6 + rand() * (h - 12);
    const len = 10 + rand() * 30;
    const angle = (rand() - 0.5) * 0.6;
    ctx.beginPath();
    ctx.moveTo(sx, sy);
    ctx.lineTo(sx + Math.cos(angle) * len, sy + Math.sin(angle) * len);
    ctx.stroke();
  }
  ctx.restore();

  ctx.save();
  ctx.globalAlpha = 0.25;
  for (let i = 0; i < 10; i++) {
    const cx = x + 8 + rand() * (w - 16);
    const cy = y + 8 + rand() * (h - 16);
    const r = 2 + rand() * 5;
    const rg = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
    rg.addColorStop(0, "rgba(96,70,36,0.85)");
    rg.addColorStop(1, "rgba(96,70,36,0)");
    ctx.fillStyle = rg;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();

  ctx.restore();
}

function drawMapContents(ctx: CanvasRenderingContext2D, layout: Layout, terrain: Terrain) {
  const { innerX, innerY, mapWidth, mapHeight, scale } = layout;
  const worldWidth = Math.max(1, terrain.worldRight - terrain.worldLeft);

  ctx.save();
  drawRoundedRect(ctx, innerX, innerY, mapWidth, mapHeight, 8);
  ctx.clip();

  ctx.fillStyle = MAP_BG;
  ctx.fillRect(innerX, innerY, mapWidth, mapHeight);

  ctx.fillStyle = MAP_GROUND;
  for (let px = 0; px < mapWidth; px++) {
    const worldX = terrain.worldLeft + ((px + 0.5) / mapWidth) * worldWidth;
    const heightIdx = clamp(
      Math.round(worldX - terrain.worldLeft),
      0,
      terrain.heightMap.length - 1
    );
    const topSolidY = clamp(Math.floor(terrain.heightMap[heightIdx] ?? terrain.height), 0, terrain.height);
    const fillStart = innerY + topSolidY * scale;
    if (fillStart <= innerY + mapHeight) {
      ctx.fillRect(innerX + px, fillStart, 1, innerY + mapHeight - fillStart);
    }
  }

  ctx.save();
  ctx.strokeStyle = "rgba(255,255,255,0.15)";
  ctx.lineWidth = 1;
  ctx.strokeRect(innerX + 0.5, innerY + 0.5, mapWidth - 1, mapHeight - 1);
  ctx.restore();

  ctx.restore();
}

type RadarState = {
  sweepX: number;
  sweepAlpha: number;
};

const RADAR_PERIOD_MS = 2600;

function getRadarState(layout: Layout, now: number): RadarState {
  const { innerX, mapWidth } = layout;
  const t = ((now % RADAR_PERIOD_MS) + RADAR_PERIOD_MS) % RADAR_PERIOD_MS;
  const progress = t / RADAR_PERIOD_MS;
  const sweepX = innerX + progress * mapWidth;
  const sweepAlpha = 0.65;
  return { sweepX, sweepAlpha };
}

function drawRadarGrid(ctx: CanvasRenderingContext2D, layout: Layout) {
  const { innerX, innerY, mapWidth, mapHeight } = layout;
  const gridCol = "rgba(120,255,170,0.07)";
  const majorCol = "rgba(140,255,190,0.09)";
  const vStep = 24;
  const hStep = 18;
  const majorEvery = 4;

  ctx.save();
  drawRoundedRect(ctx, innerX, innerY, mapWidth, mapHeight, 8);
  ctx.clip();

  ctx.lineWidth = 1;

  for (let i = 0, x = 0; x <= mapWidth; i++, x += vStep) {
    ctx.strokeStyle = i % majorEvery === 0 ? majorCol : gridCol;
    ctx.beginPath();
    ctx.moveTo(innerX + x + 0.5, innerY);
    ctx.lineTo(innerX + x + 0.5, innerY + mapHeight);
    ctx.stroke();
  }

  for (let i = 0, y = 0; y <= mapHeight; i++, y += hStep) {
    ctx.strokeStyle = i % majorEvery === 0 ? majorCol : gridCol;
    ctx.beginPath();
    ctx.moveTo(innerX, innerY + y + 0.5);
    ctx.lineTo(innerX + mapWidth, innerY + y + 0.5);
    ctx.stroke();
  }

  ctx.restore();
}

function drawRadarSweep(ctx: CanvasRenderingContext2D, layout: Layout, radar: RadarState) {
  const { innerX, innerY, mapWidth, mapHeight } = layout;
  const sweepX = radar.sweepX;

  const trailPx = Math.max(18, Math.round(mapWidth * 0.14));
  const wrapXs = [sweepX, sweepX - mapWidth];

  ctx.save();
  drawRoundedRect(ctx, innerX, innerY, mapWidth, mapHeight, 8);
  ctx.clip();
  ctx.globalCompositeOperation = "lighter";

  for (const x of wrapXs) {
    const left = x - trailPx;
    const right = x + 5;
    const g = ctx.createLinearGradient(left, 0, right, 0);
    g.addColorStop(0, "rgba(0,255,160,0)");
    g.addColorStop(0.65, `rgba(0,255,160,${0.12 * radar.sweepAlpha})`);
    g.addColorStop(0.96, `rgba(0,255,160,${0.38 * radar.sweepAlpha})`);
    g.addColorStop(1, "rgba(200,255,210,0)");
    ctx.fillStyle = g;
    ctx.fillRect(left, innerY, right - left, mapHeight);

    ctx.save();
    ctx.globalAlpha = 0.55 * radar.sweepAlpha;
    ctx.strokeStyle = "rgba(140,255,190,0.75)";
    ctx.lineWidth = 1.25;
    ctx.beginPath();
    ctx.moveTo(x + 0.5, innerY);
    ctx.lineTo(x + 0.5, innerY + mapHeight);
    ctx.stroke();
    ctx.restore();
  }

  ctx.restore();
}

function drawRadarOverlays(ctx: CanvasRenderingContext2D, layout: Layout, now: number) {
  const { innerX, innerY, mapWidth, mapHeight } = layout;
  const radar = getRadarState(layout, now);

  drawRadarGrid(ctx, layout);

  ctx.save();
  drawRoundedRect(ctx, innerX, innerY, mapWidth, mapHeight, 8);
  ctx.clip();

  const scanStep = 4;
  ctx.globalAlpha = 0.12;
  ctx.fillStyle = "rgba(0,0,0,0.8)";
  for (let y = 0; y < mapHeight; y += scanStep) {
    if ((y / scanStep) % 2 === 0) {
      ctx.fillRect(innerX, innerY + y, mapWidth, 1);
    }
  }

  const flicker = 0.65 + 0.35 * Math.sin(now / 220);
  const rand = mulberry32(Math.floor(now / 180));
  ctx.globalAlpha = 0.08 * flicker;
  ctx.fillStyle = "rgba(180,255,210,0.7)";
  const specks = 34;
  for (let i = 0; i < specks; i++) {
    const x = innerX + rand() * mapWidth;
    const y = innerY + rand() * mapHeight;
    const w = 1 + Math.floor(rand() * 2);
    const h = 1 + Math.floor(rand() * 2);
    ctx.fillRect(x, y, w, h);
  }

  ctx.restore();

  drawRadarSweep(ctx, layout, radar);

  ctx.save();
  drawRoundedRect(ctx, innerX, innerY, mapWidth, mapHeight, 8);
  ctx.clip();
  const cx = innerX + mapWidth / 2;
  const cy = innerY + mapHeight / 2;
  const r = Math.max(mapWidth, mapHeight) * 0.65;
  const vg = ctx.createRadialGradient(cx, cy, r * 0.25, cx, cy, r);
  vg.addColorStop(0, "rgba(0,0,0,0)");
  vg.addColorStop(1, "rgba(0,0,0,0.35)");
  ctx.fillStyle = vg;
  ctx.fillRect(innerX, innerY, mapWidth, mapHeight);
  ctx.restore();
}

function drawSquadDots(
  ctx: CanvasRenderingContext2D,
  layout: Layout,
  terrain: Terrain,
  teams: readonly Team[],
  radar: RadarState | null
) {
  const { innerX, innerY, mapWidth, mapHeight, scale } = layout;
  const dotRadius = 2.6;
  const pingRange = 12;

  ctx.save();
  drawRoundedRect(ctx, innerX, innerY, mapWidth, mapHeight, 8);
  ctx.clip();

  for (const team of teams) {
    const dotColor = teamDotColor(team.id);
    for (const worm of team.worms) {
      if (!worm.alive) continue;
      const mx = innerX + (worm.x - terrain.worldLeft) * scale;
      const my = innerY + worm.y * scale;
      if (mx < innerX || mx > innerX + mapWidth || my < innerY || my > innerY + mapHeight) continue;
      const ping01 = radar ? Math.max(0, 1 - Math.abs(mx - radar.sweepX) / pingRange) : 0;
      if (radar && ping01 > 0) {
        ctx.save();
        ctx.globalCompositeOperation = "lighter";
        ctx.globalAlpha = 0.6 * ping01;
        ctx.fillStyle = "rgba(160,255,200,0.9)";
        ctx.beginPath();
        ctx.arc(mx, my, dotRadius + 4.2 * ping01, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      }

      ctx.fillStyle = dotColor;
      ctx.beginPath();
      ctx.arc(mx, my, dotRadius, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = "rgba(0,0,0,0.65)";
      ctx.lineWidth = 1;
      ctx.stroke();
    }
  }

  ctx.restore();
}

function drawProjectileDot(
  ctx: CanvasRenderingContext2D,
  layout: Layout,
  terrain: Terrain,
  projectiles: readonly Projectile[],
  radar: RadarState | null
) {
  const { innerX, innerY, mapWidth, mapHeight, scale } = layout;

  let projectile: Projectile | null = null;
  for (let i = projectiles.length - 1; i >= 0; i--) {
    const candidate = projectiles[i]!;
    if (!candidate.exploded) {
      projectile = candidate;
      break;
    }
  }
  if (!projectile) return;

  const mx = innerX + (projectile.x - terrain.worldLeft) * scale;
  const my = innerY + projectile.y * scale;
  if (mx < innerX || mx > innerX + mapWidth || my < innerY || my > innerY + mapHeight) return;
  const ping01 = radar ? Math.max(0, 1 - Math.abs(mx - radar.sweepX) / 14) : 0;

  ctx.save();
  drawRoundedRect(ctx, innerX, innerY, mapWidth, mapHeight, 8);
  ctx.clip();
  ctx.globalAlpha = 0.55;
  ctx.fillStyle = "rgba(215,220,230,0.7)";
  ctx.beginPath();
  ctx.arc(mx, my, 2.0, 0, Math.PI * 2);
  ctx.fill();
  if (radar && ping01 > 0) {
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    ctx.globalAlpha = 0.45 * ping01;
    ctx.fillStyle = "rgba(160,255,200,0.8)";
    ctx.beginPath();
    ctx.arc(mx, my, 6.5 * ping01, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }
  ctx.restore();
}

export function renderMapGadget({
  ctx,
  viewportWidth,
  viewportHeight,
  now,
  terrain,
  teams,
  projectiles = [],
  showRadar = true,
  maxWidthPx,
  topOffsetPx,
}: MapGadgetOptions): void {
  if (viewportWidth <= 0 || viewportHeight <= 0) return;
  if (teams.length === 0) return;

  const layout = getLayout({
    viewportWidth,
    terrain,
    ...(maxWidthPx !== undefined ? { maxWidthPx } : {}),
    ...(topOffsetPx !== undefined ? { topOffsetPx } : {}),
  });
  if (layout.outerWidth <= 0 || layout.outerHeight <= 0) return;
  if (layout.y + layout.outerHeight < 0) return;
  if (layout.x > viewportWidth) return;

  const radar = showRadar ? getRadarState(layout, now) : null;

  ctx.save();
  drawMetalFrame(ctx, layout);
  drawMapContents(ctx, layout, terrain);
  if (showRadar) {
    drawRadarOverlays(ctx, layout, now);
  }
  drawSquadDots(ctx, layout, terrain, teams, radar);
  if (projectiles.length > 0) drawProjectileDot(ctx, layout, terrain, projectiles, radar);
  ctx.restore();
}
