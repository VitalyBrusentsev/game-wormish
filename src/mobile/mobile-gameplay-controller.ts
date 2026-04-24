import { WeaponType, clamp } from "../definitions";
import type { AimInfo } from "../rendering/game-rendering";
import type { MobileAimMode, MobileControlsState } from "../ui/mobile-controls";
import {
  didMovementGetStuck,
  isForwardProgressBlocked,
} from "../movement/stuck-detection";

export const MOBILE_WORLD_ZOOM = 0.8;
export const MOBILE_AIM_STAGE_ZOOM_MULTIPLIER = 0.7;
export const MOBILE_WORM_TOUCH_RADIUS_PX = 44;
export const MOBILE_AIM_GESTURE_ZONE_RADIUS_PX = 56;
export const MOBILE_AIM_BUTTON_OFFSET_PX = 56;
export const MOBILE_AIM_LINE_MAX_PX = 180;

const MOBILE_GHOST_REACH_PX = 8;
const MOBILE_ASSIST_MOVE_STEP_MS = 120;
const MOBILE_ASSIST_STUCK_STEPS = 3;
const MOBILE_DEFAULT_AIM_DISTANCE_PX = 140;
const MOBILE_DEFAULT_AIM_ANGLE_UP_DEG = 30;

export type MobileMovementGhostSprite = {
  canvas: HTMLCanvasElement;
  anchorX: number;
  anchorY: number;
};

type MobileMovementAssistState = {
  destinationX: number;
  accumulatorMs: number;
  stuckSteps: number;
  jumpRequested: boolean;
};

type WorldPoint = {
  x: number;
  y: number;
};

type MobileWorm = WorldPoint & {
  radius: number;
  facing: number;
  alive: boolean;
};

export type MobileGameplayContext = {
  isMobileProfile: boolean;
  overlaysBlocking: boolean;
  initialMenuDismissed: boolean;
  isActiveTeamLocallyControlled: boolean;
  isLocalTurnActive: boolean;
  networkReady: boolean;
  phase: string;
  charging: boolean;
  weapon: WeaponType;
  activeWorm: MobileWorm;
  terrainLeft: number;
  terrainRight: number;
  topUiOffsetPx: number;
  getAimInfo: () => AimInfo;
  worldToScreen: (worldX: number, worldY: number) => WorldPoint;
  setWeapon: (weapon: WeaponType) => void;
  setAimTarget: (worldX: number, worldY: number) => void;
  startCharge: () => boolean;
  cancelCharge: () => void;
  fireCurrentWeapon: (options?: { instantPower01: number }) => boolean;
  recordMovementStep: (
    direction: -1 | 1,
    durationMs: number,
    jump: boolean
  ) => boolean;
  captureMovementGhostSprite: () => MobileMovementGhostSprite | null;
};

export type MobileGameplaySnapshot = {
  aimMode: MobileAimMode;
  aimZoomLocked: boolean;
  weaponPickerOpen: boolean;
  aimTarget: WorldPoint | null;
  movementGhostX: number | null;
  movementGhostSprite: MobileMovementGhostSprite | null;
  movementAssistActive: boolean;
};

export class MobileGameplayController {
  private aimMode: MobileAimMode = "idle";
  private aimZoomLocked = false;
  private weaponPickerOpen = false;
  private aimButtonVisible = false;
  private aimTarget: WorldPoint | null = null;
  private movementGhostX: number | null = null;
  private movementGhostSprite: MobileMovementGhostSprite | null = null;
  private draggingMovement = false;
  private movementAssist: MobileMovementAssistState | null = null;

  getSnapshot(): MobileGameplaySnapshot {
    return {
      aimMode: this.aimMode,
      aimZoomLocked: this.aimZoomLocked,
      weaponPickerOpen: this.weaponPickerOpen,
      aimTarget: this.aimTarget ? { ...this.aimTarget } : null,
      movementGhostX: this.movementGhostX,
      movementGhostSprite: this.movementGhostSprite,
      movementAssistActive: this.movementAssist !== null,
    };
  }

