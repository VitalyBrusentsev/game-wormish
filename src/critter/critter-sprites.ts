import type { TeamId } from "../definitions";
import type { CritterRig, Vec2 } from "./critter-geometry";

export type CritterSpriteOffset = { x: number; y: number };

type CritterSpriteKey =
  | "tail2"
  | "tail1"
  | "torso"
  | "belt1"
  | "collar"
  | "head"
  | "helmet"
  | "face";

const SPRITE_W = 38;
const SPRITE_H = 32;
const SPRITE_COUNT = 11;
const CRITTERS_SHEET_URL = new URL("../assets/critters.png", import.meta.url).href;

const DEFAULT_SPRITE_OFFSETS: Record<CritterSpriteKey, CritterSpriteOffset> = {
  tail2: { x: 0, y: 3 },
  tail1: { x: 0, y: 2 },
  torso: { x: 0, y: 0 },
  belt1: { x: -2, y: 6 },
  collar: { x: 0, y: -4 },
  head: { x: 1, y: -8 },
  helmet: { x: 0, y: -17 },
  face: { x: 2, y: -4 },
};
const SPRITE_KEYS: readonly CritterSpriteKey[] = [
  "tail2",
  "tail1",
  "torso",
  "belt1",
  "collar",
  "head",
  "helmet",
  "face",
];

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function normalizeOffset(value: unknown): CritterSpriteOffset | null {
  if (!isObject(value)) return null;
  const x = value["x"];
  const y = value["y"];
  if (typeof x !== "number" || !Number.isFinite(x)) return null;
  if (typeof y !== "number" || !Number.isFinite(y)) return null;
  return { x, y };
}

export function resolveCritterSpriteOffsets(): Record<CritterSpriteKey, CritterSpriteOffset> {
  if (typeof window === "undefined") return DEFAULT_SPRITE_OFFSETS;

  const existing = (window as Window).spriteOffsets;
  if (isObject(existing)) {
    for (const key of SPRITE_KEYS) {
      const normalized = normalizeOffset(existing[key]);
      if (normalized) {
        existing[key] = normalized;
        continue;
      }

      const def = DEFAULT_SPRITE_OFFSETS[key];
      existing[key] = { x: def.x, y: def.y };
    }

    return existing as Record<CritterSpriteKey, CritterSpriteOffset>;
  }

  const next: Record<CritterSpriteKey, CritterSpriteOffset> = {
    tail2: { ...DEFAULT_SPRITE_OFFSETS.tail2 },
    tail1: { ...DEFAULT_SPRITE_OFFSETS.tail1 },
    torso: { ...DEFAULT_SPRITE_OFFSETS.torso },
    belt1: { ...DEFAULT_SPRITE_OFFSETS.belt1 },
    collar: { ...DEFAULT_SPRITE_OFFSETS.collar },
    head: { ...DEFAULT_SPRITE_OFFSETS.head },
    helmet: { ...DEFAULT_SPRITE_OFFSETS.helmet },
    face: { ...DEFAULT_SPRITE_OFFSETS.face },
  };
  (window as Window).spriteOffsets = next;
  return next;
}

function getSpriteIndex(team: TeamId, kind: "helmet" | "head" | "torso" | "tail1" | "tail2"): number {
  switch (kind) {
    case "helmet":
      return 0;
    case "head":
      return team === "Red" ? 1 : 5;
    case "torso":
      return team === "Red" ? 2 : 6;
    case "tail1":
      return team === "Red" ? 3 : 7;
    case "tail2":
      return team === "Red" ? 4 : 8;
  }
}

function getNeutralSpriteIndex(kind: "collar" | "belt1"): number {
  return kind === "collar" ? 9 : 10;
}

let critterSheet: HTMLImageElement | null = null;
function getCritterSheet(): HTMLImageElement | null {
  if (typeof Image === "undefined") return null;
  if (critterSheet) return critterSheet;
  critterSheet = new Image();
  critterSheet.src = CRITTERS_SHEET_URL;
  return critterSheet;
}

function isSheetReady(img: HTMLImageElement): boolean {
  return img.complete && img.naturalWidth >= SPRITE_W * SPRITE_COUNT;
}

