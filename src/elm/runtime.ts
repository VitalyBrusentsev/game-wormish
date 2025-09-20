/**
 * Thin runtime to interpret effects and hold the canonical AppState.
 * Initial interpreter implements ScheduleTimer; other effects are no-ops for now.
 */

import type { AppState } from "./state";
import type { Msg } from "./msg";
import type { EffectDescriptor } from "./effects";
import { update } from "./update";

export type Dispatch = (msg: Msg) => void;

export class ElmRuntime {
  state: AppState;

  constructor(initial: AppState) {
    this.state = initial;
  }

  dispatch = (msg: Msg): void => {
    const { state, effects } = update(this.state, msg);
    this.state = state;
    this.interpretEffects(effects);
  };

  private interpretEffects(effects: EffectDescriptor[]): void {
    for (const eff of effects) {
      this.handleEffect(eff);
    }
  }

  // Minimal interpreter; extend incrementally as reducers begin emitting effects.
  /* eslint-disable @typescript-eslint/no-unused-vars */
  private handleEffect(eff: EffectDescriptor): void {
    switch (eff.type) {
      case "ScheduleTimer": {
        const nowModel = this.state.session.turn.timeNowMs;
        const delayMs = Math.max(0, eff.atMs - nowModel);
        setTimeout(() => this.dispatch(eff.msg), delayMs);
        break;
      }
      case "PlaySound":
      case "ScreenShake":
      case "CursorSet":
      case "TerrainRedraw":
      case "SpawnVisualParticles":
      case "Dispatch": {
        // No-ops for now; will be implemented during integration phases.
        // Intentionally ignore to keep runtime side-effect free until wired.
        break;
      }
      default: {
        // Exhaustiveness guard for future additions
        const _never: never = eff as never;
        void _never;
      }
    }
  }
}