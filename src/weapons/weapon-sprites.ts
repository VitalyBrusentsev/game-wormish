import { WeaponType } from "../definitions";

export type Vec2 = { x: number; y: number };

export type WeaponSpriteKey = "bazooka" | "rifle" | "uzi";

export type WeaponSpriteSpec = {
  barrelOffsetX: number;
  offset: Vec2;
  barrelLength: number;
};

const WEAPON_SPRITE_KEYS: readonly WeaponSpriteKey[] = ["bazooka", "rifle", "uzi"];

const DEFAULT_WEAPON_SPRITES: Record<WeaponSpriteKey, WeaponSpriteSpec> = {
  bazooka: { barrelOffsetX: -12, offset: { x: 5, y: -10 }, barrelLength: 40 },
  rifle: { barrelOffsetX: -15, offset: { x: 5, y: -10 }, barrelLength: 52 },
  uzi: { barrelOffsetX: -20, offset: { x: 5, y: 0 }, barrelLength: 32 },
};

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function normalizeVec2(value: unknown): Vec2 | null {
  if (!isObject(value)) return null;
  const x = value["x"];
  const y = value["y"];
  if (typeof x !== "number" || !Number.isFinite(x)) return null;
  if (typeof y !== "number" || !Number.isFinite(y)) return null;
  return { x, y };
}

function normalizeSpriteSpec(value: unknown): WeaponSpriteSpec | null {
  if (!isObject(value)) return null;
  const barrelOffsetX = value["barrelOffsetX"];
  const offset = normalizeVec2(value["offset"]);
  const barrelLength = value["barrelLength"];
  if (typeof barrelOffsetX !== "number" || !Number.isFinite(barrelOffsetX)) return null;
  if (!offset) return null;
  if (typeof barrelLength !== "number" || !Number.isFinite(barrelLength)) return null;
  return { barrelOffsetX, offset, barrelLength };
}

export function resolveWeaponSpriteSpecs(): Record<WeaponSpriteKey, WeaponSpriteSpec> {
  if (typeof window === "undefined") return DEFAULT_WEAPON_SPRITES;

  const existing = (window as Window).weaponSprites;
  if (isObject(existing)) {
    for (const key of WEAPON_SPRITE_KEYS) {
      const normalized = normalizeSpriteSpec(existing[key]);
      if (normalized) {
        existing[key] = normalized;
        continue;
      }
      const def = DEFAULT_WEAPON_SPRITES[key];
      existing[key] = {
        barrelOffsetX: def.barrelOffsetX,
        offset: { x: def.offset.x, y: def.offset.y },
        barrelLength: def.barrelLength,
      };
    }

    return existing as Record<WeaponSpriteKey, WeaponSpriteSpec>;
  }

  const next: Record<WeaponSpriteKey, WeaponSpriteSpec> = {
    bazooka: {
      barrelOffsetX: DEFAULT_WEAPON_SPRITES.bazooka.barrelOffsetX,
      offset: { ...DEFAULT_WEAPON_SPRITES.bazooka.offset },
      barrelLength: DEFAULT_WEAPON_SPRITES.bazooka.barrelLength,
    },
    rifle: {
      barrelOffsetX: DEFAULT_WEAPON_SPRITES.rifle.barrelOffsetX,
      offset: { ...DEFAULT_WEAPON_SPRITES.rifle.offset },
      barrelLength: DEFAULT_WEAPON_SPRITES.rifle.barrelLength,
    },
    uzi: {
      barrelOffsetX: DEFAULT_WEAPON_SPRITES.uzi.barrelOffsetX,
      offset: { ...DEFAULT_WEAPON_SPRITES.uzi.offset },
      barrelLength: DEFAULT_WEAPON_SPRITES.uzi.barrelLength,
    },
  };
  (window as Window).weaponSprites = next;
  return next;
}

