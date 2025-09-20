import { describe, it, expect } from "vitest";
import { update } from "../../elm/update";
import { initialAppState } from "../../elm/init";
import type { Msg } from "../../elm/msg";

describe("update core - TickAdvanced", () => {
  it("updates session.turn.timeNowMs to the provided nowMs", () => {
    const start = 100;
    const state = initialAppState({ nowMs: start, width: 320, height: 200 });
    const msg: Msg = { type: "TickAdvanced", nowMs: 1000, dtMs: 16.6 };

    const { state: next, effects } = update(state, msg);

    expect(next.session.turn.timeNowMs).toBe(1000);
    expect(next.session.turn.turnStartAtMs).toBe(start);
    expect(effects).toEqual([]);
  });

  it("is immutable: returns a new state object when time changes", () => {
    const state = initialAppState({ nowMs: 0, width: 320, height: 200 });
    const msg: Msg = { type: "TickAdvanced", nowMs: 1, dtMs: 1 };

    const result = update(state, msg);

    expect(result.state).not.toBe(state);
    expect(result.state.session).not.toBe(state.session);
    expect(result.state.session.turn).not.toBe(state.session.turn);
  });
});