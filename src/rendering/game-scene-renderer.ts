import type { TeamId, PredictedPoint } from "../definitions";
import { COLORS, GAMEPLAY } from "../definitions";
import type { Worm } from "../entities";
import type { GameSession } from "../game/session";
import type { GameCamera } from "../game/game-camera";
import type { NetworkSessionState, NetworkSessionStateSnapshot } from "../network/session-state";
import { getNetworkMicroStatus, replaceWinnerInMessage } from "../game/player-display";
import { drawText } from "../utils";
import { getMapGadgetBottomY, renderMapGadget } from "../ui/map-gadget";
import { renderNetworkLogHUD } from "../ui/network-log-hud";
import type { ActiveWormArrow } from "../ui/active-worm-arrow";
import type { DamageFloaters } from "../ui/damage-floaters";
import type { TurnCountdownOverlay } from "../ui/turn-countdown";
import { resolveWormRenderAimPose } from "../critter/worm-render-pose";
import { renderBackground } from "./background-renderer";
import { renderHUD } from "./hud-renderer";
import {
  renderAimHelpers,
  type AimInfo,
} from "./game-rendering";

export type GameSceneRenderOptions = {
  ctx: CanvasRenderingContext2D;
  width: number;
  height: number;
  now: number;
  fps: number;
  camera: GameCamera;
  session: GameSession;
  networkState: NetworkSessionState;
  networkSnapshot: NetworkSessionStateSnapshot;
  damageFloaters: DamageFloaters;
  activeWormArrow: ActiveWormArrow;
  turnCountdown: TurnCountdownOverlay;
  aim: AimInfo;
  predictedPath: PredictedPoint[];
  isMobileProfile: boolean;
  topUiOffsetPx: number;
  displayTeamLabels: Partial<Record<TeamId, string>> | null;
  singlePlayerTeamOrder?: readonly [TeamId, TeamId];
  getTeamHealth: (teamId: TeamId) => number;
  renderMobileAimDragCrosshair: (ctx: CanvasRenderingContext2D, aim: AimInfo) => void;
  renderMobileMovementGhost: (ctx: CanvasRenderingContext2D) => void;
  renderSettingsButton: (ctx: CanvasRenderingContext2D) => void;
  overlaysBlocking: boolean;
  showRadar: boolean;
};

function renderWorldWater(
  ctx: CanvasRenderingContext2D,
  session: GameSession,
  camera: GameCamera
) {
  const worldViewport = camera.getWorldViewportSize();
  const worldBottom = camera.y + worldViewport.height + camera.padding / camera.zoom;
  const waterTopY = session.height - 30;
  const fillHeight = Math.max(40, worldBottom - waterTopY + 120);
  const terrain = session.terrain;
  const padX = Math.max(200, terrain.width * 0.1);
  const x = terrain.worldLeft - padX;
  const width = terrain.worldRight - terrain.worldLeft + padX * 2;

  ctx.save();
  ctx.fillStyle = COLORS.water;
  ctx.fillRect(x, waterTopY, width, fillHeight);
  ctx.restore();
}

function renderWorms(
  ctx: CanvasRenderingContext2D,
  options: Pick<GameSceneRenderOptions, "session" | "aim" | "now">
) {
  const { session, aim, now } = options;
  const state = session.state;
  const activeTeam = session.activeTeam;
  const activeWormIndex = session.activeWormIndex;
  const uziBurst = session.getUziBurstSnapshot();

  for (const team of session.teams) {
    for (let i = 0; i < team.worms.length; i++) {
      const worm = team.worms[i] as Worm;
      const isActive =
        team.id === activeTeam.id &&
        i === activeWormIndex &&
        state.phase !== "gameover";
      const aimPose = resolveWormRenderAimPose({
        isActive,
        phase: state.phase,
        weapon: state.weapon,
        aim,
        nowMs: now,
        turnStartMs: state.turnStartMs,
        uziBurst,
      });
      worm.render(ctx, isActive, aimPose);
    }
  }
}