export function weaponSpriteKeyForWeapon(weapon: WeaponType): WeaponSpriteKey | null {
  switch (weapon) {
    case WeaponType.Bazooka:
      return "bazooka";
    case WeaponType.Rifle:
      return "rifle";
    case WeaponType.Uzi:
      return "uzi";
    case WeaponType.HandGrenade:
    default:
      return null;
  }
}

export function computeWeaponRotationPoint(config: {
  center: Vec2;
  weapon: WeaponType;
  facing: -1 | 1;
}): Vec2 | null {
  const key = weaponSpriteKeyForWeapon(config.weapon);
  if (!key) return null;
  const spec = resolveWeaponSpriteSpecs()[key];
  return {
    x: config.center.x + config.facing * spec.offset.x,
    y: config.center.y + spec.offset.y,
  };
}

export function computeWeaponBarrelEnd(config: {
  center: Vec2;
  weapon: WeaponType;
  facing: -1 | 1;
  aimAngle: number;
}): Vec2 | null {
  const key = weaponSpriteKeyForWeapon(config.weapon);
  if (!key) return null;
  const spec = resolveWeaponSpriteSpecs()[key];
  const rotationPoint = computeWeaponRotationPoint({
    center: config.center,
    weapon: config.weapon,
    facing: config.facing,
  });
  if (!rotationPoint) return null;
  return {
    x: rotationPoint.x + Math.cos(config.aimAngle) * spec.barrelLength,
    y: rotationPoint.y + Math.sin(config.aimAngle) * spec.barrelLength,
  };
}

const WEAPON_SHEET_URL = new URL("../assets/weapon-sprites.png", import.meta.url).href;
const WEAPON_SPRITE_W = 256;
const WEAPON_SPRITE_H = 128;
const WEAPON_SPRITE_COUNT = 3;
const WEAPON_SPRITE_SCALE = 0.3;

let weaponSheet: HTMLImageElement | null = null;
function getWeaponSheet(): HTMLImageElement | null {
  if (typeof Image === "undefined") return null;
  if (weaponSheet) return weaponSheet;
  weaponSheet = new Image();
  weaponSheet.src = WEAPON_SHEET_URL;
  return weaponSheet;
}

function isSheetReady(img: HTMLImageElement): boolean {
  return (
    img.complete &&
    img.naturalWidth >= WEAPON_SPRITE_W * WEAPON_SPRITE_COUNT &&
    img.naturalHeight >= WEAPON_SPRITE_H
  );
}

function spriteIndexForKey(key: WeaponSpriteKey): number {
  switch (key) {
    case "bazooka":
      return 0;
    case "rifle":
      return 1;
    case "uzi":
      return 2;
  }
}

export function drawWeaponSprite(config: {
  ctx: CanvasRenderingContext2D;
  weapon: WeaponType;
  rotationPoint: Vec2;
  aimAngle: number;
}): boolean {
  const key = weaponSpriteKeyForWeapon(config.weapon);
  if (!key) return false;
  const img = getWeaponSheet();
  if (!img || !isSheetReady(img)) return false;

  const spec = resolveWeaponSpriteSpecs()[key];
  const spriteIndex = spriteIndexForKey(key);
  const sx = spriteIndex * WEAPON_SPRITE_W;
  const dw = WEAPON_SPRITE_W * WEAPON_SPRITE_SCALE;
  const dh = WEAPON_SPRITE_H * WEAPON_SPRITE_SCALE;
  const pivotX = dw / 2 + spec.barrelOffsetX;
  const pivotY = dh / 2;

  const { ctx, rotationPoint, aimAngle } = config;
  const flipY = Math.cos(aimAngle) < 0 ? -1 : 1;
  ctx.save();
  ctx.translate(rotationPoint.x, rotationPoint.y);
  ctx.rotate(aimAngle);
  ctx.scale(1, flipY);
  ctx.drawImage(img, sx, 0, WEAPON_SPRITE_W, WEAPON_SPRITE_H, -pivotX, -pivotY, dw, dh);
  ctx.restore();
  return true;
}
