import { GAMEPLAY, COLORS, clamp } from "../definitions";
import type { GameSession } from "../game/session";

type CountdownState = {
  second: number;
  changedAtMs: number;
};

const COUNTDOWN_FROM_SECONDS = 5;
const SECOND_MS = 1000;

function easeOutBack(t: number): number {
  const clamped = clamp(t, 0, 1);
  const c1 = 1.70158;
  const c3 = c1 + 1;
  return 1 + c3 * Math.pow(clamped - 1, 3) + c1 * Math.pow(clamped - 1, 2);
}

export class TurnCountdownOverlay {
  private state: CountdownState | null = null;

  render(ctx: CanvasRenderingContext2D, session: GameSession, nowMs: number, width: number, height: number) {
    if (!session.isLocalTurnActive()) {
      this.state = null;
      return;
    }
    if (session.state.phase !== "aim") {
      this.state = null;
      return;
    }

    const timeLeftMs = session.state.timeLeftMs(nowMs, GAMEPLAY.turnTimeMs);
    const secondsLeft = Math.ceil(timeLeftMs / SECOND_MS);
    if (secondsLeft <= 0 || secondsLeft > COUNTDOWN_FROM_SECONDS) {
      this.state = null;
      return;
    }

    if (!this.state || this.state.second !== secondsLeft) {
      this.state = { second: secondsLeft, changedAtMs: nowMs };
    }

    const sinceChangeMs = Math.max(0, nowMs - this.state.changedAtMs);
    const progress = clamp(sinceChangeMs / SECOND_MS, 0, 1);
    const pop = easeOutBack(progress);
    const scale = 0.92 + pop * 0.12;
    const alpha = clamp(0.92 - progress * 0.25, 0, 1);
    const yJitter = (1 - progress) * 10;

    const x = width / 2;
    const y = height / 2 - 40 - yJitter;
    const text = String(secondsLeft);

    ctx.save();
    ctx.translate(x, y);
    ctx.scale(scale, scale);
    ctx.globalAlpha = alpha;

    ctx.font = "900 96px ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";

    ctx.shadowColor = "rgba(0,0,0,0.45)";
    ctx.shadowBlur = 18;
    ctx.shadowOffsetX = 0;
    ctx.shadowOffsetY = 10;

    ctx.lineWidth = 8;
    ctx.strokeStyle = "rgba(0,0,0,0.45)";
    ctx.strokeText(text, 0, 0);

    ctx.shadowColor = "transparent";
    ctx.lineWidth = 4;
    ctx.strokeStyle = "rgba(255,255,255,0.8)";
    ctx.strokeText(text, 0, 0);

    const fill = secondsLeft <= 2 ? "#ffcc00" : COLORS.white;
    ctx.fillStyle = fill;
    ctx.fillText(text, 0, 0);

    ctx.restore();
  }
}
