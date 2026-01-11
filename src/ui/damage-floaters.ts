import type { TeamId } from "../definitions";
import { WORLD } from "../definitions";
import { drawText } from "../utils";
import type { GameSession } from "../game/session";
import type { GameEventMap } from "../events/game-events";

type DamageFloater = {
  id: number;
  createdAtMs: number;
  teamId: TeamId;
  wormIndex: number;
  amount: number;
  offsetX: number;
  offsetY: number;
  seedPosition: { x: number; y: number };
};

export type DamageFloaterDebugSnapshot = Readonly<Pick<DamageFloater, "teamId" | "wormIndex" | "amount" | "createdAtMs">>;

const DAMAGE_FLOATER_TTL_MS = 3000;

function easeOutQuad(t: number): number {
  const clamped = Math.max(0, Math.min(1, t));
  return 1 - (1 - clamped) * (1 - clamped);
}

export class DamageFloaters {
  private nextId = 1;
  private floaters: DamageFloater[] = [];

  getDebugSnapshot(nowMs: number): DamageFloaterDebugSnapshot[] {
    return this.floaters
      .filter((floater) => nowMs - floater.createdAtMs < DAMAGE_FLOATER_TTL_MS)
      .map(({ teamId, wormIndex, amount, createdAtMs }) => ({
        teamId,
        wormIndex,
        amount,
        createdAtMs,
      }));
  }

  onWormHealthChanged(event: GameEventMap["worm.health.changed"], nowMs: number) {
    const damage = Math.max(0, -Math.round(event.delta));
    if (damage <= 0) return;

    this.prune(nowMs);

    for (let i = this.floaters.length - 1; i >= 0; i--) {
      const floater = this.floaters[i];
      if (!floater) continue;
      if (floater.teamId !== event.teamId || floater.wormIndex !== event.wormIndex) continue;

      floater.createdAtMs = nowMs;
      floater.amount += damage;
      floater.seedPosition = { ...event.position };
      return;
    }

    const jitter = (Math.random() - 0.5) * 14;
    const heightJitter = (Math.random() - 0.5) * 8;
    this.floaters.push({
      id: this.nextId++,
      createdAtMs: nowMs,
      teamId: event.teamId,
      wormIndex: event.wormIndex,
      amount: damage,
      offsetX: jitter,
      offsetY: heightJitter,
      seedPosition: { ...event.position },
    });
  }

  prune(nowMs: number) {
    this.floaters = this.floaters.filter((floater) => nowMs - floater.createdAtMs < DAMAGE_FLOATER_TTL_MS);
  }

  render(ctx: CanvasRenderingContext2D, session: GameSession, nowMs: number) {
    if (this.floaters.length === 0) return;
    this.prune(nowMs);
    if (this.floaters.length === 0) return;

    for (const floater of this.floaters) {
      const ageMs = Math.max(0, nowMs - floater.createdAtMs);
      const progress = ageMs / DAMAGE_FLOATER_TTL_MS;
      if (progress >= 1) continue;

      const ease = easeOutQuad(progress);
      const alpha = Math.max(0, 0.9 * (1 - ease) * (1 - ease));

      const team = session.teams.find((t) => t.id === floater.teamId);
      const worm = team?.worms[floater.wormIndex];
      const anchorX = worm?.x ?? floater.seedPosition.x;
      const anchorY = worm?.y ?? floater.seedPosition.y;
      const wormRadius = worm?.radius ?? WORLD.wormRadius;

      const risePx = 42;
      const baseY = anchorY - wormRadius - 8 + floater.offsetY;
      const x = anchorX + floater.offsetX;
      const y = baseY - ease * risePx;

      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.strokeStyle = "rgba(255,255,255,0.45)";
      ctx.lineWidth = 1.5;
      ctx.lineCap = "round";
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x, y - 12);
      ctx.stroke();

      drawText(ctx, `-${floater.amount}`, x, y - 14, "rgba(255,255,255,0.92)", 14, "center", "bottom", false);
      ctx.restore();
    }
  }
}
