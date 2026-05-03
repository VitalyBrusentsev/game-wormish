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

    ctx.save();
    ctx.translate(x, y);
    ctx.globalAlpha = 0.92 * alpha;

    ctx.shadowColor = fill;
    ctx.shadowBlur = 16;
    ctx.shadowOffsetX = 0;
    ctx.shadowOffsetY = 0;

    ctx.fillStyle = "rgba(255,255,255,0.08)";
    ctx.strokeStyle = fill;
    ctx.lineWidth = 3.5;
    ctx.beginPath();
    ctx.moveTo(0, 17);
    ctx.lineTo(26, -17);
    ctx.lineTo(-26, -17);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    ctx.shadowColor = "transparent";
    ctx.globalAlpha = 0.78 * alpha;
    ctx.strokeStyle = "rgba(255,255,255,0.86)";
    ctx.lineWidth = 1.7;
    ctx.beginPath();
    ctx.moveTo(0, 10);
    ctx.lineTo(18, -13);
    ctx.lineTo(-18, -13);
    ctx.closePath();
    ctx.stroke();

    ctx.restore();
  }
}
