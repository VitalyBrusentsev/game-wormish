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

const ARROW_DURATION_MS = 3000;

function easeOutCubic(t: number): number {
  const clamped = Math.max(0, Math.min(1, t));
  return 1 - Math.pow(1 - clamped, 3);
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

    const eased = easeOutCubic(progress);
    const alpha = Math.max(0, 1 - eased);
    const bounceT = ageMs / 330;
    const bouncePx = (Math.sin(bounceT * Math.PI * 2) * 6 + 6) * (1 - eased);

    const baseY = worm.y - worm.radius - 58;
    const x = worm.x;
    const y = baseY - bouncePx;

    const arrowWidth = 30;
    const arrowHeight = 44;
    const headHeight = 18;
    const shaftWidth = 12;

    const fill = worm.team === "Red" ? COLORS.red : COLORS.blue;

    ctx.save();
    ctx.translate(x, y);
    ctx.globalAlpha = 0.92 * alpha;

    ctx.shadowColor = "rgba(0,0,0,0.35)";
    ctx.shadowBlur = 10;
    ctx.shadowOffsetX = 0;
    ctx.shadowOffsetY = 6;

    ctx.fillStyle = fill;
    ctx.beginPath();
    ctx.moveTo(0, arrowHeight / 2);
    ctx.lineTo(arrowWidth / 2, arrowHeight / 2 - headHeight);
    ctx.lineTo(shaftWidth / 2, arrowHeight / 2 - headHeight);
    ctx.lineTo(shaftWidth / 2, -arrowHeight / 2);
    ctx.lineTo(-shaftWidth / 2, -arrowHeight / 2);
    ctx.lineTo(-shaftWidth / 2, arrowHeight / 2 - headHeight);
    ctx.lineTo(-arrowWidth / 2, arrowHeight / 2 - headHeight);
    ctx.closePath();
    ctx.fill();

    ctx.shadowColor = "transparent";
    ctx.lineWidth = 3;
    ctx.strokeStyle = "rgba(255,255,255,0.75)";
    ctx.stroke();

    ctx.globalAlpha = 0.65 * alpha;
    ctx.fillStyle = "rgba(255,255,255,0.22)";
    ctx.beginPath();
    ctx.moveTo(0, -arrowHeight / 2 + 3);
    ctx.lineTo(shaftWidth / 2 - 2, -arrowHeight / 2 + 10);
    ctx.lineTo(-shaftWidth / 2 + 2, -arrowHeight / 2 + 10);
    ctx.closePath();
    ctx.fill();

    ctx.restore();
  }
}