  resetTransientState() {
    this.aimMode = "idle";
    this.aimZoomLocked = false;
    this.weaponPickerOpen = false;
    this.aimButtonVisible = false;
    this.aimTarget = null;
    this.draggingMovement = false;
    this.movementGhostX = null;
    this.movementGhostSprite = null;
    this.movementAssist = null;
  }

  resetForTurn() {
    this.aimMode = "idle";
    this.aimZoomLocked = false;
    this.aimButtonVisible = false;
    this.weaponPickerOpen = false;
    this.aimTarget = null;
    this.stopMovementAssist(true);
  }

  getDesiredWorldZoom(isMobileProfile: boolean) {
    const baseZoom = isMobileProfile ? MOBILE_WORLD_ZOOM : 1;
    if (!isMobileProfile) return baseZoom;
    if (this.aimZoomLocked || this.aimMode === "aim" || this.aimMode === "charge") {
      return baseZoom * MOBILE_AIM_STAGE_ZOOM_MULTIPLIER;
    }
    return baseZoom;
  }

  canUsePanning(context: MobileGameplayContext) {
    if (!context.isMobileProfile) return false;
    if (context.overlaysBlocking) return false;
    if (!context.initialMenuDismissed) return false;
    return true;
  }

  canUseWeaponSelector(context: MobileGameplayContext) {
    if (context.overlaysBlocking) return false;
    if (!context.initialMenuDismissed) return false;
    if (!context.isActiveTeamLocallyControlled) return false;
    if (!context.isLocalTurnActive) return false;
    if (context.phase !== "aim") return false;
    return context.networkReady;
  }

  canUseControls(context: MobileGameplayContext) {
    if (!this.canUseWeaponSelector(context)) return false;
    if (!this.canUsePanning(context)) return false;
    return true;
  }

  canStartWormInteraction(context: MobileGameplayContext, worldX: number, worldY: number) {
    if (!this.canUseControls(context)) return false;
    const active = context.activeWorm;
    if (!active.alive) return false;
    const maxRadius = Math.max(MOBILE_WORM_TOUCH_RADIUS_PX, active.radius * 2.8);
    const dist = Math.hypot(worldX - active.x, worldY - active.y);
    return dist <= maxRadius;
  }

  canStartAimGesture(context: MobileGameplayContext, canvasX: number, canvasY: number) {
    if (!this.canUseControls(context)) return false;
    if (this.aimMode !== "aim") return false;
    const aim = context.getAimInfo();
    const anchorWorld = this.getAimAnchorWorldPoint(context.activeWorm, aim);
    const anchor = context.worldToScreen(anchorWorld.x, anchorWorld.y);
    const dx = canvasX - anchor.x;
    const dy = canvasY - anchor.y;
    return dx * dx + dy * dy <= MOBILE_AIM_GESTURE_ZONE_RADIUS_PX * MOBILE_AIM_GESTURE_ZONE_RADIUS_PX;
  }

  handleTap(context: MobileGameplayContext, worldX: number, worldY: number) {
    if (!this.canStartWormInteraction(context, worldX, worldY)) return;
    this.aimButtonVisible = true;
    this.weaponPickerOpen = false;
  }

  handleToggleWeaponPicker(context: MobileGameplayContext) {
    if (!this.canUseWeaponSelector(context)) return;
    if (this.aimMode === "charge" || context.charging) return;
    this.weaponPickerOpen = !this.weaponPickerOpen;
  }

  handleSelectWeapon(context: MobileGameplayContext, weapon: WeaponType) {
    if (!this.canUseWeaponSelector(context)) return;
    if (this.aimMode === "charge" || context.charging) return;
    context.setWeapon(weapon);
    this.weaponPickerOpen = false;
  }

  handleAimButton(context: MobileGameplayContext) {
    if (!this.canUseControls(context)) return;
    if (this.aimMode !== "idle") return;
    this.aimMode = "aim";
    this.aimZoomLocked = true;
    this.aimButtonVisible = false;
    this.weaponPickerOpen = false;
    const defaultTarget = this.getDefaultAimTarget(context.activeWorm);
    this.aimTarget = defaultTarget;
    context.setAimTarget(defaultTarget.x, defaultTarget.y);
  }

