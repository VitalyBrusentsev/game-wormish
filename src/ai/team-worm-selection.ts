import type { Worm } from "../entities";
import type { Team } from "../game/team-manager";

const aliveOrAll = (worms: Worm[]): Worm[] => {
  const alive = worms.filter((worm) => worm.alive);
  return alive.length > 0 ? alive : worms;
};

const averageX = (worms: Worm[]): number => {
  if (worms.length === 0) return 0;
  let total = 0;
  for (const worm of worms) total += worm.x;
  return total / worms.length;
};

export const findFarthestWormIndex = (team: Team, enemyTeams: Team[]): number => {
  if (team.worms.length === 0) return 0;

  const candidates = aliveOrAll(team.worms);
  const candidateSet = new Set(candidates);
  const enemyWorms = enemyTeams.flatMap((enemyTeam) => aliveOrAll(enemyTeam.worms));

  const teamCenterX = averageX(candidates);
  const enemyCenterX = averageX(enemyWorms);
  const pickRightmost = enemyWorms.length > 0 ? teamCenterX >= enemyCenterX : teamCenterX >= 0;

  let selectedIndex = team.worms.findIndex((worm) => candidateSet.has(worm));
  if (selectedIndex < 0) selectedIndex = 0;
  let selectedX = team.worms[selectedIndex]!.x;

  for (let i = 0; i < team.worms.length; i++) {
    const worm = team.worms[i]!;
    if (!candidateSet.has(worm)) continue;
    const better = pickRightmost ? worm.x > selectedX : worm.x < selectedX;
    if (!better) continue;
    selectedIndex = i;
    selectedX = worm.x;
  }

  return selectedIndex;
};
