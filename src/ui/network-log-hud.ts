import type { NetworkSessionState } from "../network/session-state";
import { COLORS } from "../definitions";
import { drawText } from "../utils";

export function renderNetworkLogHUD(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  networkState: NetworkSessionState
): void {
  const snapshot = networkState.getSnapshot();
  if (snapshot.mode === "local") return;
  if (!snapshot.debug.showLog) return;

  const entries = snapshot.debug.recentMessages;
  const maxLines = Math.max(6, Math.min(16, Math.floor(height / 22)));
  const lineHeight = 16;
  const padding = 10;
  const panelWidth = Math.min(720, Math.max(320, width - 24));
  const panelHeight = padding * 2 + (maxLines + 1) * lineHeight;
  const x = 12;
  const y = height - 12 - panelHeight;

  ctx.save();
  ctx.fillStyle = "rgba(0,0,0,0.72)";
  ctx.fillRect(x, y, panelWidth, panelHeight);
  ctx.strokeStyle = "rgba(255,255,255,0.15)";
  ctx.lineWidth = 1;
  ctx.strokeRect(x, y, panelWidth, panelHeight);

  drawText(
    ctx,
    `Network log (I) mode=${snapshot.debug.logSetting}`,
    x + padding,
    y + padding,
    COLORS.white,
    12,
    "left"
  );

  const lines = entries.slice(-(maxLines));
  for (let i = 0; i < lines.length; i++) {
    const entry = lines[i]!;
    const dir = entry.direction === "send" ? "→" : "←";
    const time = entry.atMs.toFixed(0).padStart(6, " ");
    const text = `${time} ${dir} ${entry.text}`;
    drawText(
      ctx,
      text,
      x + padding,
      y + padding + (i + 1) * lineHeight,
      "#DDDDDD",
      11,
      "left",
      "top",
      false
    );
  }
  ctx.restore();
}