  handleCancel(context: MobileGameplayContext) {
    if (!this.canUseControls(context)) return;
    if (this.aimMode === "charge") {
      context.cancelCharge();
      this.aimMode = "aim";
      return;
    }
    if (this.aimMode === "aim") {
      this.aimMode = "idle";
      this.aimZoomLocked = false;
      this.aimButtonVisible = false;
      this.weaponPickerOpen = false;
      this.aimTarget = null;
    }
  }

  handlePrimary(context: MobileGameplayContext) {
    if (!this.canUseControls(context)) return;
    if (this.aimMode === "aim") {
      if (context.weapon === WeaponType.Bazooka || context.weapon === WeaponType.HandGrenade) {
        if (context.startCharge()) {
          this.aimMode = "charge";
          this.weaponPickerOpen = false;
        }
        return;
      }
      if (context.fireCurrentWeapon({ instantPower01: 1 })) {
        this.clearFiringState();
      }
      return;
    }
    if (this.aimMode === "charge" && context.fireCurrentWeapon()) {
      this.clearFiringState();
    }
  }

  handleJump() {
    if (!this.movementAssist) return;
    this.movementAssist.jumpRequested = true;
  }

  handleAimGesture(context: MobileGameplayContext, worldX: number, worldY: number) {
    if (!this.canUseControls(context)) return;
    if (this.aimMode !== "aim") return;
    this.aimTarget = { x: worldX, y: worldY };
    context.setAimTarget(worldX, worldY);
  }

  handleMovementDragStart(context: MobileGameplayContext, worldX: number) {
    if (!this.canUseControls(context)) return;
    if (this.aimMode !== "idle") return;
    this.draggingMovement = true;
    this.aimButtonVisible = false;
    this.weaponPickerOpen = false;
    this.movementGhostSprite = context.captureMovementGhostSprite();
    this.movementGhostX = clamp(worldX, context.terrainLeft, context.terrainRight);
  }

  handleMovementDrag(context: MobileGameplayContext, worldX: number) {
    if (!this.draggingMovement) return;
    this.movementGhostX = clamp(worldX, context.terrainLeft, context.terrainRight);
  }

  handleMovementDragEnd(context: MobileGameplayContext, worldX: number) {
    if (!this.draggingMovement) return;
    this.draggingMovement = false;
    const destinationX = clamp(worldX, context.terrainLeft, context.terrainRight);
    if (Math.abs(destinationX - context.activeWorm.x) <= MOBILE_GHOST_REACH_PX) {
      this.movementGhostX = null;
      this.movementGhostSprite = null;
      return;
    }
    this.movementAssist = {
      destinationX,
      accumulatorMs: 0,
      stuckSteps: 0,
      jumpRequested: false,
    };
    this.movementGhostX = destinationX;
    this.aimButtonVisible = false;
  }

  stopMovementAssist(clearGhost: boolean) {
    this.movementAssist = null;
    this.draggingMovement = false;
    if (clearGhost) {
      this.movementGhostX = null;
      this.movementGhostSprite = null;
    }
  }

  updateMovementAssist(context: MobileGameplayContext, dt: number) {
    const movement = this.movementAssist;
    if (!movement) return;
    if (!this.canUseControls(context)) {
      this.stopMovementAssist(true);
      return;
    }
    if (this.aimMode !== "idle") {
      this.stopMovementAssist(true);
      return;
    }

    const worm = context.activeWorm;
    if (Math.abs(movement.destinationX - worm.x) <= MOBILE_GHOST_REACH_PX) {
      this.stopMovementAssist(true);
      return;
    }

    movement.accumulatorMs += dt * 1000;
    while (movement.accumulatorMs >= MOBILE_ASSIST_MOVE_STEP_MS) {
      movement.accumulatorMs -= MOBILE_ASSIST_MOVE_STEP_MS;
      const toward = movement.destinationX < worm.x ? -1 : 1;
      const direction = (toward < 0 ? -1 : 1) as -1 | 1;
      const before = { x: worm.x, y: worm.y };
      const moved = context.recordMovementStep(direction, MOBILE_ASSIST_MOVE_STEP_MS, movement.jumpRequested);
      movement.jumpRequested = false;
      if (!moved) {
        this.stopMovementAssist(true);
        return;
      }
      const after = { x: worm.x, y: worm.y };
      const stuck =
        didMovementGetStuck(before, after) ||
        isForwardProgressBlocked(before, after, direction);
      movement.stuckSteps = stuck ? movement.stuckSteps + 1 : 0;
      if (movement.stuckSteps >= MOBILE_ASSIST_STUCK_STEPS) {
        this.stopMovementAssist(true);
        return;
      }
      if (Math.abs(movement.destinationX - worm.x) <= MOBILE_GHOST_REACH_PX) {
        this.stopMovementAssist(true);
        return;
      }
    }
  }

