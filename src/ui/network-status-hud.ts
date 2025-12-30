import type { NetworkSessionState } from "../network/session-state";
import { drawText } from "../utils";
import { COLORS } from "../definitions";

export function renderNetworkStatusHUD(
  ctx: CanvasRenderingContext2D,
  _width: number,
  networkState: NetworkSessionState
): void {
  const snapshot = networkState.getSnapshot();
  
  if (snapshot.mode === "local") return;

  const x = 12;
  const y = 40;
  const lineHeight = 18;
  let currentY = y;

  // Connection state badge
  const connectionState = snapshot.connection.lifecycle;
  let stateColor = COLORS.white;
  let stateText = "Unknown";

  switch (connectionState) {
    case "idle":
      stateColor = "#888888";
      stateText = "Idle";
      break;
    case "creating":
    case "joining":
      stateColor = "#FFA500";
      stateText = "Setting up...";
      break;
    case "created":
    case "joined":
      stateColor = "#FFFF00";
      stateText = "Waiting...";
      break;
    case "connecting":
      stateColor = "#FFA500";
      stateText = "Connecting...";
      break;
    case "connected":
      stateColor = "#00FF00";
      stateText = "Connected";
      break;
    case "disconnected":
      stateColor = "#FF6600";
      stateText = "Disconnected";
      break;
    case "error":
      stateColor = "#FF0000";
      stateText = "Error";
      break;
  }

  // Draw state badge
  ctx.save();
  ctx.fillStyle = "rgba(0, 0, 0, 0.6)";
  ctx.fillRect(x - 4, currentY - 14, 150, 20);
  ctx.strokeStyle = stateColor;
  ctx.lineWidth = 1;
  ctx.strokeRect(x - 4, currentY - 14, 150, 20);
  
  drawText(ctx, `● ${stateText}`, x, currentY, stateColor, 12, "left");
  currentY += lineHeight;

  // Room info
  if (snapshot.registry.code) {
    drawText(
      ctx,
      `Room: ${snapshot.registry.code}`,
      x,
      currentY,
      COLORS.white,
      11,
      "left"
    );
    currentY += lineHeight;
  }

  // Role and players
  const role = snapshot.mode === "network-host" ? "Host" : "Guest";
  const localName = snapshot.player.localName || "You";
  const remoteName = snapshot.player.remoteName || "Waiting...";

  drawText(ctx, `${role}: ${localName}`, x, currentY, COLORS.white, 11, "left");
  currentY += lineHeight;
  
  drawText(
    ctx,
    `Opponent: ${remoteName}`,
    x,
    currentY,
    snapshot.player.remoteName ? COLORS.white : "#888888",
    11,
    "left"
  );
  currentY += lineHeight;

  // Waiting indicator (when remote turn is active)
  if (snapshot.bridge.networkReady && snapshot.bridge.waitingForRemoteSnapshot) {
    const waitText =
      snapshot.mode === "network-guest" ? "Waiting for host sync..." : "Waiting for remote sync...";
    drawText(
      ctx,
      waitText,
      x,
      currentY,
      "#FFFF00",
      11,
      "left"
    );
  }

  ctx.restore();
}
