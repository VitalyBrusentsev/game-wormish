import { describe, expect, it } from "vitest";
import { Worm } from "../entities";
import type { Team } from "../game/team-manager";
import { getWormPersonality } from "../ai/personality-store";
import { assignAiTeamPersonalities } from "../ai/personality-assignment";
import { findFarthestWormIndex } from "../ai/team-worm-selection";

const createWorm = (x: number, teamId: Team["id"], name: string): Worm => {
  const worm = new Worm(x, 600, teamId, name);
  worm.alive = true;
  return worm;
};

const createTeam = (id: Team["id"], xs: number[]): Team => ({
  id,
  worms: xs.map((x, i) => createWorm(x, id, `${id[0]}${i + 1}`)),
});

describe("AI farthest worm selection", () => {
  it("picks the rightmost worm when the team is on the right side", () => {
    const aiTeam = createTeam("Red", [620, 700, 760]);
    const enemyTeam = createTeam("Blue", [180, 240, 320]);

    const index = findFarthestWormIndex(aiTeam, [enemyTeam]);
    expect(index).toBe(2);
  });

  it("picks the leftmost worm when the team is on the left side", () => {
    const aiTeam = createTeam("Blue", [110, 170, 230]);
    const enemyTeam = createTeam("Red", [680, 720, 780]);

    const index = findFarthestWormIndex(aiTeam, [enemyTeam]);
    expect(index).toBe(0);
  });

  it("ignores dead worms when selecting the farthest", () => {
    const aiTeam = createTeam("Red", [610, 690, 770]);
    const enemyTeam = createTeam("Blue", [150, 220, 290]);
    aiTeam.worms[2]!.alive = false;

    const index = findFarthestWormIndex(aiTeam, [enemyTeam]);
    expect(index).toBe(1);
  });
});

describe("AI personality assignment", () => {
  it("assigns random personalities and forces commando on the farthest worm", () => {
    const aiTeam = createTeam("Red", [620, 700, 760, 740]);
    const enemyTeam = createTeam("Blue", [120, 200, 280, 340]);
    const randomValues = [0, 0.34, 0.67, 0.92];
    let index = 0;

    assignAiTeamPersonalities({
      team: aiTeam,
      enemyTeams: [enemyTeam],
      random: () => {
        const value = randomValues[index % randomValues.length]!;
        index += 1;
        return value;
      },
    });

    const personalities = aiTeam.worms.map((worm) => getWormPersonality(worm));
    expect(personalities[0]).toBe("Generalist");
    expect(personalities[1]).toBe("Marksman");
    expect(personalities[2]).toBe("Commando");
    expect(personalities[3]).toBe("Commando");
  });
});
