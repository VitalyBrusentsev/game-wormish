import { playTurnWithGameAiForTeam } from "../ai/game-ai";
import type { TurnContext, TurnDriver, TurnDriverUpdateOptions } from "./turn-driver";

export class AiTurnController implements TurnDriver {
  readonly type = "ai" as const;

  private pendingStart = false;

  beginTurn(_context: TurnContext) {
    this.pendingStart = true;
  }

  update(
    context: TurnContext,
    _dt: number,
    options: TurnDriverUpdateOptions
  ) {
    if (!this.pendingStart) return;
    if (!options.allowInput) return;
    if (!context.session.isLocalTurnActive()) return;
    this.pendingStart = false;
    playTurnWithGameAiForTeam(context.session, context.team.id);
  }

  endTurn() {
    this.pendingStart = false;
  }
}