  sync(context: MobileGameplayContext): MobileControlsState {
    if (context.phase !== "aim") {
      this.aimMode = "idle";
      this.aimButtonVisible = false;
      this.weaponPickerOpen = false;
      this.aimTarget = null;
      this.stopMovementAssist(false);
    }

    if (this.aimMode === "charge" && !context.charging) {
      this.aimMode = context.phase === "aim" ? "aim" : "idle";
    }

    if (this.aimMode === "aim" || this.aimMode === "charge") {
      if (!this.aimTarget) {
        const aim = context.getAimInfo();
        this.aimTarget = { x: aim.targetX, y: aim.targetY };
      }
    } else {
      this.aimTarget = null;
    }

    const canUseMobile = this.canUseControls(context);
    const canUseWeaponSelector = this.canUseWeaponSelector(context);
    const canSelectWeapon =
      canUseWeaponSelector && this.aimMode !== "charge" && !context.charging;
    if (!canSelectWeapon) {
      this.weaponPickerOpen = false;
    }
    const visible = canUseWeaponSelector || canUseMobile;
    const showAimButton = canUseMobile && this.aimMode === "idle" && this.aimButtonVisible;
    const aimAnchor = context.worldToScreen(
      context.activeWorm.x,
      context.activeWorm.y - context.activeWorm.radius - MOBILE_AIM_BUTTON_OFFSET_PX
    );

    return {
      visible,
      weapon: context.weapon,
      canSelectWeapon,
      weaponPickerOpen: canSelectWeapon && this.weaponPickerOpen,
      mode: canUseMobile ? this.aimMode : "idle",
      showAimButton,
      aimButtonX: aimAnchor.x,
      aimButtonY: aimAnchor.y,
      showJumpButton: canUseMobile && this.movementAssist !== null,
      topUiOffsetPx: context.topUiOffsetPx,
    };
  }

  getAimAnchorWorldPoint(worm: MobileWorm, aim: AimInfo) {
    const dx = aim.targetX - worm.x;
    const dy = aim.targetY - worm.y;
    const len = Math.hypot(dx, dy);
    if (len <= MOBILE_AIM_LINE_MAX_PX || len <= 1e-6) {
      return { x: aim.targetX, y: aim.targetY };
    }
    const scale = MOBILE_AIM_LINE_MAX_PX / len;
    return {
      x: worm.x + dx * scale,
      y: worm.y + dy * scale,
    };
  }

  private getDefaultAimTarget(worm: MobileWorm) {
    const facing: -1 | 1 = worm.facing < 0 ? -1 : 1;
    const upAngle = (MOBILE_DEFAULT_AIM_ANGLE_UP_DEG * Math.PI) / 180;
    const angle = facing < 0 ? -Math.PI + upAngle : -upAngle;
    return {
      x: worm.x + Math.cos(angle) * MOBILE_DEFAULT_AIM_DISTANCE_PX,
      y: worm.y + Math.sin(angle) * MOBILE_DEFAULT_AIM_DISTANCE_PX,
    };
  }

  private clearFiringState() {
    this.aimMode = "idle";
    this.aimButtonVisible = false;
    this.aimTarget = null;
  }
}