function drawSprite(config: {
  ctx: CanvasRenderingContext2D;
  img: HTMLImageElement;
  spriteIndex: number;
  center: Vec2;
  offset: CritterSpriteOffset;
  facing: -1 | 1;
}) {
  const { ctx, img, spriteIndex, center, offset, facing } = config;
  const sx = spriteIndex * SPRITE_W;
  ctx.save();
  ctx.translate(center.x, center.y);
  ctx.scale(facing, 1);
  ctx.drawImage(
    img,
    sx,
    0,
    SPRITE_W,
    SPRITE_H,
    -SPRITE_W / 2 + offset.x,
    -SPRITE_H / 2 + offset.y,
    SPRITE_W,
    SPRITE_H
  );
  ctx.restore();
}

export function renderCritterSprites(config: {
  ctx: CanvasRenderingContext2D;
  rig: CritterRig;
  team: TeamId;
  facing: -1 | 1;
  partOffsets?: Partial<Record<CritterSpriteKey, Vec2>>;
  beforeAll?: () => void;
  afterTorso?: () => void;
  afterHead?: (headCenter: Vec2) => void;
  afterAll?: () => void;
}): boolean {
  const { ctx, rig, team, facing, partOffsets, beforeAll, afterTorso, afterHead, afterAll } = config;
  const img = getCritterSheet();
  if (!img || !isSheetReady(img)) return false;

  const offsets = resolveCritterSpriteOffsets();
  const withPartOffset = (center: Vec2, key: CritterSpriteKey): Vec2 => {
    const p = partOffsets?.[key];
    if (!p) return center;
    return { x: center.x + p.x, y: center.y + p.y };
  };
  const tail1 = rig.tail[0];
  const tail2 = rig.tail[1];
  if (!tail1 || !tail2) return false;
  const tail3 = rig.tail[2];

  // Draw order: tail3 -> tail2 -> tail1 -> torso -> belt1 -> collar -> head -> helmet
  beforeAll?.();
  if (tail3) {
    drawSprite({
      ctx,
      img,
      spriteIndex: getSpriteIndex(team, "tail2"),
      center: withPartOffset(tail3.center, "tail2"),
      offset: offsets.tail2,
      facing,
    });
  }
  drawSprite({
    ctx,
    img,
    spriteIndex: getSpriteIndex(team, "tail2"),
    center: withPartOffset(tail2.center, "tail2"),
    offset: offsets.tail2,
    facing,
  });
  drawSprite({
    ctx,
    img,
    spriteIndex: getSpriteIndex(team, "tail1"),
    center: withPartOffset(tail1.center, "tail1"),
    offset: offsets.tail1,
    facing,
  });
  drawSprite({
    ctx,
    img,
    spriteIndex: getSpriteIndex(team, "torso"),
    center: withPartOffset(rig.body.center, "torso"),
    offset: offsets.torso,
    facing,
  });
  drawSprite({
    ctx,
    img,
    spriteIndex: getNeutralSpriteIndex("belt1"),
    center: withPartOffset(rig.body.center, "belt1"),
    offset: offsets.belt1,
    facing,
  });

  afterTorso?.();

  drawSprite({
    ctx,
    img,
    spriteIndex: getNeutralSpriteIndex("collar"),
    center: withPartOffset(rig.body.center, "collar"),
    offset: offsets.collar,
    facing,
  });
  drawSprite({
    ctx,
    img,
    spriteIndex: getSpriteIndex(team, "head"),
    center: withPartOffset(rig.head.center, "head"),
    offset: offsets.head,
    facing,
  });

  const shiftedHead = withPartOffset(rig.head.center, "head");
  const headCenter = {
    x: shiftedHead.x + facing * (offsets.head.x + offsets.face.x),
    y: shiftedHead.y + offsets.head.y + offsets.face.y,
  };
  afterHead?.(headCenter);

  drawSprite({
    ctx,
    img,
    spriteIndex: getSpriteIndex(team, "helmet"),
    center: withPartOffset(rig.head.center, "helmet"),
    offset: offsets.helmet,
    facing,
  });

  afterAll?.();

  return true;
}
