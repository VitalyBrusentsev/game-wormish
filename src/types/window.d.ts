import type { GameDebugApi } from "../debug/game-debug";
import type { WormAnimationSettingInput } from "../rendering/worm-animation-setting";

export {};

declare global {
  interface Window {
    spriteOffsets?: Partial<
      Record<
        "tail2" | "tail1" | "torso" | "belt1" | "collar" | "head" | "helmet" | "face",
        { x: number; y: number }
      >
    >;
    weaponSprites?: Partial<
      Record<
        "bazooka" | "rifle" | "uzi",
        { barrelOffsetX: number; offset: { x: number; y: number }; barrelLength: number }
      >
    >;
    debugCritterCollision?: boolean;
    Game?: GameDebugApi;
    wormAnimationSetting?: WormAnimationSettingInput;
  }
}
