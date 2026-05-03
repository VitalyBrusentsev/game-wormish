import { COLORS } from "../definitions";
import type { TeamId } from "../definitions";
import type { GameSession } from "../game/session";
import type { GameEventMap } from "../events/game-events";

type ArrowState = {
  shownAtMs: number;
  teamId: TeamId;
  wormIndex: number;
  turnIndex: number;
};

const ARROW_DURATION_MS = 4000;
const ARROW_FADE_START_MS = 2500;

function easeInCubic(t: number): number {
  const clamped = Math.max(0, Math.min(1, t));
  return clamped * clamped * clamped;
}

function drawArrowPath(ctx: CanvasRenderingContext2D, size = 1) {
  ctx.beginPath();
  ctx.moveTo(0, 17 * size);
  ctx.lineTo(26 * size, -17 * size);
  ctx.lineTo(-26 * size, -17 * size);
  ctx.closePath();
}

export class ActiveWormArrow {
  private state: ArrowState | null = null;

  onTurnStarted(event: GameEventMap["turn.started"], nowMs: number) {
    this.state = {
      shownAtMs: nowMs,
      teamId: event.teamId,
      wormIndex: event.wormIndex,
      turnIndex: event.turnIndex,
    };
  }

  dismissForTurn(meta: { turnIndex: number; teamId: TeamId; wormIndex?: number }) {
    const state = this.state;
    if (!state) return;
    if (state.turnIndex !== meta.turnIndex) return;
    if (state.teamId !== meta.teamId) return;
    if (meta.wormIndex !== undefined && state.wormIndex !== meta.wormIndex) return;
    this.state = null;
  }

  render(ctx: CanvasRenderingContext2D, session: GameSession, nowMs: number) {
    const state = this.state;
    if (!state) return;

    const ageMs = Math.max(0, nowMs - state.shownAtMs);
    const progress = ageMs / ARROW_DURATION_MS;
    if (progress >= 1) {
      this.state = null;
      return;
    }

    const team = session.teams.find((t) => t.id === state.teamId);
    const worm = team?.worms[state.wormIndex];
    if (!worm || !worm.alive) return;
    if (session.getTurnIndex() !== state.turnIndex) return;
    if (session.activeTeam.id !== state.teamId) return;
    if (session.activeWormIndex !== state.wormIndex) return;

    const fadeStart = Math.min(1, Math.max(0, ARROW_FADE_START_MS / ARROW_DURATION_MS));
    const fadeT = progress <= fadeStart ? 0 : (progress - fadeStart) / (1 - fadeStart);
    const alpha = Math.max(0, 1 - easeInCubic(fadeT));
    const bounceT = ageMs / 330;
    const bouncePx = (Math.sin(bounceT * Math.PI * 2) * 6 + 6) * alpha;

    const baseY = worm.y - worm.radius - 58;
    const x = worm.x;
    const y = baseY - bouncePx;

    const fill = worm.team === "Red" ? COLORS.red : COLORS.blue;
    const pulse = 0.5 + 0.5 * Math.sin((ageMs / 680) * Math.PI * 2);
    const glowAlpha = alpha * (0.72 + pulse * 0.16);

    ctx.save();
    ctx.translate(x, y);

    ctx.globalAlpha = 0.3 * alpha;
    ctx.shadowColor = fill;
    ctx.shadowBlur = 28;
    ctx.shadowOffsetX = 0;
    ctx.shadowOffsetY = 0;
    ctx.strokeStyle = fill;
    ctx.lineWidth = 10;
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    drawArrowPath(ctx, 1.02);
    ctx.stroke();

    ctx.globalAlpha = 0.18 * alpha;
    ctx.shadowBlur = 18;
    ctx.translate(0, 5 + pulse * 3);
    ctx.strokeStyle = fill;
    ctx.lineWidth = 8;
    drawArrowPath(ctx, 0.9);
    ctx.stroke();
    ctx.translate(0, -(5 + pulse * 3));

    ctx.shadowColor = "transparent";
    ctx.globalAlpha = 1;
    const bodyFill = ctx.createLinearGradient(0, -20, 0, 19);
    bodyFill.addColorStop(0, `rgba(255,255,255,${0.18 * alpha})`);
    bodyFill.addColorStop(0.48, `rgba(128,226,255,${0.11 * alpha})`);
    bodyFill.addColorStop(1, `rgba(255,255,255,${0.04 * alpha})`);
    ctx.fillStyle = bodyFill;
    drawArrowPath(ctx);
    ctx.fill();

    ctx.globalAlpha = glowAlpha;
    ctx.shadowColor = fill;
    ctx.shadowBlur = 9 + pulse * 5;
    ctx.strokeStyle = fill;
    ctx.lineWidth = 5.5;
    drawArrowPath(ctx);
    ctx.stroke();

    ctx.globalAlpha = 0.88 * alpha;
    ctx.shadowColor = "rgba(255,255,255,0.9)";
    ctx.shadowBlur = 5;
    ctx.strokeStyle = "rgba(226,250,255,0.94)";
    ctx.lineWidth = 2.1;
    drawArrowPath(ctx, 0.86);
    ctx.stroke();

    ctx.globalAlpha = 0.48 * alpha;
    ctx.shadowColor = fill;
    ctx.shadowBlur = 10;
    ctx.strokeStyle = "rgba(255,255,255,0.9)";
    ctx.lineWidth = 3.2;
    ctx.beginPath();
    ctx.moveTo(-6, 10);
    ctx.quadraticCurveTo(0, 16, 6, 10);
    ctx.stroke();

    ctx.restore();
  }
}
