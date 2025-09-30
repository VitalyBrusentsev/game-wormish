import { COLORS } from "../definitions";
import { drawRoundedRect, drawText } from "../utils";

type Rect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export class HelpOverlay {
  private visible = false;
  private openedAtMs: number | null = null;
  private closeRect: Rect | null = null;

  show(nowMs: number): boolean {
    if (this.visible) return false;
    this.visible = true;
    this.openedAtMs = nowMs;
    return true;
  }

  hide(nowMs: number): number {
    if (!this.visible) return 0;
    const openedAt = this.openedAtMs;
    this.visible = false;
    this.openedAtMs = null;
    this.closeRect = null;
    if (openedAt == null) return 0;
    return Math.max(0, nowMs - openedAt);
  }

  isVisible() {
    return this.visible;
  }

  isCloseButtonHit(x: number, y: number) {
    const rect = this.closeRect;
    if (!rect) return false;
    return (
      x >= rect.x &&
      x <= rect.x + rect.width &&
      y >= rect.y &&
      y <= rect.y + rect.height
    );
  }

  render(ctx: CanvasRenderingContext2D, width: number, height: number) {
    if (!this.visible) {
      this.closeRect = null;
      return;
    }

    ctx.save();
    ctx.fillStyle = "rgba(4, 8, 18, 0.6)";
    ctx.fillRect(0, 0, width, height);

    let panelW = Math.min(620, Math.max(360, width - 120));
    let panelH = Math.min(420, Math.max(300, height - 200));
    panelW = Math.min(panelW, width - 40);
    panelH = Math.min(panelH, height - 40);
    const x = (width - panelW) / 2;
    const y = (height - panelH) / 2;

    drawRoundedRect(ctx, x, y, panelW, panelH, 20);
    ctx.fillStyle = "rgba(18, 26, 46, 0.94)";
    ctx.fill();
    ctx.strokeStyle = "rgba(255, 255, 255, 0.2)";
    ctx.lineWidth = 2;
    ctx.stroke();

    const titleY = y + 24;
    drawText(
      ctx,
      "Worm Commander's Handy Guide",
      x + panelW / 2,
      titleY,
      COLORS.white,
      24,
      "center"
    );

    const subtitleY = titleY + 28;
    drawText(
      ctx,
      "(Pause, sip cocoa, then plan your next shenanigan)",
      x + panelW / 2,
      subtitleY,
      COLORS.white,
      14,
      "center"
    );

    const helpTopics: { title: string; text: string }[] = [
      {
        title: "Move",
        text: "A / D or ← → for a wiggly parade march.",
      },
      {
        title: "Hop",
        text: "W or Space to vault over suspicious craters.",
      },
      {
        title: "Aim",
        text: "Wiggle the mouse, keep your eyes on the crosshair.",
      },
      {
        title: "Charge & Fire",
        text: "Hold the mouse button, release to unleash mayhem.",
      },
      {
        title: "Swap Toys",
        text: "1 - Bazooka, 2 - Grenade, 3 - Rifle; Choose your chaos.",
      },
      {
        title: "Wind Watch",
        text: "Mind the gusts before you light the fuse!",
      },
    ];

    const contentMargin = 44;
    const contentX = x + contentMargin;
    const contentWidth = panelW - contentMargin * 2;
    let lineY = subtitleY + 64;

    const bulletIndent = 24;
    const textStartX = contentX + bulletIndent;
    const fontSize = 16;
    const lineHeight = 26;
    const descriptionWidth = contentWidth - bulletIndent;
    const bodyFont = `bold ${fontSize}px ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial`;

    const wrapDescription = (
      text: string,
      firstLineWidth: number,
      subsequentWidth: number
    ) => {
      const words = text.split(/\s+/).filter((w) => w.length > 0);
      const lines: string[] = [];
      let currentLine = "";
      let currentLimit = firstLineWidth;

      const pushCurrent = () => {
        if (currentLine.length === 0) return;
        lines.push(currentLine);
        currentLine = "";
        currentLimit = subsequentWidth;
      };

      while (words.length > 0) {
        const nextWord = words.shift()!;
        const candidate = currentLine
          ? `${currentLine} ${nextWord}`
          : nextWord;

        if (ctx.measureText(candidate).width <= currentLimit) {
          currentLine = candidate;
          continue;
        }

        pushCurrent();

        if (ctx.measureText(nextWord).width <= currentLimit) {
          currentLine = nextWord;
          continue;
        }

        let fragment = "";
        for (const char of nextWord) {
          const extended = fragment + char;
          if (ctx.measureText(extended).width > currentLimit && fragment) {
            lines.push(fragment);
            currentLimit = subsequentWidth;
            fragment = char;
          } else {
            fragment = extended;
          }
        }
        currentLine = fragment;
      }

      pushCurrent();
      return lines;
    };

    for (const topic of helpTopics) {
      const bulletX = contentX;
      const titleText = `${topic.title}:`;

      drawText(ctx, "•", bulletX, lineY, COLORS.white, fontSize);
      drawText(ctx, titleText, textStartX, lineY, COLORS.helpTitle, fontSize);

      ctx.font = bodyFont;
      const titleWidth = ctx.measureText(`${titleText} `).width;
      const firstLineStartX = textStartX + titleWidth;
      let firstLineWidth = descriptionWidth - titleWidth;
      if (firstLineWidth <= 0) firstLineWidth = descriptionWidth;

      const lines = wrapDescription(
        topic.text,
        firstLineWidth,
        descriptionWidth
      );

      const lineCount = Math.max(1, lines.length);

      const firstLine = lines[0];
      if (firstLine) {
        drawText(
          ctx,
          firstLine,
          firstLineStartX,
          lineY,
          COLORS.white,
          fontSize
        );
      }
      for (let i = 1; i < lines.length; i++) {
        const line = lines[i];
        if (!line) continue;
        drawText(
          ctx,
          line,
          textStartX,
          lineY + lineHeight * i,
          COLORS.white,
          fontSize
        );
      }

      lineY += lineHeight * lineCount + 10;
    }

    const buttonSize = 32;
    const buttonPadding = 18;
    const buttonX = x + panelW - buttonPadding - buttonSize;
    const buttonY = y + buttonPadding;
    drawRoundedRect(ctx, buttonX, buttonY, buttonSize, buttonSize, 10);
    ctx.fillStyle = "rgba(255, 255, 255, 0.1)";
    ctx.fill();
    ctx.strokeStyle = "rgba(255, 255, 255, 0.3)";
    ctx.stroke();
    drawText(
      ctx,
      "✕",
      buttonX + buttonSize / 2,
      buttonY + buttonSize / 2,
      COLORS.white,
      20,
      "center",
      "middle"
    );

    this.closeRect = { x: buttonX, y: buttonY, width: buttonSize, height: buttonSize };

    ctx.restore();
  }
}
