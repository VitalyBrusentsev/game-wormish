import { playTurnWithGameAiForTeamAsync } from "../ai/game-ai-async";
import { findFarthestWormIndex } from "../ai/team-worm-selection";
import type { TurnContext, TurnDriver, TurnDriverUpdateOptions } from "./turn-driver";

export class AiTurnController implements TurnDriver {
  readonly type = "ai" as const;

  private pendingStart = false;
  private openingWormSelected = false;
  private lastTurnIndex = -1;

  beginTurn(context: TurnContext) {
    const turnIndex = context.session.getTurnIndex();
    if (turnIndex < this.lastTurnIndex) {
      this.openingWormSelected = false;
    }
    this.lastTurnIndex = turnIndex;

    if (!this.openingWormSelected) {
      const enemyTeams = context.session.teams.filter((team) => team.id !== context.team.id);
      const wormIndex = findFarthestWormIndex(context.team, enemyTeams);
      context.session.debugSelectWorm(context.team.id, wormIndex);
      this.openingWormSelected = true;
    }

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
    void Promise.resolve(playTurnWithGameAiForTeamAsync(context.session, context.team.id)).catch(
      () => undefined
    );
  }

  endTurn() {
    this.pendingStart = false;
  }
}
