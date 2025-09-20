/**
 * Terrain model - pure data representation (no rendering caches).
 */

import type { Vec2, Rect } from "./entities";

export type TerrainKind = "mask" | "heightMap";

export type TerrainDeformType = "crater" | "line" | "rectangle";

export type TerrainDeformOp = {
  type: TerrainDeformType;
  center: Vec2;
  radius: number;
  strength: number;
  normal?: Vec2;
  rect?: Rect;
};

export type TerrainModel = {
  kind: TerrainKind;
  width: number;
  height: number;
  solidMask?: Uint8Array | boolean[];
  heightMap?: number[];
  deformationQueue: TerrainDeformOp[];
  lastModifiedAtMs: number;
};