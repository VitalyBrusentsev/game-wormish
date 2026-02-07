import type { Input } from "../utils";
import type { TurnCommand, TurnResolution } from "./network/turn-payload";
import type { GameSession } from "./session";
import type { Team } from "./team-manager";

export type TurnControlType = "local" | "remote" | "ai";

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
  private pendingCommands: Array<{ turnIndex: number; command: TurnCommand }> = [];
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

    while (this.pendingCommands.length > 0) {
      const next = this.pendingCommands[0]!;
      if (next.turnIndex !== context.session.getTurnIndex()) {
        this.pendingCommands.shift();
        continue;
      }
      this.pendingCommands.shift();
      context.session.applyRemoteTurnCommand(next.command);
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

  receiveCommand(turnIndex: number, command: TurnCommand) {
    if (
      this.context &&
      this.awaitingResolution &&
      this.context.session.isWaitingForRemoteResolution() &&
      this.context.session.getTurnIndex() === turnIndex
    ) {
      this.context.session.applyRemoteTurnCommand(command);
      return;
    }
    this.pendingCommands.push({ turnIndex, command });
  }

  private applyResolution(context: TurnContext, resolution: TurnResolution) {
    this.awaitingResolution = false;
    this.context = null;
    this.pendingResolutions.length = 0;
    this.pendingCommands.length = 0;
    context.session.applyTurnResolution(resolution, { localizeTime: true });
  }

  private clearPending() {
    this.awaitingResolution = false;
    this.context = null;
    this.pendingResolutions.length = 0;
    this.pendingCommands.length = 0;
  }
}