export function renderGameScene(options: GameSceneRenderOptions) {
  const {
    ctx,
    width,
    height,
    now,
    fps,
    camera,
    session,
    networkState,
    networkSnapshot,
    damageFloaters,
    activeWormArrow,
    turnCountdown,
    aim,
    predictedPath,
    isMobileProfile,
    topUiOffsetPx,
    displayTeamLabels,
    singlePlayerTeamOrder,
    getTeamHealth,
    renderMobileAimDragCrosshair,
    renderMobileMovementGhost,
    renderSettingsButton,
    overlaysBlocking,
    showRadar,
  } = options;
  const state = session.state;

  ctx.save();
  ctx.translate(camera.offsetX, camera.offsetY);
  renderBackground(ctx, width, height, camera.padding, false);
  ctx.restore();

  ctx.save();
  ctx.translate(camera.offsetX, camera.offsetY);
  ctx.scale(camera.zoom, camera.zoom);
  ctx.translate(-camera.x, -camera.y);
  renderWorldWater(ctx, session, camera);
  session.terrain.render(ctx);

  for (const particle of session.particles) particle.render(ctx);

  renderWorms(ctx, { session, aim, now });

  for (const projectile of session.projectiles) projectile.render(ctx);

  damageFloaters.render(ctx, session, now);
  activeWormArrow.render(ctx, session, now);
  renderMobileAimDragCrosshair(ctx, aim);
  renderMobileMovementGhost(ctx);

  renderAimHelpers({
    ctx,
    state,
    activeWorm: session.activeWorm,
    aim,
    predictedPath,
    showDesktopAssist: !isMobileProfile,
  });
  ctx.restore();

  ctx.save();
  ctx.translate(camera.offsetX, camera.offsetY);
  const mobileMapMaxWidthPx = isMobileProfile ? Math.floor(width * 0.5) : undefined;
  const timeLabelY = isMobileProfile
    ? Math.min(
        height - 12,
        getMapGadgetBottomY({
          viewportWidth: width,
          terrain: session.terrain,
          ...(mobileMapMaxWidthPx !== undefined ? { maxWidthPx: mobileMapMaxWidthPx } : {}),
          ...(topUiOffsetPx > 0 ? { topOffsetPx: topUiOffsetPx } : {}),
        }) + 34
      )
    : undefined;
  const teamDisplayOrder = networkSnapshot.mode === "local" ? singlePlayerTeamOrder : undefined;
  const teamLabels = displayTeamLabels ?? undefined;
  const activeTeamLabel = displayTeamLabels?.[session.activeTeam.id] ?? undefined;
  const networkMicroStatus = getNetworkMicroStatus(networkSnapshot) ?? undefined;
  const displayMessage = replaceWinnerInMessage(session.message, displayTeamLabels ?? undefined);
  renderHUD({
    ctx,
    width,
    height,
    state,
    now,
    activeTeamId: session.activeTeam.id,
    activeWormFacing: session.activeWorm.facing < 0 ? -1 : 1,
    ...(teamDisplayOrder ? { teamDisplayOrder } : {}),
    getTeamHealth,
    wind: session.wind,
    message: displayMessage,
    turnDurationMs: GAMEPLAY.turnTimeMs,
    showChargeHint: !isMobileProfile,
    ...(topUiOffsetPx > 0 ? { topOffsetPx: topUiOffsetPx } : {}),
    ...(timeLabelY !== undefined ? { timeLabelY } : {}),
    ...(networkMicroStatus ? { networkMicroStatus } : {}),
    ...(teamLabels ? { teamLabels } : {}),
    ...(activeTeamLabel ? { activeTeamLabel } : {}),
  });

  if (!overlaysBlocking) {
    turnCountdown.render(ctx, session, now, width, height);
  }

  renderMapGadget({
    ctx,
    viewportWidth: width,
    viewportHeight: height,
    now,
    terrain: session.terrain,
    teams: session.teams,
    projectiles: session.projectiles,
    showRadar,
    ...(mobileMapMaxWidthPx !== undefined ? { maxWidthPx: mobileMapMaxWidthPx } : {}),
    ...(topUiOffsetPx > 0 ? { topOffsetPx: topUiOffsetPx } : {}),
  });

  renderNetworkLogHUD(ctx, width, height, networkState);

  renderSettingsButton(ctx);

  const fpsText = `FPS: ${Math.round(fps)}`;
  drawText(ctx, fpsText, 12, height - 12, COLORS.white, 12, "left", "bottom");
  ctx.restore();
}
