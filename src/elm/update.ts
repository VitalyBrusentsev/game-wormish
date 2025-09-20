/**
 * Pure update reducer: transforms immutable state in response to messages.
 * Scaffold implementation: handles TickAdvanced minimally; others no-op.
 */

import type { AppState } from "./state";
import type { Msg } from "./msg";
import type { EffectDescriptor } from "./effects";

export type UpdateResult = { state: AppState; effects: EffectDescriptor[] };

export function update(state: AppState, msg: Msg): UpdateResult {
  switch (msg.type) {
    // Time and loop
    case "TickAdvanced": {
      const next: AppState = {
        ...state,
        session: {
          ...state.session,
          turn: {
            ...state.session.turn,
            timeNowMs: msg.nowMs,
          },
        },
      };
      return { state: next, effects: [] };
    }

    case "Turn.Started": {
      const next: AppState = {
        ...state,
        session: {
          ...state.session,
          turn: {
            ...state.session.turn,
            turnStartAtMs: msg.nowMs,
            timeNowMs: msg.nowMs,
          },
        },
      };
      return { state: next, effects: [] };
    }

    case "Turn.Advanced": {
      // Incrementing indices is deferred; here we only reset timers deterministically.
      const next: AppState = {
        ...state,
        session: {
          ...state.session,
          turn: {
            ...state.session.turn,
            turnStartAtMs: msg.nowMs,
            timeNowMs: msg.nowMs,
          },
        },
      };
      return { state: next, effects: [] };
    }

    case "WindChanged": {
      const now = state.session.turn.timeNowMs;
      const next: AppState = {
        ...state,
        session: {
          ...state.session,
          turn: {
            ...state.session.turn,
            wind: {
              strength: msg.strength,
              lastUpdatedAtMs: now,
            },
          },
        },
      };
      return { state: next, effects: [] };
    }

    // Input mirroring into UI state (no gameplay behavior changes)
    case "Input.Move": {
      const now = state.session.turn.timeNowMs;
      const left = msg.direction === -1 ? msg.pressed : state.ui.input.moveLeft;
      const right = msg.direction === 1 ? msg.pressed : state.ui.input.moveRight;
      const next: AppState = {
        ...state,
        ui: {
          ...state.ui,
          input: {
            ...state.ui.input,
            moveLeft: left,
            moveRight: right,
            lastInputAtMs: now,
          },
        },
      };
      return { state: next, effects: [] };
    }

    case "Input.Jump": {
      const now = state.session.turn.timeNowMs;
      const next: AppState = {
        ...state,
        ui: {
          ...state.ui,
          input: { ...state.ui.input, lastInputAtMs: now },
        },
      };
      return { state: next, effects: [] };
    }

    case "Input.FirePressed": {
      const next: AppState = {
        ...state,
        ui: {
          ...state.ui,
          input: {
            ...state.ui.input,
            fireHeld: true,
            lastInputAtMs: msg.nowMs,
          },
        },
      };
      return { state: next, effects: [] };
    }

    case "Input.FireReleased": {
      const next: AppState = {
        ...state,
        ui: {
          ...state.ui,
          input: {
            ...state.ui.input,
            fireHeld: false,
            lastInputAtMs: msg.nowMs,
          },
        },
      };
      return { state: next, effects: [] };
    }

    case "Input.SelectWeapon": {
      const next: AppState = {
        ...state,
        ui: { ...state.ui, selectedWeapon: msg.weapon },
      };
      return { state: next, effects: [] };
    }

    // Game phase / pause
    case "Game.Paused": {
      if (state.session.phase !== "playing") return { state, effects: [] };
      const next: AppState = { ...state, session: { ...state.session, phase: "paused" } };
      return { state: next, effects: [] };
    }
    case "Game.Resumed": {
      if (state.session.phase !== "paused") return { state, effects: [] };
      const next: AppState = { ...state, session: { ...state.session, phase: "playing" } };
      return { state: next, effects: [] };
    }

    // UI messages
    case "UI.MessageSet": {
      const next: AppState = {
        ...state,
        ui: {
          ...state.ui,
          message: msg.text,
          messageUntilMs: msg.untilMs ?? null,
        },
      };
      return { state: next, effects: [] };
    }
    case "UI.MessageCleared": {
      if (state.ui.message == null && state.ui.messageUntilMs == null) {
        return { state, effects: [] };
      }
      const next: AppState = {
        ...state,
        ui: { ...state.ui, message: null, messageUntilMs: null },
      };
      return { state: next, effects: [] };
    }

    default:
      return { state, effects: [] };
  }
}