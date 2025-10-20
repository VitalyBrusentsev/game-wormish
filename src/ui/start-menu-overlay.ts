import { COLORS } from "../definitions";
import { drawRoundedRect, drawText } from "../utils";

type Rect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

type MenuItemId = "help" | "start" | "friends";

type MenuItem = {
  id: MenuItemId;
  label: string;
  enabled: boolean;
  action: "help" | "start" | null;
};

export type MenuAction = "help" | "start" | null;

export class StartMenuOverlay {
  private visible = false;
  private hovered: MenuItemId | null = null;
  private active: MenuItemId | null = null;
  private panelRect: Rect | null = null;
  private readonly itemRects = new Map<MenuItemId, Rect>();

  private readonly items: MenuItem[] = [
    { id: "help", label: "Help", enabled: true, action: "help" },
    { id: "start", label: "Start", enabled: true, action: "start" },
    { id: "friends", label: "Play With Friends", enabled: false, action: null },
  ];

  show() {
    if (this.visible) return;
    this.visible = true;
    this.hovered = null;
    this.active = null;
  }

  hide() {
    if (!this.visible) return;
    this.visible = false;
    this.hovered = null;
    this.active = null;
  }

  isVisible() {
    return this.visible;
  }

  getCursor() {
    if (!this.visible) return "default";
    if (!this.hovered) return "default";
    const item = this.items.find((it) => it.id === this.hovered);
    if (!item || !item.enabled) return "default";
    return "pointer";
  }

  updateLayout(width: number, height: number) {
    if (!this.visible) return;

    let panelWidth = Math.min(440, Math.max(340, width - 220));
    let panelHeight = Math.min(420, Math.max(320, height - 220));
    panelWidth = Math.min(panelWidth, width - 40);
    panelHeight = Math.min(panelHeight, height - 40);

    const x = (width - panelWidth) / 2;
    const y = (height - panelHeight) / 2;
    this.panelRect = { x, y, width: panelWidth, height: panelHeight };

    const buttonWidth = panelWidth - 80;
    const buttonHeight = 58;
    const buttonGap = 18;
    const titleTop = y + 36;
    const subtitleTop = titleTop + 36;
    const buttonAreaHeight =
      this.items.length * buttonHeight + (this.items.length - 1) * buttonGap;
    const minButtonY = subtitleTop + 54;
    const maxButtonY = y + panelHeight - 48 - buttonAreaHeight;
    const startY = Math.max(
      minButtonY,
      Math.min(minButtonY + 12, maxButtonY)
    );

    this.itemRects.clear();
    for (let i = 0; i < this.items.length; i++) {
      const item = this.items[i]!;
      const rect: Rect = {
        x: x + (panelWidth - buttonWidth) / 2,
        y: startY + i * (buttonHeight + buttonGap),
        width: buttonWidth,
        height: buttonHeight,
      };
      this.itemRects.set(item.id, rect);
    }
  }

  updatePointer(x: number, y: number, isDown: boolean) {
    if (!this.visible) {
      this.hovered = null;
      return;
    }
    let hovered: MenuItemId | null = null;
    for (const item of this.items) {
      if (!item.enabled) continue;
      const rect = this.itemRects.get(item.id);
      if (!rect) continue;
      if (this.pointInRect(x, y, rect)) {
        hovered = item.id;
        break;
      }
    }
    this.hovered = hovered;
    if (!isDown) return;
    if (this.active && this.hovered !== this.active) {
      this.active = null;
    }
  }

  handlePress() {
    if (!this.visible) return;
    if (this.hovered) this.active = this.hovered;
    else this.active = null;
  }

  handleRelease(x: number, y: number): MenuAction {
    if (!this.visible) return null;
    const active = this.active;
    this.active = null;
    if (!active) return null;
    const rect = this.itemRects.get(active);
    const item = this.items.find((it) => it.id === active);
    if (!rect || !item || !item.enabled) return null;
    if (!this.pointInRect(x, y, rect)) return null;
    return item.action;
  }

