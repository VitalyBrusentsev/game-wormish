import type { TeamId } from "../definitions";
import { GAMEPLAY, WeaponType } from "../definitions";
import type { GameState } from "../game-state";
import { drawRoundedRect } from "../utils";
import {
  drawCenterWeaponPanel,
  drawHudText,
  drawTeamPanel,
  drawTimerPill,
  truncateHudText,
} from "./hud-primitives";

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
  timeLabelY?: number;
  topOffsetPx?: number;
  showChargeHint?: boolean;
};

function drawChargeBar(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  charge: number,
  showHint: boolean
) {
  const w = Math.min(300, Math.max(190, width * 0.24));
  const h = 18;
  const x = (width - w) / 2;
  const y = height - h - 18;

  ctx.save();
  drawRoundedRect(ctx, x, y, w, h, h / 2);
  ctx.fillStyle = "rgba(8,22,36,0.82)";
  ctx.fill();
  ctx.strokeStyle = "rgba(255,255,255,0.25)";
  ctx.lineWidth = 1.5;
  ctx.stroke();

  drawRoundedRect(ctx, x + 3, y + 3, Math.max(0, (w - 6) * charge), h - 6, (h - 6) / 2);
  const fill = ctx.createLinearGradient(x, y, x + w, y);
  fill.addColorStop(0, "#ffe06a");
  fill.addColorStop(1, "#ff6f38");
  ctx.fillStyle = fill;
  ctx.fill();

  if (showHint) {
    drawHudText({
      ctx,
      text: "Hold and release to fire",
      x: width / 2,
      y: y - 19,
      size: 14,
      align: "center",
      weight: 800,
    });
  }
  ctx.restore();
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
  timeLabelY,
  topOffsetPx = 0,
  showChargeHint = true,
}: RenderHudOptions) {
  const compact = width < 760;
  const compactScale = 0.84;
  const panelGap = compact ? 4 : 0;
  const sideInset = compact ? (width < 390 ? 4 : 6) : 15;
  const top = (compact ? 10 : 14) + Math.max(0, topOffsetPx);
  const centerW = compact
    ? Math.round(Math.min(138, Math.max(118, width * 0.31)))
    : Math.min(410, width * 0.25);
  const panelW = compact
    ? Math.max(
        112,
        Math.min(132, (width - sideInset * 2 - centerW - panelGap * 2) / 2)
      )
    : Math.min(486, Math.max(330, width * 0.29));
  const panelH = compact ? Math.round(56 * compactScale) : 96;
  const avatar = compact ? Math.round(44 * compactScale) : 86;
  const centerH = compact ? Math.round(52 * compactScale) : 94;
  const centerX = (width - centerW) / 2;
  const [leftTeamId, rightTeamId] = teamDisplayOrder ?? ["Red", "Blue"];
  const maxTeamHealth = GAMEPLAY.teamSize * 100;
  const leftStatus = networkMicroStatus?.opponentSide === "left"
    ? { text: networkMicroStatus.text, color: networkMicroStatus.color }
    : undefined;
  const rightStatus = networkMicroStatus?.opponentSide === "right"
    ? { text: networkMicroStatus.text, color: networkMicroStatus.color }
    : undefined;

  drawTeamPanel({
    ctx,
    layout: { x: sideInset, y: top, w: panelW, h: panelH, avatar, compact, scale: compactScale },
    side: "left",
    teamId: leftTeamId,
    label: teamLabels?.[leftTeamId] ?? leftTeamId,
    health: getTeamHealth(leftTeamId),
    maxHealth: maxTeamHealth,
    active: activeTeamId === leftTeamId,
    ...(leftStatus ? { networkStatus: leftStatus } : {}),
  });
  drawTeamPanel({
    ctx,
    layout: { x: width - sideInset - panelW, y: top, w: panelW, h: panelH, avatar, compact, scale: compactScale },
    side: "right",
    teamId: rightTeamId,
    label: teamLabels?.[rightTeamId] ?? rightTeamId,
    health: getTeamHealth(rightTeamId),
    maxHealth: maxTeamHealth,
    active: activeTeamId === rightTeamId,
    ...(rightStatus ? { networkStatus: rightStatus } : {}),
  });

  const weaponLabel = state.weapon === WeaponType.HandGrenade ? "Grenade" : state.weapon;
  drawCenterWeaponPanel({
    ctx,
    x: centerX,
    y: top - (compact ? 1 : 2),
    w: centerW,
    h: centerH,
    teamLabel: activeTeamLabel ?? `${activeTeamId} Team`,
    weaponLabel,
    wind,
    compact,
    scale: compactScale,
  });

  const timeLeftMs = state.timeLeftMs(now, turnDurationMs);
  const timeLeft = Math.max(0, Math.ceil(timeLeftMs / 1000));
  const timerY = timeLabelY !== undefined ? timeLabelY - (compact ? 15 : 21) : top + centerH + (compact ? 8 : 12);
  drawTimerPill(ctx, width / 2, timerY, timeLeft, compact);

  if (message && state.phase !== "gameover") {
    const y = Math.max(top + centerH + 60, compact ? top + 94 : top + 128);
    drawHudText({
      ctx,
      text: truncateHudText(ctx, message, width * 0.62, compact ? 14 : 17, 800),
      x: width / 2,
      y,
      size: compact ? 14 : 17,
      align: "center",
      weight: 800,
    });
  }

  if (state.phase === "aim" && state.charging) {
    drawChargeBar(ctx, width, height, state.getCharge01(now), showChargeHint);
  }
}
