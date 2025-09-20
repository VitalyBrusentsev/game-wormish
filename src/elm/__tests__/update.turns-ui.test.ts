import { describe, it, expect } from "vitest";
import { update } from "../../elm/update";
import { initialAppState } from "../../elm/init";
import type { Msg } from "../../elm/msg";

describe("update - turns, wind, pause/resume, UI", () => {
  it("Turn.Started resets turnStartAtMs and timeNowMs", () => {
    const state = initialAppState({ nowMs: 100 });
    const msg: Msg = { type: "Turn.Started", nowMs: 250 };
    const { state: next } = update(state, msg);
    expect(next.session.turn.turnStartAtMs).toBe(250);
    expect(next.session.turn.timeNowMs).toBe(250);
  });

  it("Turn.Advanced resets timers similarly to Turn.Started", () => {
    const state = initialAppState({ nowMs: 500 });
    const msg: Msg = { type: "Turn.Advanced", nowMs: 750 };
    const { state: next } = update(state, msg);
    expect(next.session.turn.turnStartAtMs).toBe(750);
    expect(next.session.turn.timeNowMs).toBe(750);
  });

  it("WindChanged updates strength and stamps lastUpdatedAtMs from state's timeNowMs", () => {
    const state = initialAppState({ nowMs: 1000 });
    // First move time forward with TickAdvanced
    const tick: Msg = { type: "TickAdvanced", nowMs: 1600, dtMs: 16.6 };
    const afterTick = update(state, tick).state;
    const windMsg: Msg = { type: "WindChanged", strength: 0.42 };
    const { state: next } = update(afterTick, windMsg);
    expect(next.session.turn.wind.strength).toBeCloseTo(0.42, 5);
    expect(next.session.turn.wind.lastUpdatedAtMs).toBe(1600);
  });

  it("Game.Paused switches phase to paused only when playing", () => {
    const playing = initialAppState({ nowMs: 0 });
    const res1 = update(playing, { type: "Game.Paused" }).state;
    expect(res1.session.phase).toBe("paused");
    // Pausing again should keep paused
    const res2 = update(res1, { type: "Game.Paused" }).state;
    expect(res2.session.phase).toBe("paused");
  });

  it("Game.Resumed switches phase back to playing only from paused", () => {
    const paused = update(initialAppState({ nowMs: 0 }), { type: "Game.Paused" }).state;
    const resumed = update(paused, { type: "Game.Resumed" }).state;
    expect(resumed.session.phase).toBe("playing");
    // Resuming when already playing is a no-op
    const stillPlaying = update(resumed, { type: "Game.Resumed" }).state;
    expect(stillPlaying.session.phase).toBe("playing");
  });

  it("UI.MessageSet sets text and optional untilMs; UI.MessageCleared clears them", () => {
    const base = initialAppState({ nowMs: 0 });
    const withMsg = update(base, { type: "UI.MessageSet", text: "Hello", untilMs: 1234 }).state;
    expect(withMsg.ui.message).toBe("Hello");
    expect(withMsg.ui.messageUntilMs).toBe(1234);

    const cleared = update(withMsg, { type: "UI.MessageCleared" }).state;
    expect(cleared.ui.message).toBeNull();
    expect(cleared.ui.messageUntilMs).toBeNull();
  });
});