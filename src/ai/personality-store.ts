import type { Worm } from "../entities";
import type { AiPersonality } from "./types";

const personalityByWorm = new WeakMap<Worm, AiPersonality>();

const normalize = (value: string): AiPersonality | null => {
  const normalized = value.trim().toLowerCase();
  switch (normalized) {
    case "generalist":
      return "Generalist";
    case "marksman":
      return "Marksman";
    case "demolisher":
    case "demolitionist":
      return "Demolisher";
    case "commando":
      return "Commando";
    default:
      return null;
  }
};

export const normalizeAiPersonality = (
  value: string | AiPersonality | null | undefined
): AiPersonality | null => {
  if (!value) return null;
  if (value === "Generalist" || value === "Marksman" || value === "Demolisher" || value === "Commando") {
    return value;
  }
  return normalize(String(value));
};

export const getWormPersonality = (worm: Worm): AiPersonality =>
  personalityByWorm.get(worm) ?? "Generalist";

export const setWormPersonality = (worm: Worm, personality: AiPersonality | null) => {
  if (!personality) {
    personalityByWorm.delete(worm);
    return;
  }
  personalityByWorm.set(worm, personality);
};
