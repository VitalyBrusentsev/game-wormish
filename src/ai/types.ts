export type AiPersonality = "Generalist" | "Marksman" | "Demolisher" | "Commando";

export type AiPrecisionMode = "perfect" | "noisy";

export type AiPrecisionSettings = {
  mode?: AiPrecisionMode;
  topK?: number;
  noiseAngleRad?: number;
  noisePower?: number;
};

export type AiCinematicSettings = {
  chance?: number;
};

export type GameAiDebugSettings = {
  enabled?: boolean;
  topN?: number;
};

export type GameAiMovementSettings = {
  enabled?: boolean;
};

export type GameAiSettings = {
  personality?: AiPersonality;
  minThinkTimeMs?: number;
  cinematic?: AiCinematicSettings;
  precision?: AiPrecisionSettings;
  debug?: GameAiDebugSettings;
  movement?: GameAiMovementSettings;
};
