import { clamp } from "../definitions";

export type WormMovementSmoothingMode = "ai" | "network";

export type WormMovementSmoothingSetting = {
  enabled: boolean;
  durationScale: number;
  minDurationMs: number;
  maxDurationMs: number;
  velocityInfluence: number;
  gravityCurve: number;
};

export type WormElasticSetting = {
  enabled: boolean;
  springStiffness: number;
  springDamping: number;
  maxOffsetPx: number;
  strideHz: number;
  velocityLagSeconds: number;
  headLagPx: number;
  headBobPx: number;
  helmetLagPx: number;
  helmetBobPx: number;
  collarLagPx: number;
  collarBobPx: number;
  tailLagPx: number;
  tailSwingPx: number;
  tailLiftPx: number;
  tailPhaseStepRad: number;
};

export type WormWeaponCarrySetting = {
  enabled: boolean;
  rockRad: number;
  rockHz: number;
  bobPx: number;
  bobHz: number;
  moveScale: number;
};

export type WormAnimationSetting = {
  movementSmoothing: {
    ai: WormMovementSmoothingSetting;
    network: WormMovementSmoothingSetting;
  };
  elastic: WormElasticSetting;
  weaponCarry: WormWeaponCarrySetting;
};

export type WormAnimationSettingInput = Partial<{
  movementSmoothing: Partial<{
    ai: Partial<WormMovementSmoothingSetting>;
    network: Partial<WormMovementSmoothingSetting>;
  }>;
  elastic: Partial<WormElasticSetting>;
  weaponCarry: Partial<WormWeaponCarrySetting>;
}>;

const bool = (value: unknown, fallback: boolean) =>
  typeof value === "boolean" ? value : fallback;

const num = (value: unknown, fallback: number) =>
  typeof value === "number" && Number.isFinite(value) ? value : fallback;

const withClamp = (
  value: unknown,
  fallback: number,
  minValue: number,
  maxValue: number
) => clamp(num(value, fallback), minValue, maxValue);

const DEFAULTS: WormAnimationSetting = {
  movementSmoothing: {
    ai: {
      enabled: true,
      durationScale: 1,
      minDurationMs: 80,
      maxDurationMs: 380,
      velocityInfluence: 1,
      gravityCurve: 1,
    },
    network: {
      enabled: true,
      durationScale: 0.55,
      minDurationMs: 40,
      maxDurationMs: 170,
      velocityInfluence: 0.42,
      gravityCurve: 0.2,
    },
  },
  elastic: {
    enabled: true,
    springStiffness: 96,
    springDamping: 19,
    maxOffsetPx: 10,
    strideHz: 6.6,
    velocityLagSeconds: 0.082,
    headLagPx: 3.7,
    headBobPx: 1.1,
    helmetLagPx: 1,
    helmetBobPx: 3,
    collarLagPx: 2.8,
    collarBobPx: 0.9,
    tailLagPx: 4.9,
    tailSwingPx: 1.8,
    tailLiftPx: 1.2,
    tailPhaseStepRad: 0.68,
  },
  weaponCarry: {
    enabled: true,
    rockRad: 0.06,
    rockHz: 2.4,
    bobPx: 1.5,
    bobHz: 4.9,
    moveScale: 1,
  },
};

const resolveMovementSetting = (
  input: Partial<WormMovementSmoothingSetting> | undefined,
  fallback: WormMovementSmoothingSetting
): WormMovementSmoothingSetting => ({
  enabled: bool(input?.enabled, fallback.enabled),
  durationScale: withClamp(input?.durationScale, fallback.durationScale, 0, 3),
  minDurationMs: withClamp(input?.minDurationMs, fallback.minDurationMs, 0, 2000),
  maxDurationMs: withClamp(input?.maxDurationMs, fallback.maxDurationMs, 0, 3000),
  velocityInfluence: withClamp(input?.velocityInfluence, fallback.velocityInfluence, 0, 2.5),
  gravityCurve: withClamp(input?.gravityCurve, fallback.gravityCurve, 0, 2.5),
});