  render(ctx: CanvasRenderingContext2D, width: number, height: number) {
    if (!this.visible) {
      this.panelRect = null;
      this.itemRects.clear();
      return;
    }

    this.updateLayout(width, height);

    ctx.save();
    ctx.fillStyle = "rgba(4, 8, 18, 0.65)";
    ctx.fillRect(0, 0, width, height);

    const panel = this.panelRect;
    if (!panel) {
      ctx.restore();
      return;
    }

    drawRoundedRect(ctx, panel.x, panel.y, panel.width, panel.height, 24);
    ctx.fillStyle = "rgba(18, 26, 46, 0.96)";
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = "rgba(255, 255, 255, 0.2)";
    ctx.stroke();

    const glowPadding = 8;
    drawRoundedRect(
      ctx,
      panel.x - glowPadding,
      panel.y - glowPadding,
      panel.width + glowPadding * 2,
      panel.height + glowPadding * 2,
      30
    );
    ctx.strokeStyle = "rgba(70, 110, 255, 0.35)";
    ctx.lineWidth = 2;
    ctx.stroke();

    const titleY = panel.y + 40;
    drawText(
      ctx,
      "Worm Command Center",
      panel.x + panel.width / 2,
      titleY,
      COLORS.white,
      28,
      "center"
    );

    drawText(
      ctx,
      "Select your briefing",
      panel.x + panel.width / 2,
      titleY + 34,
      COLORS.white,
      16,
      "center"
    );

    for (const item of this.items) {
      const rect = this.itemRects.get(item.id);
      if (!rect) continue;
      const hovered = this.hovered === item.id && item.enabled;
      const active = this.active === item.id && item.enabled;

      const drawRect = { ...rect };
      if (active) {
        drawRect.y += 2;
        drawRect.height -= 2;
      }

      drawRoundedRect(ctx, drawRect.x, drawRect.y, drawRect.width, drawRect.height, 18);

      if (!item.enabled) {
        const disabledGradient = ctx.createLinearGradient(
          drawRect.x,
          drawRect.y,
          drawRect.x,
          drawRect.y + drawRect.height
        );
        disabledGradient.addColorStop(0, "rgba(120, 126, 142, 0.45)");
        disabledGradient.addColorStop(1, "rgba(82, 88, 104, 0.45)");
        ctx.fillStyle = disabledGradient;
      } else {
        const gradient = ctx.createLinearGradient(
          drawRect.x,
          drawRect.y,
          drawRect.x,
          drawRect.y + drawRect.height
        );
        if (active) {
          gradient.addColorStop(0, "rgba(58, 104, 214, 0.96)");
          gradient.addColorStop(1, "rgba(40, 78, 182, 0.98)");
        } else if (hovered) {
          gradient.addColorStop(0, "rgba(111, 175, 255, 0.96)");
          gradient.addColorStop(1, "rgba(74, 129, 230, 0.98)");
        } else {
          gradient.addColorStop(0, "rgba(76, 132, 255, 0.92)");
          gradient.addColorStop(1, "rgba(58, 104, 214, 0.94)");
        }
        ctx.fillStyle = gradient;
      }
      ctx.fill();

      ctx.lineWidth = 2;
      if (!item.enabled) {
        ctx.strokeStyle = "rgba(160, 168, 186, 0.4)";
      } else if (hovered) {
        ctx.strokeStyle = "rgba(255, 255, 255, 0.55)";
      } else {
        ctx.strokeStyle = "rgba(255, 255, 255, 0.25)";
      }
      ctx.stroke();

      if (hovered && item.enabled) {
        drawRoundedRect(
          ctx,
          drawRect.x - 4,
          drawRect.y - 4,
          drawRect.width + 8,
          drawRect.height + 8,
          20
        );
        ctx.strokeStyle = "rgba(120, 180, 255, 0.28)";
        ctx.lineWidth = 2;
        ctx.stroke();
      }

      const textColor = item.enabled
        ? COLORS.white
        : "rgba(212, 216, 228, 0.55)";
      drawText(
        ctx,
        item.label,
        drawRect.x + drawRect.width / 2,
        drawRect.y + drawRect.height / 2,
        textColor,
        20,
        "center",
        "middle",
        false
      );

      if (!item.enabled) {
        drawText(
          ctx,
          "Coming soon",
          drawRect.x + drawRect.width / 2,
          drawRect.y + drawRect.height / 2 + 24,
          "rgba(200, 205, 220, 0.35)",
          14,
          "center",
          "middle",
          false
        );
      }
    }

    ctx.restore();
  }

  private pointInRect(x: number, y: number, rect: Rect) {
    return (
      x >= rect.x &&
      x <= rect.x + rect.width &&
      y >= rect.y &&
      y <= rect.y + rect.height
    );
  }
}
