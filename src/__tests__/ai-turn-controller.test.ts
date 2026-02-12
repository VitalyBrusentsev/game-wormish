import { beforeEach, describe, expect, it, vi } from "vitest";
import { Worm } from "../entities";
import type { Team } from "../game/team-manager";
import { AiTurnController } from "../game/ai-turn-controller";
import { playTurnWithGameAiForTeamAsync } from "../ai/game-ai-async";
import type { TurnContext, TurnDriverUpdateOptions } from "../game/turn-driver";

vi.mock("../ai/game-ai-async", () => ({
  playTurnWithGameAiForTeamAsync: vi.fn(() => Promise.resolve(null)),
}));

const createWorm = (x: number, teamId: Team["id"], name: string): Worm => {
  const worm = new Worm(x, 600, teamId, name);
  worm.alive = true;
  return worm;
};

const createTeam = (id: Team["id"], xs: number[]): Team => ({
  id,
  worms: xs.map((x, i) => createWorm(x, id, `${id[0]}${i + 1}`)),
});

describe("AiTurnController", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("selects farthest worm on the first AI turn and resets after match restart", () => {
    const aiTeam = createTeam("Red", [610, 700, 770]);
    const enemyTeam = createTeam("Blue", [120, 180, 250]);
    let turnIndex = 3;
    const session = {
      getTurnIndex: () => turnIndex,
      teams: [aiTeam, enemyTeam],
      debugSelectWorm: vi.fn(),
      isLocalTurnActive: () => true,
    };
    const context: TurnContext = {
      session,
      team: aiTeam,
      teamIndex: 1,
      initial: false,
    } as unknown as TurnContext;
    const controller = new AiTurnController();
    const options: TurnDriverUpdateOptions = {
      allowInput: true,
      input: {} as TurnDriverUpdateOptions["input"],
      camera: { offsetX: 0, offsetY: 0, zoom: 1 },
    };

    controller.beginTurn(context);
    controller.update(context, 0, options);
    expect(session.debugSelectWorm).toHaveBeenCalledTimes(1);
    expect(session.debugSelectWorm).toHaveBeenLastCalledWith("Red", 2);
    expect(playTurnWithGameAiForTeamAsync).toHaveBeenCalledTimes(1);

    controller.beginTurn(context);
    controller.update(context, 0, options);
    expect(session.debugSelectWorm).toHaveBeenCalledTimes(1);
    expect(playTurnWithGameAiForTeamAsync).toHaveBeenCalledTimes(2);

    turnIndex = 1;
    controller.beginTurn(context);
    controller.update(context, 0, options);
    expect(session.debugSelectWorm).toHaveBeenCalledTimes(2);
    expect(session.debugSelectWorm).toHaveBeenLastCalledWith("Red", 2);
    expect(playTurnWithGameAiForTeamAsync).toHaveBeenCalledTimes(3);
  });
});