const resolveElasticSetting = (
  input: Partial<WormElasticSetting> | undefined
): WormElasticSetting => ({
  enabled: bool(input?.enabled, DEFAULTS.elastic.enabled),
  springStiffness: withClamp(input?.springStiffness, DEFAULTS.elastic.springStiffness, 1, 300),
  springDamping: withClamp(input?.springDamping, DEFAULTS.elastic.springDamping, 0.5, 80),
  maxOffsetPx: withClamp(input?.maxOffsetPx, DEFAULTS.elastic.maxOffsetPx, 0, 40),
  strideHz: withClamp(input?.strideHz, DEFAULTS.elastic.strideHz, 0, 20),
  velocityLagSeconds: withClamp(
    input?.velocityLagSeconds,
    DEFAULTS.elastic.velocityLagSeconds,
    0,
    0.6
  ),
  headLagPx: withClamp(input?.headLagPx, DEFAULTS.elastic.headLagPx, 0, 30),
  headBobPx: withClamp(input?.headBobPx, DEFAULTS.elastic.headBobPx, 0, 20),
  helmetLagPx: withClamp(input?.helmetLagPx, DEFAULTS.elastic.helmetLagPx, 0, 30),
  helmetBobPx: withClamp(input?.helmetBobPx, DEFAULTS.elastic.helmetBobPx, 0, 20),
  collarLagPx: withClamp(input?.collarLagPx, DEFAULTS.elastic.collarLagPx, 0, 30),
  collarBobPx: withClamp(input?.collarBobPx, DEFAULTS.elastic.collarBobPx, 0, 20),
  tailLagPx: withClamp(input?.tailLagPx, DEFAULTS.elastic.tailLagPx, 0, 30),
  tailSwingPx: withClamp(input?.tailSwingPx, DEFAULTS.elastic.tailSwingPx, 0, 20),
  tailLiftPx: withClamp(input?.tailLiftPx, DEFAULTS.elastic.tailLiftPx, 0, 20),
  tailPhaseStepRad: withClamp(
    input?.tailPhaseStepRad,
    DEFAULTS.elastic.tailPhaseStepRad,
    0,
    Math.PI * 2
  ),
});

const resolveWeaponCarrySetting = (
  input: Partial<WormWeaponCarrySetting> | undefined
): WormWeaponCarrySetting => ({
  enabled: bool(input?.enabled, DEFAULTS.weaponCarry.enabled),
  rockRad: withClamp(input?.rockRad, DEFAULTS.weaponCarry.rockRad, 0, 0.6),
  rockHz: withClamp(input?.rockHz, DEFAULTS.weaponCarry.rockHz, 0, 20),
  bobPx: withClamp(input?.bobPx, DEFAULTS.weaponCarry.bobPx, 0, 15),
  bobHz: withClamp(input?.bobHz, DEFAULTS.weaponCarry.bobHz, 0, 20),
  moveScale: withClamp(input?.moveScale, DEFAULTS.weaponCarry.moveScale, 0, 3),
});

export const resolveWormAnimationSetting = (): WormAnimationSetting => {
  if (typeof window === "undefined") return DEFAULTS;
  const existing = (window as Window).wormAnimationSetting as WormAnimationSettingInput | undefined;

  const ai = resolveMovementSetting(existing?.movementSmoothing?.ai, DEFAULTS.movementSmoothing.ai);
  const network = resolveMovementSetting(
    existing?.movementSmoothing?.network,
    DEFAULTS.movementSmoothing.network
  );
  const minAiMax = Math.max(ai.minDurationMs, ai.maxDurationMs);
  const minNetworkMax = Math.max(network.minDurationMs, network.maxDurationMs);

  const resolved: WormAnimationSetting = {
    movementSmoothing: {
      ai: {
        ...ai,
        maxDurationMs: minAiMax,
      },
      network: {
        ...network,
        maxDurationMs: minNetworkMax,
      },
    },
    elastic: resolveElasticSetting(existing?.elastic),
    weaponCarry: resolveWeaponCarrySetting(existing?.weaponCarry),
  };

  (window as Window).wormAnimationSetting = resolved;
  return resolved;
};

export const resolveMovementBlendSetting = (mode: WormMovementSmoothingMode) =>
  resolveWormAnimationSetting().movementSmoothing[mode];
