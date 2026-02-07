import type { Team } from "../game/team-manager";
import { setWormPersonality } from "./personality-store";
import { findFarthestWormIndex } from "./team-worm-selection";
import type { AiPersonality } from "./types";

const AI_PERSONALITY_POOL: AiPersonality[] = [
  "Generalist",
  "Marksman",
  "Demolisher",
  "Commando",
];

const pickRandomPersonality = (random: () => number): AiPersonality => {
  const index = Math.min(
    AI_PERSONALITY_POOL.length - 1,
    Math.max(0, Math.floor(random() * AI_PERSONALITY_POOL.length))
  );
  return AI_PERSONALITY_POOL[index]!;
};

export const assignAiTeamPersonalities = (params: {
  team: Team;
  enemyTeams: Team[];
  random: () => number;
}) => {
  const { team, enemyTeams, random } = params;
  if (team.worms.length === 0) return;

  for (const worm of team.worms) {
    setWormPersonality(worm, pickRandomPersonality(random));
  }

  const farthestWormIndex = findFarthestWormIndex(team, enemyTeams);
  const farthestWorm = team.worms[farthestWormIndex];
  if (!farthestWorm) return;
  setWormPersonality(farthestWorm, "Commando");
};
