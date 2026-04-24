import type { TeamId } from "../../definitions";
import { WeaponType } from "../../definitions";
import type {
  TurnCommandMessage,
  TurnEffectsMessage,
  TurnResolutionMessage,
} from "./messages";
import { applyAimThrottle, type AimThrottleState } from "./aim-throttle";
import { applyMoveThrottle, flushMoveThrottle, type MoveThrottleState } from "./move-throttle";
import type { TurnCommand, TurnResolution } from "./turn-payload";

export type NetworkTurnRelayMeta = {
  turnIndex: number;
  teamId: TeamId;
};

export type NetworkTurnRelaySender = (
  message: TurnCommandMessage | TurnEffectsMessage | TurnResolutionMessage
) => void;

const TURN_EFFECTS_FLUSH_INTERVAL_MS = 1000;

const toTurnCommandMessage = (
  command: TurnCommand,
  meta: NetworkTurnRelayMeta
): TurnCommandMessage => ({
  type: "turn_command",
  payload: {
    turnIndex: meta.turnIndex,
    teamId: meta.teamId,
    command,
  },
});

export class NetworkTurnRelay {
  private aimThrottleState: AimThrottleState | null = null;
  private moveThrottleState: MoveThrottleState | null = null;
  private pendingTurnEffects: TurnEffectsMessage["payload"] | null = null;
  private pendingTurnEffectsNextFlushAtMs = 0;

  constructor(private readonly nowMs: () => number) {}

  reset() {
    this.aimThrottleState = null;
    this.moveThrottleState = null;
    this.pendingTurnEffects = null;
    this.pendingTurnEffectsNextFlushAtMs = 0;
  }

  handleLocalTurnCommand(
    command: TurnCommand,
    meta: NetworkTurnRelayMeta,
    activeWorm: { x: number; y: number },
    send: NetworkTurnRelaySender
  ) {
    const now = this.nowMs();

    if (command.type !== "aim" && command.type !== "move") {
      const flushed = flushMoveThrottle({ state: this.moveThrottleState, nowMs: now });
      this.moveThrottleState = flushed.nextState;
      for (const movement of flushed.toSend) {
        send(toTurnCommandMessage(movement, meta));
      }
    }

    if (command.type === "aim") {
      const decision = applyAimThrottle({
        state: this.aimThrottleState,
        config: {
          minIntervalMs: 60,
          maxIntervalMs: 250,
          diffThreshold: 0.2,
          angleThresholdRad: 0.2,
        },
        nowMs: now,
        turnIndex: meta.turnIndex,
        teamId: meta.teamId,
        wormX: activeWorm.x,
        wormY: activeWorm.y,
        aim: command.aim,
      });
      this.aimThrottleState = decision.nextState;
      if (!decision.shouldSend) return;
    }

    if (command.type === "move") {
      const decision = applyMoveThrottle({
        state: this.moveThrottleState,
        config: {
          minIntervalMs: 60,
          suppressIdle: true,
        },
        nowMs: now,
        turnIndex: meta.turnIndex,
        teamId: meta.teamId,
        movement: command,
      });
      this.moveThrottleState = decision.nextState;
      for (const movement of decision.toSend) {
        send(toTurnCommandMessage(movement, meta));
      }
      return;
    }

    send(toTurnCommandMessage(command, meta));
  }

  handleLocalTurnEffects(
    effects: TurnEffectsMessage["payload"],
    send: NetworkTurnRelaySender
  ) {
    const shouldBatch =
      effects.terrainOperations.every((op) => op.type !== "carve-circle" || op.radius <= 10) &&
      effects.wormHealth.every((change) => change.cause === WeaponType.Uzi);
    if (!shouldBatch) {
      this.flushPendingTurnEffects(true, send);
      send({
        type: "turn_effects",
        payload: effects,
      });
      return;
    }

    const pending = this.pendingTurnEffects;
    if (!pending || pending.turnIndex !== effects.turnIndex || pending.actingTeamId !== effects.actingTeamId) {
      this.flushPendingTurnEffects(true, send);
      this.pendingTurnEffects = {
        turnIndex: effects.turnIndex,
        actingTeamId: effects.actingTeamId,
        terrainOperations: [...effects.terrainOperations],
        wormHealth: [...effects.wormHealth],
      };
      if (this.pendingTurnEffectsNextFlushAtMs <= 0) {
        this.pendingTurnEffectsNextFlushAtMs = this.nowMs() + TURN_EFFECTS_FLUSH_INTERVAL_MS;
      }
      return;
    }

    pending.terrainOperations.push(...effects.terrainOperations);
    pending.wormHealth.push(...effects.wormHealth);

    if (pending.terrainOperations.length + pending.wormHealth.length >= 24) {
      this.flushPendingTurnEffects(true, send);
    }
  }

  flushPendingTurnEffects(force: boolean, send: NetworkTurnRelaySender) {
    const pending = this.pendingTurnEffects;
    if (!pending) return;
    if (pending.terrainOperations.length === 0 && pending.wormHealth.length === 0) {
      this.pendingTurnEffects = null;
      this.pendingTurnEffectsNextFlushAtMs = 0;
      return;
    }

    const now = this.nowMs();
    if (!force && now < this.pendingTurnEffectsNextFlushAtMs) return;

    send({
      type: "turn_effects",
      payload: pending,
    });
    this.pendingTurnEffects = null;
    this.pendingTurnEffectsNextFlushAtMs = now + TURN_EFFECTS_FLUSH_INTERVAL_MS;
  }

  flushTurnResolution(
    resolution: TurnResolution | null,
    send: NetworkTurnRelaySender
  ) {
    if (!resolution) return;
    this.flushPendingTurnEffects(true, send);
    send({
      type: "turn_resolution",
      payload: resolution,
    });
  }
}
