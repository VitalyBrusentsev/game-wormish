import { describe, expect, it } from "vitest";
import { BACKGROUND_LAYERS, getBackgroundLayerOffset } from "../rendering/background-renderer";

describe("background parallax layers", () => {
  it("keeps named visual layers on their intended scroll planes", () => {
    const camera = { x: 100, y: 50, zoom: 2 };
    const expectOffset = (layer: keyof typeof BACKGROUND_LAYERS, x: number, y: number) => {
      const offset = getBackgroundLayerOffset(BACKGROUND_LAYERS[layer], camera);
      expect(offset.x).toBeCloseTo(x);
      expect(offset.y).toBeCloseTo(y);
    };

    expectOffset("distantLightMountains", 0, 0);
    expectOffset("darkerMountains", -24, -4);
    expectOffset("treeLine", -56, -8);
    expectOffset("mainGroundPlane", -200, -100);
  });
});
