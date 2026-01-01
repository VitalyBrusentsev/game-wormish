import type { NetworkSessionState } from "../network/session-state";
import { drawText } from "../utils";
import { COLORS } from "../definitions";

const HUD_FONT_STACK =
  "ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial";

function truncateHudText(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxWidth: number,
  sizePx: number
) {
  if (maxWidth <= 0) return "";
  ctx.font = `bold ${sizePx}px ${HUD_FONT_STACK}`;
  if (ctx.measureText(text).width <= maxWidth) return text;

  const ellipsis = "…";
  if (ctx.measureText(ellipsis).width > maxWidth) return "";

  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    const candidate = `${text.slice(0, mid)}${ellipsis}`;
    if (ctx.measureText(candidate).width <= maxWidth) lo = mid + 1;
    else hi = mid;
  }
  const keep = Math.max(0, lo - 1);
  return `${text.slice(0, keep)}${ellipsis}`;
}

export function renderNetworkStatusHUD(
  ctx: CanvasRenderingContext2D,
  width: number,
  networkState: NetworkSessionState
): void {
  const snapshot = networkState.getSnapshot();

  if (snapshot.mode === "local") return;

  const connectionState = snapshot.connection.lifecycle;
  let textColor = COLORS.white;
  let text = "Unknown";

  if (snapshot.bridge.networkReady && snapshot.bridge.waitingForRemoteSnapshot) {
    textColor = "#FFFF00";
    text =
      snapshot.mode === "network-guest"
        ? "Waiting for host sync..."
        : "Waiting for remote sync...";
  } else {
    const room = snapshot.registry.code ? ` ${snapshot.registry.code}` : "";
    switch (connectionState) {
      case "idle":
        textColor = "#888888";
        text = "Idle";
        break;
      case "creating":
        textColor = "#FFA500";
        text = room ? `Creating room${room}...` : "Creating room...";
        break;
      case "joining":
        textColor = "#FFA500";
        text = room ? `Joining room${room}...` : "Joining room...";
        break;
      case "created":
      case "joined":
        textColor = "#FFFF00";
        text = room ? `Waiting for opponent in${room}...` : "Waiting for opponent...";
        break;
      case "connecting":
        textColor = "#FFA500";
        text = "Connecting...";
        break;
      case "connected": {
        textColor = "#00FF00";
        const otherPlayerName = snapshot.player.remoteName || "opponent";
        text = `Connected to ${otherPlayerName}`;
        break;
      }
      case "disconnected":
        textColor = "#FF6600";
        text = "Disconnected";
        break;
      case "error": {
        textColor = "#FF0000";
        const details = snapshot.connection.lastError?.trim();
        text = details ? `Error: ${details}` : "Error";
        break;
      }
    }
  }

  const panelX = 12;
  const panelY = 40;
  const fontSizePx = 12;
  const paddingX = 10;
  const paddingY = 6;
  const maxPanelWidth = Math.max(0, width - panelX - 12);

  ctx.save();
  const displayText = truncateHudText(
    ctx,
    text,
    Math.max(0, maxPanelWidth - paddingX * 2),
    fontSizePx
  );
  const textWidth = ctx.measureText(displayText).width;
  const panelWidth = Math.min(maxPanelWidth, Math.ceil(textWidth) + paddingX * 2);
  const panelHeight = fontSizePx + paddingY * 2;

  ctx.fillStyle = "rgba(0, 0, 0, 0.6)";
  ctx.fillRect(panelX, panelY, panelWidth, panelHeight);
  ctx.strokeStyle = textColor;
  ctx.lineWidth = 1;
  ctx.strokeRect(panelX, panelY, panelWidth, panelHeight);

  drawText(
    ctx,
    displayText,
    panelX + paddingX,
    panelY + paddingY,
    textColor,
    fontSizePx,
    "left",
    "top"
  );

  ctx.restore();
}
