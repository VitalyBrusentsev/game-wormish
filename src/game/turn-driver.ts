import type { Input } from "../utils";
import type { TurnResolution } from "./network/turn-payload";
import type { GameSession } from "./session";
import type { Team } from "./team-manager";

export type TurnControlType = "local" | "remote";

export interface TurnContext {
  session: GameSession;
  team: Team;
  teamIndex: number;
  initial: boolean;
}

export interface TurnDriverUpdateOptions {
  allowInput: boolean;
  input: Input;
  camera: { offsetX: number; offsetY: number };
}

export interface TurnDriver {
  readonly type: TurnControlType;
  beginTurn(context: TurnContext): void;
  update(context: TurnContext, dt: number, options: TurnDriverUpdateOptions): void;
  endTurn?(context: TurnContext, resolution: TurnResolution): void;
}

export class LocalTurnController implements TurnDriver {
  readonly type: TurnControlType = "local";

  private acceptingInput = false;

  beginTurn() {
    this.acceptingInput = true;
  }

  update(
    context: TurnContext,
    dt: number,
    options: TurnDriverUpdateOptions
  ) {
    if (!this.acceptingInput) return;
    if (!options.allowInput) return;
    if (!context.session.isLocalTurnActive()) return;
    context.session.handleInput(options.input, dt, options.camera);
  }

  endTurn() {
    this.acceptingInput = false;
  }
}

export class RemoteTurnController implements TurnDriver {
  readonly type: TurnControlType = "remote";

  private awaitingResolution = false;
  private pendingResolutions: TurnResolution[] = [];
  private context: TurnContext | null = null;

  beginTurn(context: TurnContext) {
    this.context = context;
    this.awaitingResolution = true;
  }

  update(
    context: TurnContext,
    _dt: number,
    _options: TurnDriverUpdateOptions
  ) {
    if (!this.awaitingResolution) return;
    if (!context.session.isWaitingForRemoteResolution()) {
      this.clearPending();
      return;
    }

    const resolution = this.pendingResolutions.shift();
    if (!resolution) return;

    this.applyResolution(context, resolution);
  }

  receiveResolution(resolution: TurnResolution) {
    if (
      this.context &&
      this.awaitingResolution &&
      this.context.session.isWaitingForRemoteResolution()
    ) {
      this.applyResolution(this.context, resolution);
      return;
    }
    this.pendingResolutions.push(resolution);
  }

  private applyResolution(context: TurnContext, resolution: TurnResolution) {
    this.awaitingResolution = false;
    this.context = null;
    this.pendingResolutions.length = 0;
    context.session.applyTurnResolution(resolution);
    context.session.nextTurn();
  }

  private clearPending() {
    this.awaitingResolution = false;
    this.context = null;
    this.pendingResolutions.length = 0;
  }
}
