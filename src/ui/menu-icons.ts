export type MenuIconId = "help" | "start" | "online" | "settings" | "back";

const MENU_ICON_INDEX: Record<MenuIconId, number> = {
  help: 0,
  start: 1,
  online: 2,
  settings: 3,
  back: 4,
};

const MENU_ICON_SHEET_URL = new URL("../assets/menu_icons.png", import.meta.url).href;
const MENU_ICON_WIDTH = 160;
const MENU_ICON_HEIGHT = 132;
const MENU_ICON_COUNT = 5;

let menuIconSheet: HTMLImageElement | null = null;

function getMenuIconSheet(): HTMLImageElement | null {
  if (typeof Image === "undefined") return null;
  if (menuIconSheet) return menuIconSheet;
  menuIconSheet = new Image();
  menuIconSheet.src = MENU_ICON_SHEET_URL;
  return menuIconSheet;
}

function isMenuIconSheetReady(img: HTMLImageElement): boolean {
  return (
    img.complete &&
    img.naturalWidth >= MENU_ICON_WIDTH * MENU_ICON_COUNT &&
    img.naturalHeight >= MENU_ICON_HEIGHT
  );
}

export function drawMenuIconSprite(config: {
  ctx: CanvasRenderingContext2D;
  icon: MenuIconId;
  x: number;
  y: number;
  width: number;
  height: number;
}): boolean {
  const img = getMenuIconSheet();
  if (!img || !isMenuIconSheetReady(img)) return false;
  const sx = MENU_ICON_INDEX[config.icon] * MENU_ICON_WIDTH;
  config.ctx.drawImage(
    img,
    sx,
    0,
    MENU_ICON_WIDTH,
    MENU_ICON_HEIGHT,
    config.x,
    config.y,
    config.width,
    config.height
  );
  return true;
}
